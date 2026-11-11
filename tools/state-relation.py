#!/usr/bin/env python3
"""Which state of the attribute an answer settled on: current, older, or newer than the gold.

## The question this answers

`KU` is the capability every mechanism in this repository has been aimed at, and the scoreboard has only ever
said *wrong*. `43001135439` reports nine wrong `KU` answers out of seventy-two, and nine is not a diagnosis:

- an answer that repeats the value the corpus **had already replaced** is a reader that did not notice the
  update, and a mechanism that annotates the two statements in one place can fix it;
- an answer that takes the value stated **after** the gold is a reader that applied "newest wins" where the
  question asked about a qualifier -- "the earlier trip", "the first three months" -- and the same annotation
  makes it **worse**, because it says the old value was replaced;
- an answer whose value the window never stated is a delivery failure, and no read-time annotation reaches it.

Those are three different bugs with three different fixes, and the artifact already carries everything needed to
separate them: `turns` is the delivery with its `[YYYY/MM/DD (Ddd) HH:MM]` prefixes, `groundTruth` is the
dataset's own statement of the current value, `answer` is what was shipped. No provider call, no dispatch.

## The closed pool, and why it is closed

StateMemBench (arXiv 2608.19652) scores each answer into **current state / superseded state / neither** before
any model judges it, which is what makes its numbers comparable across systems. This tool builds the same pool
from the artifact instead of from a generator:

```text
current  = the gold value, as the dataset states it
pool     = every other value the delivery states, ordered by the timestamp on its turn
```

A value is then placed by the only ordering the artifact has: the timestamp of the turns that state it. The
comparison is against `tGold`, the **latest** statement of the gold value, because a value stated at 07/15 and
again at 09/02 is current from 07/15 and a reader who answers it later is not making an error.

## What "older" and "newer" mean, and what they do not

`older` means the answer's value occurs only in turns **earlier** than the last statement of the gold. It is
evidence of a missed update, not proof: the value could belong to a different attribute that happens to share a
number. Association is bounded by value shape -- a numeral, a `h:mm am/pm` clock time, a `w-l` record, or a
number word -- and **not** by subject, because deciding whether two sentences are about the same attribute is
the judgement this repository refuses to make without a source.

So the tool reports a **distribution with its ambiguity named**, not a verdict per row:

- `overlap` -- the answer's value is stated both before and after the gold's last statement.
- `mixed` -- the answer states values on both sides.
- `only-in-answer` -- the answer's value is in no delivered turn, so it was derived, hallucinated, or counted.
- `gold-not-in-window` -- the delivery never stated the gold's value, so the pool has no current and nothing can
  be called superseded. `69fee5aa` is this shape: 37 is delivered, 38 never is.

## Two guards that a reading depends on, and one that it does not

The gold is located **only in a turn that also names the question's attribute**, so an unrelated `20` cannot
date the current state of a ledger. On `42533236864` this condition changes **no row**: all 51 numbered `KU`
records classify identically with it disabled. It is kept as a guard against a shape this corpus does not
contain, and it is pinned by a test that fails if it is removed -- but no number below depends on it, and a
reader should not credit it with any of the distribution.

The two guards the reading does depend on are both removals rather than conditions, and both were found by
reading a wrong row by hand:

- **Citations.** Answers cite their evidence as `[2023/04/30]`, and a raw numeral pass reads that as the value
  `2023` beside `4` and `30`. Before this rule, seventeen correct answers read `both`.
- **Numbered lists.** An assistant turn that answers with a list puts `5.` at the start of its fifth item.
  Before this rule `f9e8c073`'s current state was dated to a turn about art events, and the question read
  `overlap` instead of undelivered.

## The validity check, and why the tool refuses without it

A classifier that puts wrong answers in tidy buckets is worth nothing if it also puts **correct** answers there.
The positive control is internal and exact: a correct `KU` answer whose gold is numeric must read `current`,
because the string that was graded correct contains the gold. Twenty `KU` golds are not numeric at all (`Paris`,
`Yes.`, `in a shoe rack in my closet`) and are counted as `unnumbered` rather than forced into a bucket.

If fewer than `MIN_GOLD_FOUND_SHARE` of the numbered correct answers **state the gold**, the classifier is the
subject of the measurement rather than the run, and the tool refuses with that number in the message. On
`42533236864` and on `43001135439` alike it reads 40 of 43 -- 93.0% -- and the three exceptions are each
explainable: a gold the window never carried, a phrase gold read as numerals, and `a1eacc2a`, the leniency
artefact `MEASURE-SUPERSEDE.md` 12.2 already records.

## Usage

    python3 tools/state-relation.py <artifact>.json
    python3 tools/state-relation.py <artifact>.json --capability all
    python3 tools/state-relation.py <artifact>.json --audit
    python3 tools/state-relation.py <artifact>.json --json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Every delivered turn opens with `[2023/05/11 (Thu) 02:24] `, and that prefix is the only ordering the artifact
# holds. Packed into one integer rather than compared as a tuple so `max` over a list of them is one call.
STAMP = re.compile(r"^\[(\d{4})/(\d{2})/(\d{2})\s*\(\w{3}\)\s*(\d{2}):(\d{2})\]")

# A clock time, which must not also be read as its two numerals: `6:00 pm` is one value and `6`/`00` are not.
TIME = re.compile(r"\b(\d{1,2}):(\d{2})\s*(am|pm)\b")
# A win-loss record, for the same reason: `5-2` is one value, and `5` and `2` separately would collide with
# every other pair of numbers in the window.
RECORD = re.compile(r"\b(\d{1,2})-(\d{1,2})\b")
# A calendar date, removed before anything else is read. Answers in this corpus cite their evidence as
# `[2023/04/30]`, and a raw numeral pass reads that as the value `2023` beside `4` and `30` -- which is how the
# first version of this tool put seventeen correct answers in `both` on the strength of a citation.
DATE = re.compile(r"\b\d{4}/\d{1,2}/\d{1,2}\b")
# A numbered-list marker, removed for the same reason a date is: an assistant turn that answers with a list puts
# `5.` at the start of its fifth item, and the first version of this tool read that as the value five -- which was
# enough to date the current state of `f9e8c073` to a turn about art events.
LIST_MARKER = re.compile(r"(?<![\d\w])\d{1,2}[.)](?=\s)")
# A numeral at a boundary. The lookbehind and lookahead keep it out of fractions and date remainders, and `\b`
# keeps `20` from matching inside `1200` -- the substring error `supersede-rewrites.py` documents.
NUMERAL = re.compile(r"(?<![\d/:])\b\d[\d,]*(?:\.\d+)?\b(?![\d/:])")

# Golds in this corpus are written as words as often as digits -- `five`, `seven`, `Three times a week.` -- and a
# reader that answers `5` has stated the gold. One direction only: a digit never becomes a word.
WORD_NUMBERS = {
    word: str(index)
    for index, word in enumerate(
        "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
        "fifteen sixteen seventeen eighteen nineteen twenty".split()
    )
}

# Words a question uses to name its attribute. Kept short and lower-cased; a question word of fewer letters
# names nothing specific enough to locate a statement with.
STOP_WORDS = frozenset(
    "what how many much does did the and for with from that this these those have has had was were are you "
    "your our their about time currently current first last previous past total".split()
)


def attribute_words(text: str) -> set[str]:
    """The content words a question or a turn uses, lower-cased and stripped of the corpus's question filler."""
    return {word for word in re.findall(r"[a-z]{4,}", text.lower()) if word not in STOP_WORDS}


