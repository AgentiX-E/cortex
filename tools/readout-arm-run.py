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
    python3 tools/readout-arm-run.py --union path/to/report.json
    python3 tools/readout-arm-run.py --counted path/to/report.json
    python3 tools/readout-arm-run.py --pool path/to/report.json
    python3 tools/readout-arm-run.py --ranks path/to/report.json
    python3 tools/readout-arm-run.py --turns path/to/report.json
    python3 tools/readout-arm-run.py --window path/to/report.json
    python3 tools/readout-arm-run.py --final path/to/report.json
    python3 tools/readout-arm-run.py --numbers path/to/report.json
    python3 tools/readout-arm-run.py --counting path/to/report.json
    python3 tools/readout-arm-run.py --sweep path/to/report.json
    python3 tools/readout-arm-run.py --lists path/to/report.json
    python3 tools/readout-arm-run.py --reach path/to/report.json
    python3 tools/readout-arm-run.py --paired before.json after.json
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


def union_section(report: dict, questions: list[dict]) -> tuple[str, int]:
    """The union of the two sides, per capability, and the feature's distance from it.

    ## Why this is the number the roadmap ranks on

    A capability where the feature loses is not automatically worth work: what is recoverable
    is the set of questions **one of the two systems already answers correctly**, because that
    set is proof the information was available to some pipeline on this exact input. On run
    `39035438120` that union is **431/500 = 86.20%** against the feature's 354, and **75 of the
    77** the feature misses are in MR and TR -- which is the whole of the case for putting those
    two first (§110, `07-sota-roadmap.md` §11).

    ## Why the baseline side has to be reconstructed, and why that needs a guard

    The roster carries the feature's correctness only. The baseline is recovered from the two
    discordant lists, and getting a sign wrong produces a **plausible table with a wrong number
    in it** -- the first attempt at this read the baseline as 431/500 instead of 222/500 and the
    union looked like 100%. The reconstruction is therefore checked against the report's own
    `baselineMetrics.correct` and the caller refuses to print on disagreement. An invariant
    asserted after the number is printed is not a check.
    """
    ablation = report.get('ablation') or {}
    baseline_metrics = ablation.get('baselineMetrics') or {}
    expected = baseline_metrics.get('correct')
    discordant = ablation.get('discordantQuestions') or {}
    only_baseline = set(discordant.get('baselineCorrectFeatureIncorrect') or ())
    only_feature = set(discordant.get('baselineIncorrectFeatureCorrect') or ())

    by_capability: dict[str, list[dict]] = {}
    for question in questions:
        by_capability.setdefault(str(question.get('capability', '?')), []).append(question)

    rows: list[tuple[str, int, int, int, int]] = []
    baseline_total = 0
    for capability in sorted(by_capability):
        feature = baseline = union = 0
        for question in by_capability[capability]:
            identifier = question.get('questionId')
            feature_correct = bool(question.get('correct'))
            if feature_correct and identifier in only_feature:
                baseline_correct = False
            elif (not feature_correct) and identifier in only_baseline:
                baseline_correct = True
            else:
                baseline_correct = feature_correct
            feature += feature_correct
            baseline += baseline_correct
            union += feature_correct or baseline_correct
        rows.append((capability, len(by_capability[capability]), baseline, feature, union))
        baseline_total += baseline

    if isinstance(expected, int) and expected != baseline_total:
        raise ValueError(
            f'the reconstructed baseline is {baseline_total}, and the report says {expected}. '
            'The two discordant lists do not describe this roster, so every union number '
            'derived from them would be wrong in a way that looks plausible.'
        )

    lines = ['', 'union of the two sides (either side correct), per capability']
    lines.append(f'  {"capability":<10} {"n":>4} {"baseline":>9} {"feature":>8} {"union":>6} {"gap":>5}')
    totals = [0, 0, 0, 0]
    for capability, count, baseline, feature, union in rows:
        lines.append(
            f'  {capability:<10} {count:>4} {baseline:>9} {feature:>8} {union:>6} {union - feature:>5}'
        )
        totals[0] += count
        totals[1] += baseline
        totals[2] += feature
        totals[3] += union
    lines.append(
        f'  {"TOTAL":<10} {totals[0]:>4} {totals[1]:>9} {totals[2]:>8} {totals[3]:>6} '
        f'{totals[3] - totals[2]:>5}'
    )
    lines.append(
        f'  union {totals[3]}/{totals[0]} = {totals[3] / totals[0]:.2%}; '
        f'feature {totals[2]}/{totals[0]} = {totals[2] / totals[0]:.2%}; '
        f'gap {totals[3] - totals[2]} questions'
    )
    lines.append(
        '  gap = questions one of the two sides already answers correctly and the feature '
        'does not. It is the recoverable set, not the union of two ceilings.'
    )
    return '\n'.join(lines), totals[3] - totals[2]


def counted_section(questions: list[dict], capability: str = 'MR') -> tuple[str, int, int]:
    """Whether the answer equals the length of the model's own Step 1 list.

    ## The defect this separates

    Run `39035438120`'s MR has 27 `numeric_mismatch`. Ten are off by exactly one, and in 9 of
    the 27 the answer **is** the number of items the model listed -- it counted its list
    faithfully and the list was one short. "The model cannot count" and "the model was shown
    too little to count" need opposite repairs, and this is the measurement that tells them
    apart: a short list with a faithful count is a coverage finding, a mismatched count is an
    arithmetic one.

    ## Why both fields

    Every other readout of this artifact reads one of them. `failure_shape` grades `answer`,
    `decline_state` reads `rawOutput`, and this is the only question that needs both: did the
    reasoning produce the graded answer?

    Returns `(section, counted_its_list, records_read)`.
    """
    classifier = _load_classifier()
    rows: list[tuple[str, int, int, int, float | None]] = []
    for question in questions:
        if str(question.get('capability', '')) != capability:
            continue
        if question.get('correct'):
            continue
        if question.get('answer') is None:
            continue
        state, listed, _ = decline_state(question)
        if state not in ('empty-list', 'non-empty-list'):
            continue
        gold = classifier.numbers_in(question.get('groundTruth'))
        answered = classifier.numbers_in(question.get('answer'))
        if not gold or not answered:
            continue
        rows.append((
            str(question.get('questionId')),
            _as_int(gold[0]),
            _as_int(answered[0]),
            listed,
            coverage_of(question),
        ))

    if not rows:
        return '', 0, 0

    lines = ['', f'{capability} wrong answers that carry a Step 1 list (field: rawOutput + answer)']
    lines.append(f'  {"question":<14}{"listed":>7}{"answered":>9}{"gold":>6}{"gold-ans":>9}{"cov":>7}')
    counted = 0
    for identifier, gold, answered, listed, coverage in rows:
        equal = listed == answered
        counted += equal
        difference = '' if gold is None or answered is None else f'{gold - answered:+d}'
        mark = '  <- counted its list' if equal else ''
        shown = '-' if coverage is None else f'{coverage:.2f}'
        lines.append(
            f'  {identifier:<14}{listed:>7}{answered if answered is not None else "-":>9}'
            f'{gold if gold is not None else "-":>6}{difference:>9}{shown:>7}{mark}'
        )
    lines.append('')
    lines.append(
        f'  counted its list: {counted} of {len(rows)} -- the answer is exactly the number of '
        'items Step 1 listed'
    )
    differences = [
        gold - answered for _, gold, answered, _, _ in rows
        if gold is not None and answered is not None
    ]
    if differences:
        by_one = sum(1 for difference in differences if difference == 1)
        lines.append(f'  off by exactly one (gold one higher): {by_one} of {len(differences)}')
    return '\n'.join(lines), counted, len(rows)


def _as_int(token: str) -> int | None:
    """A numeric token as an int, or `None`.

    The taxonomy compares strings, which is right for a verdict and wrong for a difference.
    `70` and `70.0` are the same answer; `3,000` and `3000` are the same answer after
    `numbers_in` strips the separator; `1/48` is not a number this can difference, and `None`
    is the honest answer for it rather than a zero that would read as "off by the gold".
    """
    try:
        return int(float(token))
    except (TypeError, ValueError):
        return None


def paired_section(
    after: list[dict], before: list[dict]
) -> tuple[str, dict[str, int]]:
    """The state-transition matrix between two rosters, per capability.

    ## What this answers that a count cannot

    A per-capability count says a capability moved from 28 declines to 23. It cannot say
    whether the five that stopped declining became correct, became wrong answers, or became
    prose -- and §13.56.3's whole finding was that 3 of them became correct while 2 became
    `numeric_mismatch`. Two runs with the same totals can have those rows swapped.

    ## The noise floor is the same number on untouched questions

    `changed state` is printed per capability so the comparison can be made against the
    capabilities whose prompt did not move. That is the 6.1% of §13.56.4, and without it a
    registered tolerance of two questions has nothing to be measured against.

    ## Missing ids are a defect, not a transition

    Two rosters of one dataset name the same questions. Counting an id that appears on one
    side only as "changed state" would inflate the noise floor in the direction that hides a
    real effect, so it raises instead.
    """
    classifier = _load_classifier()
    before_by_id = {str(question.get('questionId')): question for question in before}
    after_by_id = {str(question.get('questionId')): question for question in after}
    if set(before_by_id) != set(after_by_id):
        missing = sorted(set(before_by_id) ^ set(after_by_id))
        raise ValueError(
            f'the two rosters do not name the same questions: {len(missing)} id(s) are missing '
            f'from one side ({", ".join(missing[:5])}{"..." if len(missing) > 5 else ""}). '
            'A missing id counted as a transition would inflate the noise floor.'
        )

    def state(question: dict) -> str:
        return 'correct' if question.get('correct') else classifier.failure_shape(question)

    by_capability: dict[str, list[str]] = {}
    for identifier, question in after_by_id.items():
        by_capability.setdefault(str(question.get('capability', '?')), []).append(identifier)

    lines = ['', 'state transitions, before -> after (states from the shared taxonomy)']
    changed_totals: dict[str, int] = {}
    for capability in sorted(by_capability):
        identifiers = by_capability[capability]
        transitions: dict[tuple[str, str], int] = {}
        changed = 0
        for identifier in identifiers:
            was = state(before_by_id[identifier])
            now = state(after_by_id[identifier])
            transitions[(was, now)] = transitions.get((was, now), 0) + 1
            if was != now:
                changed += 1
        changed_totals[capability] = changed
        lines.append(
            f'  {capability}: changed state {changed} of {len(identifiers)} '
            f'({changed / len(identifiers):.1%})'
        )
        for (was, now), count in sorted(transitions.items(), key=lambda item: -item[1]):
            if was == now:
                continue
            lines.append(f'     {was:>18} -> {now:<18} {count}')
    return '\n'.join(lines), changed_totals


CLOCK_PATTERN = re.compile(r'\d{1,2}:\d{2}|\b(?:am|pm)\b', re.I)
NUMBER_PATTERN = re.compile(r'-?\d[\d,]*(?:\.\d+)?')


