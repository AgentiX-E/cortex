#!/usr/bin/env python3
"""Two artifacts, one reader axis, and the delta written down where the matrix can read it.

    python3 tools/reader-ladder.py --control A.json --run-a 42533236864 \\
        --treatment B.json --run-b 42826272421 [--write path.json]

## What this is for

`M1` asks the only question about readers that this project can answer from its own data: how many
accuracy points does a reasoning reader buy over a non-reasoning one, on the same prompts. The row sat
`unrun` for three rounds because the answer existed only as prose in three places — a 200-question
screening pair in `PREREGISTRATION` §13.344, a 500-question pair from before the room map that ships,
and a model-tier pair that is a different axis. A row that reads prose is a row nothing re-derives.

So the pairing moves here: two artifacts in, one delta out, with the three conditions that decide
whether the pair is a comparison at all checked before the number is written.

## The three conditions, and why each one refuses rather than warns

- **same repetition count.** One repetition's accuracy is a single draw; four repetitions' mean has
  half a draw's standard error. A delta between a one-run arm and a four-run arm is a delta between two
  instruments.
- **same population.** `T1r` ran 200 questions and the arm ships 500. The 200-question sample gives
  `MR` 29 questions, where a 3-point effect is 1.2 questions, so a delta across populations is a
  comparison of two different questions rather than of two readers.
- **the same prompts.** `promptDigest` is the field that compares two artifacts (`promptChars` only
  compares lengths). A pair whose digests differ on any question is reported **inadmissible**: the
  delta is written, the flag is written beside it, and `M1`'s attestation refuses it.

A refusal here is a `SystemExit` with the reason, not a warning, because every number this tool
produces becomes a cell in `ACCEPTANCE-MATRIX.md` and a warning is a cell that gets quoted.

## Why accuracy is recomputed from `ablation`, not read from `feature.metrics`

`feature.metrics.accuracy` is **one repetition**; `ablation.featureCorrectByRun` is the per-repetition
vector the report writes for exactly this purpose. On `42533236864` the two are 0.912 and 0.9105, and
the difference is 0.75 questions against a threshold of 3.0 points. The mean is the statistic `S1`
gates and `frontier.json` carries, so it is the statistic this file writes.

## What it does not do

It does not decide whether the delta is significant. The exact test on the discordant split is
`arm-flip-census.py`'s job and it needs the per-question verdicts; this tool writes the point estimate
and the identity census, and it prints the census command so the two readings are one step apart
rather than one document apart.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

POINTS = 'the row\'s unit is an accuracy fraction: 0.03 is 3.0 points'


def _repetition_mean(report: dict) -> float:
    """The mean accuracy over the report's own repetitions.

    `ablation.featureCorrectByRun` is a **list of digit strings**, one string per repetition, each
    character the verdict of one question in that repetition. The list is the report's own encoding
    and the mean over every character is the statistic `S1` gates and `frontier.json` carries, so a
    run that writes no vector is refused rather than substituted with `feature.metrics.accuracy`
    (one draw, 0.912 against this mean's 0.9105 on `42533236864`).

    A bare **string** is refused rather than read as one repetition. "1111" could be one repetition of
    four questions or four repetitions of one, and the two means differ by a factor of four -- the
    ambiguity is the reason this is a refusal and not a convenience.
    """
    ablation = report.get('ablation') or {}
    vector = ablation.get('featureCorrectByRun')
    total = report.get('questionCount')
    if isinstance(vector, str):
        raise SystemExit(
            'ablation.featureCorrectByRun is a string, and a string of digits cannot say whether it '
            'is one repetition of many questions or many repetitions of one; the report writes a list'
        )
    if not isinstance(vector, list) or not vector:
        raise SystemExit(
            'the artifact carries no ablation.featureCorrectByRun, so it has no repetition mean; '
            'feature.metrics.accuracy is one draw and is not a substitute'
        )
    if not isinstance(total, int) or total <= 0:
        raise SystemExit('the artifact carries no questionCount')
    correct = 0
    for element in vector:
        if not isinstance(element, str) or not element.isdigit():
            raise SystemExit(f'ablation.featureCorrectByRun carries a non-digit entry: {element!r}')
        if len(element) != total:
            raise SystemExit(
                f'a repetition carries {len(element)} verdicts for {total} questions, so the vector '
                'is not aligned to the population and its mean would be a different denominator'
            )
        correct += sum(int(digit) for digit in element)
    return correct / (len(vector) * total)


def pairing(control: dict, treatment: dict) -> None:
    """Refuse the three ways two artifacts can stop being a pair."""
    for label, report in (('control', control), ('treatment', treatment)):
        if not isinstance(report.get('questions'), list) or not report['questions']:
            raise SystemExit(f'the {label} artifact carries no per-question records')
    if control.get('questionCount') != treatment.get('questionCount'):
        raise SystemExit(
            'the two artifacts graded different populations: '
            f'{control.get("questionCount")} against {treatment.get("questionCount")} questions. '
            'A 200-question sample gives MR 29 questions, where a 3-point effect is 1.2 questions'
        )
    if control.get('runs') != treatment.get('runs'):
        raise SystemExit(
            'the two artifacts carry different repetition counts: '
            f'{control.get("runs")} against {treatment.get("runs")}. One repetition is a single draw'
        )


def identity(control: dict, treatment: dict) -> dict:
    """`promptDigest` compared question by question, and the three states kept apart."""
    left = {q['questionId']: q for q in control['questions'] if isinstance(q, dict) and 'questionId' in q}
    right = {q['questionId']: q for q in treatment['questions'] if isinstance(q, dict) and 'questionId' in q}
    shared = [i for i in left if i in right]
    identical = differ = missing = 0
    for identifier in shared:
        a = left[identifier].get('promptDigest')
        b = right[identifier].get('promptDigest')
        if not isinstance(a, str) or not isinstance(b, str):
            missing += 1
        elif a == b:
            identical += 1
        else:
            differ += 1
    return {
        'identical': identical,
        'differ': differ,
        'missing': missing,
        'shared': len(shared),
        'admissible': differ == 0 and missing == 0,
    }


def per_capability(control: dict, treatment: dict) -> list[dict]:
    """The same statistic per capability, from each report's own ablation block."""
    left = (control.get('ablation') or {}).get('featureByCapability') or {}
    right = (treatment.get('ablation') or {}).get('featureByCapability') or {}
    counts = (control.get('ablation') or {}).get('questionsByCapability') or {}
    rows = []
    for capability in sorted(set(left) & set(right)):
        total = counts.get(capability)
        if not isinstance(total, int) or total <= 0:
            continue
        rows.append(
            {
                'capability': capability,
                'questions': total,
                'control': left[capability]['avg'] / total,
                'treatment': right[capability]['avg'] / total,
                'delta': (right[capability]['avg'] - left[capability]['avg']) / total,
            }
        )
    return rows


def reading(
    control: dict,
    treatment: dict,
    run_a: str,
    run_b: str,
    reasoning_side: str = 'treatment',
) -> dict:
    """The pair, its delta, and the row's statistic with the reasoning side named.

    `deltaPoints` is `treatment - control`, which is what a pair means. `reasoningGainPoints` is the
    same quantity with the sign the row asks for — `M1` measures *how much the reasoning reader gains*,
    so a pair whose reasoning side is the treatment gives its gain directly and a pair whose reasoning
    side is the control gives the negation. The side is a parameter rather than an inference because a
    tool that guessed it would silently invert a row's sign, and a sign is the whole reading.
    """
    if reasoning_side not in ('control', 'treatment'):
        raise SystemExit(f'--reasoning-side must be control or treatment, not {reasoning_side!r}')
    pairing(control, treatment)
    control_accuracy = _repetition_mean(control)
    treatment_accuracy = _repetition_mean(treatment)
    return {
        'unit': 'accuracy fraction',
        'unitNote': POINTS,
        'control': {
            'run': run_a,
            'accuracy': control_accuracy,
            'runs': control['runs'],
            'questionCount': control['questionCount'],
        },
        'treatment': {
            'run': run_b,
            'accuracy': treatment_accuracy,
            'runs': treatment['runs'],
            'questionCount': treatment['questionCount'],
        },
        'deltaPoints': treatment_accuracy - control_accuracy,
        'reasoningSide': reasoning_side,
        'reasoningGainPoints': (
            control_accuracy - treatment_accuracy
            if reasoning_side == 'control'
            else treatment_accuracy - control_accuracy
        ),
        'promptIdentity': identity(control, treatment),
        'perCapability': per_capability(control, treatment),
    }


def render(result: dict) -> str:
    ident = result['promptIdentity']
    lines = [
        'Reader ladder',
        '',
        f'  control    {result["control"]["run"]}  {result["control"]["accuracy"]:.4%}'
        f'  ({result["control"]["runs"]} runs, {result["control"]["questionCount"]} questions)',
        f'  treatment  {result["treatment"]["run"]}  {result["treatment"]["accuracy"]:.4%}'
        f'  ({result["treatment"]["runs"]} runs, {result["treatment"]["questionCount"]} questions)',
        f'  delta      {result["deltaPoints"] * 100:+.2f} points  (treatment - control)',
        f'  reasoning  {result["reasoningGainPoints"] * 100:+.2f} points'
        f'  (the {result["reasoningSide"]} side is the one that reasons)',
        '',
        f'  prompts    {ident["identical"]}/{ident["shared"]} identical, {ident["differ"]} differ, '
        f'{ident["missing"]} missing',
        f'  admissible {"yes" if ident["admissible"] else "NO — the pair is not a reader comparison"}',
        '',
        f'{"capability":12s} {"n":>5s} {"control":>9s} {"treatment":>10s} {"delta":>8s}',
        '-' * 48,
    ]
    for row in result['perCapability']:
        lines.append(
            f'{row["capability"]:12s} {row["questions"]:5d} {row["control"]:9.2%} '
            f'{row["treatment"]:10.2%} {row["delta"] * 100:+8.2f}'
        )
    lines += [
        '',
        '  significance is not this tool\'s: run `tools/arm-flip-census.py --relations` on the same',
        '  pair for the exact test on the discordant split and the relation of each flip to its gold.',
    ]
    return '\n'.join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--control', required=True, help='the artifact the treatment is paired against')
    parser.add_argument('--run-a', required=True, help='the control run id, because artifacts carry none')
    parser.add_argument('--treatment', required=True, help='the artifact under test')
    parser.add_argument('--run-b', required=True, help='the treatment run id')
    parser.add_argument(
        '--reasoning-side',
        default='treatment',
        choices=('control', 'treatment'),
        help='which arm is the reasoning reader; the row measures its gain, so the sign depends on it',
    )
    parser.add_argument('--write', default=None, help='write the reading here as JSON')
    parser.add_argument('--json', action='store_true', help='print the reading instead of the table')
    args = parser.parse_args(argv)

    control = json.loads(Path(args.control).read_text())
    treatment = json.loads(Path(args.treatment).read_text())
    result = reading(control, treatment, args.run_a, args.run_b, args.reasoning_side)
    if args.write:
        Path(args.write).write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
    print(json.dumps(result, indent=1, sort_keys=True) if args.json else render(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
