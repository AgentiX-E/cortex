#!/usr/bin/env python3
"""Split wrong numeric answers by the arithmetic needed, not the evidence lacked.

    python3 tools/mr-arithmetic-census.py <report.json> [--capability MR] [--json]

## Why this census had to exist before another mechanism experiment

`MR` is the capability the registration is furthest behind on, and three separate plans have been
written against three different explanations of it. §47 read the gap as `[thing N]` (a per-item
identity the reader can count without double-counting). The `enumerated` ask reads it as a listing
contract. `evidence-completeness.py` reads it as a window problem. All three are plausible, and the
artifacts could not tell them apart, so every dispatch tested whichever one the last plan happened
to name.

The artifact does carry the distinguisher: `goldOverlap.carried == goldOverlap.total` says the gold
evidence was in the delivered block. A question that answered wrong with `carried == total` did not
fail at retrieval — whatever it failed at happened after the reader had the evidence. That is the
first split this tool prints, and it is the one that decides which of the three plans can be right.

## The second split, and why the arithmetic is reported as a range and not a verdict

Among the failures whose evidence was complete, the next question is what the answer *was*. A count
that came out too high and one that came out too low are different defects: the first is what an
item identity fixes, the second is what a listing contract fixes. The tool reports `over`, `under`,
`refuse` and their counts, and **does not** claim a mechanism per bucket — the same wrong number can
be produced by a reader that lost an item and by a reader that counted one twice.

## The trap this tool refuses to fall into

The tempting next step is subset-sum: find a set of numbers in the evidence that adds up to the gold
and call it proof that the answer was one addition away. On these artifacts that test is
meaningless.
A delivered block carries eleven to nineteen distinct numbers, so a subset summing to almost any
target under a few thousand exists by combinatorics alone — a first draft of this analysis found
`4 = 1 + 3` for a question about how many times the user baked, which proves nothing about baking.

So the only arithmetic evidence this tool reports is the **strict** one: whether `|answer - gold|`
appears **verbatim** as a single number in the delivered evidence. That is a much weaker test and it
is the strongest one available, because a difference that is present as one line is a line the
reader saw and skipped, while a difference that had to be summed is a difference the analysis
invented. The
tool prints the difference so a small one can be discounted by eye: a difference of 1 is "present in
the evidence" for essentially every record, and it is reported as such rather than filtered, because
filtering it would hide how much of the count it contributes.

## What it cannot do

It cannot say which line was missed. `goldTurns` carries the delivered text, not the per-turn
delivered flag, so "the reader saw 542 and dropped it" and "the reader never had 542 in front of it"
are the same string on the record. It also cannot separate a wrong count from a right count of the
wrong unit -- `2ce6a0f2` asks for art events and the gold is 4, which is only 4 if a lecture and a
volunteer shift count and a class does not.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from fractions import Fraction
from pathlib import Path

NUMBER = re.compile(r"-?\d[\d,]*(?:\.\d+)?")

#: A gold has to *start* with its number. `5 days. 6 days (including the last day) is also
#: acceptable.` qualifies; `I viewed four properties ... the 1-bedroom condo` does not, and
#: without this test the
#: `1` inside "1-bedroom" is read as the gold of a question whose answer is a list of four
#: properties.
GOLD_OPENS_WITH_NUMBER = re.compile(r"\s*\$?\s*-?\d")


def as_fraction(text: object) -> Fraction | None:
    """The first number in a string, as an exact fraction. `None` when there is none.

    `Fraction` rather than `float`: the golds include `0.5` and sums like `1,998`, and a float
    comparison on a difference of one in ten thousand would report a hit that is not there.
    """
    if text is None:
        return None
    match = NUMBER.search(str(text).replace(",", ""))
    if match is None:
        return None
    try:
        return Fraction(match.group(0))
    except (ValueError, ZeroDivisionError):
        return None


def evidence_numbers(record: dict) -> set[Fraction]:
    """Every number the delivered block carried, as a set.

    A set rather than a multiset on purpose: the question this feeds is "was this figure in front of
    the reader", and a figure printed twice was still in front of the reader.
    """
    turns = (record.get("goldOverlap") or {}).get("goldTurns") or []
    found: set[Fraction] = set()
    for turn in turns:
        for match in NUMBER.finditer(str(turn).replace(",", "")):
            try:
                found.add(Fraction(match.group(0)))
            except (ValueError, ZeroDivisionError):
                continue
    return found


def classify(record: dict) -> dict | None:
    """One row for one numeric-gold question, or `None` when the record is not one.

    Records whose gold does not *open* with a number are excluded rather than coerced.
    `gpt4_7fce9456` is the case: its gold is four sentences about four properties, and one of them
    says "the 1-bedroom condo" -- so a naive `as_fraction` reads the gold as `1` and reports a
    5-versus-1 over-count that is arithmetic about a hyphenated adjective. `5 days. 6 days
    (including the last day) is also
    acceptable.` still qualifies, because its gold *does* open with its number.
    """
    raw_gold = record.get("groundTruth")
    if raw_gold is None or GOLD_OPENS_WITH_NUMBER.match(str(raw_gold)) is None:
        return None
    gold = as_fraction(raw_gold)
    if gold is None:
        return None
    answer = as_fraction(record.get("answer"))
    if record.get("correct"):
        kind = "correct"
    elif answer is None:
        kind = "refuse"
    elif answer > gold:
        kind = "over"
    elif answer < gold:
        kind = "under"
    else:
        kind = "equal-unscored"

    overlap = record.get("goldOverlap") or {}
    carried, total = overlap.get("carried"), overlap.get("total")
    complete = carried is not None and total is not None and carried == total

    difference = None if answer is None else abs(answer - gold)
    delta_present = difference is not None and difference in evidence_numbers(record)

    return {
        "questionId": record.get("questionId"),
        "kind": kind,
        "gold": str(gold),
        "answer": None if answer is None else str(answer),
        "difference": None if difference is None else str(difference),
        "evidenceComplete": complete,
        "carried": carried,
        "total": total,
        "deltaInEvidence": delta_present,
        "goldInEvidence": gold in evidence_numbers(record),
    }


def census(records: list[dict], capability: str | None) -> dict:
    rows = []
    for record in records:
        if capability is not None and record.get("capability") != capability:
            continue
        row = classify(record)
        if row is not None:
            rows.append(row)

    wrong = [row for row in rows if row["kind"] not in ("correct",)]
    by_kind: dict[str, list[dict]] = {}
    for row in wrong:
        by_kind.setdefault(row["kind"], []).append(row)

    return {
        "numericGold": len(rows),
        "wrong": len(wrong),
        "byKind": {kind: len(items) for kind, items in sorted(by_kind.items())},
        "completeEvidence": {
            kind: sum(1 for row in items if row["evidenceComplete"])
            for kind, items in sorted(by_kind.items())
        },
        "deltaInEvidence": {
            kind: sum(1 for row in items if row["deltaInEvidence"])
            for kind, items in sorted(by_kind.items())
        },
        # The share of wrong answers whose gold number was *not* printed anywhere in the block.
        # A high share is the signature of a question that has to be computed rather than copied,
        # and it is
        # the reason "give it more evidence" cannot be the repair.
        "goldComputed": sum(1 for row in wrong if not row["goldInEvidence"]),
        "rows": wrong,
    }


def print_report(result: dict, source: str) -> None:
    print(f"mr-arithmetic-census: {source}")
    detail = (
        " (" + ", ".join(f"{kind} {count}" for kind, count in result["byKind"].items()) + ")"
        if result["byKind"]
        else ""
    )
    print(f"  numeric gold {result['numericGold']}, wrong {result['wrong']}{detail}")
    if result["wrong"] == 0:
        print("  no wrong numeric answers: nothing to classify.")
        return

    print()
    print(f"  {'kind':9s} {'n':>3s} {'evidence complete':>18s} {'delta in evidence':>18s}")
    for kind, count in result["byKind"].items():
        complete = result["completeEvidence"].get(kind, 0)
        delta = result["deltaInEvidence"].get(kind, 0)
        print(f"  {kind:9s} {count:3d} {complete:>18d} {delta:>18d}")

    computed = result["goldComputed"]
    share = computed / result["wrong"] * 100
    print()
    print(
        f"  gold number absent from the delivered block: "
        f"{computed}/{result['wrong']} ({share:.0f}%)."
    )
    if share >= 60:
        print(
            "  Read this as an arithmetic failure, not a retrieval failure: the figure asked\n"
            "  asks for was never printed, so no window and no ranking could have delivered it. A\n"
            "  repair must change what the reader does with the lines, not how many it\n"
            "  gets."
        )
    elif share <= 40:
        print(
            "  Read this as a retrieval-or-selection failure: most golds were printed in\n"
            "  block, so a wider or better-ordered window is a live repair."
        )
    else:
        print(
            "  Mixed. Split before dispatching: an arithmetic repair and a window repair move\n"
            "  questions, and a single arm would average them into a number that names neither."
        )

    strict = sum(result["deltaInEvidence"].values())
    print()
    print(f"  |answer - gold| present verbatim in the block: {strict}/{result['wrong']}.")
    print(
        "  A hit is a line the reader saw and did not fold in. A miss is not the\n"
        "  opposite -- it is the absence of evidence, and subset-sum on a block this size\n"
        "  target."
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("report", type=Path)
    parser.add_argument("--capability", default="MR")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--all-capabilities", action="store_true")
    options = parser.parse_args(argv)

    document = json.loads(options.report.read_text(encoding="utf-8"))
    records = document.get("questions") or []
    if not records:
        print(
            f"{options.report}: no `questions` array; is this an ablation report?", file=sys.stderr
        )
        return 2

    capability = None if options.all_capabilities else options.capability
    result = census(records, capability)

    if options.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print_report(result, str(options.report))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