def _stated_number(text: object) -> float | None:
    """The first number in a string, or `None`.

    A clock time is deliberately not a number: `9:00 AM` contains digits, and subtracting them
    would compare 9 against 9 for two different times and call a wrong answer equal. A time is a
    value whose arithmetic is not the subtraction of its parts.
    """
    if not isinstance(text, str):
        return None
    if CLOCK_PATTERN.search(text):
        return None
    match = NUMBER_PATTERN.search(text.replace('$', '').replace('%', ''))
    if match is None:
        return None
    try:
        return float(match.group(0).replace(',', ''))
    except ValueError:  # a token like `1,` that survived the pattern
        return None


def arithmetic_section(questions: list[dict]) -> str:
    """Where a wrong MR answer is wrong, not merely that it is.

    ## The question this answers

    A per-capability count says MR is 86 of 121. It cannot say whether the 35 misses are
    under-counts, over-counts, declines or grading artefacts -- and §13.102.3 needed exactly that
    split to tell a membership failure (twelve under-counts off by exactly one) from a sampling one.
    That split was computed by an inline script, which is the defect §13.38 recorded three times.

    ## Why the buckets are the ones they are

    `under` and `over` are directional and are the mechanism. `abstention`, `non-numeric gold`,
    `no number stated`, `clock gold` and `equal` are states in which direction is undefined; folding
    any of them into `under` would make a run that declined more look like a run that counted less.
    `equal` is its own bucket because an answer that states the gold's number and is still wrong is a
    grading or formatting question, and hiding it inside a direction would misattribute it.

    ## Why `off by one` is printed beside the direction

    A constant offset of one is the signature of a membership decision -- one item systematically
    excluded -- rather than of arithmetic. §13.103's fourth prediction is stated against it, so the
    count has to be re-derivable by a reader.
    """
    counts = {
        'under': 0,
        'over': 0,
        'equal': 0,
        'abstention': 0,
        'no number stated': 0,
        'non-numeric gold': 0,
        'clock gold': 0,
    }
    off_by_one = {'under': 0, 'over': 0}
    for question in questions:
        if question.get('capability') != 'MR' or question.get('correct'):
            continue
        answer = question.get('answer')
        gold_text = question.get('groundTruth')
        if answer is None:
            counts['abstention'] += 1
            continue
        if isinstance(gold_text, str) and CLOCK_PATTERN.search(gold_text):
            counts['clock gold'] += 1
            continue
        gold = _stated_number(gold_text)
        if gold is None:
            counts['non-numeric gold'] += 1
            continue
        stated = _stated_number(answer)
        if stated is None:
            counts['no number stated'] += 1
            continue
        if stated < gold:
            counts['under'] += 1
            if abs(gold - stated) == 1:
                off_by_one['under'] += 1
        elif stated > gold:
            counts['over'] += 1
            if abs(stated - gold) == 1:
                off_by_one['over'] += 1
        else:
            counts['equal'] += 1

    total = sum(counts.values())
    lines = ['', 'MR wrong answers by arithmetic direction (stated vs gold)']
    lines.append(f'  {"direction":<20}{"count":>7}{"share":>9}')
    for direction, count in sorted(counts.items(), key=lambda item: -item[1]):
        if count == 0 and direction in ('clock gold', 'equal'):
            continue
        share = f'{count / total:>8.1%}' if total else f'{"n/a":>8}'
        suffix = ''
        if direction in off_by_one:
            suffix = f'   off by one: {off_by_one[direction]}'
        lines.append(f'  {direction:<20}{count:>7}{share}{suffix}')
    lines.append(f'  {"total":<20}{total:>7}')
    lines.append('')
    lines.append(
        'under/over are directional and are the mechanism; every other bucket is a state in which '
        'direction is undefined. A constant offset of one is the signature of a membership decision '
        'rather than of arithmetic.'
    )
    return '\n'.join(lines)


#: Which route each capability is answered on. Used by `--audit` to decide where a role
#: filter or a reach claim is supposed to apply.
CAPABILITY_ROUTES = {
    'MR': 'multi-session',
    'TR': 'temporal',
    'IE': 'flat',
    'KU': 'knowledge-update',
    'ABS': 'abstention',
}

#: The turn text's own role marker, as the dataset writes it: `[2023/02/15 (Wed) 03:14] user: ...`.
ASSISTANT_TURN = re.compile(r'\]\s*assistant:', re.I)


def audit_section(report: dict, questions: list[dict]) -> tuple[str, int]:
    """Check one artifact's fields against each other, and report the failures.

    ## Why the configuration line has to be auditable

    Three defects in three rounds were found by a person reading an artifact, and none of them
    by a test: `vote=0/0/0` on a run that never voted (§13.104), a reach table that disagreed
    with the fallthrough implementing it (§13.104), and a census that counted consultations
    instead of questions once voting was on (§13.107). Every one is a disagreement **between
    fields of a single run** -- which means every one is decidable without a control, and none
    of them needed the reader who found it.

    ## What a check here is allowed to be

    Only an invariant that holds for every legitimate run. Two shapes that look wrong and are
    not, and are therefore absent:

      * `evidenceTurns` above `relevanceTopK` -- the pool is counted in records and a record
        expands to its turns;
      * turns longer than `maxTurnChars` -- the cap is applied when the prompt is rendered,
        while the roster keeps what was selected.

    A check that fires on a good run is worse than no check: it teaches a reader to skip the
    output, which is how a real failure gets through.

    ## The return value

    The rendered block and the number of failures, so the caller can exit non-zero. A tool that
    printed a failure and exited 0 could not gate a dispatch.
    """
    config = report.get('memoryArmConfig') or {}
    question_count = report.get('questionCount')
    runs = report.get('runs') or 1
    failures: list[str] = []
    lines: list[str] = []

    def check(name: str, ok: bool, detail: str) -> None:
        if not ok:
            failures.append(name)
        lines.append(f'  {"PASS" if ok else "FAIL"}  {name:<14}{detail}')

    total_answers = (question_count * runs) if isinstance(question_count, int) else None
    mr = [question for question in questions if question.get('capability') == 'MR']
    mr_texts = {str(question.get('question')) for question in mr}

    # 1. The roster is the roster the artifact declares.
    check(
        'roster',
        question_count == len(questions),
        f'{len(questions)} records, questionCount says {question_count}',
    )

    # 2. The census counts questions, not model calls (§13.107).
    census = report.get('abstentionReasons') or {}
    census_total = sum(value for value in census.values() if isinstance(value, int))
    check(
        'census-unit',
        total_answers is not None and census_total == total_answers,
        f'{census_total} outcomes, {total_answers} question-answers '
        f'({question_count} x {runs}); a treatment that consults more than once per '
        'question must not inflate this',
    )

    # 3. No prompt exceeded the budget it declares.
    over_budget = [
        question.get('promptChars', 0)
        for question in questions
        if isinstance(question.get('promptChars'), int)
        and question['promptChars'] > (config.get('maxPromptChars') or 10**9)
    ]
    check(
        'budget',
        not over_budget,
        f'largest prompt {max((q.get("promptChars", 0) for q in questions), default=0)} '
        f'against maxPromptChars {config.get("maxPromptChars")}',
    )

    # 4. The reach names only routes the run rendered, and names none when no ask was dispatched.
    reach = list(config.get('askRoutes') or [])
    rendered = set(config.get('renderingRoutes') or [])
    unreached = sorted(set(reach) - rendered)
    empty_matches = (len(reach) == 0) == (config.get('ask') == 'route')
    check(
        'reach',
        not unreached and empty_matches,
        f'ask={config.get("ask")} touches {reach}'
        + (f', of which {unreached} never rendered' if unreached else '')
        + ('' if empty_matches else '; an empty reach must mean the shipped ask and only that'),
    )

    # 5. The vote census exists exactly when the run voted, and sums to the votes taken.
    vote = config.get('voteCounts')
    voting = (config.get('selfConsistency') or 'none') != 'none'
    vote_total = sum(vote.values()) if isinstance(vote, dict) else 0
    expected_votes = len(mr) * runs
    if voting:
        check(
            'vote',
            isinstance(vote, dict) and vote_total == expected_votes,
            f'selfConsistency={config.get("selfConsistency")} with census '
            f'{vote if isinstance(vote, dict) else "absent"}; {expected_votes} votes expected',
        )
    else:
        check(
            'vote',
            not isinstance(vote, dict) or vote_total > 0,
            'one consultation per question, so no census may be published'
            + (' -- a zeroed census claims a mechanism that never ran' if vote_total == 0 and isinstance(vote, dict) else ''),
        )

    # 6. The expansion counts exist exactly when the run expanded, and name every MR question.
    expansion = config.get('queryExpansionCounts')
    expanding = (config.get('queryExpansion') or 'none') != 'none'
    if expanding:
        named = expansion.get('questions') if isinstance(expansion, dict) else None
        check(
            'expansion',
            named == len(mr_texts),
            f'queryExpansion={config.get("queryExpansion")} reporting '
            f'{named} question(s) expanded; the roster has {len(mr_texts)} distinct MR texts',
        )
    else:
        check(
            'expansion',
            expansion is None,
            'no expansion dispatched, so no counts may be published',
        )

    # 7. A user-only route carries no assistant turn.
    roles = list(config.get('evidenceRoles') or [])
    role_routes = set(config.get('evidenceRolesRoutes') or [])
    offending: list[str] = []
    if roles == ['user']:
        for question in questions:
            route = CAPABILITY_ROUTES.get(str(question.get('capability')))
            if route not in role_routes:
                continue
            turns = question.get('turns') or []
            if any(ASSISTANT_TURN.search(str(turn.get('text', ''))) for turn in turns):
                offending.append(str(question.get('questionId')))
    check(
        'roles',
        not offending,
        f'evidenceRoles={roles} on {sorted(role_routes)}'
        + (
            f'; {len(offending)} window(s) carry an assistant turn, first {offending[0]}'
            if offending
            else '; no window on those routes carries one'
        ),
    )

    header = [
        '',
        'artifact audit (each field checked against another field of the same run)',
    ]
    footer = [
        '',
        (
            'every check is an invariant of a legitimate run; two shapes that look wrong and are '
            'not are deliberately absent (evidenceTurns above the pool width, and turns longer than '
            'maxTurnChars -- the pool is counted in records and the cap is applied at render time)'
        ),
    ]
    return '\n'.join(header + lines + footer), len(failures)


