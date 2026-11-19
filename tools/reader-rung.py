#!/usr/bin/env python3
"""The readings a reader swap is judged by, computed from the two artifacts it left.

## Why this is not `arm-reading-ledger.py`

That tool prices *the absence of a mechanism* (`S11`, `S14`): it refuses an artifact whose arm is not
the row's arm, which is the right refusal for a row that is defined by a configuration value. A reader
swap is not that shape — it is defined by **two artifacts that differ in one field**, and the field is
one the ledger's rows do not name. Adding a row for every reader would make the ledger's refusal table
describe a matrix rather than a question.

## What it computes, and the three numbers that make it a reading rather than two means

- **The paired cells.** Per capability and overall: both correct, control only, treatment only, neither,
  with the net in questions and an exact McNemar p. A pair is a *majority of the repetitions*, which is
  `arm-reading-ledger.py`'s `paired()` convention; a file built on the first repetition would report
  repetition noise as a treatment effect.
- **The prompt identity.** How many of the paired questions carry the same `promptDigest`. A reader swap
  must move **no byte**, so this number is the single-variable claim itself: `identical = n, differ = 0`
  or the treatment is not what its registration says.
- **The declines.** `abstentionReasons.llm` per run on both arms. A reader that buys accuracy by
  declining less is not a stronger reader — `v4-pro`'s non-thinking arm answered seven unanswerable
  questions instead of declining and lost all seven.

## The refusals

1. **A different dataset fingerprint.** Two populations cannot be paired, however similar the ids look.
2. **A different repetition count.** Two means over different numbers of passes are not the same
   statistic, and a majority of two is a tie-breaker rather than a vote.
3. **An empty intersection.** A pairing over zero questions prints `0.0%` against `0.0%` and reads as
   agreement; the tool says so instead.
4. **A roster in one artifact the other does not carry, in full.** Named, not dropped: a silent inner
   join shrinks every denominator on the page (`window-pair.mjs`'s refusal, applied to accuracy).

Usage:
  python3 tools/reader-rung.py --treatment T.json --control C.json [--capability MR] [--json]
"""

from __future__ import annotations

import argparse
import json
import sys
from math import comb
from pathlib import Path


def load(path: str) -> dict:
    return json.loads(Path(path).read_text(encoding='utf-8'))


def repetitions(artifact: dict) -> list[str]:
    """The per-repetition correctness strings, one character per question in roster order."""
    runs = (artifact.get('ablation') or {}).get('featureCorrectByRun')
    if not isinstance(runs, list) or not runs:
        return []
    return [str(run) for run in runs]


def majority(runs: list[str], index: int) -> bool:
    votes = [run[index] == '1' for run in runs]
    return sum(votes) * 2 > len(votes)


def exact_mcnemar(only_control: int, only_treatment: int) -> float:
    """Two-sided exact binomial p, the statistic `readout-arm-run.py` and the ledger both use."""
    total = only_control + only_treatment
    if total == 0:
        return 1.0
    tail = min(only_control, only_treatment)
    probability = sum(comb(total, i) for i in range(0, tail + 1)) / 2**total
    return min(1.0, 2 * probability)


def cells(control: dict[str, bool], treatment: dict[str, bool], ids: list[str]) -> dict[str, int]:
    both = sum(1 for q in ids if control[q] and treatment[q])
    only_control = sum(1 for q in ids if control[q] and not treatment[q])
    only_treatment = sum(1 for q in ids if treatment[q] and not control[q])
    return {
        'questions': len(ids),
        'both': both,
        'onlyControl': only_control,
        'onlyTreatment': only_treatment,
        'neither': len(ids) - both - only_control - only_treatment,
        'deltaQuestions': only_treatment - only_control,
        'mcnemarExactP': exact_mcnemar(only_control, only_treatment),
    }


