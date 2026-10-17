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
    python3 tools/readout-arm-run.py --coverage path/to/report.json
    python3 tools/readout-arm-run.py --declines path/to/report.json
"""

from __future__ import annotations

import argparse
import json
import re
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



# The bands are wide at the bottom because that is where the relationship is steepest:
# §13.51's table goes 0% -> 37.2% -> 55.0% -> 77.0% -> 82.8% -> 98.1%, and a band of 10
# points at the top would hide that the last step is the largest.
COVERAGE_BANDS = (
    (0.0, 0.001, '0%'),
    (0.001, 0.25, '1-24%'),
    (0.25, 0.5, '25-49%'),
    (0.5, 0.75, '50-74%'),
    (0.75, 0.999, '75-99%'),
    (0.999, 1.01, '100%'),
)


def coverage_of(question: dict) -> float | None:
    """The share of a question's gold turns that reached the window, or `None`.

    `None` covers two different absences and the caller distinguishes them by counting:
    a record without `goldOverlap` (a producer that does not measure it, or a dataset with
    no gold turns) and a record whose `total` is zero. Neither is 0% coverage -- 0% means
    "the question names gold turns and none of them arrived", which is a measurement.
    """
    overlap = question.get('goldOverlap')
    if not isinstance(overlap, dict):
        return None
    total = overlap.get('total')
    if not isinstance(total, int) or total <= 0:
        return None
    carried = overlap.get('carried')
    if not isinstance(carried, int):
        return None
    return carried / total


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


def coverage_section(questions: list[dict]) -> tuple[str, int]:
    """The coverage table and the per-outcome medians, plus how many records were read.

    ## Why this is a section of the readout and not a one-off

    §13.51 chose the next variable from this table and built it inline, twenty minutes
    before dispatching. It separated TR's declines -- a coverage problem, 39.7% against
    58.3% on the questions it answers -- from MR's, which are not one: 52.8% against 54.2%,
    inside the noise. **The two capabilities' declines have different causes**, and that
    distinction changed which variable was dispatched.

    A measurement that decides a dispatch belongs in a tool, for the reason §13.44 gives.
    """
    measured = [(question, coverage_of(question)) for question in questions]
    measured = [(question, coverage) for question, coverage in measured if coverage is not None]
    if not measured:
        return '', 0

    excluded = len(questions) - len(measured)
    lines: list[str] = ['', 'coverage (gold turns carried / stated)']

    tallies = {label: [0, 0, 0] for _, _, label in COVERAGE_BANDS}
    for question, coverage in measured:
        for low, high, label in COVERAGE_BANDS:
            if low <= coverage < high:
                row = tallies[label]
                row[0] += 1
                if question.get('correct'):
                    row[1] += 1
                elif question.get('answer') is None:
                    row[2] += 1
                break

    for _, _, label in COVERAGE_BANDS:
        count, correct, declined = tallies[label]
        if count == 0:
            continue
        lines.append(
            f'  {label:7} n={count:3}  correct {correct / count:6.1%}  declined {declined / count:6.1%}'
        )

    lines.append('')
    lines.append('by capability and outcome, median coverage')
    by_capability: dict[str, list[tuple[dict, float]]] = {}
    for question, coverage in measured:
        by_capability.setdefault(str(question.get('capability', '?')), []).append((question, coverage))

    for capability in sorted(by_capability):
        rows = by_capability[capability]
        groups = {
            'correct': [c for q, c in rows if q.get('correct')],
            'declined': [c for q, c in rows if not q.get('correct') and q.get('answer') is None],
            'wrong': [c for q, c in rows if not q.get('correct') and q.get('answer') is not None],
        }
        parts = []
        for label in ('correct', 'declined', 'wrong'):
            values = groups[label]
            median = _median(values)
            if median is None:
                continue
            parts.append(f'{label} {median:6.1%} (n={len(values):3})')
        if parts:
            lines.append(f'  {capability}: ' + '  '.join(parts))

    if excluded:
        lines.append(
            f'  {excluded} record(s) excluded: no goldOverlap, or the dataset names no gold turns'
        )
    return '\n'.join(lines), len(measured)


# The heading `parse.ts` splits a stepped response on, restated here because the parser is
# TypeScript and this is Python. The two must agree: a heading the parser recognises and this
# does not would report a listed decline as an unlisted one, which is the direction that
# hides the defect instead of the direction that invents it. `parse-stepped.test.ts` pins the
# pattern against the contract's own lines; the cases below pin it against the model's.
STEP_HEADING = re.compile(r'^\s*step\s*(\d+)\s*[\u2014:-]', re.IGNORECASE | re.MULTILINE)

# A bullet, in the three shapes the artifacts use.
BULLET = re.compile(r'^\s*(?:[-*\u2022]|\d+[.)])\s+(.*\S)\s*$')

# A bullet that asserts absence rather than naming an item.
#
# This is the distinction the whole table turns on. "No items in the evidence mention a
# camping trip" is a bullet, and the list that contains only it is EMPTY -- the model wrote
# a line to say there was nothing to write. Counting bullets would report an honest empty
# list as a non-empty one and send the campaign after a defect that is not there.
ABSENCE = re.compile(
    r'^(?:no\b|none\b|not\b|n/?a\b|cannot\b|nothing\b|there (?:is|are) no\b)',
    re.IGNORECASE,
)

DIGIT = re.compile(r'\d')

# The states a decline can be in, in the order the table prints them.
#
# `no-step` is not a degenerate `empty-list`: it means the model declined without writing
# Step 1 at all, which the contract's own sentence forbids, and it is what every decline on
# a route the contract does not reach looks like.
DECLINE_STATES = (
    'empty-list',
    'non-empty-list',
    'no-step',
    'no-output',
)


def step_sections(raw: str) -> dict[int, str]:
    """`{step number: the text after its heading, up to the next heading}`.

    The first occurrence of a number wins: a model that writes `Step 1` twice is answered
    from the first list it wrote, which is the one it built before reasoning about it.
    """
    headings = list(STEP_HEADING.finditer(raw))
    sections: dict[int, str] = {}
    for index, heading in enumerate(headings):
        end = headings[index + 1].start() if index + 1 < len(headings) else len(raw)
        sections.setdefault(int(heading.group(1)), raw[heading.end():end])
    return sections


def decline_state(record: dict) -> tuple[str, int, bool]:
    """`(state, items listed, whether Step 2 stated a number)` for one decline.

    Reads `rawOutput`, which is the inverse of `failure_shape`'s choice and for a reason
    that is the same reason: that function classifies **how the answer was wrong**, and this
    one classifies **what the model did before declining** -- which is only in the raw text.
    """
    raw = record.get('rawOutput')
    if not isinstance(raw, str) or not raw.strip():
        return 'no-output', 0, False
    sections = step_sections(raw)
    if 1 not in sections:
        return 'no-step', 0, False
    items = 0
    for line in sections[1].splitlines():
        bullet = BULLET.match(line)
        if bullet and not ABSENCE.match(bullet.group(1)):
            items += 1
    stated = bool(DIGIT.search(sections.get(2, '')))
    return ('empty-list' if items == 0 else 'non-empty-list'), items, stated


def declines_section(questions: list[dict]) -> tuple[str, int]:
    """The decline table by Step 1 content, per capability, plus how many declines were read.

    ## Why the table exists

    §13.56 chose its variable from it. §13.55 forbade declining with a non-empty list, and
    run `39035438120` declined anyway: of the 21 MR declines it inherited, **12 carried a
    non-empty list**, and `7024f17c` listed the jog, computed `Total = 0.5 hours` against a
    gold of `0.5 hours`, and appended the sentinel. A table that said "23 declines" could not
    have told that apart from an honest empty list, and the two need opposite repairs: the
    first is a prompt-placement defect, the second is retrieval.

    ## Why every capability is printed

    TR's and IE's declines are all `no-step`, because the contract does not reach those
    routes. Printing them makes the reach visible from the artifact, which is the same
    argument `askRoutes` makes about the config block.
    """
    by_capability: dict[str, list[dict]] = {}
    for question in questions:
        if question.get('correct'):
            continue
        if question.get('answer') is not None:
            continue
        by_capability.setdefault(str(question.get('capability', '?')), []).append(question)

    if not by_capability:
        return '', 0

    lines = ['', 'declines by Step 1 content (field: rawOutput)']
    total = 0
    for capability in sorted(by_capability):
        rows = by_capability[capability]
        total += len(rows)
        tallies: dict[tuple[str, bool], int] = {}
        for row in rows:
            state, _, stated = decline_state(row)
            tallies[(state, stated)] = tallies.get((state, stated), 0) + 1
        lines.append(f'  {capability}: declines {len(rows)}')
        for state in DECLINE_STATES:
            for stated in (True, False):
                count = tallies.get((state, stated), 0)
                if not count:
                    continue
                if state == 'non-empty-list':
                    label = 'non-empty list, number in Step 2' if stated else 'non-empty list, no number'
                elif state == 'empty-list':
                    label = 'empty list, number in Step 2' if stated else 'empty list'
                elif state == 'no-step':
                    label = 'no Step 1 section'
                else:
                    label = state
                lines.append(f'     {label:<32} {count}')
    return '\n'.join(lines), total


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path, help='a benchmark-cortex-memory-ablation-report.json')
    parser.add_argument(
        '--reference',
        action='store_true',
        help=f'compare per-capability counts against run {REFERENCE_RUN}',
    )
    parser.add_argument(
        '--coverage',
        action='store_true',
        help='print the gold-coverage table instead of the run summary',
    )
    parser.add_argument(
        '--declines',
        action='store_true',
        help='print the decline table by Step 1 content instead of the run summary',
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

    if args.coverage:
        section, measured = coverage_section(questions)
        if measured == 0:
            print(
                f'{args.report}: no goldOverlap in this roster. A producer that does not '
                'measure coverage, or a dataset that names no gold turns, cannot be read for it.',
                file=sys.stderr,
            )
            return 2
        print(f'records with coverage: {measured} of {len(questions)}')
        print(section)
        return 0

    if args.declines:
        section, read = declines_section(questions)
        if read == 0:
            print(f'{args.report}: no declines in this roster.', file=sys.stderr)
            return 2
        print(f'declines read: {read}')
        print(section)
        return 0

    print(describe(report, args.reference))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
