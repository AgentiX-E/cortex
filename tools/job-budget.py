#!/usr/bin/env python3
"""Why a benchmark that should take two hours takes five, and whether its protection can fire.

Asked on 2026-11-01 with run `41284575092` four hours into a job whose own ceiling is 350 minutes.
The answer is not "it is slow": it is that the run is **serial**, so its wall clock is the sum of
4000 sequential requests, and that the two ceilings guarding it were measured on **different
scales**, which is why the slower runs now finish minutes before a kill nobody would see.

## The arithmetic, which is the whole argument

One dispatch of `benchmark-cortex-memory.yml` runs `2 arms x 4 repetitions = 8` passes. Until this
round `CORTEX_MEMORY_BUDGET_MINUTES` bounded **one pass** (`evaluateWithScorerDetailed` restarted its
clock on every call), so the budget permitted a run of

    ceiling = passes x budget + overhead = 8 x 90 + 1 = 721 minutes

inside a job killed at **350**. `8 x 90 = 720` is 2.06x the job, so the budget could not fire for any
timing where the job would kill the run first — and that is exactly the regime the recent runs were
in:

| run | wall clock | per pass | 8 passes fit? | budget fired? |
|---|---|---|---|---|
| `41203245999` | 122.6 min | 15.3 | yes, 122 | no |
| `41222844945` | 117.5 min | 14.7 | yes, 118 | no |
| `41254359622` | 305.9 min | 38.2 | yes, 306 | no |
| `41259622431` | 334.8 min | 41.9 | **yes, 15 minutes of headroom** | no |

`41259622431` finished 15 minutes before a kill, and no artifact records that margin. The next draw
that runs 5% slower does not fail with `BenchmarkBudgetExceeded` and a `benchmark-error.log`; it
fails with no artifact at all, because a job timeout kills the remaining steps including the two
carrying `if: always()`.

**This is the same defect as the degradation guard's**, one level up: a protection whose safety comes
from the failure never arriving rather than from the rule being adequate. `AUDIT-MODEL-PORTABILITY.md`
§9.4 priced the guard's version at 72.26% of working deployments; this one costs a whole dispatch,
which at the current rate is between five and six hours.

## The two scopes, and why the tool must carry both

The repair moved the budget to the **run** (`AblationOptions.budgetMs` is now a deadline shared by
every pass), so the tool has to describe both shapes or it would be unable to read either the
archived dispatches or the current one:

| scope | inner ceiling | binds when | what a binding value costs |
|---|---|---|---|
| `run` | `budget + overhead` | `340 + 1 <= 360` **yes** | none: 340 sits above the largest measured run (334.8) |
| `pass` | `passes x budget + overhead` | `8 x 43.5 + 1 <= 350` only at 43.5 | a working pass already costs 41.9, so the margin is one slow draw |

The `pass` row is why the repair could not be a smaller number: narrowing a per-pass budget to the
point where it binds puts it *below* what a working pass costs, which converts a lost run into a
false failure. Only concurrency, or a budget on a quantity that does not multiply, moves that wall.

## What this tool will not do

It does not claim concurrency is free. `--concurrency c` divides each pass by `c`, which is the
**optimistic** figure: the provider's rate limit, the per-attempt retry ladder and the shared
embedding cache all bound the real speedup, and none of them appear in a workflow file. The tool
reports the ideal so the gap between it and a measurement is visible.

## The third quantity, which the first two could not see (run `41625442265`)

The sentence above was true of a run that had no client-side pace. It has one, and it is a **gate**
rather than a delay: `cortex-ai`'s `RequestGate` hands out slots from one process-wide schedule, so
`CORTEX_LLM_MIN_INTERVAL_MS=6000` means one request every six seconds **whatever the pool width is**.
Concurrency then moves nothing, and the two quantities this tool already carried -- a per-pass cost
and a per-run budget -- are both statements about work that a pace has already replaced with a
schedule.

`41625442265` is the measurement: 500 questions x 8 passes x 6 s = **400 minutes of waiting alone**,
dispatched with `CORTEX_MEMORY_BUDGET_MINUTES=340` inside a 360-minute job. It could not complete
before its own ceiling fired, at any speed the provider ran at, and the budget's fire was therefore
not a protection but a scheduled failure. It fired at question 146 of the fifth pass and wrote a
partial record -- which is strictly better than the kill it would otherwise have met, and still not
a measurement.

So the floor is its own quantity, `pacing_floor_minutes`, and it is compared against the **budget**
rather than against the job: a budget below the floor is a dispatch that cannot succeed. The exit
code `3` says exactly that, and the workflow refuses the run in five seconds instead of six hours.

## Output and exit codes

`0` the inner ceiling fires before the job, `1` the job kills the run first, `2` the inputs cannot
be read.
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys
from dataclasses import dataclass
from math import floor
from typing import Iterable, Literal

Scope = Literal["run", "pass"]

# The shape this repository ships, pinned so the tool's own example cannot drift from the workflow.
DEFAULT_PASSES = 8
DEFAULT_BUDGET_MINUTES = 340.0
DEFAULT_SCOPE: Scope = "run"

# The graded set and the requests one question costs the reader. One is a floor, not an estimate: a
# question that consults the reader at all consults it once, and the judge is a second call on the
# answers the first one produced. Counting the floor rather than a measured average is what makes the
# result a lower bound on the run, which is the only form a refusal can be built on.
DEFAULT_QUESTIONS = 500
DEFAULT_CALLS_PER_QUESTION = 1.0


# --------------------------------------------------------------------------- the pace

def pacing_floor_minutes(
    questions: int,
    passes: int,
    min_interval_ms: float,
    calls_per_question: float = DEFAULT_CALLS_PER_QUESTION,
) -> float:
    """The least wall clock a paced dispatch can finish in, in minutes.

    `RequestGate` hands out one slot per request from a single schedule, so the number of slots a run
    needs is `questions x calls_per_question x passes` and the schedule spends `min_interval_ms` on
    each. Nothing here is divided by concurrency, and that is the whole point of the quantity: a gate
    fixes the rate at which requests leave, so a wider pool changes how much is in flight and not how
    long the schedule is.
    """
    if questions <= 0:
        raise ValueError(f"questions must be positive, got {questions!r}")
    _check_passes(passes)
    if min_interval_ms <= 0:
        raise ValueError(
            f"min_interval_ms must be positive, got {min_interval_ms!r}: a run with no pace has no "
            "floor, and passing 0 would claim a floor of zero minutes for a gate that does not exist",
        )
    if calls_per_question <= 0:
        raise ValueError(f"calls_per_question must be positive, got {calls_per_question!r}")
    slots = questions * calls_per_question * passes
    return slots * min_interval_ms / 60_000


def can_complete(
    questions: int,
    passes: int,
    min_interval_ms: float,
    budget_minutes: float,
    calls_per_question: float = DEFAULT_CALLS_PER_QUESTION,
) -> bool:
    """Whether the run's own ceiling can be met at all.

    Inclusive, for the reason `binds` is inclusive: at equality the two mechanisms fire at the same
    instant, and the one that leaves a readable record is the one to keep. The comparison is against
    the **budget** and not the job, because a budget below the floor turns the run's protection into
    the scheduled cause of its failure.
    """
    if budget_minutes <= 0:
        raise ValueError(f"budget must be positive, got {budget_minutes!r}")
    floor = pacing_floor_minutes(questions, passes, min_interval_ms, calls_per_question)
    return floor <= budget_minutes


# --------------------------------------------------------------------------- arithmetic

def _check_passes(passes: int) -> None:
    if passes <= 0:
        raise ValueError(f"passes must be positive, got {passes!r}")


def _check_overhead(overhead_minutes: float) -> None:
    if overhead_minutes < 0:
        raise ValueError(f"overhead must be non-negative, got {overhead_minutes!r}")


def _check_job(job_minutes: float, overhead_minutes: float) -> None:
    if job_minutes <= overhead_minutes:
        raise ValueError(
            f"job must exceed the overhead, got job={job_minutes!r} overhead={overhead_minutes!r}: a "
            "job that ends before its own setup has no usable time and the division below would "
            "report a negative budget as a number",
        )


def _check_scope(scope: str) -> Scope:
    if scope not in ("run", "pass"):
        raise ValueError(f"scope must be 'run' or 'pass', got {scope!r}")
    return scope  # type: ignore[return-value]


def budget_ceiling(
    passes: int,
    budget_minutes: float,
    overhead_minutes: float,
    scope: Scope = DEFAULT_SCOPE,
) -> float:
    """The longest run the budget permits, in minutes.

    This is the number the budget is actually a statement about, and the reason the old defect was
    invisible: `90 minutes` read as a bound on the run and was a bound on `1/8` of the run.

    Under `run` the ceiling is the budget plus the setup that happens before the clock starts; under
    `pass` it is the budget times the number of passes, which is the multiplication that made a
    per-pass figure unable to bind.
    """
    _check_passes(passes)
    if budget_minutes <= 0:
        raise ValueError(f"pass budget must be positive, got {budget_minutes!r}")
    _check_overhead(overhead_minutes)
    if _check_scope(scope) == "run":
        return budget_minutes + overhead_minutes
    return passes * budget_minutes + overhead_minutes


def binds(
    passes: int,
    budget_minutes: float,
    job_minutes: float,
    overhead_minutes: float,
    scope: Scope = DEFAULT_SCOPE,
) -> bool:
    """Whether the budget can fire before the job kills the run.

    Inclusive at equality: when both would fire at the same minute, a tie has to resolve towards the
    mechanism that produces a readable error, because the alternative is a run that vanishes.
    """
    return budget_ceiling(passes, budget_minutes, overhead_minutes, scope) <= job_minutes


def binding_budget(
    passes: int,
    job_minutes: float,
    overhead_minutes: float,
    concurrency: int = 1,
    scope: Scope = DEFAULT_SCOPE,
) -> float:
    """The largest budget that still binds, in the unit `scope` names.

    `concurrency` scales a **pass**, so it only appears in the `pass` row: a pass measured at `t`
    minutes serial costs `t / c` at concurrency `c`, and a per-pass ceiling has to be set above
    that. A run-level ceiling is wall-clock already, so concurrency does not move it -- it moves how
    much work fits inside it, which is the point.
    """
    _check_passes(passes)
    _check_overhead(overhead_minutes)
    if concurrency < 1:
        raise ValueError(f"concurrency must be at least 1, got {concurrency!r}")
    _check_job(job_minutes, overhead_minutes)
    usable = job_minutes - overhead_minutes
    if _check_scope(scope) == "run":
        return usable
    return usable / passes * concurrency


# --------------------------------------------------------------------------- the reading

@dataclass(frozen=True)
class Reading:
    """What actually ends a run of this shape, given a measured pass."""

    passes: int
    measured_pass_minutes: float
    job_minutes: float
    overhead_minutes: float
    budget_minutes: float
    scope: Scope
    completed_passes: int
    total_minutes: float
    headroom_minutes: float
    budget_would_fire: bool
    outcome: str

    def describe(self) -> str:
        usable = self.job_minutes - self.overhead_minutes
        fitting = floor(usable / self.measured_pass_minutes)
        ceiling = budget_ceiling(self.passes, self.budget_minutes, self.overhead_minutes, self.scope)
        # Both scopes fire on the clock, not on a count of passes: a run-level clock starts at the
        # first question, and a pass-level clock restarts every pass, so the instant is the same and
        # only the *condition* differs (accumulated work versus one pass).
        fires_at = self.overhead_minutes + self.budget_minutes
        lines = [
            f"passes {self.passes}, measured {self.measured_pass_minutes:.2f} min each, "
            f"budget {self.budget_minutes:.0f} min per {self.scope}, job {self.job_minutes:.0f} min",
            f"  budget ceiling   {ceiling:.0f} min ({ceiling / self.job_minutes:.2f}x the job)",
            f"  usable in job    {usable:.1f} min, so {fitting} complete passes fit "
            f"({usable / self.measured_pass_minutes:.2f} passes' worth of time)",
            f"  this run         {self.completed_passes} of {self.passes} passes, "
            f"{self.total_minutes:.1f} min, headroom {self.headroom_minutes:+.1f} min "
            f"({self.headroom_minutes / self.job_minutes * 100:.1f}% of the job)",
            "  budget fires     "
            + (
                f"at {fires_at:.0f} min: the run fails with `BenchmarkBudgetExceeded` and a readable "
                "partial record"
                if self.budget_would_fire
                else f"never: this run costs {self.total_minutes:.1f} and the budget ends at "
                f"{fires_at:.0f}, so its protection is the job ceiling alone"
            ),
        ]
        if self.outcome == "fits":
            lines.append(
                "  outcome          fits, and the margin is the only thing between this dispatch and a "
                "kill that writes no artifact"
            )
        elif self.outcome == "killed":
            lines.append(
                f"  outcome          KILLED inside pass {self.completed_passes + 1}: no budget error, "
                "no benchmark-error.log, no artifact"
            )
        else:
            lines.append("  outcome          the budget fires first, which is the readable failure")
        return "\n".join(lines)


def read(
    passes: int,
    measured_pass_minutes: float,
    job_minutes: float,
    overhead_minutes: float,
    budget_minutes: float,
    scope: Scope = DEFAULT_SCOPE,
) -> Reading:
    """Classify what ends a run of this shape."""
    _check_passes(passes)
    _check_overhead(overhead_minutes)
    _check_job(job_minutes, overhead_minutes)
    _check_scope(scope)
    if measured_pass_minutes <= 0:
        raise ValueError(f"measured pass must be positive, got {measured_pass_minutes!r}")

    usable = job_minutes - overhead_minutes
    completed = min(passes, floor(usable / measured_pass_minutes))
    total = completed * measured_pass_minutes + overhead_minutes

    if scope == "run":
        # One clock for the whole run: it fires once the accumulated work passes the budget, so the
        # question is whether this run's total reaches it while the job is still alive.
        fires_at = overhead_minutes + budget_minutes
        budget_would_fire = total > fires_at and fires_at <= job_minutes
    else:
        # One clock per pass: it fires inside the first pass that runs longer than the budget, which
        # is a question about a single pass rather than about the sum.
        budget_would_fire = measured_pass_minutes > budget_minutes

    if budget_would_fire:
        outcome = "budget"
    elif completed < passes:
        outcome = "killed"
    else:
        outcome = "fits"

    return Reading(
        passes=passes,
        measured_pass_minutes=measured_pass_minutes,
        job_minutes=job_minutes,
        overhead_minutes=overhead_minutes,
        budget_minutes=budget_minutes,
        scope=scope,
        completed_passes=completed,
        total_minutes=total,
        headroom_minutes=job_minutes - total,
        budget_would_fire=budget_would_fire,
        outcome=outcome,
    )


# --------------------------------------------------------------------------- the workflow

def from_workflow(path: pathlib.Path) -> tuple[float, float | None]:
    """Read the job timeout and the budget out of a workflow file.

    Two regexes rather than a YAML parse, and deliberately: the values are scalars at fixed keys, and
    a parser would happily accept a workflow whose budget is expressed as an expression this tool
    cannot evaluate -- which is the failure mode that matters. Anything it cannot read, it says it
    cannot read.
    """
    text = path.read_text()
    job = re.search(r"^\s*timeout-minutes:\s*(\d+(?:\.\d+)?)\s*$", text, re.MULTILINE)
    if job is None:
        raise ValueError(f"{path}: no timeout-minutes in the file, so there is no job ceiling to read")
    found = re.search(r"CORTEX_MEMORY_BUDGET_MINUTES:\s*'?(\d+(?:\.\d+)?)'?", text)
    return float(job.group(1)), None if found is None else float(found.group(1))


# --------------------------------------------------------------------------- entry point

def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Does the benchmark's own ceiling fire before the job kills the run?",
    )
    parser.add_argument("--workflow", type=pathlib.Path, help="read the job timeout and budget from here")
    parser.add_argument("--job-minutes", type=float, help="the job ceiling, if not read from a workflow")
    parser.add_argument("--budget-minutes", type=float, help="the benchmark's own ceiling, if not read")
    parser.add_argument("--passes", type=int, default=DEFAULT_PASSES, help="arms x repetitions")
    parser.add_argument("--overhead-minutes", type=float, default=1.0, help="setup before the clock")
    parser.add_argument(
        "--scope",
        choices=("run", "pass"),
        default=DEFAULT_SCOPE,
        help="what the budget bounds: the whole run (current) or one pass (historical)",
    )
    parser.add_argument("--concurrency", type=int, default=1, help="requests in flight, for the repair")
    parser.add_argument(
        "--questions",
        type=int,
        default=DEFAULT_QUESTIONS,
        help="graded questions per pass, for the pacing floor",
    )
    parser.add_argument(
        "--min-interval-ms",
        type=float,
        default=None,
        help=(
            "the client-side pace the run is dispatched at (CORTEX_LLM_MIN_INTERVAL_MS). Omitted means "
            "no floor is computed, which is the only honest reading of a workflow whose pace arrives "
            "in a repository variable this tool cannot see"
        ),
    )
    parser.add_argument(
        "--calls-per-question",
        type=float,
        default=DEFAULT_CALLS_PER_QUESTION,
        help="reader requests one question costs; the floor counts this many slots per question",
    )
    parser.add_argument(
        "--measured-pass-minutes",
        type=float,
        action="append",
        default=None,
        help="a measured per-pass cost; repeat to read several runs",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    job = args.job_minutes
    budget = args.budget_minutes
    if args.workflow is not None:
        try:
            read_job, read_budget = from_workflow(args.workflow)
        except (OSError, ValueError) as error:
            print(str(error), file=sys.stderr)
            return 2
        job = read_job if job is None else job
        budget = read_budget if budget is None else budget
    if job is None:
        print("--job-minutes or --workflow is required", file=sys.stderr)
        return 2
    if budget is None:
        print(
            "--budget-minutes is required (the workflow does not set one, so there is no ceiling to "
            "check)",
            file=sys.stderr,
        )
        return 2

    try:
        ceiling = budget_ceiling(args.passes, budget, args.overhead_minutes, args.scope)
        bound = binding_budget(args.passes, job, args.overhead_minutes, args.concurrency, args.scope)
        readings = [
            read(args.passes, minutes, job, args.overhead_minutes, budget, args.scope)
            for minutes in (args.measured_pass_minutes or [])
        ]
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2

    print(f"job {job:.0f} min, {args.passes} passes, {budget:.0f} min per {args.scope}")
    can_bind = binds(args.passes, budget, job, args.overhead_minutes, args.scope)
    print(f"  the ceiling permits {ceiling:.0f} min of run ({ceiling / job:.2f}x the job) -> "
          + ("it binds" if can_bind else "IT CANNOT BIND"))
    print(f"  the largest budget that binds at concurrency {args.concurrency}: {bound:.2f} min")

    # The pace, when the caller knows it. Reported before the per-run readings because it outranks
    # them: a run below its own floor never reaches the point where a measurement exists to read.
    completes = True
    if args.min_interval_ms is not None:
        try:
            floor_minutes = pacing_floor_minutes(
                args.questions, args.passes, args.min_interval_ms, args.calls_per_question
            )
            completes = can_complete(
                args.questions, args.passes, args.min_interval_ms, budget, args.calls_per_question
            )
        except ValueError as error:
            print(str(error), file=sys.stderr)
            return 2
        print(
            f"  pacing floor {floor_minutes:.0f} min "
            f"({args.questions} questions x {args.calls_per_question:g} call(s) x {args.passes} "
            f"passes x {args.min_interval_ms:g} ms), budget {budget:.0f} -> "
            + (
                "the run can finish"
                if completes
                else f"THE RUN CANNOT FINISH: the budget fires {floor_minutes - budget:.0f} min "
                "before the last question is asked"
            )
        )

    for reading in readings:
        print()
        print(reading.describe())

    if not completes:
        return 3
    return 0 if can_bind else 1


if __name__ == "__main__":
    raise SystemExit(main())
