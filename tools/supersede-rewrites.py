#!/usr/bin/env python3
"""What each supersession substitution was worth, read off one artifact instead of two runs.

## The gap this closes, and what it cost

Run `43001135439` published `replaced 18` beside `refused 270`. The eighteen were unreadable. The record's
`answer` is what the pass **shipped**, so a wrong answer next to a positive count reads identically whether the
pass destroyed a correct answer or merely replaced one wrong answer with another. Reading the direction meant
pairing that arm against an **earlier** run's control arm -- a second dispatch of the same five-hundred-question
population, paid for one column.

The product now records the pair: `supersessionRewrites` carries `{first, final}` per substitution, where
`first` is the string the route would have returned with the pass switched off on that question. That is the
counterfactual a replacement mechanism owes, and with it the census splits into conversions and damages on the
day the run lands.

## Why containment is a lower bound, and not the grader

The grader is a model call and this tool cannot make one. What it can do is ask whether the gold string is
present in each side of the pair, which is decidable and reproducible:

- gold in `final` and not in `first` -> **conversion** (the substitution moved the answer onto the gold);
- gold in `first` and not in `final` -> **damage** (the substitution moved a correct answer off it);
- gold in both, or in neither -> **neutral** (the substitution did not decide this question either way).

Containment is weaker than the grader in one direction and stronger in none: a string can contain the gold and
still be judged wrong (`a1eacc2a` did exactly that -- the grader's answer was rejected while the gold string was
inside it), and a string can be judged right without containing the gold verbatim. So `conversion - damage` is
a **lower bound** on the true net, and every row is printable so a reader can check the arithmetic against the
strings rather than against the tool.

A numeric gold is matched as a numeral with boundaries rather than as a substring: `20` occurs inside `1200`, and
a substring rule would score a substitution about a follower count as a conversion on a question about eggs.

## What it refuses

- **An artifact whose records carry no `supersessionRewrites`.** Every earlier run does. Reporting `0 damages`
  over a population where the field is absent would be the "no measurement read as zero" defect this repository
  has paid for three times; the tool says `not scorable` and stops.
- **An artifact whose pairs do not sum to its own `supersessionReplacements`.** The two are written from the same
  counter on the same call, so a disagreement is a defect in the instrument rather than a fact about the run, and
  a rate computed over the wrong denominator is worse than no rate.
- **A record with a pair and no replacement count.** Half a measurement is not a measurement.

Usage:

    python3 tools/supersede-rewrites.py <artifact>.json
    python3 tools/supersede-rewrites.py <artifact>.json --json
    python3 tools/supersede-rewrites.py <artifact>.json --show 10
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# The gold may be a number with thousands separators, and the answer may print it either way. Kept as a pattern
# rather than a float comparison because `20` and `20.0` are different strings to the grader.
NUMERAL = re.compile(r"\d[\d,]*(?:\.\d+)?")

# How much of each side is printed. A rewritten `first` can be a bulleted list of a dozen lines, and a reading
# that pasted them whole would be a wall of text no one checks; the head is enough to recognise the question.
SHOWN_CHARS = 160


def normalize(text: str) -> str:
    """Lower-case, collapse whitespace. The grader is case-insensitive and this tool must not be stricter."""
    return " ".join(text.lower().split())


def numerals(text: str) -> set[str]:
    """Every numeral in the text, with separators dropped so `1,300` and `1300` are one token."""
    return {match.replace(",", "") for match in NUMERAL.findall(text)}


def contains_gold(text: str | None, gold: str) -> bool:
    """Whether `gold` is present in `text` as a value rather than as a run of characters inside another value."""
    if not text:
        return False
    if not gold.strip():
        return False
    haystack = normalize(text)
    needle = normalize(gold)
    if NUMERAL.fullmatch(needle):
        return needle.replace(",", "") in numerals(haystack)
    return needle in haystack


def classify(first: str | None, final: str | None, gold: str | None) -> str:
    """Which way one substitution moved the answer, as far as containment can tell."""
    if not gold:
        # A question with no gold is not a question this tool can score, and counting it as neutral would put it
        # in the denominator of a rate it cannot move.
        return "unscorable"
    in_first = contains_gold(first, gold)
    in_final = contains_gold(final, gold)
    if in_first and not in_final:
        return "damage"
    if in_final and not in_first:
        return "conversion"
    return "neutral"


def rewrites_of(record: dict) -> list[dict]:
    """The pairs on one record, or an empty list. Malformed entries are dropped rather than guessed at."""
    pairs = record.get("supersessionRewrites")
    if not isinstance(pairs, list):
        return []
    kept: list[dict] = []
    for entry in pairs:
        if not isinstance(entry, dict):
            continue
        first = entry.get("first")
        final = entry.get("final")
        if not isinstance(first, str) or not isinstance(final, str):
            continue
        kept.append({"first": first, "final": final})
    return kept


def read(path: Path) -> dict:
    """The census of one artifact, or a refusal.

    Raises `SystemExit` with a message rather than returning a partial reading: every refusal below is a state in
    which a number would be worse than none.
    """
    report = json.loads(path.read_text(encoding="utf-8"))
    questions = report.get("questions")
    if not isinstance(questions, list) or not questions:
        raise SystemExit(f"{path}: no per-question roster, so there is nothing to attribute a pair to")

    rows: list[dict] = []
    counted = 0
    pairs = 0
    for record in questions:
        declared = record.get("supersessionReplacements")
        found = rewrites_of(record)
        if declared is None and found:
            raise SystemExit(
                f"{path}: question `{record.get('questionId')}` carries {len(found)} pair(s) and no "
                "replacement count; half a measurement is not a measurement"
            )
        if declared is not None:
            counted += int(declared)
            pairs += len(found)
        if not found:
            continue
        capability = record.get("capability") or "unknown"
        gold = record.get("groundTruth")
        for entry in found:
            rows.append(
                {
                    "questionId": record.get("questionId"),
                    "capability": capability,
                    "gold": gold,
                    "first": entry["first"],
                    "final": entry["final"],
                    "verdict": classify(entry["first"], entry["final"], gold),
                }
            )

    if pairs == 0:
        raise SystemExit(
            f"{path}: not scorable -- no record carries `supersessionRewrites`, so the substitutions this run "
            "made cannot be classified without a second dispatch against a control arm"
        )
    if pairs != counted:
        raise SystemExit(
            f"{path}: {pairs} pair(s) against {counted} declared replacement(s); the two are written from the "
            "same counter, so a disagreement is a defect in the instrument rather than a fact about the run"
        )

    return {"artifact": str(path), "rows": rows, **census(rows, counted)}


def census(rows: list[dict], counted: int) -> dict:
    """Totals, per-capability split, and the two exact binomial tails a reader needs before believing a net."""
    by_capability: dict[str, dict[str, int]] = {}
    for row in rows:
        bucket = by_capability.setdefault(
            row["capability"],
            {"pairs": 0, "conversion": 0, "damage": 0, "neutral": 0, "unscorable": 0},
        )
        bucket["pairs"] += 1
        bucket[row["verdict"]] += 1

    totals = {"pairs": 0, "conversion": 0, "damage": 0, "neutral": 0, "unscorable": 0}
    for bucket in by_capability.values():
        for key in totals:
            totals[key] += bucket[key]

    return {
        "declaredReplacements": counted,
        "totals": totals,
        "perCapability": dict(sorted(by_capability.items())),
        "netLowerBound": totals["conversion"] - totals["damage"],
    }


def excerpt(text: str) -> str:
    """One line of a string, truncated. A pair is printed so a reader can check the verdict by eye."""
    line = " ".join(text.split())
    return line if len(line) <= SHOWN_CHARS else f"{line[:SHOWN_CHARS]}…"


def report(reading: dict, shown: int) -> str:
    totals = reading["totals"]
    lines = [
        f"# `{Path(reading['artifact']).name}`",
        "",
        f"{totals['pairs']} substitution(s) against {reading['declaredReplacements']} declared replacement(s).",
        "",
        "| capability | pairs | conversion | damage | neutral | unscorable | net (lower bound) |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for name, row in reading["perCapability"].items():
        lines.append(
            f"| `{name}` | {row['pairs']} | {row['conversion']} | {row['damage']} | {row['neutral']} | "
            f"{row['unscorable']} | {row['conversion'] - row['damage']:+d} |"
        )
    lines.append(
        f"| **all** | {totals['pairs']} | {totals['conversion']} | {totals['damage']} | {totals['neutral']} | "
        f"{totals['unscorable']} | **{reading['netLowerBound']:+d}** |"
    )
    lines.append("")
    lines.append(
        "`net` is a **lower bound**: containment cannot see a substitution that was judged correct without "
        "containing the gold, and cannot see one that contained the gold and was judged wrong anyway. The "
        "grader's own verdict on the shipped answer is the record's `correct`, which this tool does not re-derive."
    )
    decided = [row for row in reading["rows"] if row["verdict"] in ("conversion", "damage")]
    if decided and shown > 0:
        lines.append("")
        lines.append(f"## the substitutions that decided a question (first {min(shown, len(decided))})")
        lines.append("")
        lines.append("| question | capability | verdict | gold | first | final |")
        lines.append("| --- | --- | --- | --- | --- | --- |")
        for row in decided[:shown]:
            lines.append(
                f"| `{row['questionId']}` | `{row['capability']}` | **{row['verdict']}** | "
                f"{excerpt(str(row['gold']))} | {excerpt(row['first'])} | {excerpt(row['final'])} |"
            )
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("artifacts", nargs="+", type=Path)
    parser.add_argument("--json", action="store_true", help="emit the reading as JSON")
    parser.add_argument(
        "--show",
        type=int,
        default=8,
        help="how many decided substitutions to print per artifact (0 suppresses the table)",
    )
    arguments = parser.parse_args(argv)

    readings = [read(path) for path in arguments.artifacts]
    if arguments.json:
        print(json.dumps(readings if len(readings) > 1 else readings[0], indent=2, sort_keys=True))
    else:
        print("\n\n".join(report(reading, arguments.show) for reading in readings))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