# The share of numbered correct answers the classifier must read as `current` before any distribution is
# reported. Not 100%: `12.2`'s leniency artefact and a gold the window never carried are both real states, and
# a threshold at 100% would refuse every artifact that contains one.
MIN_GOLD_FOUND_SHARE = 0.90

RELATIONS = (
    "current",
    "both",
    "older",
    "newer",
    "overlap",
    "mixed",
    "only-in-answer",
    "gold-not-in-window",
    "unnumbered",
)


def stamp_of(text: str) -> int | None:
    """The turn's timestamp as one sortable integer, or `None` when it has no prefix."""
    match = STAMP.match(text)
    if match is None:
        return None
    year, month, day, hour, minute = (int(part) for part in match.groups())
    return year * 10**8 + month * 10**6 + day * 10**4 + hour * 100 + minute


def values_of(text: str) -> set[str]:
    """Every canonical value in the text, in three families that cannot collide with each other."""
    lowered = LIST_MARKER.sub(" ", DATE.sub(" ", text.lower()))
    found: set[str] = set()
    for hour, minute, meridiem in TIME.findall(lowered):
        found.add(f"T{int(hour)}:{minute}{meridiem}")
    without_times = TIME.sub(" ", lowered)
    for left, right in RECORD.findall(without_times):
        found.add(f"R{left}-{right}")
    without_records = RECORD.sub(" ", without_times)
    for numeral in NUMERAL.findall(without_records):
        found.add("N" + numeral.replace(",", ""))
    for word, digit in WORD_NUMBERS.items():
        if re.search(rf"\b{word}\b", lowered):
            found.add("N" + digit)
    return found


