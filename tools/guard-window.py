#!/usr/bin/env python3
"""Would the degradation guard fire on a reader that is working?

`AUDIT-MODEL-PORTABILITY.md` 8 lists four falsifiers, and the third one is the only one that needs
no new calls: *if a deployment running on an **already measured** reader downgrades often, then
`3 of 20` is calibrated against the wrong scale and the guard is a random configuration generator.*
This tool answers it from artifacts that already exist.

## What it can and cannot read

`DegradationGuard` counts four signals. An artifact records one of them.

| signal | derivable from an artifact | why |
|---|---|---|
| `empty-completion` | **yes** | `rawOutput` is stored per question |
| `parse-failed` | no | the artifact stores the parse *result*, never a judgement that it was wrong |
| `abstention-unrecognised` | no | needs a lexicon, and a lexicon is a guess until someone measures it |
| `deadline-exceeded` | no | the adapter raises it; nothing writes it to a field |

So the honest answer for a published artifact is about **one** signal, and the tool prints the other
three as *not derivable* rather than as zero. A tool that reported "0 of 4 fired" when it could only
see one would be the same defect it is measuring: a count whose denominator is not what it says.

## The counterfactual, which is the interesting half

The one thing that looks like a failure and is stored per question on every run is the **decline**
(`answer === null`). Counting it would make the guard fire often, and the tool computes exactly how
often — because the temptation to treat "the model refused" as "the model is broken" is the mistake
`ABSTAIN_TOKEN` was written to prevent, and a number is the cheapest way to keep it prevented.

Run `41254359622` declines **32 of 500** times and **30 of those 32 are scored correct** — they are
the right answer to a question whose evidence is absent. The other two are declines on questions that
did have an answer, which is the one shape a guard could legitimately notice, and it occurs **twice in
five hundred calls** — about a tenth of the 4.22% rate at which this rule fires on one window in
twenty.

Counting the whole decline rate instead fires **105 of 481 windows (21.83%)** on that reader. A guard
that did that would downgrade a deployment for abstaining properly, and it would do it four times an
hour.

## The calibration the third falsifier actually needs

Inverting the rule gives the failure rate at which a *working* reader starts to trip it. At
`n = 20, k = 3, target = 5%` of windows that is **p ≈ 4.0%**. Compare §13.194.4's measured
same-prompt flip rate of 4.8%: a reader noisier than the one this campaign measured would fire on
more than one window in twenty, which is the regime where the guard stops describing the provider and
starts describing its own threshold.

Exit codes: `0` every derivable signal is at or below the target, `1` a signal exceeds it, `2` the
input cannot be read.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from math import comb
from typing import Iterable, Sequence


# --------------------------------------------------------------------------- binomial

def binomial_tail(k: int, n: int, p: float) -> float:
    """P(X >= k) for X ~ Binomial(n, p), summed exactly rather than approximated.

    Exact because this number decides whether an operator's deployment changes configuration, and
    the normal approximation is worst exactly here: at `n = 20, p = 0.04` the mean is 0.8, which is
    inside the region where the tail crosses zero and a Gaussian gives a confident answer to a
    question that is about three discrete events.
    """
    if k <= 0:
        return 1.0
    if k > n:
        return 0.0
    if p <= 0.0:
        return 0.0
    if p >= 1.0:
        return 1.0
    total = 0.0
    for i in range(k, n + 1):
        total += comb(n, i) * (p ** i) * ((1.0 - p) ** (n - i))
    return total


def rate_for_firing(k: int, n: int, target: float) -> float:
    """The per-call failure rate at which a window fires with probability `target`.

    Bisection on a monotone function, and the answer is reported to four decimals because it is a
    **threshold** rather than a measurement: quoting it to more places would suggest a precision the
    underlying `target` does not have.
    """
    if not 0.0 < target < 1.0:
        raise ValueError(f"target must be in (0, 1), got {target!r}")
    lo, hi = 0.0, 1.0
    for _ in range(200):
        mid = (lo + hi) / 2.0
        if binomial_tail(k, n, mid) < target:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


# --------------------------------------------------------------------------- windows

def window_fires(flags: Sequence[bool], window: int, trigger: int) -> int:
    """How many of the `window`-sized consecutive runs contain at least `trigger` true flags.

    Windows are counted **per start position**, so the denominator is `len(flags) - window + 1` and
    two firing windows that overlap count twice. That is deliberate: the question is "how often does
    this rule fire", and a sliding window that fires at positions 7 and 8 fired twice.
    """
    if window <= 0:
        raise ValueError(f"window must be positive, got {window!r}")
    if trigger <= 0:
        raise ValueError(f"trigger must be positive, got {trigger!r}")
    if len(flags) < window:
        return 0
    running = sum(1 for flag in flags[:window] if flag)
    fired = 1 if running >= trigger else 0
    for index in range(window, len(flags)):
        running += (1 if flags[index] else 0) - (1 if flags[index - window] else 0)
        if running >= trigger:
            fired += 1
    return fired


def window_count(calls: int, window: int) -> int:
    """The denominator `window_fires` is divided by, or zero when no window fits."""
    return max(0, calls - window + 1)


# --------------------------------------------------------------------------- artifact

class Artifact:
    """The fields one run's report carries that this question needs.

    Parsed defensively and with named failures, because the alternative — a `.get` chain — turns a
    renamed field into a zero, and a zero is the answer this tool is asked to certify.
    """

    def __init__(self, path: pathlib.Path, raw: dict) -> None:
        self.path = path
        try:
            self.questions: list[dict] = raw["questions"]
            self.reasons: dict = raw["abstentionReasons"]
            self.run_id = str(raw.get("runId") or raw.get("generatedAt") or path.name)
        except (KeyError, TypeError) as error:
            raise SystemExit(
                f"{path}: not a cortex-memory report ({error}). This tool reads the fields the "
                "arm writes; it does not guess at another artifact's shape."
            ) from error
        if not isinstance(self.questions, list) or not self.questions:
            raise SystemExit(f"{path}: `questions` is empty, so there is no call stream to window")

    # -- derivable signals ---------------------------------------------------

    def empty_completion(self) -> list[bool]:
        """One flag per call, in the artifact's own order.

        A completion whose text is empty *or whitespace* counts: `parseAnswer` trims first and
        returns the empty answer, so `"  \\n "` reaches the scorer as a blank — a wrong answer, and
        the same event the guard is meant to notice.
        """
        return [not str(question.get("rawOutput") or "").strip() for question in self.questions]

    def declines(self) -> list[bool]:
        """The counterfactual signal: the reader declined rather than failed."""
        return [question.get("answer") is None for question in self.questions]

    def decline_correctness(self) -> tuple[int, int]:
        """(declines that were scored correct, declines). The second number is the first's ceiling."""
        declined = [question for question in self.questions if question.get("answer") is None]
        correct = sum(1 for question in declined if question.get("correct") is True)
        return correct, len(declined)

    def aggregate_calls(self) -> int:
        """Calls the run reports having made, which is `runs * questions` for the arm."""
        return sum(int(value) for value in self.reasons.values())