def stability_section(after: list[dict], before: list[dict]) -> str:
    """How much of the answer layer moves when nothing about the configuration does.

    ## The question this answers, and why it had to be built

    §13.98.2 read 24 of 127 temporal answers changing between two runs on a route whose
    prompt was identical to the character, and had to say so with a script written for that
    section. That is the defect §13.38 recorded three times: a number a later reader cannot
    re-derive. The number is the **noise floor**, and every future registration has to be
    stated against it -- so it needs a definition a reader can run.

    ## Two counts, not one

    `text-changed` counts answers whose text differs; `state-changed` counts answers whose
    scored state differs. A run that re-words `three` into `3` and keeps the point has a
    text change and no instability, and collapsing the two would make that run look as
    unsteady as one that changed its mind. The transition block below the table is the
    state view only, for the same reason `--paired` prints one.

    ## The treated route is called out separately

    The floor is per capability, and the capability a treatment reached is the one whose
    movement is being claimed. Printing it again as a single line keeps a reader from
    adding a treated route's movement to an untreated route's and calling the sum noise.
    """
    classifier = _load_classifier()
    before_by_id = {str(question.get('questionId')): question for question in before}
    after_by_id = {str(question.get('questionId')): question for question in after}
    if set(before_by_id) != set(after_by_id):
        missing = sorted(set(before_by_id) ^ set(after_by_id))
        raise ValueError(
            f'the two rosters do not name the same questions: {len(missing)} id(s) are missing '
            f'from one side ({", ".join(missing[:5])}{"..." if len(missing) > 5 else ""}). '
            'A missing id counted as movement would inflate the noise floor.'
        )

    def state(question: dict) -> str:
        return 'correct' if question.get('correct') else classifier.failure_shape(question)

    by_capability: dict[str, dict[str, object]] = {}
    for identifier, question in after_by_id.items():
        capability = str(question.get('capability', '?'))
        row = by_capability.setdefault(
            capability, {'compared': 0, 'text': 0, 'state': 0, 'transitions': {}}
        )
        was_question = before_by_id[identifier]
        row['compared'] = int(row['compared']) + 1  # type: ignore[arg-type]
        if was_question.get('answer') != question.get('answer'):
            row['text'] = int(row['text']) + 1  # type: ignore[arg-type]
        was, now = state(was_question), state(question)
        if was != now:
            row['state'] = int(row['state']) + 1  # type: ignore[arg-type]
            transitions = row['transitions']
            assert isinstance(transitions, dict)
            transitions[(was, now)] = transitions.get((was, now), 0) + 1

    lines = [
        '',
        'answer stability, before/after (one configuration read twice: the noise floor)',
        f'  {"capability":<12}{"compared":>10}{"text-changed":>14}{"share":>8}{"state-changed":>15}',
    ]
    totals = {'compared': 0, 'text': 0, 'state': 0}
    for capability in sorted(by_capability):
        row = by_capability[capability]
        compared = int(row['compared'])
        text = int(row['text'])
        changed = int(row['state'])
        totals['compared'] += compared
        totals['text'] += text
        totals['state'] += changed
        lines.append(
            f'  {capability:<12}{compared:>10}{text:>14}{text / compared:>7.1%}{changed:>15}'
        )
    lines.append(
        f'  {"TOTAL":<12}{totals["compared"]:>10}{totals["text"]:>14}'
        f'{totals["text"] / totals["compared"]:>7.1%}{totals["state"]:>15}'
    )

    lines.append('')
    lines.append('state transitions (before and after, from the shared taxonomy)')
    for capability in sorted(by_capability):
        transitions = by_capability[capability]['transitions']
        assert isinstance(transitions, dict)
        if not transitions:
            continue
        rendered = ', '.join(
            f'{was} -> {now} {count}'
            for (was, now), count in sorted(transitions.items(), key=lambda item: -item[1])
        )
        lines.append(f'  {capability}: {rendered}')

    lines.append('')
    lines.append(
        'text-changed counts a different answer string; state-changed counts a different score. '
        'Only the second is instability, and re-worded answers that keep their score are counted '
        'as the first.'
    )
    return '\n'.join(lines)


def evidence_roles(report: dict) -> list[str] | None:
    """The roles the run admitted, or `None` when it admitted every turn.

    Read rather than assumed, for §13.81.5's reason applied to a third quantity: this run's
    `--pool` table is only exhaustive when every turn could reach the prompt, and a reader that
    did not know the filter was on would attribute a policy to the budget.
    """
    config = report.get('memoryArmConfig')
    if not isinstance(config, dict):
        return None
    roles = config.get('evidenceRoles')
    if not isinstance(roles, list) or not roles:
        return None
    return [str(role) for role in roles]


def _has_total_all(question: dict) -> bool:
    """Whether this record's gold denominator already follows the run's role policy."""
    overlap = question.get('goldOverlap')
    return isinstance(overlap, dict) and isinstance(overlap.get('totalAll'), int)


def pool_section(questions: list[dict], roles: list[str] | None = None) -> tuple[str, int]:
    """Where the gold went: never surfaced, cut by the budget, or delivered.

    ## The question this answers, and why it needed a new field

    `goldOverlap` carried `carried` and `total` from §13.16 onward, which says how much gold
    reached the reader and not where the rest went -- and the two destinations need opposite
    repairs. §13.62 added `pool` so the gold set partitions:

        total - pool      the ranking never surfaced it
        pool  - carried   the ranking had it and the budget cut it
        carried           it reached the reader

    ## The absence, which is why this is not a subtraction over zeroes

    A record with no `pool` was produced by a run that consulted no ranking, or before the
    field existed. Summing those as zero would report a ranking that surfaced none of the
    gold where no ranking ran, so they are counted separately and said so. An artifact with
    no pool anywhere refuses rather than printing a table of zeroes.

    ## The two directions, and the regime that has both

    Below the pool's width the room refuses gold the ranking offered; above it the room reaches
    gold the ranking never offered, because the selection continues past the scored set. §13.68's
    cap is what first put a window above the pool width (68 turns against 64), and the first
    version of this table printed the second direction as a **negative** cut on run `39180819474`
    -- and called it a caller defect. Both columns are now clamped at zero and both are labelled,
    so a row says which of the two it is instead of leaving a minus sign to mean one of them.

    ## The impossible row

    `pool > total` and `carried > total` cannot happen: the ranking cannot surface more gold than
    the dataset names, and a prompt cannot deliver more than it was shown. Those are counted and
    printed rather than clamped or dropped, because a caller defect that reads as a plausible row
    is the failure mode the campaign has spent seven sections removing.
    """
    by_capability: dict[str, list[tuple[int, int, int]]] = {}
    without_pool = 0
    impossible = 0
    for question in questions:
        overlap = question.get('goldOverlap')
        if not isinstance(overlap, dict):
            continue
        total = overlap.get('total')
        carried = overlap.get('carried')
        if not isinstance(total, int) or not isinstance(carried, int):
            continue
        pool = overlap.get('pool')
        if not isinstance(pool, int):
            without_pool += 1
            continue
        # `carried > pool` is NOT a defect: with a window wider than the pool the selection
        # continues into unscored turns and delivers gold the ranking never offered. Only these
        # two are impossible -- a ranking cannot surface more gold than the dataset names, and a
        # prompt cannot deliver more than it was shown.
        if pool > total or carried > total:
            impossible += 1
        capability = str(question.get('capability', '?'))
        by_capability.setdefault(capability, []).append((total, carried, pool))

    measured = sum(len(rows) for rows in by_capability.values())
    if measured == 0:
        return '', 0

    lines = ['', 'where the gold went (goldOverlap: total, carried, pool)']
    lines.append(
        f'  {"capability":<10}{"n":>5}{"gold":>7}{"never surfaced":>16}{"cut by the budget":>19}'
        f'{"beyond the pool":>17}{"delivered":>11}'
    )
    totals = [0, 0, 0, 0]
    beyond_total = 0
    for capability in sorted(by_capability):
        rows = by_capability[capability]
        gold = sum(row[0] for row in rows)
        carried = sum(row[1] for row in rows)
        pool = sum(row[2] for row in rows)
        # The two directions are different quantities and only one of them can be positive.
        # Below the pool's width the room refuses gold the ranking offered; above it the room
        # reaches gold the ranking never offered, because the selection continues past the
        # scored set. Printing the second as a negative first would report a cut that ran
        # backwards -- which is what the first version of this table did on run `39180819474`.
        cut = max(0, pool - carried)
        beyond = max(0, carried - pool)
        lines.append(
            f'  {capability:<10}{len(rows):>5}{gold:>7}{gold - pool:>16}{cut:>19}'
            f'{beyond:>17}{carried:>11}'
        )
        totals[0] += gold
        totals[1] += carried
        totals[2] += pool
        beyond_total += beyond
    lines.append(
        f'  {"TOTAL":<10}{measured:>5}{totals[0]:>7}{totals[0] - totals[2]:>16}'
        f'{max(0, totals[2] - totals[1]):>19}{beyond_total:>17}{totals[1]:>11}'
    )
    lines.append(
        '  "never surfaced" is the ranking\'s reach; "cut by the budget" is the order above '
        'the cut; "beyond the pool" is gold the room reached that the ranking never offered, '
        'which is possible only when the window is wider than the pool.'
    )
    if without_pool:
        lines.append(f'  {without_pool} record(s) without a pool: no ranking was consulted, '
                     'or the artifact predates the field')
    if roles is not None:
        # Two states, and they need different words. Since §13.85 the denominator follows the
        # policy, so a filtered artifact made after it carries `totalAll` on the records whose
        # gold the policy narrowed and the partition is exhaustive over the gold the policy
        # admits. An artifact made before it counts every gold turn against a delivery that can
        # only carry admitted roles -- §13.84's MR read 48.35% that way, and its "cut by the
        # budget" rose from 301 to 1,710 on a budget that never moved.
        narrowed = sum(1 for question in questions if _has_total_all(question))
        if narrowed:
            lines.append(
                f'  NOTE: this run admitted only {", ".join(roles)}, and its denominators follow '
                f'that policy ({narrowed} record(s) carry `totalAll`). The partition is exhaustive '
                'over the gold the policy admits; gold in an excluded role is not in `total` and '
                'is therefore in no column here.'
            )
        else:
            lines.append(
                f'  NOTE: this run admitted only {", ".join(roles)} but its denominators do NOT '
                'follow that policy, so "cut by the budget" is `pool - carried` against every '
                'gold turn -- gold in an excluded role is counted there whether or not the budget '
                'reached it. The column mixes policy with room and is NOT a budget reading on '
                'this artifact.'
            )
    if beyond_total:
        lines.append(
            f'  {beyond_total} gold turn(s) arrived from outside the pool: the window holds '
            'more turns than the ranking scored, so selection continues past the scored set '
            'rather than stopping at it (§13.72).'
        )
    if impossible:
        lines.append(
            f'  {impossible} record(s) have pool > total or carried > total: the ranking '
            'cannot surface more gold than the dataset names, and no prompt can deliver more '
            'than it was shown -- a caller defect, reported rather than clamped'
        )
    return '\n'.join(lines), measured


# The cut points the rank curve reports.
#
# Three, and they are the three the argument needs rather than a sweep: 8 is roughly the
# head of a window a model reads attentively, 16 is a third of the pool, and 32 is half of
# it. A deeper sweep would describe the curve without changing the decision it feeds.
RANK_CUTS = (8, 16, 32)