def turn_text(turn: object) -> str | None:
    """The text of one delivered turn, whether the artifact stored an object or a bare string."""
    if isinstance(turn, str):
        return turn
    if isinstance(turn, dict):
        text = turn.get("text")
        return text if isinstance(text, str) else None
    return None


def relation_of(record: dict) -> dict:
    """The relation of one answer to the pool its delivery states."""
    gold = record.get("groundTruth")
    answer = record.get("answer")
    gold_values = values_of(str(gold)) if gold is not None else set()
    answer_values = values_of(str(answer)) if answer is not None else set()

    delivered: list[tuple[int, str]] = []
    undated = 0
    for turn in record.get("turns") or []:
        text = turn_text(turn)
        if text is None:
            continue
        stamp = stamp_of(text)
        if stamp is None:
            undated += 1
            continue
        delivered.append((stamp, text))

    base = {
        "questionId": record.get("questionId"),
        "capability": record.get("capability") or "unknown",
        "correct": bool(record.get("correct")),
        "gold": gold,
        "answer": answer,
        "goldValues": sorted(gold_values),
        "answerValues": sorted(answer_values),
        # The positive control, decided before any bucket: does the answer state the gold's value at all. A
        # correct answer that hedges between the old and the new value states it, and that is `both` rather than
        # a miss -- so the control reads this flag and not the relation.
        "goldFound": bool(gold_values) and gold_values <= answer_values,
        "spans": {},
        "undatedTurns": undated,
    }

    if not gold_values:
        # A phrase or a bare `Yes.`: the pool has no current this instrument can name, so the record leaves the
        # denominator instead of being forced into `neither`.
        return {**base, "relation": "unnumbered"}

    attribute = attribute_words(str(record.get("question") or ""))
    spans: dict[str, list[int]] = {}
    aligned: dict[str, list[int]] = {}
    for stamp, text in delivered:
        stated = values_of(text)
        shares_attribute = bool(attribute & attribute_words(text))
        for value in stated:
            spans.setdefault(value, []).append(stamp)
            if shares_attribute:
                aligned.setdefault(value, []).append(stamp)
    base["spans"] = {
        value: [min(spans[value]), max(spans[value])]
        for value in sorted(spans)
        if value in gold_values or value in answer_values
    }
    base["aligned"] = {
        value: [min(aligned[value]), max(aligned[value])]
        for value in sorted(aligned)
        if value in gold_values or value in answer_values
    }

    if base["goldFound"]:
        # The gold is in the answer. Another pool value beside it is a hedge, not a missed update, and the two
        # are separated because only the first is a mechanism's fault.
        extras = {value for value in answer_values - gold_values if value in spans}
        return {**base, "relation": "both" if extras else "current"}

    # The gold is located in a turn that also names the question's attribute. Without that condition a common
    # gold -- `5`, `20`, `7` -- is "located" by any turn that happens to contain the numeral, and the latest such
    # turn then dates the current state wrongly. `f9e8c073` is the case that forced this: its gold is `five` and
    # the window never states it, but an unrelated `5` on 07/15 was enough to make the answer look superseded.
    located = {value: aligned.get(value) or [] for value in gold_values}
    missing = sorted(value for value, stamps in located.items() if not stamps)
    if missing:
        return {**base, "relation": "gold-not-in-window", "missingGold": missing}

    latest_gold = max(max(located[value]) for value in gold_values)
    buckets: set[str] = set()
    placed: dict[str, str] = {}
    for value in sorted(answer_values - gold_values):
        if value not in spans:
            continue
        # Placement reads every occurrence, aligned or not: the question is when the deliverable window stated
        # this value, and a turn that does not repeat the attribute word is still evidence the reader could see.
        earliest, latest = min(spans[value]), max(spans[value])
        if latest < latest_gold:
            buckets.add("older")
            placed[value] = "older"
        elif earliest > latest_gold:
            buckets.add("newer")
            placed[value] = "newer"
        else:
            buckets.add("overlap")
            placed[value] = "overlap"

    base["placed"] = placed
    base["latestGold"] = latest_gold
    if not buckets:
        return {**base, "relation": "only-in-answer"}
    if len(buckets) == 1:
        return {**base, "relation": buckets.pop()}
    return {**base, "relation": "mixed"}