def read(report: dict, name: str) -> tuple[dict[str, bool], dict[str, dict]]:
    runs = repetitions(report)
    questions = report.get('questions') or []
    if not runs:
        raise SystemExit(f'{name}: no ablation.featureCorrectByRun, so there is no majority to take')
    if any(len(run) != len(questions) for run in runs):
        raise SystemExit(
            f'{name}: a correctness string is {len(runs[0])} characters and the roster is '
            f'{len(questions)} records; the two are indexed by position and cannot disagree'
        )
    verdicts = {q['questionId']: majority(runs, i) for i, q in enumerate(questions)}
    return verdicts, {q['questionId']: q for q in questions}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--treatment', required=True)
    parser.add_argument('--control', required=True)
    parser.add_argument('--capability', default=None)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)

    treatment_report, control_report = load(args.treatment), load(args.control)

    fingerprints = {
        name: report.get('datasetFingerprint')
        for name, report in (('treatment', treatment_report), ('control', control_report))
    }
    if fingerprints['treatment'] != fingerprints['control']:
        raise SystemExit(
            'the two artifacts are not the same population: '
            f'{fingerprints["treatment"]} against {fingerprints["control"]}'
        )
    if len(repetitions(treatment_report)) != len(repetitions(control_report)):
        raise SystemExit(
            f'the arms took {len(repetitions(treatment_report))} and '
            f'{len(repetitions(control_report))} repetitions; a majority of two is a tie-breaker'
        )

    treatment, treatment_records = read(treatment_report, 'treatment')
    control, control_records = read(control_report, 'control')

    shared = [qid for qid in treatment_records if qid in control_records]
    if not shared:
        raise SystemExit(
            'the roster intersection is empty, so every denominator this tool prints would be zero'
        )
    only_in = sorted(set(treatment_records) - set(control_records))
    if len(shared) != len(treatment_records) or len(shared) != len(control_records):
        raise SystemExit(
            f'the rosters are not the same set: {len(shared)} shared, {len(treatment_records)} in the '
            f'treatment, {len(control_records)} in the control'
            + (f' (e.g. {only_in[:3]} appear only in the treatment)' if only_in else '')
        )

    if args.capability:
        wanted = {name.strip() for name in args.capability.split(',') if name.strip()}
        shared = [qid for qid in shared if treatment_records[qid].get('capability') in wanted]
        if not shared:
            raise SystemExit(f'no question in the roster carries capability {sorted(wanted)}')

    overall = cells(control, treatment, shared)
    by_capability: dict[str, dict[str, int]] = {}
    for qid in shared:
        capability = str(treatment_records[qid].get('capability'))
        by_capability.setdefault(capability, []).append(qid)
    by_capability = {name: cells(control, treatment, ids) for name, ids in sorted(by_capability.items())}

    identical = sum(
        1 for qid in shared
        if treatment_records[qid].get('promptDigest') == control_records[qid].get('promptDigest')
        and treatment_records[qid].get('promptDigest') is not None
    )
    declines = {
        'treatment': ((treatment_report.get('abstentionReasons') or {}).get('llm')),
        'control': ((control_report.get('abstentionReasons') or {}).get('llm')),
    }
    runs = {'treatment': len(repetitions(treatment_report)), 'control': len(repetitions(control_report))}

    if args.json:
        print(json.dumps({
            'capability': args.capability,
            'overall': overall,
            'byCapability': by_capability,
            'promptIdentity': {'identical': identical, 'shared': len(shared), 'differ': len(shared) - identical},
            'declines': declines,
            'repetitions': runs,
        }, indent=2))
        return 0

    print(f'paired on {len(shared)} question(s)'
          + (f' of capability {args.capability}' if args.capability else '')
          + f', majority of {runs["treatment"]} repetitions')
    print('')
    print('| capability | n | control | treatment | delta | b/c | b/t | neither | McNemar p |')
    print('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for name, row in by_capability.items():
        control_accuracy = 100 * (row['both'] + row['onlyControl']) / row['questions']
        treatment_accuracy = 100 * (row['both'] + row['onlyTreatment']) / row['questions']
        print(
            f'| {name} | {row["questions"]} | {control_accuracy:.2f}% | {treatment_accuracy:.2f}% | '
            f'{treatment_accuracy - control_accuracy:+.2f} | {row["onlyControl"]} | '
            f'{row["onlyTreatment"]} | {row["neither"]} | {row["mcnemarExactP"]:.4g} |'
        )
    control_accuracy = 100 * (overall['both'] + overall['onlyControl']) / overall['questions']
    treatment_accuracy = 100 * (overall['both'] + overall['onlyTreatment']) / overall['questions']
    print(
        f'| **all** | {overall["questions"]} | **{control_accuracy:.2f}%** | '
        f'**{treatment_accuracy:.2f}%** | **{treatment_accuracy - control_accuracy:+.2f}** | '
        f'{overall["onlyControl"]} | {overall["onlyTreatment"]} | {overall["neither"]} | '
        f'{overall["mcnemarExactP"]:.4g} |'
    )
    print('')
    print(f'prompt identity: {identical} of {len(shared)} byte-identical, '
          f'{len(shared) - identical} differing'
          + (' — a reader swap that moved a prompt is not a reader swap' if identical != len(shared) else ''))
    print(f'declines (`abstentionReasons.llm`, all runs): control {declines["control"]}, '
          f'treatment {declines["treatment"]}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