def ranks_section(questions: list[dict]) -> tuple[str, int]:
    """How many of a question's gold turns sit in the top 8 / 16 / 32 of the ordered pool.

    ## The question this answers, and why a count could not

    `--pool` says how many gold turns the ranking surfaced and how many the budget then cut.
    It cannot say whether the cut ones were **ordered just below the cut** -- where a better
    order is the lever -- or **far below it**, where no order helps and the room is. §13.64.7
    left MR's 903 budget-cut gold turns exactly there.

    A rank makes the difference one subtraction. Gold at rank 30 against a room of 26 is a
    near miss; gold at rank 500 is not in the argument at all.

    ## Why the percentages are of the gold, not of the questions

    A question with 24 gold turns and one with 2 should not weigh the same when the claim is
    about how much of the gold a cut reaches. The per-question median is printed beside it so
    a reader can see whether the aggregate is carried by a few large questions.
    """
    rows: list[tuple[str, list[int]]] = []
    for question in questions:
        overlap = question.get('goldOverlap')
        if not isinstance(overlap, dict):
            continue
        ranks = overlap.get('goldRanks')
        if not isinstance(ranks, list):
            continue
        rows.append((str(question.get('capability', '?')), [r for r in ranks if isinstance(r, int)]))

    if not rows:
        return '', 0

    by_capability: dict[str, list[list[int]]] = {}
    for capability, ranks in rows:
        by_capability.setdefault(capability, []).append(ranks)

    lines = ['', f'gold ranks in the ordered pool (cuts {", ".join(str(c) for c in RANK_CUTS)}, -1 = not surfaced)']
    header = f'  {"capability":<10}{"n":>5}{"gold":>7}'
    for cut in RANK_CUTS:
        header += f'{f"top {cut}":>9}'
    header += f'{"surfaced":>10}'
    lines.append(header)

    totals = {'n': 0, 'gold': 0, **{cut: 0 for cut in RANK_CUTS}, 'surfaced': 0}
    for capability in sorted(by_capability):
        groups = by_capability[capability]
        gold = [rank for ranks in groups for rank in ranks]
        counts = {cut: sum(1 for rank in gold if 0 <= rank < cut) for cut in RANK_CUTS}
        surfaced = sum(1 for rank in gold if rank >= 0)
        line = f'  {capability:<10}{len(groups):>5}{len(gold):>7}'
        for cut in RANK_CUTS:
            line += f'{counts[cut]:>9}'
        line += f'{surfaced:>10}'
        lines.append(line)
        totals['n'] += len(groups)
        totals['gold'] += len(gold)
        for cut in RANK_CUTS:
            totals[cut] += counts[cut]
        totals['surfaced'] += surfaced

    line = f'  {"TOTAL":<10}{totals["n"]:>5}{totals["gold"]:>7}'
    for cut in RANK_CUTS:
        line += f'{totals[cut]:>9}'
    line += f'{totals["surfaced"]:>10}'
    lines.append(line)

    lines.append('')
    for cut in RANK_CUTS:
        share = totals[cut] / totals['gold'] if totals['gold'] else 0
        lines.append(f'  top {cut:>2}: {totals[cut]:>5} of {totals["gold"]} gold turns = {share:6.1%}')
    lines.append(
        '  the gap between top 8 and top 32 is what a better ORDER could buy; the gap between '
        'top 32 and surfaced is what a larger ROOM could buy; below surfaced, only the ranking can.'
    )
    return '\n'.join(lines), len(rows)


# The per-turn caps the length table reports.
#
# Four, and they bracket the delivered median of 272 characters: 200 is below it, 400 and
# 600 are the region where most of the tail disappears, and 900 is the point where the
# saving falls under half. A sweep finer than this would describe the curve without
# changing the choice the table feeds.
TURN_CAPS = (200, 400, 600, 900)


