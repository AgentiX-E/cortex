#!/usr/bin/env python3
"""Classify the raw model output behind each abstention in the per-question roster.

## What question this answers

`docs/09-progress-and-delivery-report.md` sections 58, 60 and 61 established a
chain: the abstention census covered one route (58), the per-question roster
arrived and the read was still empty (60), and the model's own words were dying
at `parseAnswer` before any of it was recorded (61). The carrier is now complete
-- `QuestionRecord.rawOutput` holds the text the model produced, captured where
the answer is produced rather than assembled afterwards.

What the carrier does NOT yet say is **what those texts look like**. Section
60.2 stated the three shapes that all collapse to `null`:

    INSUFFICIENT_EVIDENCE                    bare token
    Answer: INSUFFICIENT_EVIDENCE            labelled token
    ...explanation...\\nINSUFFICIENT_EVIDENCE  token after prose

The three call for different repairs. A bare token means the contract asked for
a token and got one. A labelled token means the parser's `stripLabel` is the only
thing standing between a correct answer and a `null`. The third means the model
IS deliberating and the harness is discarding the deliberation -- which would
make the instruction text, not the model, the thing to change.

So the classification is not descriptive. It selects the next intervention.

## Why the classifier reads `parseAnswer`'s own rules rather than guessing

A classifier that re-derived "what counts as a bare token" from its own opinion
would disagree with the parser exactly at the boundary, and the boundary is the
whole question. `parse.ts` was read and its rules are encoded here: the answer is
the LAST non-empty line, an optional `Answer:` label is stripped, and comparison
is case-insensitive. A text whose last line is the token classifies as bare or
labelled regardless of what precedes it -- which is why the third bucket is
detected by "prose BEFORE the token", not by "text contains prose".

## Usage

    python3 tools/classify-raw-outputs.py path/to/benchmark-*.json
    python3 tools/classify-raw-outputs.py --capability MR path/to/report.json
    python3 tools/classify-raw-outputs.py --failures --capability MR path/to/report.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

# The abstention sentinel, case-folded for comparison. Assembled from parts is not
# needed here -- this is a normal identifier with no shell significance.
SENTINEL = 'insufficient_evidence'

LABEL = re.compile(r'^answer\s*:\s*', re.IGNORECASE)


def classify(raw: str | None | object) -> str:
    """One of `bare`, `labelled`, `prose-then-token`, `other`, `absent`, `empty`.

    ## Why the buckets are what they are

    `absent` is separated from `other` on purpose, and it is reached only for an
    explicit `None`. A `null` rawOutput is a real statement -- the model was not
    consulted, which is what a machine-derived abstention looks like. `other`
    means a text WAS captured and does not end in the sentinel at all, which is a
    different finding: the model declined in words the parser does not know.

    Merging them would let a broken capture read as "the model answered
    differently", which is the substitution section 60 was written to prevent.

    `MISSING` is the third state and it is not `absent`. `QuestionRecord` declares
    `rawOutput?: string | null`, and `undefined` means nobody captured anything for
    that question while `null` means the model was not consulted. The record
    documents that distinction one field up for `answer`, and a classifier that
    collapsed it would describe a recording gap as reader behaviour -- the exact
    error section 61 was written to remove.
    """
    if raw is MISSING:
        return 'not-captured'
    if raw is None:
        return 'not-consulted'
    if not isinstance(raw, str):
        return 'not-a-string'
    lines = [line.strip() for line in raw.split('\n') if line.strip()]
    if not lines:
        return 'empty'
    # The LAST non-empty line, which is what `parseAnswer` reads. A classifier
    # that read the first would classify a deliberating model as a bare
    # responder, and that is the specific error this bucket exists to avoid.
    last = lines[-1]
    stripped = LABEL.sub('', last)
    if stripped.casefold() != SENTINEL:
        return 'other'
    if len(lines) == 1:
        return 'bare' if stripped == last else 'labelled'
    # More than one non-empty line, and the last one is the sentinel: the model
    # wrote prose and then the token. Whether the label is present on that last
    # line is a secondary distinction, and it is kept because the repair differs
    # (stripLabel vs. instruction text).
    return 'prose-labelled' if stripped != last else 'prose-then-token'


# The sentinel for "the key is absent", which is neither `None` nor a string.
#
# A module-level singleton rather than a keyword argument, because the call sites
# need to distinguish three states and a default cannot be one of them. `dict.get`
# with a two-argument form cannot express this at all: it maps both a missing key
# and a JSON `null` to the same default, which is how a recording gap becomes a
# reader behaviour in the first place.
MISSING = object()


# --------------------------------------------------------------------------
# The failure taxonomy of a non-correct answer
# --------------------------------------------------------------------------
#
# ## Why this exists as code
#
# `numeric_mismatch` was published in `docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md`
# twice -- as the largest row of §13.26.4's taxonomy, and as the subject of §13.34.5's
# second registered prediction ("41 of 47 -> <= 25") -- and appeared in no file of
# this repository. The number behind the prediction came from a script that was run
# once and not committed, so the prediction could not be re-derived by its reader.
# A registered prediction whose input is not a thing the instrument produces is the
# defect class this campaign keeps meeting, one layer down from the code.
#
# ## The definitions, and how they were obtained
#
# They were **recovered by calibrating against the two archived rosters**, not
# chosen. `tools/__tests__/fixtures/mr-roster-38595325261.json` and
# `.../mr-roster-38828538851.json` hold the MR questions of the two runs whose
# tables are published, and the tests require these rules to reproduce the
# detailed table (24/4/2/31/2/7) exactly.
#
# `numeric_mismatch` compares the **first** number on each side. That choice is
# made by the calibration rather than by argument: of the seven readings of "the
# numbers disagree" that were tried -- multisets differ, no common number, the
# answer's numbers not a subset of the gold's, the last numbers differ, and so on
# -- five give 32 for the detailed table's row and only this one gives 31. The
# semantic story offered for it (a counting question leads with the quantity it
# asks for, on both sides) is a plausibility, not the evidence.
#
# ## The two published readings, and they are not the same rule
#
# Run 38828538851 was published as `wrong 47, of which 41 are numeric`. Under the
# precedence below that roster is **39**, and the 41 is the same roster with
# `plan_output` folded into `numeric_mismatch` -- two records answered a counting
# question with `Let me gather all mentions ... **Session 6**`, whose gold and
# whose prose both carry numbers. Both numbers are correct answers to different
# questions, and the document named only one of them. The report prints both,
# labelled, so the prediction can be read against the definition it was written
# against while the taxonomy stays the one whose rows define the vocabulary.
#
# ## The precedence, and why it is not free
#
# `abstention`, `plan_output`, `soft_refusal`, `numeric_mismatch`, `long_prose`,
# `other`. Two of these orderings are load-bearing and each is pinned by a test:
# a plan output must outrank the numbers in its own body (that is the whole of the
# 41-vs-39 disagreement), and a numeric mismatch must outrank `long_prose` (else
# the two buckets swap by one record and the detailed table matches neither way).

FAILURE_SHAPES = (
    'abstention',
    'plan_output',
    'soft_refusal',
    'numeric_mismatch',
    'long_prose',
    'other',
)

# The abstention shapes `classify` produces. A non-correct answer whose raw output
# ends in the sentinel is an abstention whatever precedes it, so these four names
# collapse here -- and they collapse to a value read off `classify`, so the two
# reports in this file can never disagree about what a bare token is.
ABSTENTION_SHAPES = frozenset({'bare', 'labelled', 'prose-then-token', 'prose-labelled'})

# A number: digits with optional thousands separators and optional decimal part.
# Signs are included because a delta can be the answer. Number WORDS are not
# numbers here, and that is measured rather than careless: the published taxonomy
# put `three` / `2` and `five` / `3` in `other`, so a word-aware rule would move
# three records and stop reproducing the table it is calibrating against.
NUMERIC = re.compile(r'-?\d[\d,]*(?:\.\d+)?')

# A plan output: the model narrated its approach instead of answering. Anchored at
# the start, because "Step 1" three paragraphs in is an answer that explained
# itself, not a plan that never arrived.
PLAN_OUTPUT = re.compile(r'\s*(let me gather|step\s*1)', re.IGNORECASE)

# A refusal in prose. The abstention sentinel is a machine-readable decline; these
# are the same decision written out, and §13.26.4 says why they are counted apart:
# the first is the contract working, the second is the contract being ignored.
SOFT_REFUSAL = re.compile(
    r"don't have (enough|sufficient)"
    r"|do not have (enough|sufficient)"
    r"|not enough information"
    r"|i'm sorry|i am sorry"
    r"|cannot determine|can't determine",
    re.IGNORECASE,
)

# The length at which an answer is reasoning rather than an answer. Measured, not
# chosen: the detailed table's `long_prose` row is 2 at this bound and 1 at 200
# with the opposite precedence, so the bound and the order are pinned together.
LONG_PROSE_CHARS = 200


def numbers_in(text: object) -> list[str]:
    """Every number in `text`, thousands separators removed, in order of appearance."""
    if not isinstance(text, str):
        return []
    return [token.replace(',', '') for token in NUMERIC.findall(text)]


def numeric_mismatch(gold: object, answer: object) -> bool:
    """Both sides carry a number and the first of each differ.

    The definition the detailed published taxonomy was produced under. See the
    block comment above for why "the first" and not "the multiset".
    """
    gold_numbers = numbers_in(gold)
    answer_numbers = numbers_in(answer)
    return bool(gold_numbers) and bool(answer_numbers) and gold_numbers[0] != answer_numbers[0]


def numeric_mismatch_by_multiset(gold: object, answer: object) -> bool:
    """The literal reading of §13.26.4's sentence: "both sides carry a number and they differ".

    Kept because it is the more natural reading of the published wording and one
    record separates it from the rule the table was actually produced with. A
    reader who checks the sentence against the table has to be able to see that
    the two disagree by one, rather than to conclude the table is wrong.
    """
    gold_numbers = numbers_in(gold)
    answer_numbers = numbers_in(answer)
    return bool(gold_numbers) and bool(answer_numbers) and gold_numbers != answer_numbers


def failure_shape(record: dict) -> str:
    """One of `FAILURE_SHAPES` for a non-correct question record.

    `record` is a `QuestionRecord` from a benchmark report: `groundTruth`,
    `answer` and `rawOutput` are the only keys read, and each may be absent. The
    three absent states collapse here rather than being reported separately --
    `classify` is what keeps them apart, and it is consulted first.
    """
    raw = record['rawOutput'] if 'rawOutput' in record else MISSING
    # `classify` owns the sentinel rules; this function must not re-derive them.
    if classify(raw) in ABSTENTION_SHAPES:
        return 'abstention'

    answer = record.get('answer')
    answer_text = answer if isinstance(answer, str) else ''
    gold = record.get('groundTruth')

    if isinstance(raw, str) and PLAN_OUTPUT.match(raw):
        return 'plan_output'
    if SOFT_REFUSAL.search(answer_text) or (isinstance(raw, str) and SOFT_REFUSAL.search(raw)):
        return 'soft_refusal'
    if numeric_mismatch(gold, answer_text):
        return 'numeric_mismatch'
    if len(answer_text) >= LONG_PROSE_CHARS:
        return 'long_prose'
    return 'other'


def failure_census(questions: list[dict]) -> dict[str, int]:
    """`FAILURE_SHAPES` -> count, over the non-correct questions of `questions`.

    Correct questions are not classified. Every shape here is a *way of being
    wrong*, and counting a correct answer's length or its numbers would put it in
    a bucket whose name would then describe the wrong population.
    """
    counts = dict.fromkeys(FAILURE_SHAPES, 0)
    for question in questions:
        if question.get('correct'):
            continue
        counts[failure_shape(question)] += 1
    return counts


def folded_numeric(counts: dict[str, int]) -> int:
    """`numeric_mismatch` with `plan_output` folded in -- §13.34.4's reading.

    Named rather than inlined because it is a second definition of a number the
    document uses one word for, and a reader comparing §13.34.5's prediction
    against this tool needs to know which of the two the prediction used.
    """
    return counts['numeric_mismatch'] + counts['plan_output']



def questions_of(report: dict) -> list[dict]:
    """The per-question roster from a benchmark report, whichever key holds it.

    Two shapes are accepted because two producers write this file: the primary
    benchmark and the cortex-memory arm. Reading only one key would report an
    empty roster for the other producer and look like a capture failure.
    """
    for key in ('questions', 'questionRecords'):
        value = report.get(key)
        if isinstance(value, list):
            return [q for q in value if isinstance(q, dict)]
    return []


def summarise(path: Path, dataset: str | None) -> int:
    report = json.loads(path.read_text(encoding='utf-8'))
    questions = questions_of(report)
    if not questions:
        print(f'{path}: no per-question roster found. Keys: {sorted(report)}', file=sys.stderr)
        return 2

    # `capability`, not `dataset`. The first draft of this tool grouped by a
    # `dataset` key that `QuestionRecord` does not have, and every record would
    # have landed in one `?` bucket while the tool reported success -- a plausible
    # table computed from a field that does not exist. Section 61's own defect
    # class, one layer up in the reading tool.
    selected = [q for q in questions if dataset is None or q.get('capability') == dataset]
    if dataset is not None:
        print(f'capability filter: {dataset}')

    by_dataset: dict[str, Counter[str]] = {}
    for q in selected:
        ds = str(q.get('capability', '?'))
        # `.get` would map a missing key and a JSON `null` to the same value, and
        # those are the two states the record declares separately. An explicit
        # membership test keeps them apart.
        raw = q['rawOutput'] if 'rawOutput' in q else MISSING
        by_dataset.setdefault(ds, Counter())[classify(raw)] += 1

    buckets = (
        'bare', 'labelled', 'prose-then-token', 'prose-labelled', 'other',
        'empty', 'not-captured', 'not-consulted', 'not-a-string',
    )
    for ds in sorted(by_dataset):
        counts = by_dataset[ds]
        total = sum(counts.values())
        print(f'\n{ds}: {total} question(s)')
        for bucket in buckets:
            n = counts.get(bucket, 0)
            if n:
                print(f'  {bucket:18} {n:4}  {n / total:6.2%}')

    # The per-question detail is what makes this a measurement rather than a
    # count: the next intervention depends on WHICH questions landed where, and a
    # bucket total cannot supply that.
    print('\nper-question detail (first 20 per capability):')
    seen: Counter[str] = Counter()
    for q in selected:
        ds = str(q.get('capability', '?'))
        seen[ds] += 1
        if seen[ds] > 20:
            continue
        raw = q['rawOutput'] if 'rawOutput' in q else MISSING
        preview = '' if not isinstance(raw, str) else raw.replace('\n', '\\n')[:90]
        print(
            f'  {ds:3} {str(q.get("questionId", "?"))[:28]:30} '
            f'{classify(raw):18} {preview}'
        )
    return 0


def failures_report(path: Path, dataset: str | None) -> int:
    """Print the failure taxonomy of a report's non-correct questions.

    The definitions block is printed with the table rather than left to this file's
    docstring, because the whole defect this report closes is that a number was
    published without the rule that produced it. A reader who has the table and not
    the rules is exactly where §13.34.5's prediction left its reader.
    """
    report = json.loads(path.read_text(encoding='utf-8'))
    questions = questions_of(report)
    if not questions:
        print(f'{path}: no per-question roster found. Keys: {sorted(report)}', file=sys.stderr)
        return 2
    if dataset is not None:
        questions = [q for q in questions if q.get('capability') == dataset]

    by_capability: dict[str, list[dict]] = {}
    for question in questions:
        by_capability.setdefault(str(question.get('capability', '?')), []).append(question)

    for capability in sorted(by_capability):
        rows = by_capability[capability]
        correct = sum(1 for q in rows if q.get('correct'))
        counts = failure_census(rows)
        non_correct = sum(counts.values())
        print(f'\n{capability}: {len(rows)} question(s), {correct} correct, {non_correct} non-correct')
        for shape in FAILURE_SHAPES:
            n = counts[shape]
            share = f'{n / non_correct:6.1%}' if non_correct else '     -'
            print(f'  {shape:18} {n:4}  {share}')
        print('\n  definitions (precedence, first match wins)')
        print('    abstention        the last non-empty line of rawOutput is INSUFFICIENT_EVIDENCE')
        print('    plan_output       rawOutput opens with "Let me gather" or "Step 1"')
        print('    soft_refusal      a refusal written out in prose, in the answer or the raw output')
        print('    numeric_mismatch  both sides carry a number and the FIRST of each differ')
        print(f'    long_prose        the answer is {LONG_PROSE_CHARS} characters or more')
        print('    other             none of the above')
        print('\n  comparability')
        print(f'    numeric_mismatch, plan_output folded in      {folded_numeric(counts):4}'
              "   §13.34.4's reading, which §13.34.5's prediction 2 is stated against")
        multiset = sum(1 for q in rows if not q.get('correct')
                       and classify(q.get('rawOutput', MISSING)) not in ABSTENTION_SHAPES
                       and numeric_mismatch_by_multiset(q.get('groundTruth'), q.get('answer') or '')
                       and not (isinstance(q.get('rawOutput'), str) and PLAN_OUTPUT.match(q['rawOutput'])))
        print(f'    numeric_mismatch by multiset instead      {multiset:4}'
              "   the literal reading of §13.26.4's sentence")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog='classify-raw-outputs.py',
        description='Classify the raw model output behind each roster abstention.',
    )
    parser.add_argument('report', type=Path)
    parser.add_argument('--capability', help='restrict to one capability code (e.g. MR, TR, ABS)')
    parser.add_argument(
        '--failures',
        action='store_true',
        help='classify every non-correct question instead of every raw output',
    )
    args = parser.parse_args(argv[1:])
    if not args.report.is_file():
        print(f'no such report: {args.report}', file=sys.stderr)
        return 2
    if args.failures:
        return failures_report(args.report, args.capability)
    return summarise(args.report, args.capability)


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