def tally(rows: list[dict]) -> dict:
    """Counts by relation, split by whether the answer was graded correct.

    The split is the point: a distribution over wrong answers alone cannot be told apart from a classifier that
    is describing the corpus rather than the run.
    """
    def bucket(selection: list[dict]) -> dict:
        counts = {relation: 0 for relation in RELATIONS}
        for row in selection:
            counts[row["relation"]] += 1
        return counts

    numbered = [row for row in rows if row["relation"] != "unnumbered"]
    correct_numbered = [row for row in numbered if row["correct"]]
    return {
        "rows": len(rows),
        "numbered": len(numbered),
        "unnumbered": len(rows) - len(numbered),
        "all": bucket(rows),
        "correct": bucket([row for row in rows if row["correct"]]),
        "wrong": bucket([row for row in rows if not row["correct"]]),
        "correctNumbered": len(correct_numbered),
        # The control counts `goldFound`, not `relation == "current"`: a hedged answer that states the gold
        # beside the old value is `both`, and counting it as a control failure would make every verbose answer
        # look like an instrument defect.
        "correctGoldFound": sum(1 for row in correct_numbered if row["goldFound"]),
    }


def census(rows: list[dict]) -> dict:
    """The tally, its per-capability split, and the validity check that decides whether it may be read."""
    capabilities = sorted({row["capability"] for row in rows})
    overall = tally(rows)
    share = (
        overall["correctGoldFound"] / overall["correctNumbered"] if overall["correctNumbered"] else None
    )
    return {
        "totals": overall,
        "perCapability": {
            capability: tally([row for row in rows if row["capability"] == capability])
            for capability in capabilities
        },
        "goldFoundShareOnCorrect": share,
    }