def turns_section(questions: list[dict]) -> tuple[str, int]:
    """How long the delivered turns are, and how many more would fit under a per-turn cap.

    ## Why the distribution is the measurement, not the count

    §13.34.3 concluded the room is sufficient because it holds a median of 26 turns against
    a median gold set of 24. §13.67 found the other half: the delivered turns have a
    **median of 272 characters**, so 26 of them are 7,072 characters in a 24,000-character
    room. The room is not spent on turns of typical size -- it is spent on a tail, and a
    per-turn cap buys back most of it.

    The saving is computed on the turns the artifact actually carries, so "2.76x more turns
    would fit" is arithmetic over this run rather than an assumption about a corpus.
    """
    lengths: list[int] = []
    rosters: list[int] = []
    for question in questions:
        turns = question.get('turns')
        if not isinstance(turns, list):
            continue
        texts = [turn['text'] for turn in turns if isinstance(turn, dict) and isinstance(turn.get('text'), str)]
        if not texts:
            continue
        rosters.append(len(texts))
        lengths.extend(len(text) for text in texts)

    if not lengths:
        return '', 0

    ordered = sorted(lengths)
    total = sum(lengths)
    median = ordered[len(ordered) // 2]
    lines = ['', 'turn lengths (the character budget is spent on these)']
    lines.append(f'  turns {len(lengths)}, median {median} chars, mean {total / len(lengths):.0f}, '
                 f'roster median {sorted(rosters)[len(rosters) // 2]} per question')
    lines.append(f'  total {total} chars; p90 {ordered[int(len(ordered) * 0.9)]}, max {ordered[-1]}')
    lines.append('')
    lines.append(f'  {"cap":>6}{"chars saved":>14}{"share":>8}{"turns that would fit":>22}')
    for cap in TURN_CAPS:
        saved = sum(max(0, length - cap) for length in lengths)
        share = saved / total if total else 0
        factor = 1 / (1 - share) if share < 1 else float('inf')
        lines.append(f'  {cap:>6}{saved:>14}{share:>8.1%}{f"{factor:.2f}x":>22}')
    lines.append(
        '  "turns that would fit" is the same character room holding turns truncated to the '
        'cap, i.e. what a per-turn cap buys in exchange for cutting each turn at that length.'
    )
    return '\n'.join(lines), len(rosters)


# The prompt budget the arm assembles under when a run names none, in UTF-16 code units.
#
# `DEFAULT_MAX_PROMPT_CHARS` in `packages/cortex-memory/src/prompt.ts`, restated here because
# this tool reads a JSON artifact and cannot import TypeScript. It is asserted in that
# package's tests, so the copy cannot drift silently.
#
# It is a **default**, not the budget: since §13.81 the arm has an input (`maxPromptChars`) and
# an artifact reports the value it ran under. This constant is what an artifact produced before
# that input existed was assembled at, and dividing every artifact by it was a reader defect
# waiting for the first run that spent more than it -- see `prompt_budget`.
DEFAULT_PROMPT_BUDGET_CHARS = 24_000


def prompt_budget(report: dict) -> tuple[int, str]:
    """The character budget this artifact was produced under, and where the reader got it.

    ## Why the divisor cannot be a constant

    Every reading in `window_section` is a ratio against the budget: turns carried, characters
    spent, and the share of the room they filled. §13.81 made the budget a dispatched input, so
    an artifact from that run carries `memoryArmConfig.maxPromptChars: 48000` while the constant
    is 24,000 -- and the first table built on it would have reported **200% of budget** on a
    prompt that fitted perfectly. That is not a cosmetic error: §13.81's prediction 1 is
    "the room grows", this table is its mechanism check, and a doubled fill would have been read
    as the allocator overflowing when it was the reader that failed to read the run.

    ## Absent means the default, which is a value and not a gap

    The arm omits the field exactly when the input was not set, and an unset input means the
    product's default: 24,000. So absence is decided, not unknown, and the table names which
    divisor it used so a historical artifact is still readable and a current one is checkable.

    ## Zero and negatives are refused rather than clamped

    The arm rejects a non-positive budget at startup (`readMaxPromptChars`), so a zero here is a
    corrupt artifact -- and dividing by it would print an infinite fill, describing evidence
    carried in a zero-character room. `True` is rejected beside them because Python's `bool` is
    an `int` and a producer that serialised a flag into this field must not read as a budget of 1.
    """
    config = report.get('memoryArmConfig')
    named = config.get('maxPromptChars') if isinstance(config, dict) else None
    if named is None:
        return DEFAULT_PROMPT_BUDGET_CHARS, 'default'
    if isinstance(named, bool) or not isinstance(named, int) or named <= 0:
        raise ValueError(
            f'memoryArmConfig.maxPromptChars is {named!r}: a budget must be a positive integer, '
            'and the arm rejects anything else at startup, so this artifact is corrupt'
        )
    return named, 'configured'


def window_section(questions: list[dict], budget: int, source: str) -> tuple[str, int]:
    """How many turns the prompt held, and how much of the budget they spent.

    ## The two readings a coverage number cannot separate

    A per-turn cap can raise coverage because the room now holds more turns, or it can raise
    nothing because the roster already fitted and the cap only shortened turns that were not
    the constraint. `--coverage` reports the outcome; this reports the mechanism, and the two
    only mean something together (§13.68's prediction 1 is the outcome, this table is why).

    ## Why medians and not means

    The artifacts are skewed: a question carrying one 15,369-character turn and one carrying
    twenty short ones are both real, and means over them describe a prompt nobody sent. Median
    turns, median characters, and the median turn length are each a statement about the
    typical question -- and the per-capability split exists because §13.66 measured that the
    capabilities differ by more than one standard error.

    ## Why a missing `promptChars` refuses rather than counting as zero

    Zero would read as "this prompt spent none of its budget", which is a measurement. The
    field's absence means either that the artifact predates it or that the route assembled no
    prompt, and neither is a fill of 0%.
    """
    by_capability: dict[str, list[tuple[int, int]]] = {}
    without = 0
    for question in questions:
        turns = question.get('turns')
        chars = question.get('promptChars')
        if not isinstance(turns, list):
            continue
        if not isinstance(chars, int):
            without += 1
            continue
        by_capability.setdefault(str(question.get('capability', '?')), []).append(
            (len(turns), chars)
        )

    if not by_capability:
        return '', 0

    def median(values: list[int]) -> float:
        ordered = sorted(values)
        middle = len(ordered) // 2
        if len(ordered) % 2:
            return float(ordered[middle])
        return (ordered[middle - 1] + ordered[middle]) / 2

    lines = ['', 'what the prompt window held (turns carried, characters spent)']
    lines.append(
        f'  {"capability":<10}{"n":>5}{"turns":>8}{"chars":>9}{"chars/turn":>12}{"budget":>9}'
    )
    def per_turn(rows: list[tuple[int, int]]) -> float:
        """Median of each question's own chars-per-turn, not the ratio of the two medians.

        The difference is not pedantry: dividing the median characters by the median turns
        answers "what would a median prompt spend on a median count", which no single question
        is. The median of the per-question ratios answers "how long is a typical turn in the
        prompt", which is the quantity a per-turn cap acts on.
        """
        return median([int(chars / turns) for turns, chars in rows if turns > 0])

    for capability in sorted(by_capability):
        rows = by_capability[capability]
        turns = median([row[0] for row in rows])
        chars = median([row[1] for row in rows])
        fill = chars / budget
        lines.append(
            f'  {capability:<10}{len(rows):>5}{turns:>8.1f}{chars:>9.0f}'
            f'{per_turn(rows):>12.0f}{fill:>8.1%}'
        )
    every = [row for rows in by_capability.values() for row in rows]
    turns = median([row[0] for row in every])
    chars = median([row[1] for row in every])
    fill = chars / budget
    lines.append(
        f'  {"TOTAL":<10}{len(every):>5}{turns:>8.1f}{chars:>9.0f}'
        f'{per_turn(every):>12.0f}{fill:>8.1%}'
    )
    # Which divisor, said on the line that uses it. `default` is a fact about the artifact -- the
    # arm omits the field when the input was unset -- and `configured` means the run named its own
    # budget, which is the only case where this table and the run disagree unless it is read.
    divisor = (
        "this run's own `maxPromptChars`"
        if source == 'configured'
        else 'the default, since the artifact names no `maxPromptChars`'
    )
    lines.append(
        f'  medians, and "budget" is the evidence carried as a share of the {budget:,}-character '
        f'prompt budget ({divisor}); instructions, the question and the section header sit '
        'outside it, so a prompt near 100% is at the cut, which is the state a per-turn cap '
        'changes.'
    )
    # The impossible state, counted rather than clamped. `promptChars` is the evidence the prompt
    # carried AFTER the budget cut, so it cannot exceed the budget the run assembled under: a
    # fill above 100% is either a divisor that is not the run's or a producer reporting the offer
    # instead of the delivery, and both are defects that would otherwise read as a measurement.
    over = sum(1 for _, chars in every if chars > budget)
    if over:
        lines.append(
            f'  {over} record(s) over budget: the prompt reports carrying more evidence than '
            f'{budget:,} characters allow. Either this divisor is not the budget the run '
            'assembled under, or the producer reported the offer (evidenceChars) instead of the '
            'delivery (promptChars). A fill above 100% is not a measurement.'
        )
    if without:
        lines.append(
            f'  {without} record(s) without promptChars: the artifact predates the field, or '
            'the route assembled no prompt -- not a fill of zero'
        )
    return '\n'.join(lines), len(every)


# Which route each capability answers on. The mapping is the runner's (`benchmark.ts` routes MR
# to `answerSessions`, TR to `answerTemporal`, ABS to `answerAbstention`, KU to
# `answerKnowledgeUpdate` and everything else to `answer`), restated here because this tool reads
# a JSON artifact and cannot import it. Only MR and TR are load-bearing today: they are the two
# routes the cap reaches, so they are the two whose rendered size depends on this table.
CAPABILITY_ROUTE = {
    'MR': 'multi-session',
    'TR': 'temporal',
    'ABS': 'abstention',
    'KU': 'knowledge-update',
    'IE': 'flat',
}

# The role prefix this dataset's haystack rendering uses. Anchored at the start with a non-empty
# bracketed stamp, so a turn that merely mentions `assistant:` later is not mislabelled -- the
# same shape the arm's classifier uses, restated for the reason the route map is.
ROLE_PREFIX = re.compile(r'^\[[^\]]+\]\s*(user|assistant)\s*:', re.I)


def capability_spreads(report: dict) -> tuple[dict, dict] | None:
    """The per-capability correct counts across repetitions, and their denominators.

    ## Why the artifact needs its own reader

    Every per-capability count elsewhere in this tool is **one repetition's** -- the roster is the
    first pass. `featureAggregate` beside it is a mean over all of them. §13.87's replication is
    what that cost: the same configuration, code and data moved MR from 90 to 83 between two runs,
    and no section could say whether the movement was the treatment or the pass.

    `None` means the artifact cannot answer: it predates §13.88, or the run had one repetition and
    the field is absent by design.
    """
    ablation = report.get('ablation')
    if not isinstance(ablation, dict):
        return None
    spreads = ablation.get('featureByCapability')
    totals = ablation.get('questionsByCapability')
    if not isinstance(spreads, dict) or not isinstance(totals, dict) or not spreads:
        return None
    return spreads, totals


def caps_section(spreads: dict, totals: dict) -> str:
    """The per-capability spread as a table, in the counts the roster uses."""
    lines = ['', 'per capability across repetitions (correct counts, min / mean / max)']
    lines.append(f'  {"capability":<12}{"total":>7}{"min":>7}{"mean":>8}{"max":>7}{"accuracy":>11}')
    grand = [0.0, 0.0, 0.0, 0]
    for capability in sorted(spreads):
        spread = spreads[capability]
        total = totals.get(capability)
        if not isinstance(spread, dict) or not isinstance(total, int) or total <= 0:
            continue
        low = spread['min']
        mean = spread['avg']
        high = spread['max']
        grand[0] += low
        grand[1] += mean
        grand[2] += high
        grand[3] += total
        lines.append(
            f'  {capability:<12}{total:>7}{low:>7}{mean:>8.1f}{high:>7}{mean / total:>10.1%}'
        )
    lines.append(
        f'  {"TOTAL":<12}{grand[3]:>7}{grand[0]:>7.0f}{grand[1]:>8.1f}{grand[2]:>7.0f}'
        f'{grand[1] / grand[3]:>10.1%}'
    )
    lines.append(
        '  "accuracy" is the MEAN correct over the repetitions divided by the capability\'s question'
        ' count -- the unit the register uses. The roster elsewhere in this tool is the FIRST'
        ' repetition, and the two differ by the spread shown here.'
    )
    return '\n'.join(lines)


def turn_cap(report: dict) -> tuple[int | None, list[str] | None]:
    """The per-turn cap this run applied, and the routes it reached, both read from the artifact.

    §13.81.5's rule, applied to a second quantity: a reader that assumed the cap would describe a
    prompt nobody sent. `maxTurnChars` is absent when no cap ran, and `maxTurnCharsRoutes`
    is absent when the reach was every route.
    """
    config = report.get('memoryArmConfig')
    if not isinstance(config, dict):
        return None, None
    cap = config.get('maxTurnChars')
    if isinstance(cap, bool) or not isinstance(cap, int) or cap <= 0:
        cap = None
    reach = config.get('maxTurnCharsRoutes')
    if not isinstance(reach, list) or not all(isinstance(name, str) for name in reach):
        reach = None
    return cap, reach


def roles_section(
    questions: list[dict], cap: int | None, reach: list[str] | None
) -> tuple[str, int]:
    """How much of the rendered evidence room came from each role.

    ## The question this answers

    §13.82 measured the composition of the 48,000-character room by hand and found 51.9% of the
    multi-session route's rendered characters were assistant turns, while the reference pipeline
    reaches 85.95% on that capability at half the budget by reading user turns only. §13.83
    registers that filter and its first prediction is a mechanism claim -- the user share rises
    above 95% -- that no number in the artifact states. This table states it.

    ## Why the cap is applied here rather than assumed absent

    The record's `turns` carry the turns as they were selected, **before** the per-turn cap; the
    prompt printed them capped. A share computed from the raw texts would describe a prompt
    nobody sent, and it would do so in the direction that overstates the assistant's share --
    assistant turns are the long ones, so the uncapped arithmetic would make the problem look
    worse than it was and the treatment look better than it is.

    ## Why an unreadable role is its own column

    Folding it into either role is the same defect as a filter that drops the turn it cannot
    classify: a classifier failure would read as a measurement. The column exists so a bug in the
    reader or in the data shows up as a number rather than as a share.
    """
    totals: dict[str, dict[str, int]] = {}
    counts: dict[str, int] = {}
    for question in questions:
        turns = question.get('turns')
        if not isinstance(turns, list):
            continue
        capability = str(question.get('capability', '?'))
        route = CAPABILITY_ROUTE.get(capability)
        capped = cap if (cap is not None and (reach is None or route in reach)) else None
        row = totals.setdefault(capability, {'user': 0, 'assistant': 0, 'unreadable': 0})
        counts[capability] = counts.get(capability, 0) + 1
        for turn in turns:
            text = turn.get('text') if isinstance(turn, dict) else None
            if not isinstance(text, str):
                continue
            match = ROLE_PREFIX.match(text)
            role = match.group(1).lower() if match is not None else 'unreadable'
            row[role] += len(text) if capped is None else min(len(text), capped)

    measured = sum(counts.values())
    if measured == 0:
        return '', 0

    lines = ['', 'what the evidence room is made of (rendered characters by role)']
    lines.append(
        f'  {"capability":<10}{"n":>5}{"user":>9}{"assistant":>11}{"unreadable":>12}{"cap":>7}'
    )
    overall = {'user': 0, 'assistant': 0, 'unreadable': 0}
    for capability in sorted(totals):
        row = totals[capability]
        total = row['user'] + row['assistant'] + row['unreadable']
        for role in overall:
            overall[role] += row[role]
        route = CAPABILITY_ROUTE.get(capability)
        cap_label = 'none' if (cap is None or (reach is not None and route not in reach)) else str(cap)
        lines.append(
            f'  {capability:<10}{counts[capability]:>5}'
            f'{row["user"] / total:>8.1%}{row["assistant"] / total:>11.1%}'
            f'{row["unreadable"] / total:>12.1%}{cap_label:>7}'
        )
    total = overall['user'] + overall['assistant'] + overall['unreadable']
    lines.append(
        f'  {"TOTAL":<10}{measured:>5}{overall["user"] / total:>8.1%}'
        f'{overall["assistant"] / total:>11.1%}{overall["unreadable"] / total:>12.1%}'
    )
    lines.append(
        '  shares of the characters the prompt would print, with the run\'s own per-turn cap '
        'applied where its reach covers the route. "unreadable" is turns whose role prefix this '
        'reader could not match -- a column rather than folded into either role, because a '
        'classifier failure must not read as a composition.'
    )
    return '\n'.join(lines), measured


# The Step 1 heading shapes, and the bullet shape, for the list census.
#
# The same two patterns `decline_state` uses, restated here rather than shared, because this
# function asks a different question of them: how many bullets are in the list, not whether the
# list is empty. A shared helper would have to return both and would then be two functions in one.
_LISTS_STEP = re.compile(r'^\s*step\s*(\d+)\s*[\u2014:-]', re.I | re.M)
_LISTS_BULLET = re.compile(r'^\s*(?:[-*\u2022]|\d+[.)])\s+(.*\S)\s*$')

# Language with which a model says it decided *not* to count something.
#
# Deliberately narrow: "not included", "excluded", "already owned". A broad pattern would match
# every hedge and report that every failure explains itself, which is the opposite of the finding
# this column exists to support.
_LISTS_EXCLUSION = re.compile(
    r'not (?:included|counted|stated as|considered)|do not (?:count|include)|excluded|'
    r'already owned|so they are not',
    re.I,
)


def _step_one_items(raw: str) -> int:
    """How many bullets the response wrote under its Step 1 heading, or 0 when there is none."""
    headings = list(_LISTS_STEP.finditer(raw))
    for index, heading in enumerate(headings):
        if int(heading.group(1)) != 1:
            continue
        end = headings[index + 1].start() if index + 1 < len(headings) else len(raw)
        body = raw[heading.end() : end]
        return sum(1 for line in body.splitlines() if _LISTS_BULLET.match(line))
    return 0


# One line per session, as §13.92's ask asks the response to write it: `Session 7: <items>` or
# `Session 7: none`. Bullets and numbering are tolerated because models restyle lists, and the
# session number is required because that is what makes the line a claim about a block of evidence
# rather than a remark.
SWEEP_LINE = re.compile(r'^\s*(?:[-*\u2022]|\d+[.)])?\s*[Ss]ession\s+\d+\s*[:\-\u2014]\s*(.*)$')

# What a session line says when the session holds nothing that matches. The vocabulary is narrow on
# purpose: "0 items" and "no items" are the same claim, and a line naming an item always starts with
# something else.
SWEEP_NOTHING = re.compile(r'^\s*(?:none|no\b|nothing|n/?a|0\b|zero\b)', re.I)


def median(values: list[float]) -> float:
    """The middle of a sorted list, averaging the two middles when the count is even.

    A local definition rather than an import: the tables in this tool have always taken the middle
    of their own sample, and `statistics.median` would return a float for an int sample and change
    the formatting of every table that already prints one.
    """
    if not values:
        return 0.0
    middle = len(values) // 2
    if len(values) % 2 == 1:
        return float(values[middle])
    return (values[middle - 1] + values[middle]) / 2.0


# A gold that is a small count, and therefore a question where a list's length can be compared with
# the number the answer should be. Above ten the comparison stops meaning anything -- a gold of 856 is
# a balance, not a set of items -- and the campaign's §13.92 premise was corrected for exactly that.
COUNT_LOW = 2
COUNT_HIGH = 10

# A bullet or numbered item, which is what an `enumerated` response writes.
LIST_ITEM = re.compile(r'^\s*(?:[-*\u2022]|\d+[.)])\s+\S')


def count_of(value: object) -> int | None:
    """The value as a small count, or `None` when it is not one."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not re.fullmatch(r'\d+', text):
        return None
    number = int(text)
    return number if COUNT_LOW <= number <= COUNT_HIGH else None


def item_lines_of(raw: str, ask: str | None) -> list[str]:
    """The lines of this response that name an item, read in the shape the run's ask produced.

    Two shapes, one reader: an `enumerated` response names items as bullets, and a `sweep` response
    names them after a `Session <n>:` label. Reading both from one function is what lets two runs of
    different asks be compared on the same axis, which is the only comparison §13.92's prediction 2
    makes.
    """
    if ask == 'sweep':
        named: list[str] = []
        for line in raw.split('\n'):
            match = SWEEP_LINE.match(line)
            if match is None:
                continue
            text = match.group(1).strip()
            if text and not SWEEP_NOTHING.match(text):
                named.append(text)
        return named
    return [line.strip() for line in raw.split('\n') if LIST_ITEM.match(line)]


# A number as a gold states it: digits, thousands separators, an optional decimal part. Currency,
# units and words are dropped because the question is whether the digits reached the prompt, not
# whether the sentence around them did.
GOLD_NUMBER = re.compile(r'\d[\d,]*(?:\.\d+)?')


def numbers_of(text: str) -> set[str]:
    """The distinct numbers in a string, commas removed and leading zeros trimmed.

    `1,998` and `1998` are one number; the dataset writes both. Trailing `.0` is kept as written,
    because `2` and `2.0` are different strings in the evidence and collapsing them would report a
    delivery that did not happen.
    """
    out = set()
    for raw in GOLD_NUMBER.findall(text):
        whole, _, fraction = raw.replace(',', '').partition('.')
        # Leading zeros belong to the integer part and to nothing else: `lstrip('0')` on the whole
        # string turns `0.5` into `.5`, which then fails to match the `0.5` the evidence states and
        # reports a delivered number as absent. The first reading of run `39367801501` did exactly
        # that to `7024f17c` and `9aaed6a3`.
        whole = whole.lstrip('0') or '0'
        out.add(f'{whole}.{fraction}' if fraction else whole)
    return out


def final_line_of(raw: str) -> str:
    """The last non-empty line of a response, which is where the answer is asked to be."""
    lines = [line.strip() for line in raw.split('\n') if line.strip()]
    return lines[-1] if lines else ''


def bare_number(value: object) -> str | None:
    """A gold that IS a number, with nothing else in the string.

    Only these are audited. A gold of `3.5 weeks` and a closing line of `3.5` agree, and a gold of
    `a yellow dress` and a closing line of `Yellow dress and a pair of earrings` agree in meaning --
    neither can be decided by string comparison, and pretending otherwise produced 124 "disagreements"
    on the first draft of this table, of which the abstention rows were 29 and the paraphrases most of
    the rest. A bare number is a question whose answer is a quantity, and `2` against `3` is not a
    paraphrase.
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text if re.fullmatch(r'\d+(?:\.\d+)?', text) else None


def final_section(questions: list[dict]) -> tuple[str, int]:
    """Whether the correct answers to quantity questions actually end with their number.

    ## The defect this exists for, measured on run `39389557774`

    §13.92's sweep produced answers that were 44-line session transcripts, and 42 of MR's 60 correct
    answers were graded from such a transcript. Splitting them by what the response's closing line
    says: **11 end with the gold and 31 end with a different number** -- the transcript contained the
    gold somewhere, and the last scoring channel accepted it. The accuracy column cannot show that: a
    run whose answers are transcripts reads as a run that answered.

    ## What it says about the runs the campaign is built on

    On `39367801501`, the adopted configuration reports **0** disagreements on MR against 31 for the
    sweep. The multi-line answers there are ledgers -- `5 + 30 + 10 + 25 + 70 = 140` with `140` as the
    closing line -- and a ledger states its total where this table looks for it. So the audit is not
    an accusation against the archive; it is the check that tells the two shapes apart.
    """
    rows = []
    for question in questions:
        if not question.get('correct'):
            continue
        gold = bare_number(question.get('groundTruth'))
        raw = question.get('rawOutput')
        if gold is None or not isinstance(raw, str) or raw.strip() == '':
            continue
        final = final_line_of(raw)
        # Any number in the closing line, not only a leading one: `The total is 5 days.` states 5,
        # and a rule that demanded the number first would report every prose answer as a
        # disagreement -- which is what the first draft did to all eight of TR's.
        stated = {token.replace(',', '') for token in re.findall(r'\d[\d,]*(?:\.\d+)?', final)}
        agrees = gold in stated
        rows.append(
            {
                'id': str(question.get('questionId', '?')),
                'capability': str(question.get('capability', '?')),
                'agrees': agrees,
                'final': final[:44],
                'gold': gold,
            }
        )
    if not rows:
        return '', 0

    lines = ['', 'do the correct answers to quantity questions end with their number']
    lines.append(f'  {"capability":<12}{"correct":>8}{"agrees":>8}{"disagrees":>10}')
    for capability in sorted({row['capability'] for row in rows}):
        subset = [row for row in rows if row['capability'] == capability]
        agree = sum(1 for row in subset if row['agrees'])
        lines.append(f'  {capability:<12}{len(subset):>8}{agree:>8}{len(subset) - agree:>10}')
    total_agree = sum(1 for row in rows if row['agrees'])
    lines.append(f'  {"TOTAL":<12}{len(rows):>8}{total_agree:>8}{len(rows) - total_agree:>10}')
    bad = [row for row in rows if not row['agrees']]
    if bad:
        lines.append('')
        lines.append(f'  {"question":<16}{"cap":>5}  {"final line":<44}  gold')
        for row in bad[:20]:
            lines.append(
                f'  {row["id"][:16]:<16}{row["capability"]:>5}  {row["final"]:<44}  {row["gold"]}'
            )
    lines.append(
        '  Only golds that ARE a number are audited: a gold of `3.5 weeks` and a closing line of '
        '`3.5` agree, and prose paraphrases cannot be decided by string comparison. A disagreement '
        'here means the response ended with a different number than the one it was scored against.'
    )
    return '\n'.join(lines), len(rows)


def numbers_section(questions: list[dict]) -> tuple[str, int]:
    """Where the gold's numbers are: inside the window, or nowhere in it.

    ## The two failures this separates, and why the separation is worth a table

    §13.92's premise is about the reader's work list, but a wording can only matter if the number is
    there to be found. For each wrong MR answer whose gold states a number, this asks one question:
    do the gold's digits appear anywhere in the turns the prompt carried?

    - **absent** — the number is not in the window at all. That is retrieval, and no instruction
      reaches it.
    - **present** — the digits are in the window and the answer is something else. That is the
      reader's, and it is the only kind of MR error the ask axis can address.

    ## Why "present" is an upper bound on "stated"

    A substring test cannot tell "she paid $720" from "720 days ago", so a present number is not
    proof that the answer was stated. The number of *absent* golds is exact -- a digit string that
    appears nowhere was certainly not read -- and the present count is an upper bound on what a
    wording could fix. Both are stated that way in the output rather than sold as one measurement.
    """
    rows = []
    for question in questions:
        if question.get('capability') != 'MR' or question.get('correct'):
            continue
        gold = numbers_of(str(question.get('groundTruth')))
        if not gold:
            continue
        text = ' '.join(
            turn.get('text', '') if isinstance(turn, dict) else '' for turn in (question.get('turns') or [])
        )
        flat = text.replace(',', '')
        missing = sorted(number for number in gold if number not in flat)
        rows.append(
            {
                'id': str(question.get('questionId', '?')),
                'gold': str(question.get('groundTruth'))[:20],
                'stated': str(question.get('answer'))[:16],
                'missing': missing,
            }
        )
    if not rows:
        return '', 0

    absent = [row for row in rows if row['missing']]
    present = [row for row in rows if not row['missing']]
    lines = ['', 'where the gold numbers are, for the wrong MR answers that state one']
    lines.append(
        f'  wrong with a number in the gold {len(rows)}   '
        f'in the window {len(present)}   absent {len(absent)}'
    )
    lines.append(
        '  "absent" is exact: a digit string that appears nowhere was not read, so that error is '
        'retrieval and no wording reaches it. "in the window" is an upper bound -- a substring test '
        'cannot tell a payment from a date -- so it bounds what the reader could have used.'
    )
    if absent:
        lines.append('')
        lines.append(f'  {"question":<16}{"gold":>20}  {"stated":>16}  missing')
        for row in absent:
            lines.append(
                f'  {row["id"][:16]:<16}{row["gold"]:>20}  {row["stated"]:>16}  '
                f'{", ".join(row["missing"])}'
            )
    return '\n'.join(lines), len(rows)


def counting_section(questions: list[dict], ask: str | None) -> tuple[str, int]:
    """The counting questions: what the answer was, and how long the list behind it was.

    ## Why this is a table and not a filter on `--lists`

    §13.92's premise had to be corrected once already. Comparing a list's length with the gold
    *number* is only meaningful when the gold **is** a count: of the sixteen wrong numeric MR
    answers, twelve had a shorter list, and six of those twelve were questions whose gold is 23, 50,
    100, 856 -- amounts and durations, where a two-item list is not an under-enumeration. Restricted
    to counts from 2 to 10 the same artifact gives **six of ten wrong**, and that is the number the
    registration uses. A table that does not restrict itself would keep producing the other one.
    """
    rows = []
    for question in questions:
        if question.get('capability') != 'MR':
            continue
        gold = count_of(question.get('groundTruth'))
        raw = question.get('rawOutput')
        if gold is None or not isinstance(raw, str) or raw.strip() == '':
            continue
        named = item_lines_of(raw, ask)
        stated = question.get('answer')
        rows.append(
            {
                'id': str(question.get('questionId', '?')),
                'correct': bool(question.get('correct')),
                'gold': gold,
                'items': len(named),
                'stated': stated,
            }
        )
    if not rows:
        return '', 0

    def tally(rows: list[dict]) -> tuple[int, int, int]:
        under = sum(1 for row in rows if row['items'] < row['gold'])
        equal = sum(1 for row in rows if row['items'] == row['gold'])
        over = sum(1 for row in rows if row['items'] > row['gold'])
        return under, equal, over

    right = [row for row in rows if row['correct']]
    wrong = [row for row in rows if not row['correct']]
    lines = ['', f'the counting questions (MR, gold an integer from {COUNT_LOW} to {COUNT_HIGH})']
    lines.append(f'  shape read: {"session lines" if ask == "sweep" else "bullets"} (ask={ask!r})')
    for label, subset in (('correct', right), ('wrong', wrong)):
        under, equal, over = tally(subset)
        median_items = median(sorted(row['items'] for row in subset)) if subset else 0.0
        lines.append(
            f'  {label:<9}{len(subset):>4}   list shorter {under:>3}   equal {equal:>3}   '
            f'longer {over:>3}   median items {median_items:.1f}'
        )
    lines.append('')
    # The id is printed because a registration names questions: §13.92.2's fourth prediction is about
    # six ids, and a table of lengths that cannot be joined to those ids cannot decide it.
    lines.append(f'  {"question":<16}{"items":>6}{"gold":>6}  {"stated":>18}  flags')
    for row in wrong:
        flags = []
        if row['items'] < row['gold']:
            flags.append('under-lists')
        if row['items'] == row['gold']:
            flags.append('counts right')
        lines.append(
            f'  {row["id"][:16]:<16}{row["items"]:>6}{row["gold"]:>6}  '
            f'{str(row["stated"])[:18]:>18}  {", ".join(flags)}'
        )
    lines.append(
        '  the table lists the WRONG answers only. "counts right" means the response named the gold '
        'number of items and stated something else -- arithmetic rather than enumeration.'
    )
    return '\n'.join(lines), len(rows)


def sweep_section(questions: list[dict]) -> tuple[str, int]:
    """What the responses' session lines hold, and what the stated number was.

    ## The question this answers

    §13.92 replaces "write the list" with "write a line for every session", because the lists of run
    `39367801501` are **2.0 items** long for right and wrong answers alike while the windows hold
    ~174 turns in about thirty sessions. This reads the shape that treatment asks for: how many
    session lines a response wrote, how many of them name an item, and what number it stated.

    ## Why the record's own text, and not the prompt

    The roster carries the carried turns but not the session boundaries the renderer printed, so the
    number of sessions in a window cannot be recovered from the artifact. What can be read is the
    response, and that is the mechanism claim in any case: before this ask, a response writes
    **zero** session lines; the prediction is that after it, the median is well above ten.

    ## Why `--lists` is not reused

    `--lists` counts bullets, and a session line is not a bullet. Reading this artifact with that
    table would report zero items for every record and look like a collapse.
    """
    rows = []
    for question in questions:
        if question.get('capability') != 'MR':
            continue
        raw = question.get('rawOutput')
        if not isinstance(raw, str) or raw.strip() == '':
            continue
        lines: list[str] = []
        for line in raw.split('\n'):
            match = SWEEP_LINE.match(line)
            if match is not None:
                lines.append(match.group(1).strip())
        rows.append(
            {
                'id': str(question.get('questionId', '?')),
                'correct': bool(question.get('correct')),
                'sessions': len(lines),
                'items': sum(1 for text in lines if text and not SWEEP_NOTHING.match(text)),
                'stated': question.get('answer'),
                'gold': question.get('groundTruth'),
            }
        )
    if not rows:
        return '', 0

    scanned = sorted(row['sessions'] for row in rows)
    items = sorted(row['items'] for row in rows)
    at_ten = sum(1 for row in rows if row['sessions'] >= 10)
    silent = sum(1 for row in rows if row['sessions'] == 0)

    lines = ['', 'what the session lines held (MR: one line per session, then the count)']
    lines.append(
        f'  records {len(rows)}   median session lines {median(scanned):.1f}   '
        f'median item lines {median(items):.1f}'
    )
    lines.append(
        f'  records with at least 10 session lines: {at_ten} ({at_ten / len(rows):.1%})   '
        f'records with none: {silent}'
    )
    if silent:
        lines.append(
            f'  {silent} record(s) wrote no session line at all: the ask reached the prompt and the '
            'response ignored its shape, so those answers are a control on the wording rather than '
            'a reading of the mechanism'
        )
    lines.append('')
    lines.append(f'  {"items":>6}{"sess":>6}  {"stated":>18}  {"gold":>18}  flags')
    for row in rows:
        if row['correct']:
            continue
        flags = []
        if row['sessions'] == 0:
            flags.append('no scan')
        if row['items'] and str(row['stated']).strip() == str(row['items']).strip():
            flags.append('counts its item lines')
        lines.append(
            f'  {row["items"]:>6}{row["sessions"]:>6}  {str(row["stated"])[:18]:>18}  '
            f'{str(row["gold"])[:18]:>18}  {", ".join(flags)}'
        )
    lines.append(
        '  the table lists the WRONG answers only, because the question is what the treatment '
        'changed there; the summary above covers all of them.'
    )
    return '\n'.join(lines), len(rows)


def lists_section(questions: list[dict]) -> tuple[str, int]:
    """What Step 1 held, what the model said, and the gold — for the answers that were wrong.

    ## The question this answers, and the name it corrected

    §13.76.6 called the next variable "MR's arithmetic", reading the taxonomy: 33
    `numeric_mismatch` of 45 wrong answers. This table says that is the wrong name. The lists are
    **1–6 items** deep while the window holds 60–79 turns, and the stated number is usually **not**
    the list length — the model aggregates a short list correctly. The failure is which items got
    onto the list, not what was done with them.

    ## Why the truncation share is beside it

    A 400-character cap cuts four turns in ten, so "the missing item was cut away" is the first
    competing explanation. It is priced per outcome instead of argued: if failures carried more
    truncated turns than successes, the cap would be implicated. They do not (40.8% against 38.8%
    on run `39205060432`), and that is what removes it.

    ## What it deliberately does not claim

    That the list is short *relative to the evidence* — this tool cannot see the gold turns' text,
    only how many of them were carried. It reports the list against itself and against the stated
    answer, which is what separates "faithful count of a short list" from "aggregation".
    """
    correct: list[tuple[int, float]] = []
    mismatched: list[tuple[int, float, str, str, str, bool]] = []
    for question in questions:
        if question.get('capability') != 'MR':
            continue
        turns = question.get('turns') or []
        lengths = [len(turn['text']) for turn in turns if isinstance(turn, dict)]
        share = (sum(1 for length in lengths if length > 400) / len(lengths)) if lengths else 0.0
        if question.get('correct'):
            correct.append((_step_one_items(question.get('rawOutput') or ''), share))
            continue
        if question.get('answer') is None:
            continue
        raw = question.get('rawOutput') or ''
        # The failures this table is about: a number was stated and it was not the gold. The
        # taxonomy lives in another module and is imported there rather than re-derived here; the
        # filter is stated as "stated an answer and got it wrong", which is what the section reads.
        mismatched.append((
            _step_one_items(raw),
            share,
            str(question.get('answer'))[:18],
            str(question.get('groundTruth'))[:20],
            raw,
            bool(_LISTS_EXCLUSION.search(raw)),
        ))

    if not correct and not mismatched:
        return '', 0

    def median(values: list[int]) -> float:
        ordered = sorted(values)
        middle = len(ordered) // 2
        if len(ordered) % 2:
            return float(ordered[middle])
        return (ordered[middle - 1] + ordered[middle]) / 2

    lines = ['', 'what Step 1 held (MR: items listed, the number stated, the gold)']
    for label, rows in (('correct', correct), ('wrong', mismatched)):
        if not rows:
            continue
        items = [row[0] for row in rows]
        shares = [row[1] for row in rows]
        lines.append(
            f'  {label:<8} n={len(rows):>3}  median list {median(items):.1f}  '
            f'median truncated turns {median(shares) * 100:.1f}%'
        )
    if correct:
        faithful = sum(1 for count, _ in correct if count > 0)
        lines.append(f'  correct with a parsable Step 1 list: {faithful} of {len(correct)}')

    if mismatched:
        lines.append('')
        lines.append(f'  {"items":>6}{"trunc":>7}{"stated":>10}{"gold":>10}  flags')
        counts_list = 0
        for count, share, stated, gold, _raw, excluded in mismatched:
            flags = []
            if stated.strip() == str(count):
                flags.append('counts its list')
                counts_list += 1
            if excluded:
                flags.append('states an exclusion')
            lines.append(
                f'  {count:>6}{share * 100:>6.0f}%{stated:>10}{gold:>10}  {", ".join(flags)}'
            )
        lines.append('')
        lines.append(
            f'  counts its list: {counts_list} of {len(mismatched)} — the rest aggregate a short '
            'list into a sum or a duration, which is why "arithmetic" was the wrong name for this.'
        )
    return '\n'.join(lines), len(correct) + len(mismatched)


# The rank bands `--reach` reports.
#
# 64 is the width every run before §13.78 used, 128 is the midpoint of the widened pool, and 256 is
# the widened pool itself. Three cuts, because the three answers they separate need three different
# repairs: inside 64 is what the campaign already had, 64-127 is a near miss a wider pool fixes,
# 128-255 is the edge of the widened pool, and beyond it the ranker cannot reach its own answer.
REACH_BANDS = (64, 128, 256)


def reach_section(questions: list[dict]) -> tuple[str, int]:
    """Where the gold sits in the ranking, banded, with the median of what the old width could not see.

    ## The two readings `-1` conflates

    `goldRanks` records `-1` for a gold turn the ranking never surfaced, and a `-1` produced at
    `k = 64` could be rank 65 or rank 900. Those need opposite repairs — a wider pool, or a better
    ranker — and no artifact produced at `k = 64` can tell them apart. This table reads an artifact
    produced at a **wider** `k`, where the same gold turn carries its true rank, and bands the
    ranks so the question has one number.

    ## Why the median is of the gold beyond the old width, and not of all gold

    The median of all ranks describes the pool; the median of the ranks **≥ 64** describes the part
    the campaign could not previously reach, which is the thing under study. When an artifact was
    produced at `k = 64` that band is empty, and the table says **not measured** rather than `0` —
    a zero would read as "no gold sits there" when the truth is that nothing was scored there.
    """
    by_capability: dict[str, list[int]] = {}
    for question in questions:
        overlap = question.get('goldOverlap')
        if not isinstance(overlap, dict):
            continue
        ranks = overlap.get('goldRanks')
        if not isinstance(ranks, list):
            continue
        capability = str(question.get('capability', '?'))
        by_capability.setdefault(capability, []).extend(
            rank for rank in ranks if isinstance(rank, int)
        )

    if not by_capability:
        return '', 0

    def median_rank(values: list[int]) -> float:
        """The ordinary median: average the middle pair when the count is even.

        The module's `_median` takes the upper middle, which is right for the coverage table (a
        band boundary is a count, not a distance). Here the number feeds a claim about *how far*
        the unreachable gold sits, and with two values the upper one overstates it by half their
        gap — the gap being the thing under study. So this averages, and the difference is stated
        rather than inherited.
        """
        ordered = sorted(values)
        middle = len(ordered) // 2
        if len(ordered) % 2:
            return float(ordered[middle])
        return (ordered[middle - 1] + ordered[middle]) / 2

    header = f'  {"capability":<10}{"gold":>6}'
    for cut in REACH_BANDS:
        lower = 0 if cut == REACH_BANDS[0] else REACH_BANDS[REACH_BANDS.index(cut) - 1]
        header += f'{f"{lower}-{cut - 1}":>9}'
    header += f'{"never":>7}{"median>=64":>12}'

    lines = ['', 'where the gold sits in the ranking (goldRanks, banded)']
    lines.append(header)
    totals = {cut: 0 for cut in REACH_BANDS}
    total_gold = 0
    total_never = 0
    beyond: list[int] = []
    for capability in sorted(by_capability):
        ranks = by_capability[capability]
        total_gold += len(ranks)
        line = f'  {capability:<10}{len(ranks):>6}'
        previous = 0
        for cut in REACH_BANDS:
            count = sum(1 for rank in ranks if previous <= rank < cut)
            totals[cut] += count
            line += f'{count:>9}'
            previous = cut
        never = sum(1 for rank in ranks if rank < 0 or rank >= REACH_BANDS[-1])
        total_never += never
        line += f'{never:>7}'
        here = [rank for rank in ranks if rank >= REACH_BANDS[0]]
        beyond.extend(here)
        if here:
            line += f'{median_rank(here):>12.0f}'
        else:
            line += f'{"not measured":>12}'
        lines.append(line)

    line = f'  {"TOTAL":<10}{total_gold:>6}'
    for cut in REACH_BANDS:
        line += f'{totals[cut]:>9}'
    line += f'{total_never:>7}'
    if beyond:
        line += f'{median_rank(beyond):>12.0f}'
    else:
        line += f'{"not measured":>12}'
    lines.append(line)

    lines.append('')
    for cut in REACH_BANDS:
        lower = 0 if cut == REACH_BANDS[0] else REACH_BANDS[REACH_BANDS.index(cut) - 1]
        share = totals[cut] / total_gold if total_gold else 0
        lines.append(f'  rank {lower:>3}-{cut - 1:<3}: {totals[cut]:>5} of {total_gold} = {share:6.1%}')
    lines.append(
        f'  "never" is rank >= {REACH_BANDS[-1]}, or a -1 from a run whose k was narrower than '
        'that band -- which is why it is not the same statement as "0 gold sits there".'
    )
    return '\n'.join(lines), len(by_capability)


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
    parser.add_argument(
        '--union',
        action='store_true',
        help='print the union of the two sides per capability instead of the run summary',
    )
    parser.add_argument(
        '--counted',
        action='store_true',
        help='print whether MR wrong answers equal the length of their own Step 1 list',
    )
    parser.add_argument(
        '--pool',
        action='store_true',
        help='print where the gold went: never surfaced, cut by the budget, delivered',
    )
    parser.add_argument(
        '--reach',
        action='store_true',
        help='print the ranked gold banded by rank, with the median beyond the old pool width',
    )
    parser.add_argument(
        '--final',
        action='store_true',
        help="for answers that scored correct: does the response's closing line state the gold",
    )
    parser.add_argument(
        '--numbers',
        action='store_true',
        help='for wrong MR answers with a number in the gold: is that number in the window',
    )
    parser.add_argument(
        '--counting',
        action='store_true',
        help='print the MR counting questions: the list behind each answer, against the gold count',
    )
    parser.add_argument(
        '--sweep',
        action='store_true',
        help='print the session lines a sweep-shaped response wrote, MR only',
    )
    parser.add_argument(
        '--lists',
        action='store_true',
        help='print what the Step 1 list held beside the stated number and the gold, MR only',
    )
    parser.add_argument(
        '--window',
        action='store_true',
        help='print how many turns the prompt held and how much of the budget they spent',
    )
    parser.add_argument(
        '--turns',
        action='store_true',
        help='print the delivered turn lengths and what a per-turn cap would buy',
    )
    parser.add_argument(
        '--caps',
        action='store_true',
        help='print per-capability correct counts across repetitions (min / mean / max)',
    )
    parser.add_argument(
        '--roles',
        action='store_true',
        help='print how much of the rendered evidence room came from each role',
    )
    parser.add_argument(
        '--ranks',
        action='store_true',
        help='print how many gold turns sit in the top 8 / 16 / 32 of the ordered pool',
    )
    parser.add_argument(
        '--paired',
        type=Path,
        metavar='BEFORE',
        help='print the state transitions from the BEFORE report to this one',
    )
    parser.add_argument(
        '--audit',
        action='store_true',
        help='check the artifact against itself, and exit 1 if any field contradicts another',
    )
    parser.add_argument(
        '--arithmetic',
        action='store_true',
        help='print where each wrong MR answer is wrong: under, over, equal or undefined direction',
    )
    parser.add_argument(
        '--stability',
        type=Path,
        metavar='BEFORE',
        help='print per-capability answer agreement between BEFORE and this report',
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
        # §13.85: the bands are computed from `total`, so a reader comparing this table against
        # another run's has to know which denominator it was computed against. `totalAll` is the
        # artifact's own statement that the policy, not the dataset, set the denominator.
        narrowed = sum(1 for question in questions if _has_total_all(question))
        if narrowed:
            print(
                f'denominator: the role policy on {narrowed} record(s) -- each carries `totalAll` '
                'beside its `total`, so these bands are NOT comparable against a run whose '
                'denominator was the dataset.'
            )
        print(section)
        return 0

    if args.union:
        try:
            section, gap = union_section(report, questions)
        except ValueError as error:
            print(f'{args.report}: {error}', file=sys.stderr)
            return 2
        print(section)
        return 0

    if args.audit:
        block, failed = audit_section(report, questions)
        print(block)
        return 1 if failed else 0

    if args.arithmetic:
        print(arithmetic_section(questions))
        return 0

    if args.stability:
        try:
            previous = json.loads(args.stability.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError) as error:
            print(f'{args.stability}: {error}', file=sys.stderr)
            return 2
        before_questions = _questions(previous)
        if before_questions is None:
            print(f'{args.stability}: no per-question roster in this report', file=sys.stderr)
            return 2
        try:
            print(stability_section(questions, before_questions))
        except ValueError as error:
            print(f'{args.report}: {error}', file=sys.stderr)
            return 2
        return 0

    if args.paired:
        try:
            previous = json.loads(args.paired.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError) as error:
            print(f'{args.paired}: {error}', file=sys.stderr)
            return 2
        before_questions = _questions(previous)
        if before_questions is None:
            print(f'{args.paired}: no per-question roster in this report', file=sys.stderr)
            return 2
        try:
            section, _ = paired_section(questions, before_questions)
        except ValueError as error:
            print(f'{args.report}: {error}', file=sys.stderr)
            return 2
        print(section)
        return 0

    if args.reach:
        section, measured = reach_section(questions)
        if measured == 0:
            print(f'{args.report}: no record carries goldRanks.', file=sys.stderr)
            return 2
        print(section)
        return 0

    if args.final:
        if questions is None:
            print(
                f'{args.report}: no per-question roster, so the answers cannot be audited.',
                file=sys.stderr,
            )
            return 2
        section, measured = final_section(questions)
        if measured == 0:
            print(f'{args.report}: no correct record carries a raw output.', file=sys.stderr)
            return 2
        print(section)
        return 0

    if args.numbers:
        if questions is None:
            print(
                f'{args.report}: no per-question roster, so the window cannot be searched for the '
                'gold numbers.',
                file=sys.stderr,
            )
            return 2
        section, measured = numbers_section(questions)
        if measured == 0:
            print(
                f'{args.report}: no wrong MR record carries a number in its gold.',
                file=sys.stderr,
            )
            return 2
        print(section)
        return 0

    if args.counting:
        if questions is None:
            print(
                f'{args.report}: no per-question roster, so the counting questions cannot be read.',
                file=sys.stderr,
            )
            return 2
        config = report.get('memoryArmConfig')
        ask = config.get('ask') if isinstance(config, dict) else None
        section, measured = counting_section(questions, ask if isinstance(ask, str) else None)
        if measured == 0:
            print(
                f'{args.report}: no MR record carries a count for a gold and a readable list.',
                file=sys.stderr,
            )
            return 2
        print(section)
        return 0

    if args.sweep:
        config = report.get('memoryArmConfig')
        ask = config.get('ask') if isinstance(config, dict) else None
        if ask != 'sweep':
            print(
                f'{args.report}: this artifact ran with ask={ask!r}, so its responses have no '
                'session lines to read. `--lists` is the table for an `enumerated` run; this one '
                'reads the shape `sweep` asks for, and reading it on any other run would report '
                'zero as a measurement.',
                file=sys.stderr,
            )
            return 2
        section, measured = sweep_section(questions)
        if measured == 0:
            print(f'{args.report}: no MR record carries raw output.', file=sys.stderr)
            return 2
        print(section)
        return 0

    if args.lists:
        section, measured = lists_section(questions)
        if measured == 0:
            print(f'{args.report}: no MR record carries a Step 1 list.', file=sys.stderr)
            return 2
        print(section)
        return 0

    if args.caps:
        spreads = capability_spreads(report)
        if spreads is None:
            print(
                f'{args.report}: no per-capability spread. Either the run had one repetition -- the '
                'field is absent by design, because a spread of zero reads as perfect stability -- '
                'or the artifact predates it. Re-run with more repetitions to read this.',
                file=sys.stderr,
            )
            return 2
        print(caps_section(*spreads))
        return 0

    if args.roles:
        if questions is None:
            print(
                f'{args.report}: no per-question roster, so the composition of the evidence '
                'cannot be read. A reduced report drops the turns this table is made of.',
                file=sys.stderr,
            )
            return 2
        cap, reach = turn_cap(report)
        section, measured = roles_section(questions, cap, reach)
        if measured == 0:
            print(
                f'{args.report}: no record carries turns. A producer that does not capture the '
                'context, or an artifact whose roster was emptied, cannot be read for composition.',
                file=sys.stderr,
            )
            return 2
        print(section)
        return 0

    if args.window:
        try:
            budget, source = prompt_budget(report)
        except ValueError as error:
            print(f'{args.report}: {error}', file=sys.stderr)
            return 2
        section, measured = window_section(questions, budget, source)
        if measured == 0:
            print(
                f'{args.report}: no record carries both turns and promptChars.',
                file=sys.stderr,
            )
            return 2
        print(section)
        return 0

    if args.turns:
        section, measured = turns_section(questions)
        if measured == 0:
            print(f'{args.report}: no record carries turns.', file=sys.stderr)
            return 2
        print(section)
        return 0

    if args.ranks:
        section, measured = ranks_section(questions)
        if measured == 0:
            print(
                f'{args.report}: no record carries a goldOverlap.goldRanks. A run that '
                'consulted no ranking has none, and an artifact produced before §13.65 '
                'predates the field.',
                file=sys.stderr,
            )
            return 2
        print(section)
        return 0

    if args.pool:
        section, measured = pool_section(questions, evidence_roles(report))
        if measured == 0:
            print(
                f'{args.report}: no record carries a goldOverlap.pool. A run that consulted '
                'no ranking has none, and an artifact produced before §13.62 predates the field.',
                file=sys.stderr,
            )
            return 2
        print(section)
        return 0

    if args.counted:
        section, counted, read = counted_section(questions)
        if read == 0:
            print(f'{args.report}: no MR wrong answers carrying a Step 1 list.', file=sys.stderr)
            return 2
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