# --------------------------------------------------------------------------- report

NOT_DERIVABLE = (
    (
        "parse-failed",
        "the artifact stores the parse result, never a judgement that the parse was wrong",
    ),
    (
        "abstention-unrecognised",
        "needs a lexicon, and a lexicon is a guess until someone measures it",
    ),
    (
        "deadline-exceeded",
        "the adapter raises it and no artifact field carries it",
    ),
)


def describe(flags: Sequence[bool], window: int, trigger: int) -> str:
    """The count, the rate, and the windows — the three numbers that make the rate checkable."""
    calls = len(flags)
    hits = sum(1 for flag in flags if flag)
    rate = hits / calls if calls else 0.0
    fired = window_fires(flags, window, trigger)
    denominator = window_count(calls, window)
    share = fired / denominator if denominator else 0.0
    return (
        f"{hits:>4} of {calls} calls ({rate * 100:6.3f}%)   "
        f"windows fired {fired:>3} of {denominator} ({share * 100:6.2f}%)"
    )


def render(artifact: Artifact, window: int, trigger: int, target: float) -> tuple[str, int]:
    lines: list[str] = []
    calls = len(artifact.questions)
    denominator = window_count(calls, window)
    lines.append(f"artifact  {artifact.path}")
    lines.append(
        f"  calls {calls}, aggregate {artifact.aggregate_calls()} (x{artifact.aggregate_calls() // calls}"
        f" repetitions)   window {window}, trigger {trigger}, target {target * 100:.1f}% of windows"
        if calls
        else f"  calls 0   window {window}, trigger {trigger}"
    )
    if denominator == 0:
        lines.append(
            f"  no window fits: {calls} calls is shorter than the {window}-call window, so the "
            "guard could not have fired and this artifact cannot falsify anything"
        )
        return "\n".join(lines), 2

    exceeded = False
    lines.append("  derivable  1 of 4 guard signals")
    empty = artifact.empty_completion()
    line = describe(empty, window, trigger)
    lines.append(f"    empty-completion       {line}")
    fired = window_fires(empty, window, trigger)
    if fired / denominator > target:
        exceeded = True

    lines.append("  not derivable from this artifact")
    for name, reason in NOT_DERIVABLE:
        lines.append(f"    {name:<22} {reason}")

    declined = artifact.declines()
    correct, total = artifact.decline_correctness()
    lines.append("  counterfactual: counting a decline as a failure")
    lines.append(f"    declined-as-signal     {describe(declined, window, trigger)}")
    lines.append(
        f"    of those {total} declined calls, {correct} were scored **correct** — so a guard that "
        "counted declines would downgrade a deployment for abstaining properly"
    )

    threshold = rate_for_firing(trigger, window, target)
    lines.append(
        f"  calibration  a reader whose per-call failure rate is {threshold * 100:.2f}% fires on "
        f"{target * 100:.1f}% of windows"
    )

    verdict = (
        "verdict: quiet on the one signal this artifact can express, and the other three are "
        "stated as unreadable rather than as zero"
        if not exceeded
        else "verdict: FIRES above the target on a measured reader, which falsifies the 3-of-20 scale"
    )
    lines.append(verdict)
    return "\n".join(lines), (1 if exceeded else 0)


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Falsifier 3 of the portability audit: does the guard fire on a working reader?",
    )
    parser.add_argument("artifact", nargs="+", help="cortex-memory ablation report(s) to window")
    parser.add_argument("--window", type=int, default=20, help="calls per window (the guard's own)")
    parser.add_argument("--trigger", type=int, default=3, help="signals that downgrade a bucket")
    parser.add_argument(
        "--target",
        type=float,
        default=0.05,
        help=(
            "share of windows a working reader may fire on before the scale is wrong. 5%% is one "
            "window in twenty: high enough that a single bad question cannot trip it twice, low "
            "enough that a broken reader cannot stay quiet"
        ),
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.window <= 0 or args.trigger <= 0:
        print("--window and --trigger must be positive", file=sys.stderr)
        return 2
    if not 0.0 < args.target < 1.0:
        print("--target must be in (0, 1)", file=sys.stderr)
        return 2

    worst = 0
    for raw_path in args.artifact:
        path = pathlib.Path(raw_path)
        try:
            raw = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as error:
            print(f"{path}: cannot read ({error})", file=sys.stderr)
            return 2
        text, code = render(Artifact(path, raw), args.window, args.trigger, args.target)
        print(text)
        print()
        worst = max(worst, code)
    return worst


if __name__ == "__main__":
    raise SystemExit(main())
