#!/usr/bin/env python3
"""`S11`'s reading: what the bare construction scores when nobody ranks.

## Why the row needed a producer before a dispatch

`S11` was registered with a source path and no tool that writes it. That is the state `S10` was in for
a round, and it is worse than an `unrun` row: a dispatch can be paid for and its artifact uploaded while
the file the criterion reads never comes into existence, so the row stays `unrun` and the money buys a
number no row can see. The instrument comes first; the dispatch is the cheap half.

## What it reads, and why it recomputes instead of quoting

`overall.accuracy` is the **mean of the per-repetition accuracies**, computed from
`ablation.featureCorrectByRun` and not from `feature.metrics.accuracy`. Two reasons, and the second is
the one that bites:

- the row's dataset says "four repetitions", and a metric computed over four passes is not the same
  object as the first pass's verdict;
- `questions[].correct` is a **one-repetition** reading. A file built from it would agree with the
  four-repetition figure until the two diverged, which is exactly when a reader would need them to
  agree. `S10`'s tool recomputes for the same reason and states it there.

## The five refusals

1. **`--write` without `--run`.** An evidence file that does not name its run is a number nobody can
   re-derive.
2. **An artifact of a configuration nobody registers.** The attestation is `registration-attest.py`'s,
   the same one `cost-ledger.py` uses, so a file cannot describe a configuration the project does not
   ship.
3. **An arm that is not the bare one.** `relevanceSignal` must read `none`. A ranked artifact written
   here would publish a ranked accuracy under a row whose entire content is that nothing ranked it --
   and the number would look entirely plausible, because it would be a real measurement of the wrong
   product.
4. **A population that is not the registered instrument.** 500 questions and four repetitions, because
   the row's threshold is expressed on them. Unlike `S10`, this file has no `screening` tier: the
   criterion reads `overall.accuracy` with no switch, so a smaller run has nowhere honest to go and is
   refused rather than written under a label the row would still read.
5. **A departure the artifact does not declare.** This one was missing, and it made the tool refusable by
   the only row it serves: `S11`'s arm **is** a departure on `relevanceSignal`, the declaration was checked
   at dispatch time and printed to the log, and then dropped -- so the first real artifact produced for
   this row was refused as "not a measurement of the registered configuration" and the money bought a
   number no file could carry. The declaration is now an argument (`--departs`), it is required to name
   exactly the inputs that moved, and it is written into the file so a reader can see which fields the
   number was bought at.

Usage:
  python3 tools/no-ranking-ledger.py <artifact> --run <id> --departs cortex_memory_relevance \
      --write ../cortex-docs/evidence/longmemeval/no-ranking.json
"""

from __future__ import annotations

import argparse
import json
import sys
from importlib import import_module
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
registration = import_module('registration-attest')

REGISTRATION = Path(__file__).resolve().parent / 'arm-config-baseline.json'

# The registered instrument, from `acceptance.ts`'s `S11`: 500 questions, four repetitions, one
# dispatch. Named as constants rather than as flags because the row's threshold is expressed on them
# and a `--questions 200` that wrote a passing file would be the row passing on a different instrument.
QUESTIONS = 500
REPETITIONS = 4


def accuracy(report: dict) -> dict:
    """The mean of the per-repetition accuracies, and the numbers it was computed from."""
    questions = [row['questionId'] for row in report.get('questions') or []]
    # `.get` at both levels, because this tool is also pointed at partial artifacts -- a smoke report, a
    # hand-built fixture -- and a `KeyError` there is a crash where the honest answer is a refusal. The
    # distinction matters: a traceback reads as "the tool is broken", a refusal reads as "this artifact
    # cannot answer this row", and only one of those is true.
    vectors = (report.get('ablation') or {}).get('featureCorrectByRun')
    if not isinstance(vectors, list) or not vectors:
        raise SystemExit(
            'refusing: the artifact carries no `ablation.featureCorrectByRun`, so the accuracy cannot be '
            'recomputed and `questions[].correct` would be a one-repetition reading of a four-repetition run'
        )
    for index, bits in enumerate(vectors):
        if not isinstance(bits, str) or len(bits) != len(questions):
            raise SystemExit(
                f'refusing: repetition {index} carries {len(bits) if isinstance(bits, str) else "no"} '
                f'verdicts for {len(questions)} questions, so the vector is not aligned with the roster'
            )
    per_run = [sum(1 for bit in bits if bit == '1') / len(questions) for bits in vectors]
    return {
        'accuracy': sum(per_run) / len(per_run),
        'accuracyPerRun': per_run,
        'questions': len(questions),
        'runs': len(vectors),
        'accuracySource': 'recomputed from ablation.featureCorrectByRun; not questions[].correct',
    }


def fingerprint(report: dict) -> str:
    """The attestation's own hash, not a second spelling of it.

    `capability-ledger.py` writes this field from `registration.fingerprint`, so a local implementation
    would be a second hash of one configuration -- and the two would agree until the canonicalisation
    changed, at which point every evidence file would disagree with the attestation and nothing would
    say which of them was right.
    """
    return registration.fingerprint(report.get('memoryArmConfig'))


