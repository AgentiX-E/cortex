#!/usr/bin/env python3
"""Read the supersession arm against its control, and answer K1-K5 of section 13.366.

## Why this is a tool and not a reading done by hand

The last three verdicts in this campaign were each computed from an artifact by a person with a calculator, and
each one had to be re-derived when a later round disagreed with it. The gates here are five, they are stated in
the pre-registration before the dispatch, and three of them are read from columns no summary table prints
(`promptDigest` equality, the per-question roster pair, the refusal reasons). A hand reading of five numbers is
four numbers and an assumption.

## What it refuses

- **A question in one artifact and not the other.** The join is by `questionId` and a missing side is an error,
  not a smaller denominator: a net computed over the intersection is a number that cannot be compared to the one
  it replaced, which is the rule every other census in this repository follows.
- **A run with fewer than two repetitions.** Every gate below is stated over the four-repetition mean, and one
  repetition cannot separate a mechanism from a draw. `failure-stability.ts` refuses the same input for the same
  reason.
- **A capability whose population differs between the artifacts.** The two sides of this arm answer the same
  dataset in the same job, so a difference is a defect in the artifact and not a fact about the run.

## The two nulls, and why both are printed

`MEASURE-PAIRED-POWER.md` is the argument. A paired exact test looks only at the discordant counts, so it is
generous; the measured flip floor says this population moves 4.1% of itself with **nothing changed**, so it is
not. A result that clears both is a result. A result that clears one is a direction, and the output says which
one it cleared rather than choosing for the reader.

Usage:

    python3 tools/supersede-reading.py --treatment <spec-run>.json --control <control>.json
    python3 tools/supersede-reading.py --treatment A.json --control B.json --json
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# The six questions section 3 of `MEASURE-FAILURE-STABILITY.md` named, kept as a **continuity table** and not as
# the gate. §13.366.1 is the amendment: that list was read from `42355323615`, and read against this arm's control
# three of the six are correct in all four repetitions -- so a bar stated over them was unreachable by
# construction. The population is now derived from the control the reader is handed.
ORIGINAL_SIX: tuple[str, ...] = (
    "ce6d2d27",
    "9ea5eabc",
    "ed4ddc30",
    "59524333",
    "69fee5aa",
    "a2f3aa27",
)

# The fraction of the control's stable failures the arm must convert. Three quarters, which on the eight this
# control carries is six -- the `6/0` cell §13.366 prices at `p = 0.031` exact and `p = 0.0037` against the flip
# floor. A rate rather than a count so the gate survives a control whose population is a different size.
CONVERSION_SHARE = 0.75

# The capability the pass claims to reach, and the ones it must not.
TREATED = "KU"

# Each capability's own repetition 2 sd, from `MEASURE-FAILURE-STABILITY.md` section 1. Stated here rather than
# recomputed from the artifacts, because the gate is "the pass reached no other route" and a bound recomputed
# from the treatment could widen with the treatment's own noise.
SPREAD: dict[str, float] = {"ABS": 0.00, "KU": 2.52, "MR": 4.16, "TR": 4.32, "IE": 3.46}

# The measured flip floor (`MEASURE-PLAN-SHAPE.md` section 1): 5 of 121 questions moved under a byte-identical
# prompt, so 4.1% of any population this size moves with nothing changed, half in each direction.
FLIP_RATE = 5 / 121


def mcnemar_exact(repairs: int, damages: int) -> float:
    """Two-sided exact McNemar p, which depends only on the discordant counts."""
    n = repairs + damages
    if n == 0:
        return 1.0
    tail = sum(math.comb(n, i) for i in range(0, min(repairs, damages) + 1)) * (0.5**n)
    return min(1.0, 2 * tail)


def noise_floor(repairs: int, total: int, rate: float = FLIP_RATE / 2) -> float:
    """`p(at least `repairs` same-direction flips)` if the population flipped at the measured rate.

    One-directional on purpose. The measured floor produced three repairs and two damages on 121 questions, so
    the per-direction rate is half the flip rate; a mechanism's repairs have to be more than that coincidence,
    and counting both directions would let opposite movements cancel.
    """
    if total <= 0:
        return 1.0
    return sum(
        math.comb(total, i) * rate**i * (1 - rate) ** (total - i) for i in range(repairs, total + 1)
    )


@dataclass(frozen=True)
class Side:
    """One artifact, with the per-question facts the gates read."""

    report: dict[str, Any]
    questions: dict[str, dict[str, Any]]
    per_run: list[list[int]]

    @classmethod
    def load(cls, path: Path) -> Side:
        report = json.loads(path.read_text(encoding="utf-8"))
        records = report.get("questions")
        if not isinstance(records, list) or not records:
            raise SystemExit(f"{path}: the artifact carries no per-question roster")
        per_run = report.get("ablation", {}).get("featureCorrectByRun")
        if not isinstance(per_run, list) or len(per_run) < 2:
            raise SystemExit(
                f"{path}: fewer than two repetitions. Every gate in section 13.366 is stated over the "
                "four-repetition mean, and one repetition cannot separate a mechanism from a draw."
            )
        questions = {str(record["questionId"]): record for record in records}
        if len(questions) != len(records):
            raise SystemExit(f"{path}: duplicate questionId in the roster")
        return cls(report=report, questions=questions, per_run=per_run)

    def pass_rate(self, index: int) -> float:
        """How often the question at `index` was answered correctly, over every repetition.

        Index rather than id because `featureCorrectByRun` is a list of masks in dataset order and carries no
        ids; `index_of` is the one place the two coordinate systems meet.

        `int()` rather than a comparison, because the mask is written as a string of `0`/`1` characters while
        the in-memory form is a list of integers, and the two artifacts this tool reads are the file form. A
        non-numeric entry raises here rather than being counted as a pass, which is the right direction: a
        malformed mask is a defect in the writer, not a question the mechanism converted.
        """
        return sum(int(mask[index]) for mask in self.per_run) / len(self.per_run)


def join(treatment: Side, control: Side) -> list[str]:
    """The question ids both artifacts carry, refusing anything else.

    Position is not identity: the two artifacts are written by the same code from the same dataset, so their
    rosters *should* align, and a join that assumed it would silently compare question 41's answer with question
    42's the first time the dataset changed. `questionId` is the only key that survives that.
    """
    left = set(treatment.questions)
    right = set(control.questions)
    if left != right:
        missing = sorted(left ^ right)[:5]
        raise SystemExit(
            "the two artifacts do not carry the same questions; the first few that differ: "
            + ", ".join(missing)
        )
    return sorted(left)


def index_of(treatment: Side, ids: list[str]) -> dict[str, int]:
    """Map a question id to its position in the roster, which is the order the masks use."""
    order = [str(record["questionId"]) for record in treatment.report["questions"]]
    position = {question_id: index for index, question_id in enumerate(order)}
    return {question_id: position[question_id] for question_id in ids}


def capability(record: dict[str, Any]) -> str:
    return str(record.get("capability") or "?")


def capability_of(treatment: Side, question_id: str) -> str:
    return capability(treatment.questions[question_id])


def signed_counts(
    treatment: Side, control: Side, ids: list[str], position: dict[str, int], only: str | None = None
) -> tuple[list[str], list[str]]:
    """Questions this arm moved up, and questions it moved down, on the four-repetition mean.

    The mean rather than any single repetition, because a mechanism that converts a question in three of four
    repetitions has converted three quarters of a question and a boolean column would have to call it either 1
    or 0. The consequence is that `repairs` and `damages` here are counts of **questions**, and the exact test
    over them is the question-level test the registration states.
    """
    repairs: list[str] = []
    damages: list[str] = []
    for question_id in ids:
        if only is not None and capability_of(treatment, question_id) != only:
            continue
        gap = treatment.pass_rate(position[question_id]) - control.pass_rate(position[question_id])
        if gap > 0:
            repairs.append(question_id)
        elif gap < 0:
            damages.append(question_id)
    return repairs, damages


def read(treatment_path: Path, control_path: Path) -> dict[str, Any]:
    """Every gate, computed once, so the printed table and the JSON cannot disagree."""
    treatment = Side.load(treatment_path)
    control = Side.load(control_path)
    ids = join(treatment, control)
    position = index_of(treatment, ids)

    population = [question_id for question_id in ids if capability_of(treatment, question_id) == TREATED]
    repairs, damages = signed_counts(treatment, control, population, position)
    exact = mcnemar_exact(len(repairs), len(damages))
    noise = noise_floor(len(repairs), len(population))

    # The gate's population: the control's own stable failures, read from its masks rather than carried over from
    # another dispatch (§13.366.1).
    stable = [
        question_id
        for question_id in population
        if control.pass_rate(position[question_id]) == 0.0
    ]
    targets = []
    for question_id in stable:
        before = control.pass_rate(position[question_id])
        after = treatment.pass_rate(position[question_id])
        targets.append(
            {
                "id": question_id,
                "state": "converted" if after > before else "regressed" if after < before else "held",
                "before": round(before, 3),
                "after": round(after, 3),
            }
        )
    converted = [row for row in targets if row["state"] == "converted"]

    # The questions the previous census named, printed beside the gate so a reader can see which of them were
    # passing in this control all along -- the defect §13.366.1 records.
    continuity = [
        {
            "id": question_id,
            "control": round(control.pass_rate(position[question_id]), 3),
            "treatment": round(treatment.pass_rate(position[question_id]), 3),
        }
        if question_id in treatment.questions
        else {"id": question_id, "control": None, "treatment": None}
        for question_id in ORIGINAL_SIX
    ]

    per_capability = {}
    for name in sorted({capability_of(treatment, question_id) for question_id in ids}):
        sub = [question_id for question_id in ids if capability_of(treatment, question_id) == name]
        cap_repairs, cap_damages = signed_counts(treatment, control, sub, position)
        delta = sum(
            treatment.pass_rate(position[question_id]) - control.pass_rate(position[question_id])
            for question_id in sub
        )
        per_capability[name] = {
            "n": len(sub),
            "repairs": len(cap_repairs),
            "damages": len(cap_damages),
            "net": round(delta, 3),
            "points": round(100 * delta / len(sub), 2),
            "spread": SPREAD.get(name),
        }

    # The reach proof. Every question the pass does not claim must be asked the byte-identical prompt, so the two
    # artifacts must agree on `promptDigest` for all of them. A digest difference on a `MR` question would mean the
    # pass reached a route it does not claim, which is the defect both earlier passes had to add an audit for.
    reach_diffs = [
        question_id
        for question_id in ids
        if capability_of(treatment, question_id) != TREATED
        and treatment.questions[question_id].get("promptDigest")
        != control.questions[question_id].get("promptDigest")
    ]

    census = treatment.report.get("supersession")
    usage = {
        "treatment": treatment.report.get("llmUsage") or {},
        "control": control.report.get("llmUsage") or {},
    }

    gates = {}
    required = math.ceil(CONVERSION_SHARE * len(stable)) if stable else 0
    gates["K1"] = {
        "passed": bool(stable) and len(converted) >= required and not damages,
        "reading": f"{len(converted)}/{len(stable)} of the control's stable failures converted "
        f"(bar {required}), {len(damages)} regressed on the column",
        "exact_p": round(exact, 6),
        "noise_p": round(noise, 6),
    }
    outside = {
        name: row
        for name, row in per_capability.items()
        if name != TREATED and row["spread"] is not None and abs(row["net"]) > row["spread"]
    }
    # Two gates and not one, because they can fail independently and they mean different things: a capability
    # outside its own spread is a *statistical* movement the pass does not claim, and a changed prompt on a route
    # the pass does not claim is a *structural* one. §13.366 registers them separately for that reason, and a
    # single gate here would have made one of them unreportable.
    gates["K2"] = {
        "passed": not outside,
        "reading": "no other capability outside its own 2 sd"
        if not outside
        else "outside 2 sd: " + ", ".join(sorted(outside)),
    }
    gates["K3"] = {"passed": not reach_diffs, "reading": f"{len(reach_diffs)} non-{TREATED} digest difference(s)"}
    replaced = int((census or {}).get("replaced") or 0)
    refused = int((census or {}).get("refused") or 0)
    gates["K4"] = {
        "passed": replaced > 0 and refused > 0,
        "reading": f"replaced {replaced}, refused {refused}",
        "refusals": (census or {}).get("refusals") or {},
    }
    before_tokens = usage["control"]
    after_tokens = usage["treatment"]
    prompt_ratio = ratio(after_tokens.get("promptTokens"), before_tokens.get("promptTokens"))
    completion_ratio = ratio(after_tokens.get("completionTokens"), before_tokens.get("completionTokens"))
    gates["K5"] = {
        "passed": prompt_ratio <= 0.15 and completion_ratio <= 0.25,
        "reading": f"prompt {prompt_ratio:+.1%}, completion {completion_ratio:+.1%}",
    }

    return {
        "questions": len(ids),
        "targets": targets,
        "continuity": continuity,
        "population": {
            "capability": TREATED,
            "n": len(population),
            "repairs": len(repairs),
            "damages": len(damages),
            "exact_p": round(exact, 6),
            "noise_p": round(noise, 6),
        },
        "per_capability": per_capability,
        "digest_differences": reach_diffs,
        "census": census,
        "usage": usage,
        "gates": gates,
    }


def ratio(after: Any, before: Any) -> float:
    """A relative change, and `inf` rather than a silent zero when the denominator is missing."""
    if not isinstance(before, (int, float)) or before <= 0:
        return math.inf
    if not isinstance(after, (int, float)):
        return math.inf
    return (after - before) / before


def report(result: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append(f"# the supersession arm, against its control ({result['questions']} questions)")
    lines.append("")
    lines.append("## the control's stable failures (the gate's population)")
    lines.append("")
    lines.append("| question | state | control | treatment |")
    lines.append("| --- | --- | ---: | ---: |")
    for row in result["targets"]:
        lines.append(f"| `{row['id']}` | {row['state']} | {row['before']:.2f} | {row['after']:.2f} |")
    lines.append("")
    lines.append("## the six §3 named, for continuity")
    lines.append("")
    lines.append("| question | control | treatment | |")
    lines.append("| --- | ---: | ---: | --- |")
    for row in result["continuity"]:
        if row["control"] is None:
            lines.append(f"| `{row['id']}` | — | — | absent from the artifact |")
            continue
        note = "already passing in this control" if row["control"] == 1.0 else ""
        lines.append(
            f"| `{row['id']}` | {row['control']:.2f} | {row['treatment']:.2f} | {note} |"
        )
    lines.append("")
    population = result["population"]
    lines.append(
        f"`{population['capability']}` column: **{population['repairs']} repairs / "
        f"{population['damages']} damages** on {population['n']} questions — exact `p = "
        f"{population['exact_p']}` against the flip floor's `p = {population['noise_p']}`"
    )
    lines.append("")
    lines.append("## every capability")
    lines.append("")
    lines.append("| capability | n | repairs | damages | net | points | own 2 sd |")
    lines.append("| --- | ---: | ---: | ---: | ---: | ---: | ---: |")
    for name, row in result["per_capability"].items():
        spread = "—" if row["spread"] is None else f"{row['spread']:.2f}"
        lines.append(
            f"| `{name}` | {row['n']} | {row['repairs']} | {row['damages']} | {row['net']:+.2f} | "
            f"{row['points']:+.2f} | {spread} |"
        )
    lines.append("")
    lines.append("## the gates")
    lines.append("")
    lines.append("| # | verdict | reading |")
    lines.append("| --- | --- | --- |")
    for name, gate in result["gates"].items():
        verdict = "**holds**" if gate["passed"] else "**fails**"
        lines.append(f"| `{name}` | {verdict} | {gate['reading']} |")
    refusals = result["gates"]["K4"].get("refusals") or {}
    if refusals:
        lines.append("")
        lines.append(
            "refusals: " + ", ".join(f"`{name}` {count}" for name, count in sorted(refusals.items()) if count)
        )
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--treatment", required=True, type=Path)
    parser.add_argument("--control", required=True, type=Path)
    parser.add_argument("--json", action="store_true", help="emit the reading as JSON")
    arguments = parser.parse_args(argv)
    result = read(arguments.treatment, arguments.control)
    if arguments.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(report(result))
    return 0 if all(gate["passed"] for gate in result["gates"].values()) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