def read(path: Path, capability: str | None) -> dict:
    """The census of one artifact, or a refusal.

    Every refusal below is a state in which a distribution would describe the tool rather than the run.
    """
    report = json.loads(path.read_text(encoding="utf-8"))
    questions = report.get("questions")
    if not isinstance(questions, list) or not questions:
        raise SystemExit(f"{path}: no per-question roster, so there is no answer to place in a pool")

    selected = [
        record
        for record in questions
        if capability is None or record.get("capability") == capability
    ]
    if not selected:
        raise SystemExit(f"{path}: no record has capability `{capability}`")

    rows = [relation_of(record) for record in selected]
    if not any(row["spans"] for row in rows):
        raise SystemExit(
            f"{path}: no delivered turn carries a `[YYYY/MM/DD (Ddd) HH:MM]` prefix, so the pool cannot be "
            "ordered and no value can be called older or newer than another"
        )

    measured = census(rows)
    share = measured["goldFoundShareOnCorrect"]
    if share is None:
        raise SystemExit(
            f"{path}: no numbered correct answer in the population, so the classifier has no positive control "
            "and its distribution cannot be validated"
        )
    if share < MIN_GOLD_FOUND_SHARE:
        raise SystemExit(
            f"{path}: the classifier finds the gold in only {share:.1%} of numbered correct answers "
            f"(floor {MIN_GOLD_FOUND_SHARE:.0%}). A graded-correct answer states the gold by definition, so this "
            "is a defect in the instrument, and any split of the wrong answers would be a fact about it"
        )

    return {"artifact": str(path), "capability": capability, "rows": rows, **measured}


def headline(reading: dict) -> str:
    """The three lines a reader needs before the table: population, control, distribution."""
    totals = reading["totals"]
    share = reading["goldFoundShareOnCorrect"]
    return (
        f"population: {totals['rows']} record(s), {totals['numbered']} numbered, "
        f"{totals['unnumbered']} unnumbered (phrase-valued gold)\n"
        f"control   : {totals['correctGoldFound']}/{totals['correctNumbered']} numbered correct answers state "
        f"the gold ({share:.1%}, floor {MIN_GOLD_FOUND_SHARE:.0%})\n"
        f"wrong     : {_only_counts(totals['wrong'])}\n"
        f"correct   : {_only_counts(totals['correct'])}\n"
    )


def _only_counts(counts: dict) -> str:
    return ", ".join(f"{name} {count}" for name, count in counts.items() if count) or "nothing"


def audit_table(reading: dict, limit: int) -> str:
    """One line per wrong record, with the two timestamps the classification rests on."""
    lines: list[str] = []
    shown = 0
    for row in reading["rows"]:
        if row["correct"]:
            continue
        if shown >= limit:
            break
        shown += 1
        latest = row.get("latestGold")
        placed = row.get("placed") or {}
        detail = ", ".join(f"{value}@{bucket}" for value, bucket in placed.items()) or "-"
        lines.append(
            f"  {row['questionId']} {row['relation']:18s} gold={_clip(row['gold'])} "
            f"answer={_clip(row['answer'], 44)} tGold={latest or '-'} placed={detail}"
        )
    return "\n".join(lines) if lines else "  (no wrong record in the population)"


def _clip(value: object, width: int = 28) -> str:
    text = " ".join(str(value).split()) if value is not None else "-"
    return text if len(text) <= width else text[: width - 1] + "…"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("artifacts", nargs="+", type=Path)
    parser.add_argument(
        "--capability",
        default="KU",
        help="capability to measure, or `all` for every record (default: KU)",
    )
    parser.add_argument("--json", action="store_true", help="emit one JSON object per artifact")
    parser.add_argument("--audit", action="store_true", help="print one line per wrong record")
    parser.add_argument("--show", type=int, default=20, help="audit rows to print (default 20)")
    args = parser.parse_args(argv)

    capability = None if args.capability == "all" else args.capability
    for path in args.artifacts:
        reading = read(path, capability)
        if args.json:
            print(json.dumps(reading))
            continue
        print(f"artifact  : {path}")
        print(headline(reading))
        if args.audit:
            print(audit_table(reading, args.show))
    return 0


if __name__ == "__main__":
    sys.exit(main())
