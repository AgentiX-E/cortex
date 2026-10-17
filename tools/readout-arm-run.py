#!/usr/bin/env python3
"""Read an ablation run out of its report, with every number beside its definition.

## Why this is a tool and not an inline script

Every section of this campaign that quotes a number from a run has, until now, done so
through a script written for that section and not committed. §13.38 found the
consequence: a registered prediction whose input came from "a script that was run once",
which made the prediction unre-derivable by its reader. §13.41 and §13.42 found it twice
more -- a second inline script for the failure taxonomy, and a third for the channel
split.

So the readout lives here, with tests, and it prints the definition beside every number.

## The two accuracies, which §13.41.5 confused for a minute

A report carries **one repetition's** accuracy in `feature.metrics` and the **mean over
four repetitions** in `ablation.delta`. On run `38985220145` those read `+21.00pp` and
`+23.25pp` -- the same run, two numbers, one of them the registered statistic. Both are
printed here, labelled, and the register's is named as such.

## What it does not do

It does not compute the scorer-channel split. That is `judgeScorer`'s accounting and it
requires the TypeScript judge, so it is printed by the arm itself (`scorer channels:
…` on both the success and the failure path) and read from the run's log. A Python
re-implementation would be a second definition of the same number.

Usage:

    python3 tools/readout-arm-run.py path/to/benchmark-cortex-memory-ablation-report.json
    python3 tools/readout-arm-run.py --reference path/to/report.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# §13.26's per-capability counts for run `38595325261` (`ask: computed`, the configuration
# the register calls the default). Carried as constants rather than read from that run's
# artifact because the artifact is not committed and this comparison must work offline --
# but only shown on request, and only for the dataset those counts were produced on, so a
# run against another dataset cannot silently acquire a delta against them.
REFERENCE_PER_CAPABILITY = {
    'ABS': 29,
    'IE': 133,
    'KU': 62,
    'MR': 51,
    'TR': 72,
}
REFERENCE_RUN = '38595325261'
REFERENCE_DATASET = 'longmemeval-s'


def _load_classifier():  # noqa: ANN202 - the classifier module, imported by path
    """Import `classify-raw-outputs.py`, whose hyphen makes it unimportable by name.

    The taxonomy is not re-implemented here for the reason §13.38 gives: two definitions
    of one word is the defect it was written to close.
    """
    import importlib.util

    path = Path(__file__).resolve().parent / 'classify-raw-outputs.py'
    spec = importlib.util.spec_from_file_location('classify_raw_outputs', path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _questions(report: dict) -> list[dict] | None:
    """The per-question roster, under either key a report uses.

    A reduced report drops it (`serializeReportOrReduce`), and a run whose roster was
    dropped cannot be read for anything but its headline numbers -- which is why this
    returns `None` rather than an empty list, so the caller can say so.
    """
    for key in ('questions', 'records'):
        value = report.get(key)
        if isinstance(value, list) and value:
            return value
    return None


def _pct(value: float) -> str:
    return f'{value * 100:+.2f}pp'


def describe(report: dict, reference: bool) -> str:
    lines: list[str] = []
    config = report.get('memoryArmConfig') or {}
    lines.append(
        'config: '
        + ' '.join(
            f'{key}={config[key]}'
            for key in ('ask', 'relevanceUnits', 'relevanceSignal', 'relevanceTopK', 'promptContract')
            if key in config
        )
    )
    if 'dataset' in config:
        lines.append(f'dataset: {config["dataset"]}')

    baseline = report.get('baseline', {}).get('metrics', {})
    feature = report.get('feature', {}).get('metrics', {})
    ablation = report.get('ablation', {})

    # The two accuracies, in the order a reader needs them: what one repetition scored,
    # then what the register's statistic says.
    if 'accuracy' in baseline and 'accuracy' in feature:
        single = feature['accuracy'] - baseline['accuracy']
        lines.append(
            f'accuracy (this repetition): baseline {baseline["accuracy"]:.4f}  '
            f'feature {feature["accuracy"]:.4f}  -> {_pct(single)}'
        )

    feature_aggregate = ablation.get('featureAggregate') or {}
    baseline_aggregate = ablation.get('baselineAggregate') or {}
    if feature_aggregate and baseline_aggregate:
        lines.append(
            f'aggregates (the repetitions behind the register): '
            f'baseline avg {baseline_aggregate.get("avg")} '
            f'(min {baseline_aggregate.get("min"):.3f} max {baseline_aggregate.get("max"):.3f})  '
            f'feature avg {feature_aggregate.get("avg")} '
            f'(min {feature_aggregate.get("min"):.3f} max {feature_aggregate.get("max"):.3f})'
        )

    if 'delta' in ablation:
        p_value = ablation.get('mcnemarPValue')
        verdict = 'significant' if ablation.get('mcnemarSignificant') else 'NOT significant'
        lines.append(
            f'registered statistic: delta {_pct(ablation["delta"])} -- the mean of the '
            f'repetitions above, which is the number the register uses. '
            f'McNemar p={p_value:.3e} ({verdict})'
            if isinstance(p_value, (int, float))
            else f'registered statistic: delta {_pct(ablation["delta"])}'
        )

    discordant = ablation.get('discordant') or {}
    if discordant:
        lines.append(
            'discordant: baseline-incorrect/feature-correct '
            f'{discordant.get("baselineIncorrectFeatureCorrect")}, '
            'baseline-correct/feature-incorrect '
            f'{discordant.get("baselineCorrectFeatureIncorrect")}'
        )

    questions = _questions(report)
    if questions is None:
        lines.append('')
        lines.append(
            'no per-question roster in this report: a reduced report carries headline '
            'numbers only. The per-capability table and the failure taxonomy need it.'
        )
        return '\n'.join(lines)

    by_capability: dict[str, list[dict]] = {}
    for question in questions:
        by_capability.setdefault(str(question.get('capability', '?')), []).append(question)

    lines.append('')
    lines.append('per capability (feature side, counted from the roster):')
    for capability in sorted(by_capability):
        rows = by_capability[capability]
        correct = sum(1 for row in rows if row.get('correct'))
        line = f'  {capability}: {correct}/{len(rows)}'
        if reference and capability in REFERENCE_PER_CAPABILITY:
            line += f'  against {REFERENCE_RUN}: {REFERENCE_PER_CAPABILITY[capability]}'
            line += f' ({correct - REFERENCE_PER_CAPABILITY[capability]:+d})'
        lines.append(line)

    dataset = config.get('dataset')
    if not reference:
        lines.append(
            f'  no §13.26 reference shown (pass --reference to compare against run '
            f'{REFERENCE_RUN}, which was {REFERENCE_DATASET})'
        )
    elif dataset not in (None, REFERENCE_DATASET):
        lines.append(
            f'  WARNING: this report says dataset={dataset!r}, and the §13.26 counts were '
            f'produced on {REFERENCE_DATASET!r}. The delta column is not a comparison.'
        )

    # The taxonomy, from the classifier rather than a second copy of the rules. It reads
    # `answer` -- the string the scorer graded -- which is what makes it meaningful on a
    # run whose raw outputs are transcripts.
    classifier = _load_classifier()
    mr = by_capability.get('MR')
    if mr:
        census = classifier.failure_census(mr)
        lines.append('')
        lines.append('MR failure taxonomy (field: answer)')
        for shape in classifier.FAILURE_SHAPES:
            lines.append(f'  {shape}: {census[shape]}')
        lines.append(
            f'  numeric_mismatch with plan_output folded in: {classifier.folded_numeric(census)}'
            '  (§13.34.4\'s reading)'
        )

    return '\n'.join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path, help='a benchmark-cortex-memory-ablation-report.json')
    parser.add_argument(
        '--reference',
        action='store_true',
        help=f'compare per-capability counts against run {REFERENCE_RUN}',
    )
    args = parser.parse_args(argv)

    try:
        report = json.loads(args.report.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as error:
        print(f'{args.report}: {error}', file=sys.stderr)
        return 2

    questions = _questions(report)
    if questions is None and 'ablation' not in report:
        print(
            f'{args.report}: no per-question roster and no ablation block. Keys: {sorted(report)}',
            file=sys.stderr,
        )
        return 2

    print(describe(report, args.reference))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