def ledger(report: dict, run: str | None, declared: list[str]) -> dict:
    arm = report.get('memoryArmConfig', {})
    signal = arm.get('relevanceSignal')
    overall = accuracy(report)
    return {
        '$comment': (
            'S11. The construction a caller gets without choosing one: `relevanceSignal: none`, so the '
            'budget spends the arrival-order prefix and nothing ranks. One dispatch, four repetitions, '
            'the same reader, judge and prompt as S1. The row asks whether a bare install is shippable '
            'at 88.0%, which is S1 minus S9\'s registered tolerance.'
        ),
        'row': 'S11',
        'run': run,
        # Always present, and the reason is the one every always-present field in this campaign has: a
        # file that omitted it would make "no departure" and "written before the field existed" the same
        # bytes, and the row exists precisely because one field *did* move.
        'declaredDepartures': list(declared),
        'arm': {
            'name': report.get('kind'),
            'relevanceSignal': signal,
            'reader': (arm.get('reader') or {}).get('model'),
            'judge': (arm.get('judge') or {}).get('model'),
            'maxTurnChars': arm.get('maxTurnChars'),
            'turnCutMarker': arm.get('turnCutMarker'),
            'promptContract': arm.get('promptContract'),
        },
        'dataset': {
            'name': report.get('dataset'),
            'fingerprint': report.get('datasetFingerprint'),
            'questions': overall['questions'],
            'repetitions': overall['runs'],
        },
        'overall': overall,
        'configurationFingerprint': fingerprint(report),
        # `registered` is a claim the strict path has verified; a departure is a different claim and gets a
        # different word, because the two files are read by the same criterion and only one of them is the
        # configuration the project ships.
        'tier': 'declared-departure' if declared else 'registered',
    }


def render(result: dict) -> str:
    overall = result['overall']
    lines = [
        f"S11  run {result['run']}",
        f"  arm: relevanceSignal={result['arm']['relevanceSignal']}  reader={result['arm']['reader']}  "
        f"judge={result['arm']['judge']}",
        f"  population: {overall['questions']} questions x {overall['runs']} repetitions",
        '  per run: ' + ', '.join(f'{value * 100:.2f}%' for value in overall['accuracyPerRun']),
        f"  overall: {overall['accuracy'] * 100:.2f}%  (S11 floor 88.0%)",
        '  declared: ' + (', '.join(result['declaredDepartures']) or 'none'),
        f"  verdict: {'pass' if overall['accuracy'] >= 0.88 else 'miss'}",
    ]
    return '\n'.join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path, help='a benchmark-cortex-memory-ablation-report.json')
    parser.add_argument('--json', action='store_true', help='print the reading as JSON')
    parser.add_argument('--write', type=Path, help='write the evidence file to this path')
    parser.add_argument('--run', help='the workflow run id this report came from')
    parser.add_argument('--baseline', type=Path, default=REGISTRATION, help='the registration record')
    parser.add_argument(
        '--departs',
        default='',
        metavar='FIELDS',
        help=(
            'comma-separated dispatch inputs this artifact moved away from the registration, so its '
            'evidence may be written; every difference must be named here and every name here must be a '
            'difference. Empty means the artifact claims to be the registration, which is the strict '
            'default'
        ),
    )
    args = parser.parse_args(argv)

    if args.write is not None and not args.run:
        raise SystemExit('--write requires --run: an evidence file must name the run it came from')

    report = json.loads(args.report.read_text())
    arm = report.get('memoryArmConfig', {})
    if arm.get('relevanceSignal') != 'none':
        raise SystemExit(
            f"refusing: the artifact's `relevanceSignal` reads {arm.get('relevanceSignal')!r} and S11 is the "
            "arm where nothing ranks. Writing this file would publish a ranked accuracy under a row whose "
            'whole content is that no ranking was configured, and the number would be a real measurement of '
            'the wrong product.'
        )
    overall = accuracy(report)
    if args.write is not None:
        if overall['questions'] != QUESTIONS or overall['runs'] != REPETITIONS:
            raise SystemExit(
                f"refusing: the run graded {overall['questions']} questions over {overall['runs']} "
                f'repetitions and S11 is registered on {QUESTIONS} x {REPETITIONS}. Unlike S10 this row has '
                'no screening tier -- the criterion reads `overall.accuracy` with no switch -- so a smaller '
                'run would pass the row on an instrument the threshold was not written for.'
            )
        baseline = json.loads(args.baseline.read_text(encoding='utf-8'))
        declared = [name.strip() for name in args.departs.split(',') if name.strip()]
        if not declared:
            registration_reading = registration.attestation(report, baseline)
            if not registration_reading['matched']:
                raise SystemExit(registration.refusal(registration_reading, args.baseline))
        else:
            reading = registration.declared_attestation(report, baseline, declared)
            if not reading['accepted']:
                raise SystemExit(registration.declaration_refusal(reading, args.baseline))

    declared = [name.strip() for name in args.departs.split(',') if name.strip()]
    result = ledger(report, args.run, declared)
    if args.write is not None:
        args.write.parent.mkdir(parents=True, exist_ok=True)
        args.write.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2) if args.json else render(result))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
