#!/usr/bin/env python3
"""Measure how much of a sentence's relation survives the split into atoms.

The review artifact this reads is an HTML page holding one JSON blob (`id="a3-data"`) with, per
card, the sentence the person said (`arm: "source"`) and the atoms a model offered (`arm:
"atoms"`). Nothing here calls a model: this is a census over text that was already produced, so
the reading is reproducible without an API key.

    python3 tools/measure-atom-fidelity.py path/to/review.html
    python3 tools/measure-atom-fidelity.py path/to/review.html --json

The two readings it prints are the ones `docs/DESIGN-KNOWLEDGE-MODEL.md` §5 gates on:

    marker survival  -- of the frames whose sentence carries an explicit relation marker, the
                        share where no atom carries it. This is the defect.
    relational atom  -- frames where an atom states the relation itself ("communities help me
                        learn"), which is the shape the design wants more of.

A marker is counted only when it is a whole word, because `so` inside `also` is not a marker and
a substring test would inflate the defect.
"""

from __future__ import annotations

import json
import re
import sys

MARKERS: dict[str, tuple[str, ...]] = {
    'causal': (
        'because',
        'therefore',
        'thus',
        'hence',
        'so',
        'since',
        'due to',
        'as a result',
        'led to',
        'thanks to',
    ),
    'temporal': (
        'after',
        'before',
        'when',
        'while',
        'until',
        'then',
        'once',
        'during',
        'now that',
        'anymore',
        'no longer',
        'used to',
    ),
    'conditional': ('if', 'unless', 'otherwise', 'in case', 'as long as', 'provided'),
    'contrast': (
        'but',
        'although',
        'though',
        'however',
        'instead',
        'rather than',
        'yet',
        'whereas',
        'even though',
    ),
}

# Phrases that contain a marker token without being one, removed before matching.
#
# Both entries were found by reading the first census rather than by anticipating it, and both
# are the same mistake in two costumes: a token that is a conjunction in one frame is something
# else in the next. `for a while now` (g10) is a duration, not the `while` that joins clauses;
# `wondering if` (g32) is an embedded question, not a condition. Leaving either in inflates the
# defect by counting a frame that has no relation to lose -- which is the same class of error as
# the causal hallucination this design guards against, so the gate is symmetric: no marker, no
# loss, and no edge.
NOT_MARKERS: tuple[str, ...] = (
    'for a while',
    'a while now',
    'a while',
    'wondering if',
    'wonder if',
    'know if',
    'check if',
    'see if',
    'ask if',
    'whether',
    'as if',
)

# A relation stated by an atom itself. These verbs turn a sentence about two things into a
# sentence about their link; `g04` is the reviewed example ("communities help me learn").
RELATIONAL_VERBS = (
    'help',
    'helps',
    'helped',
    'cause',
    'causes',
    'caused',
    'lead to',
    'leads to',
    'led to',
    'allow',
    'allows',
    'allowed',
    'prevent',
    'prevents',
    'prevented',
    'enable',
    'enables',
    'enabled',
    'means',
    'meant',
    'because',
    'so that',
    'thanks to',
    'due to',
)


def words(text: str) -> str:
    """Lowercase, punctuation to spaces, padded — so `\\bso\\b` cannot match inside `also`."""
    return ' ' + re.sub(r"[^a-z0-9' ]", ' ', text.lower()) + ' '


def markers(text: str) -> set[tuple[str, str]]:
    padded = words(text)
    for phrase in NOT_MARKERS:
        padded = padded.replace(f' {phrase} ', ' __ ')
    found: set[tuple[str, str]] = set()
    for kind, tokens in MARKERS.items():
        for token in tokens:
            if f' {token} ' in padded:
                found.add((kind, token))
    return found


def states_relation(text: str) -> bool:
    padded = words(text)
    return any(f' {verb} ' in padded for verb in RELATIONAL_VERBS)


def load_pairs(path: str) -> dict[str, dict[str, object]]:
    with open(path, encoding='utf-8') as handle:
        html = handle.read()
    blobs = re.findall(r'<script[^>]*id="a3-data"[^>]*>(.*?)</script>', html, re.S)
    if not blobs:
        raise SystemExit(f'no a3-data blob in {path}: is this a review page?')
    data = json.loads(blobs[0])
    steps = data.get('steps')
    if not isinstance(steps, list) or not steps:
        raise SystemExit(f'a3-data in {path} carries no steps')
    pairs: dict[str, dict[str, object]] = {}
    for step in steps:
        pairs.setdefault(step['cardId'], {})[step['arm']] = step
    return pairs


def census(pairs: dict[str, dict[str, object]]) -> dict[str, object]:
    rows = []
    for card_id in sorted(pairs):
        pair = pairs[card_id]
        source = pair.get('source') or {}
        atoms = pair.get('atoms') or {}
        frame = source.get('source')
        offered = atoms.get('atoms')
        if not frame or not offered:
            continue
        frame_markers = markers(frame)
        atom_markers = [markers(atom) for atom in offered]
        union = set().union(*atom_markers) if atom_markers else set()
        rows.append(
            {
                'cardId': card_id,
                'atoms': len(offered),
                'markers': sorted(f'{kind}:{token}' for kind, token in frame_markers),
                'kept': sorted(f'{kind}:{token}' for kind, token in union),
                'lost': sorted(f'{kind}:{token}' for kind, token in frame_markers - union),
                'relational': [atom for atom in offered if states_relation(atom)],
                'copied': any(atom.strip() == frame.strip() for atom in offered),
            }
        )

    marked = [row for row in rows if row['markers']]
    fully_lost = [row for row in marked if not row['kept']]
    partly_lost = [row for row in marked if row['kept'] and row['lost']]
    return {
        'pairs': len(rows),
        'marked': len(marked),
        'fully_lost': len(fully_lost),
        'partly_lost': len(partly_lost),
        'lost_share': (len(fully_lost) + len(partly_lost)) / len(marked) if marked else 0.0,
        'relational_frames': [row['cardId'] for row in rows if row['relational']],
        'copied_frames': [row['cardId'] for row in rows if row['copied']],
        'rows': rows,
    }


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    path = argv[1]
    as_json = '--json' in argv[2:]
    result = census(load_pairs(path))

    if as_json:
        print(json.dumps(result, indent=2))
        return 0

    print(f'pairs measured            {result["pairs"]}')
    print(f'frames with a marker      {result["marked"]}')
    print(f'  lost entirely           {result["fully_lost"]}')
    print(f'  lost in part            {result["partly_lost"]}')
    print(f'  loss share              {result["lost_share"]:.1%}')
    print(f'relational atoms present  {", ".join(result["relational_frames"]) or "none"}')
    print(f'copied frames             {", ".join(result["copied_frames"]) or "none"}')
    print()
    for row in result['rows']:
        if not row['markers']:
            continue
        tag = 'LOST' if not row['kept'] else ('PART' if row['lost'] else ' ok ')
        print(f'{row["cardId"]}  n={row["atoms"]}  {tag}  markers={row["markers"]}  lost={row["lost"]}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
