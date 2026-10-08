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
    python3 tools/classify-raw-outputs.py --dataset MR path/to/report.json
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


def classify(raw: str | None) -> str:
    """One of `bare`, `labelled`, `prose-then-token`, `other`, `absent`.

    ## Why the buckets are what they are

    `absent` is separated from `other` on purpose. A `null` rawOutput means the
    capture did not run or the arm had no model -- a measurement gap. `other`
    means a text was captured and does not end in the sentinel at all, which is a
    different finding: the model declined in words the parser does not know.

    Merging them would let a broken capture read as "the model answered
    differently", which is the substitution section 60 was written to prevent.
    """
    if raw is None:
        return 'absent'
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

    selected = [q for q in questions if dataset is None or q.get('dataset') == dataset]
    if dataset is not None:
        print(f'dataset filter: {dataset}')

    by_dataset: dict[str, Counter[str]] = {}
    for q in selected:
        ds = str(q.get('dataset', '?'))
        by_dataset.setdefault(ds, Counter())[classify(q.get('rawOutput'))] += 1

    for ds in sorted(by_dataset):
        counts = by_dataset[ds]
        total = sum(counts.values())
        print(f'\n{ds}: {total} question(s)')
        for bucket in ('bare', 'labelled', 'prose-then-token', 'prose-labelled',
                       'other', 'empty', 'absent'):
            n = counts.get(bucket, 0)
            if n:
                print(f'  {bucket:18} {n:4}  {n / total:6.2%}')

    # The per-question detail is what makes this a measurement rather than a
    # count: the next intervention depends on WHICH questions landed where, and a
    # bucket total cannot supply that.
    print('\nper-question detail (first 20 per dataset):')
    seen: Counter[str] = Counter()
    for q in selected:
        ds = str(q.get('dataset', '?'))
        seen[ds] += 1
        if seen[ds] > 20:
            continue
        raw = q.get('rawOutput')
        preview = '' if raw is None else raw.replace('\n', '\\n')[:90]
        print(f'  {ds:3} {str(q.get("id", "?"))[:28]:30} {classify(raw):18} {preview}')
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog='classify-raw-outputs.py',
        description='Classify the raw model output behind each roster abstention.',
    )
    parser.add_argument('report', type=Path)
    parser.add_argument('--dataset', help='restrict to one dataset code (e.g. MR, TR, CF)')
    args = parser.parse_args(argv[1:])
    if not args.report.is_file():
        print(f'no such report: {args.report}', file=sys.stderr)
        return 2
    return summarise(args.report, args.dataset)


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
