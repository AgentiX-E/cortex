#!/usr/bin/env python3
"""Extract the user's own utterances from benchmark artifacts, deduplicated by exact text.

    python3 tools/extract-user-turns.py --glob '/workspace/run-*/…/report.json' --out turns.json

## Why this corpus

`§10.2` gate 3 needs a denominator of *publications*, and no hand-labelled sample of 60 rows has
one. The artifacts this project already writes contain every turn the memory arm was given --
LongMemEval-S user utterances, real assistant conversations with the full distribution of trigger
words in it. Extracting them is free, needs no Hub, and reproduces exactly from a run id.

## What is deliberately excluded

Assistant turns. The disclosure layer runs on what the *user* says; an assistant turn is the
product's own text and would score the rule against its own output. Rows are deduplicated by exact
text because the same haystack is reused across questions, and a duplicated row would silently
double-weight whatever it happens to contain.

## Why the output is a file and not a number

Extraction needs the artifacts; measuring must not. Splitting them is what lets the census in
`tools/triage-publish-census.mjs` run against a frozen corpus, which is the only way the number it
produces is reviewable.
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import re
import sys

TURN = re.compile(r'^\[[^\]]+\]\s*(user|assistant)\s*:\s*(.*)$', re.S)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--glob', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--limit', type=int, default=0, help='stop after this many reports (0 = all)')
    args = parser.parse_args()

    paths = sorted(glob.glob(args.glob))
    if args.limit:
        paths = paths[: args.limit]
    if not paths:
        print(f'no artifacts matched {args.glob}', file=sys.stderr)
        return 1

    seen: dict[str, str] = {}
    scanned = 0
    for path in paths:
        with open(path, encoding='utf-8') as handle:
            report = json.load(handle)
        for question in report.get('questions', []):
            for turn in question.get('turns', []):
                scanned += 1
                match = TURN.match(turn.get('text') or '')
                if not match or match.group(1) != 'user':
                    continue
                body = ' '.join(match.group(2).split())
                if body:
                    seen.setdefault(hashlib.sha1(body.encode()).hexdigest(), body)

    payload = {
        'source': 'LongMemEval-S benchmark artifacts: user turns only, deduplicated by exact text',
        'artifacts': [p.split('/workspace/')[-1] for p in paths],
        'turnsScanned': scanned,
        'turns': list(seen.values()),
    }
    with open(args.out, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle)
    print(f'{scanned} turns scanned, {len(seen)} distinct user utterances -> {args.out}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
