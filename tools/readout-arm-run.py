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
    python3 tools/readout-arm-run.py --split path/to/report.json
    python3 tools/readout-arm-run.py --room 32000 path/to/report.json
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
    python3 tools/readout-arm-run.py --attribution before.json after.json
    python3 tools/readout-arm-run.py --config control.json --treatment cortex_memory_ask run.json
"""

from __future__ import annotations

import argparse
import json
import math
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


def exact_sign_test(wins: int, losses: int) -> float:
    """Two-sided exact binomial probability of a split at least this lopsided, at `p = 0.5`.

    ## Why exact and not a normal approximation

    §13.257's ledger had 23 discordant pairs, and the whole point of reading it was that 13 of
    them turned out not to belong to the treatment. A normal approximation on a number that small
    is a different answer on the same data, and the difference lands exactly where the decision is.
    `statistics` has no exact binomial either, so it is computed here.

    ## Why `wins + losses == 0` answers 1.0 and not 0.0

    No disagreement is **not** evidence of a direction. Returning zero would let every run with no
    flips pass any significance bar, which is the same defect as reporting a missing measurement as
    a zero one -- the rule §13.11.2 fixes for the artifact fields.
    """
    n = wins + losses
    if n == 0:
        return 1.0
    tail = sum(math.comb(n, k) for k in range(0, min(wins, losses) + 1)) / 2**n
    return min(1.0, 2 * tail)


def _digest(question: dict) -> str | None:
    """The 64-bit prompt fingerprint, or `None` when the record predates the field.

    `None` is not "unchanged". A record without a digest cannot testify about whether the reader
    saw the same bytes, so it goes into its own bucket rather than being counted with either side
    -- the distinction the whole attribution rests on.
    """
    value = question.get('promptDigest')
    return value if isinstance(value, str) and value else None


def attribution_section(after_report: dict, before_report: dict) -> tuple[str, int]:
    """Split a paired roster into the population the treatment changed and the one it did not.

    ## The defect this exists to stop reading into a number

    §13.257's dispatch changed the prompt on **128 of 500** questions. The other 372 were sent to
    the reader as the same bytes, and a flip there cannot be caused by the treatment. Pooling all
    500 into one paired test produced `5 wins to 18 losses, p = 0.0106` -- and **13 of those 23
    discordant pairs were in the untouched population**, whose own split was `2-11, p = 0.0225`.
    Read as a mechanism effect, that number says the mechanism hurt the reader on prompts it did
    not change.

    So the ledger is printed per population, the untouched one is named as the noise control, and
    only the changed one carries an attributable delta.

    ## The self-check that makes the split trustworthy

    A gold turn can only enter or leave the delivered set when the prompt changes. If the untouched
    population shows a non-zero gold delta, then either the digest or the pairing key is wrong, and
    the function reports it as a failure rather than printing a split nobody should believe.

    ## The second reading: means against spreads

    A first-pass verdict is a sample. The arm's own `featureByCapability` carries `min / avg / max`
    over the four passes, so the spread is printed beside the mean: §13.257.5 failed a gate whose
    width (`+-5` MR questions) was narrower than the spread it was reading (`6-7`).
    """
    after = {str(question.get('questionId')): question for question in _questions(after_report) or []}
    before = {str(question.get('questionId')): question for question in _questions(before_report) or []}
    if not after or not before:
        raise ValueError('one side has no per-question roster, so no question can be attributed')
    if set(after) != set(before):
        missing = sorted(set(after) ^ set(before))
        raise ValueError(
            f'the two rosters do not name the same questions: {len(missing)} id(s) are missing '
            f'from one side ({", ".join(missing[:5])}{"..." if len(missing) > 5 else ""}). '
            'A missing id counted as a flip would inflate the treatment population.'
        )

    buckets = {'identical': [], 'changed': [], 'unpaired': []}
    for identifier in sorted(after):
        now, was = _digest(after[identifier]), _digest(before[identifier])
        if now is None or was is None:
            buckets['unpaired'].append(identifier)
        elif now == was:
            buckets['identical'].append(identifier)
        else:
            buckets['changed'].append(identifier)

    lines = [
        '',
        'attribution of the paired ledger, split by whether the prompt changed',
        f'  paired questions {len(after)}: '
        f'identical prompt {len(buckets["identical"])}, '
        f'changed prompt {len(buckets["changed"])}, '
        f'no digest on one side {len(buckets["unpaired"])}',
        '',
        f'  {"population":<12} {"n":>5} {"up":>5} {"down":>5} {"tie":>5} {"flip":>7} {"p":>8} {"gold":>6}',
    ]
    failures = 0
    for name in ('identical', 'changed', 'unpaired'):
        identifiers = buckets[name]
        if not identifiers:
            continue
        up = down = gold = 0
        for identifier in identifiers:
            was_correct = bool(before[identifier].get('correct'))
            now_correct = bool(after[identifier].get('correct'))
            if now_correct and not was_correct:
                up += 1
            elif was_correct and not now_correct:
                down += 1
            gold += _gold_carried(after[identifier]) - _gold_carried(before[identifier])
        flips = up + down
        lines.append(
            f'  {name:<12} {len(identifiers):>5} {up:>5} {down:>5} {len(identifiers) - flips:>5} '
            f'{flips / len(identifiers):>7.2%} {exact_sign_test(up, down):>8.4f} {gold:>+6d}'
        )
        if name == 'identical' and gold != 0:
            failures += 1
            lines.append(
                f'     FAIL: {gold:+d} gold turn(s) moved on questions whose prompt did not change. '
                'A delivered turn cannot enter or leave without the prompt changing, so either '
                '`promptDigest` or the pairing key is wrong and this split means nothing.'
            )

    changed = buckets['changed']
    if changed:
        up = sum(
            1
            for identifier in changed
            if after[identifier].get('correct') and not before[identifier].get('correct')
        )
        down = sum(
            1
            for identifier in changed
            if before[identifier].get('correct') and not after[identifier].get('correct')
        )
        points = (up - down) / len(after) * 100
        lines.append('')
        lines.append(
            f'  attributable delta {(up - down):+d} question(s) of {len(after)} = {points:+.2f} points'
        )
        lines.append(
            '  Read this beside the identical-prompt row: a directional split there is reader and '
            'judge drift, and the all-question paired test cannot separate the two.'
        )

    means = _spread_table(after_report, before_report)
    if means:
        lines.append('')
        lines.extend(means)
    return '\n'.join(lines), failures


def _gold_carried(question: dict) -> int:
    """Gold turns this record says reached the reader, or zero when it says nothing.

    Zero rather than `None` arithmetic: a record without `goldOverlap` contributes nothing to a
    delta, and the case where **both** sides lack it cancels. A record that has it on one side only
    is a schema difference between two dispatches, which the identical-prompt self-check above
    catches on the gold it would otherwise hide.
    """
    overlap = question.get('goldOverlap')
    if not isinstance(overlap, dict):
        return 0
    carried = overlap.get('carried')
    return carried if isinstance(carried, int) else 0


def _spread_table(after_report: dict, before_report: dict) -> list[str]:
    """The four-pass `min / avg / max` per capability, for both sides of the comparison.

    The point of the table is the **spread**, not the mean: a gate whose width is narrower than the
    spread it reads cannot be failed or passed by one pass. §13.257.5's MR row is exactly that --
    `92/94.8/99` against `91/94.8/97`, means identical, first passes seven questions apart.
    """
    after_ablation = after_report.get('ablation')
    before_ablation = before_report.get('ablation')
    if not isinstance(after_ablation, dict) or not isinstance(before_ablation, dict):
        return []
    after_by_capability = after_ablation.get('featureByCapability')
    before_by_capability = before_ablation.get('featureByCapability')
    if not isinstance(after_by_capability, dict) or not isinstance(before_by_capability, dict):
        return []
    def triple(entry: dict) -> str:
        return f'{entry.get("min")} / {entry.get("avg")} / {entry.get("max")}'

    lines = [
        '  four passes, per capability (the spread is what a single-pass gate is compared to)',
        f'    {"cap":<4} {"control min/avg/max":<22} {"treatment min/avg/max":<22} '
        f'{"avg delta":>9} {"spread":>6}',
    ]
    for capability in sorted(after_by_capability):
        was = before_by_capability.get(capability)
        now = after_by_capability.get(capability)
        if not isinstance(was, dict) or not isinstance(now, dict):
            continue
        spread = max(now.get('max', 0) - now.get('min', 0), was.get('max', 0) - was.get('min', 0))
        lines.append(
            f'    {capability:<4} {triple(was):<22} {triple(now):<22} '
            f'{now.get("avg", 0) - was.get("avg", 0):>+9.2f} {spread:>6}'
        )
    return lines


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


#: The prefix-cache share bands §13.147.3 registers, with what each one licenses.
#:
#: Registered before the first artifact carrying `llmUsage` existed, and here rather than in prose so
#: the reading is a lookup instead of an argument. A run whose share lands in the middle band needs a
#: measurement this artifact cannot supply, and the band says so rather than leaving a reader to
#: decide that a number between two stories supports the convenient one.
PREFIX_SHARE_BANDS = (
    (
        0.0,
        0.05,
        'under 5%: no repetition reuse and no ordering win -- repetitions cost what they were '
        'assumed to cost, and moving a stable block to the front is settled negative',
    ),
    (
        0.20,
        0.60,
        '20-60%: neither story fits -- the instrument or the provider is doing something neither '
        '13.140.2 nor 13.147.2 describes, and per-pass spend is required to localise it',
    ),
    (
        0.60,
        0.80,
        '60-80%: repetitions are reused -- the marginal repetition costs about a tenth of the '
        'prompt, so "eight repetitions cost double" is wrong and the resolution arithmetic must be '
        'restated; ordering stays untested by this artifact',
    ),
)


def spend_section(report: dict) -> str:
    """What the provider said this run cost, and which registered reading its cache share lands in.

    ## Why this reads `llmUsage` and divides by nothing

    §13.140.1 registers the numbers and §13.147.2 does the one division that is licensed (prompt
    tokens over the roster's `promptChars`, to check that the prompt is the size the roster says).
    Everything else here is stated as the artifact states it, because the alternative -- a currency
    figure -- is a rate card checked into a tool that ages silently and then reads as authoritative
    (§13.140.7 refuses exactly that).

    ## Why the share is the number with a decision attached

    A dispatch runs `runs` repetitions, and passes 2..runs send byte-identical requests: `now` is
    fixed at construction, retrieval is deterministic over a cached store, and the reader runs at
    temperature 0. So the share the artifact reports is dominated by repetition reuse rather than by
    prompt ordering, and the two questions have different consequences. §13.147.3 registers three
    bands and what each one licenses; this function is where that registration is applied.

    ## What is refused rather than printed

    A cache hit larger than the prompt, more unpriced calls than calls, or a negative count are
    corrupt artifacts: `parseUsage` drops a hit above its own prompt per call, so a sum that
    violates it did not come from this adapter. Printing such a share would describe a discount the
    run did not get.
    """
    usage = report.get('llmUsage')
    if not isinstance(usage, dict):
        raise ValueError(
            'no llmUsage block: this artifact predates §13.140, or the run made no instrumented '
            'call. Both are absences and neither is a zero-spend run'
        )

    def count(name: str) -> int:
        value = usage.get(name)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f'llmUsage.{name} is {value!r}: a token count must be a non-negative integer')
        return value

    calls = count('calls')
    unpriced = count('unpricedCalls')
    prompt = count('promptTokens')
    completion = count('completionTokens')
    cached = count('cacheHitPromptTokens')

    if unpriced > calls:
        raise ValueError(f'llmUsage says {unpriced} unpriced of {calls} calls, which cannot be')
    if cached > prompt:
        raise ValueError(
            f'llmUsage says {cached} cached tokens of a {prompt}-token prompt: the share is a subset '
            'by construction, so this artifact is corrupt'
        )

    runs = report.get('runs')
    if isinstance(runs, bool) or not isinstance(runs, int) or runs < 1:
        runs = None

    lines = ['provider spend (llmUsage)']
    priced = f', {unpriced:,} unpriced' if unpriced else ''
    lines.append(f'  calls        {calls:,}{priced}')
    share = (cached / prompt) if prompt else None
    if share is None:
        lines.append(f'  prompt       {0:,} tokens -- no prompt tokens were reported')
    else:
        lines.append(
            f'  prompt       {prompt:,} tokens, of which {cached:,} were served from the prefix '
            f'cache ({share * 100:.1f}%)'
        )
    lines.append(f'  completion   {completion:,} tokens')
    if prompt:
        lines.append(f'  prompt:completion ratio {prompt / max(completion, 1):.1f}:1')

    if runs is None:
        lines.append(
            '  repetitions  this artifact does not state `runs`, so the per-pass call count cannot '
            'be derived and the share cannot be attributed between repetition reuse and ordering'
        )
    else:
        lines.append(
            f'  repetitions  {runs}, so a 500-question pass over two sides issues '
            f'{500 * 2 * runs:,} answer calls of the {calls:,} recorded'
        )

    # The residual, which the Markdown report has carried since §13.189 and this readout has not.
    #
    # `usageBySide` partitions the calls onto the two arms; the judge, the phrasing stage and
    # setup belong to neither, and `report.ts` renders that on its own line
    # (`neither arm (judge, phrasing, setup)`). So this number is not unrecorded -- it is
    # unread at the terminal, which is where the spend question actually gets asked.
    #
    # Two dimensions, and they disagree by an order of magnitude, which is the reason to print
    # both. On run `41284575092`: 886 calls are on neither arm, 15.7% of 5,651 -- and they spent
    # 235,881 prompt tokens, 0.8% of 31.1M. A judge call carries about 266 prompt tokens against
    # the feature arm's 13,600, so a readout that prints tokens alone shows a bill that looks
    # complete and is short by one call in six. That is the same defect as §13.220's, one
    # measurement down: the number exists, and the place a decision is made does not show it.
    by_side = report.get('usageBySide')
    if isinstance(by_side, dict):
        parts: list[str] = []
        side_calls = 0
        for side in ('baseline', 'feature'):
            entry = by_side.get(side)
            if isinstance(entry, dict) and isinstance(entry.get('calls'), int):
                parts.append(f'{side} {entry["calls"]:,}')
                side_calls += entry['calls']
        if parts:
            residual = calls - side_calls
            share_of_calls = (residual / calls * 100) if calls else 0.0
            side_prompt = 0
            for side in ('baseline', 'feature'):
                entry = by_side.get(side)
                if isinstance(entry, dict) and isinstance(entry.get('promptTokens'), int):
                    side_prompt += entry['promptTokens']
            residual_prompt = prompt - side_prompt
            share_of_prompt = (residual_prompt / prompt * 100) if prompt else 0.0
            lines.append(f'  by side      {" + ".join(parts)} = {side_calls:,} calls')
            lines.append(
                f'  residual     {residual:,} calls ({share_of_calls:.1f}%) and '
                f'{residual_prompt:,} prompt tokens ({share_of_prompt:.1f}%) belong to neither '
                'arm: the judge, the phrasing stage and setup (report.ts renders this as '
                '"neither arm")'
            )
            if residual < 0:
                lines.append(
                    '  reading      the sides exceed the total, so one of the two ledgers is '
                    'counting another one\'s calls; this artifact contradicts itself'
                )

    if share is not None:
        verdict = None
        for low, high, text in PREFIX_SHARE_BANDS:
            if low <= share < high:
                verdict = text
                break
        if verdict is None:
            # Between 5% and 20%: neither registered band, and the gap is deliberate -- a share in
            # it is too high for "no reuse" and too low for repetition reuse of three passes in four.
            verdict = (
                '5-20%: inside none of the three registered bands (13.147.3). That is a reading '
                'neither this tool nor the registration anticipated, and per-pass spend is the only '
                'way to attribute it'
            )
        lines.append(f'  reading      {verdict}')

    return '\n'.join(lines)


# §13.334.4's `E3.1`, per repetition: the pass fires on 3 to 5 questions and converts all of them.
#
# A pair of counts rather than a rate, because 3 to 5 questions is +0.6 to +1.0 points, which is
# inside the corpus's seventeen-question noise floor -- the headline cannot confirm or refute this
# mechanism, and a flat run with a `4 / 4` census is the *expected* reading rather than a null one.
REPLY_REPAIR_BAND = (3, 5)


def _pair_of_counts(value: object, where: str) -> dict[str, int]:
    """Validate one `{attempted, answered}` pair, raising when it is not one.

    A malformed part discards the whole field rather than being coerced, for the reason the
    TypeScript side gives: a total without its parts lets a reader credit a conversion to a
    treatment that never fired, and a coerced zero reads as "the pass never ran" -- the same silent
    success the four-state classifier exists to make impossible. `bool` is rejected explicitly
    because `isinstance(True, int)` is true in Python and a `true` in a counter is a fault, not one.
    """
    if not isinstance(value, dict):
        raise ValueError(f'{where} is not an object')
    out: dict[str, int] = {}
    for key in ('attempted', 'answered'):
        item = value.get(key)
        if isinstance(item, bool) or not isinstance(item, int) or item < 0:
            raise ValueError(f'{where}.{key} is not a non-negative integer')
        out[key] = item
    return out


def reply_repair_section(report: dict) -> tuple[str, bool]:
    """The reply-contract repair's census, divided by the configured run count, plus `E3.1`'s verdict.

    ## Why the divisor is the point of this section

    A memory instance is reused across every repetition (`§12.5`), so the census's totals are
    `per-repetition x runs`: `16` on a four-repetition run is `4.0` per repetition. Read against a
    band of `[3, 5]` without dividing, a working mechanism looks broken by a factor of four. The
    same artifact once carried a census of `120` beside a capability table of `30` and both were
    correct; nothing in the document said which was which.

    So the divisor is `report.runs`, the count that was actually configured, and it is printed.
    Deriving it from `questionCount` would assume every question was asked exactly `runs` times,
    which a partially-failed run falsifies, and assuming `1` when the field is absent would invent
    a reading. An artifact with no published divisor therefore refuses to score: that is a
    statement about the artifact, not about the mechanism.

    ## What it prints and what it leaves to the other sections

    `E3.2` (no non-target flips) is `--paired`'s ledger, `E3.3` (`ABS` 30/30) is the capability
    table, and `E3.4` (the bill) is `--spend`. Restating any of the three here would create a second
    reader of one quantity, which is how two numbers that agree get reported as a disagreement.
    """
    census = _pair_of_counts(report.get('replyRepair'), 'replyRepair')
    commitment = _pair_of_counts(census_parts(report, 'commitment'), 'replyRepair.commitment')
    shape = _pair_of_counts(census_parts(report, 'shape'), 'replyRepair.shape')

    runs = report.get('runs')
    if isinstance(runs, bool) or not isinstance(runs, int) or runs < 1:
        raise ValueError(
            'carries no `runs`, so the per-repetition band of §13.334.4 cannot be applied. The '
            'census is accumulated on one instance reused across repetitions; dividing it by an '
            'assumed single pass would read a working mechanism as four times its true rate'
        )

    lines = ['', 'reply-contract repair (field: replyRepair; §13.334.4)']
    for name, pair in (('commitment', commitment), ('shape', shape), ('total', census)):
        lines.append(f'  {name:<12} {pair["attempted"]} / {pair["answered"]}')
    lines.append('               attempted / answered')
    per_run = commitment['attempted'] / runs
    lines.append(f'  repetitions  {runs}   (the divisor for the band below, from `runs`)')
    lines.append(f'  per run      {per_run:.1f} attempted, {commitment["answered"] / runs:.1f} answered')

    low, high = REPLY_REPAIR_BAND
    unconverted = census['attempted'] - census['answered']
    if unconverted:
        verdict = (
            f'FAIL  {unconverted} not converted: the commitment rule fires and does not commit, '
            'which is `E3.1`\'s second falsifier'
        )
    elif not low <= per_run <= high:
        verdict = (
            f'FAIL  {per_run:.1f} per repetition is outside [{low}, {high}]: the plan fired on the '
            'wrong population, or the predicate and the wiring disagree, which is the first falsifier'
        )
    else:
        verdict = f'PASS  {per_run:.1f} per repetition in [{low}, {high}], {unconverted} unconverted'
    lines.append(f'  E3.1         attempted == answered, per-repetition attempted in band   {verdict}')
    lines.append('  E3.2/E3.3/E3.4  read `--paired`, the capability table and `--spend`')
    if shape['attempted']:
        lines.append(
            f'  note         the refused kind fired {shape["attempted"]} times: §13.334.3 '
            'dispatches `commitment` only, so a non-zero `shape` means the wrong value was written'
        )
    return '\n'.join(lines), not unconverted and low <= per_run <= high


def census_parts(report: dict, kind: str) -> object:
    """The named half of the census, or a value `_pair_of_counts` will reject by name."""
    census = report.get('replyRepair')
    if not isinstance(census, dict):
        return None
    return census.get(kind)


def _window_reordered(question: dict) -> bool:
    """Whether this record says the window mechanism reached it.

    Read through `featureConfig`, which is where the arm writes the mechanism's own flags
    (`§13.161.2`). A record that carries no `featureConfig` at all is the same answer as one
    that carries `windowReorder: false`: neither says the delivery was reordered, and the
    audit's question is what the artifact asserts, not what it omits.
    """
    feature = question.get('featureConfig')
    return isinstance(feature, dict) and feature.get('windowReorder') is True


def _window_fingerprint(replay: dict | None) -> tuple[bool, str]:
    """Whether a replay of the promotion finds the delivery already carrying it.

    ## Why the flag is not enough, and what replaces it

    `windowReorder: true` is written by the same code whose correctness the audit is asking
    about. A run that set the knob, wrote the flag and then crashed before reordering
    anything would publish a perfectly consistent artifact, and no arrangement of the
    artifact's own fields could tell. That is not hypothetical: `40984213349` died on its
    first question after writing its configuration.

    The replay closes it because it is computed FROM the delivered order rather than from
    any claim about it. Re-running the promotion on a delivery that already carries the
    partition finds nothing to move -- the operation is idempotent -- so `fired > 0` with
    `moved == 0` is the fingerprint of an administered run, and `moved > 0` is the control's
    own reading (`§13.161.2` measured 9 on it).

    `fired > 0` is a conjunct and not decoration: zero fired with zero moved is idempotent
    too, and it is exactly what a run that never reached the ladder prints.
    """
    if replay is None:
        return (
            False,
            'no replay supplied, so the flag above is the run\'s own word for having run; '
            'pass --wired with the output of tools/window-wired.mjs --json',
        )
    total = replay.get('total') if isinstance(replay, dict) else None
    if not isinstance(total, dict):
        return (False, 'the replay has no total block, so it measured nothing')
    fired = total.get('fired')
    moved = total.get('moved')
    if not isinstance(fired, int) or not isinstance(moved, int):
        return (False, f'the replay reports fired={fired!r} moved={moved!r}, which is not a count')
    if fired == 0:
        return (
            False,
            'the replay fired on no question, so this run never reached the ladder and the '
            'zero it moved is the absence of a mechanism rather than its idempotence',
        )
    if moved != 0:
        return (
            False,
            f'the replay fires on {fired} question(s) and still moves {moved}, so this '
            'delivery does not carry the promotion it claims; the control moves 9',
        )
    return (True, f'replay: fired {fired}, moved 0 -- the delivery already carries the partition')


def consulted_once_each(rows: list[dict], total: int) -> bool:
    """Whether every record carries the audit pair, so the sum is over the whole roster.

    A sum is only an identity if the rows it adds are all the rows there are: a producer that wrote the
    field on the questions the pass reached and omitted it on the others would sum to the same tally over
    a smaller denominator, and the artifact would look self-consistent while describing a population it
    had silently filtered (§13.262). The count is written for every record by construction -- zero is a
    measurement and absence is reserved for a build with no audit at all.
    """
    return len(rows) == total


def audit_section(
    report: dict, questions: list[dict], replay: dict | None = None
) -> tuple[str, int]:
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

    # 6. The knob that was set left the trace that knob can leave.
    #
    # `queryExpansion` carries two mechanisms that do different things. `llm` expands a
    # question into phrases BEFORE retrieval and records how many it expanded; `window`
    # expands nothing, parses a date range and stable-partitions the delivered turns, so its
    # counter is `None` by construction and always will be (§13.153, §13.161.7). Reading one
    # field for both mechanisms meant a correct window dispatch failed the audit --
    # `40989420944` did, on `queryExpansion=window reporting None question(s) expanded`.
    #
    # The repair is not "skip the check when the knob says window". It is to check the trace
    # the knob actually leaves, which for this mechanism is two things: a per-record flag, and
    # a replay whose verdict is a conjunction. A flag is a claim the run makes about itself;
    # the replay is a measurement. Accepting the flag alone would restore exactly the hole the
    # audit exists to close, because the flag is written by the same code that would be broken.
    expansion = config.get('queryExpansionCounts')
    expansion_mode = config.get('queryExpansion') or 'none'
    if expansion_mode == 'window':
        flagged = [str(q.get('questionId')) for q in questions if not _window_reordered(q)]
        if not flagged:
            detail = 'every record carries featureConfig.windowReorder'
        elif len(flagged) == len(questions):
            detail = (
                'no record carries featureConfig.windowReorder, so nothing in this artifact '
                'distinguishes a reordered run from one that was dispatched to reorder and never '
                'reached it'
            )
        else:
            detail = f'{len(flagged)} record(s) without windowReorder, first {flagged[0]}'
        if expansion is not None:
            detail = (
                f'queryExpansionCounts is published on a window dispatch, which expands '
                f'nothing; the count cannot be a measurement here. {detail}'
            )
        fingerprint, why = _window_fingerprint(replay)
        check('windowReorder', not flagged and expansion is None and fingerprint, f'{detail}. {why}')
    elif expansion_mode != 'none':
        named = expansion.get('questions') if isinstance(expansion, dict) else None
        check(
            'expansion',
            named == len(mr_texts),
            f'queryExpansion={expansion_mode} reporting '
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

    # 7b. The audit census exists exactly when the run carried the pass, and the roster **sums** to it.
    #
    # §13.260. `reviewPass` is a knob that produces both a run-level tally and a per-question pair, and
    # until now neither existed in an artifact: the product's `lastReview()` had no reader anywhere in
    # the harness, so a run could spend a call on every answered multi-session question and the only
    # trace of it was a call count nine per cent above the control's.
    #
    # §13.262. The first version of this check compared the tally against the number of records flagged,
    # and `42054107910` failed it with `attempted: 469` against `118` flags -- not because either ledger
    # was wrong, but because the roster records the **first** repetition while the tally counts all four.
    # The factor was the repetition count. A flag cannot satisfy an identity at `runs > 1`; a count can,
    # and the identity is then the only one worth writing: the column sums to the tally.
    audit_census = report.get('audit')
    auditing = (config.get('reviewPass') or 'bare') == 'audit'
    roster_consultations = [
        question for question in questions if question.get('auditConsultations') is not None
    ]
    consultations = sum(question.get('auditConsultations') or 0 for question in roster_consultations)
    changes = sum(question.get('auditChanges') or 0 for question in roster_consultations)
    if auditing:
        tally = audit_census if isinstance(audit_census, dict) else None
        attempted = tally.get('attempted') if isinstance(tally, dict) else None
        changed = tally.get('changed') if isinstance(tally, dict) else None
        consistent = (
            isinstance(attempted, int)
            and isinstance(changed, int)
            and 0 <= changed <= attempted
            and consulted_once_each(roster_consultations, len(questions))
            and consultations == attempted
            and changes == changed
        )
        check(
            'audit',
            consistent,
            f'reviewPass=audit with census {tally if tally is not None else "absent"}; '
            f'the roster sums to {consultations:,} consultations and {changes:,} changes over '
            f'{len(roster_consultations)} of {len(questions)} records'
            + (
                ''
                if consistent
                else ' -- the column must sum to the tally, every record must carry it, and a '
                'review cannot move more answers than it was shown'
            ),
        )
    else:
        check(
            'audit',
            audit_census is None and not roster_consultations,
            'reviewPass=bare, so neither a tally nor a per-question count may be published'
            + (
                ''
                if audit_census is None and not roster_consultations
                else ' -- a zeroed census here would claim a mechanism that never ran'
            ),
        )

    # 8. The three spend counts are a partition, and the remainder is stated rather than left
    #    to the reader's subtraction.
    #
    # `usageBySide` partitions the calls onto the two arms, and the judge, the phrasing stage and
    # setup belong to neither -- `report.ts` renders that on its own line, so the residual is
    # recorded and named. What has never been checked is that the three add up, and the check
    # belongs here because these are two fields of one artifact disagreeing or agreeing about the
    # same total, which is exactly the class §13.107 found three times.
    #
    # The invariant is one-sided on purpose: the sides may be smaller than the total (the residual
    # is real), never larger -- larger would mean two ledgers counted one call twice, or that one
    # of them is not a subset of the other. The share is printed and not judged, because no
    # registration has said what a legitimate share is, and a threshold invented here would be a
    # bar invented to be passed.
    usage_total = report.get('llmUsage')
    by_side = report.get('usageBySide')
    if isinstance(usage_total, dict) and isinstance(by_side, dict):
        total_calls = usage_total.get('calls')
        side_calls = sum(
            side.get('calls')
            for side in (by_side.get('baseline'), by_side.get('feature'))
            if isinstance(side, dict) and isinstance(side.get('calls'), int)
        )
        if isinstance(total_calls, int):
            residual = total_calls - side_calls
            share = (residual / total_calls * 100) if total_calls else 0.0
            check(
                'spend',
                residual >= 0,
                f'{side_calls:,} of {total_calls:,} calls are on a side; {residual:,} '
                f'({share:.1f}%) outside both, which is the judge and the phrasing stage '
                'by construction (report.ts, attachUsageBySide)'
                if residual >= 0
                else f'the sides report {side_calls:,} calls against a total of {total_calls:,}, '
                'so one ledger counted a call twice or is not a subset of the other',
            )
        else:
            check(
                'spend',
                False,
                'llmUsage.calls is not an integer, so the partition cannot be checked',
            )
    else:
        # Absence is not a failure: an artifact that predates either instrument has no partition
        # to check, and inventing a pass would claim it did.
        lines.append(
            '  SKIP  spend         no llmUsage/usageBySide pair to partition (this artifact '
            'predates one of the two instruments)'
        )

    # 9. The pass shape is three numbers a reader can act on, or it is absent.
    #
    # §13.227 put the pace on the gate line and §13.228 moved it into the artifact, so what is left
    # to check is what a producer is allowed to write there. The three values are not arm properties
    # -- they belong beside `transportRetry` rather than in `memoryArmConfig` -- so their absence is
    # a reading (every artifact written before §13.228 has none, and the reference pipeline resolves
    # no pace at all) and only a present-but-impossible block is a failure.
    #
    # What is deliberately NOT checked: whether `attempts` is consistent with the interval. The
    # bound would be `attempts <= elapsed / interval + 1`, and `elapsed` is nowhere in the artifact;
    # worse, `transportRetry` is process-wide and "not attributable to one backend" in this tool's
    # own words, so a run whose embeddings went out unpaced would carry attempts the reader's gate
    # could not have issued, and a correct run would fail. §13.228.6 records that the falsification
    # condition stays prose for exactly that reason.
    shape = report.get('passShape')
    if isinstance(shape, dict):
        workers = shape.get('workers')
        interval = shape.get('minIntervalMs')
        budget = shape.get('retryBudgetMs')

        def _optional_whole(value: object) -> bool:
            # `bool` is a subclass of `int` in Python, and `True` where a millisecond count belongs
            # is a producer writing a flag into a number's slot -- the class of defect this block
            # exists to catch, not an input to coerce.
            if value is None:
                return True
            return isinstance(value, int) and not isinstance(value, bool) and value >= 0

        workers_ok = (
            isinstance(workers, int)
            and not isinstance(workers, bool)
            and 1 <= workers <= 64
        )
        shape_ok = workers_ok and _optional_whole(interval) and _optional_whole(budget)
        check(
            'pass-shape',
            shape_ok,
            f'{workers} worker(s), interval '
            f'{interval if interval is not None else "unset"}, budget '
            f'{budget if budget is not None else "default"}'
            + (
                ''
                if shape_ok
                else '; workers must be 1..64 -- the range `readWorkers` refuses outside of, so a '
                'block naming another is a producer that clamped instead of failing -- and the '
                'other two must be a non-negative whole number or null, never a formatted string '
                'and never a bool'
            ),
        )
    else:
        lines.append(
            '  SKIP  pass-shape    no passShape block (this artifact predates §13.228, or it came '
            'from the reference pipeline, which resolves no pace); the width it ran at and the '
            'rate it emitted cannot be recovered from it'
        )

    # 10. The prompt's three terms agree: the question and the evidence are inside the prompt.
    #
    # §13.230.2 read `evidenceChars` (the offer) against `promptChars` (the delivery) and concluded
    # that whatever `promptChars` held, it could not be "the evidence in the prompt". It is: an offer
    # larger than the delivered prompt is the ordinary case on a budget-bound route -- medians
    # 504,478 against 46,701 on the 500-question artifact. The pair that answers "what is the
    # overhead" is `promptChars` against the whole prompt, and §13.231 added
    # `deliveredPromptChars` for it.
    #
    # Two invariants, both containment, both true of any run: the evidence is a substring of the
    # prompt it was rendered into, and so is the question. A record violating either has two numbers
    # read from two different prompts, which is the shape §13.230.2 mistook for a contradiction -- a
    # number filed under an object it is not about.
    #
    # What is left after both is the decoration, and it is **printed, not judged**: it is the
    # instruction block plus the four labels and separators, which `buildPrompt` composes as one
    # string per contract, so a run reports one value per contract and a spread is the finding. No
    # threshold is invented here for the reason §13.228 gives one field over -- a bar nobody
    # registered is a bar invented to be passed.
    def _whole_number(value: object) -> bool:
        return isinstance(value, int) and not isinstance(value, bool)

    triples = [
        (
            str(q.get('questionId')),
            q.get('promptChars'),
            q.get('deliveredPromptChars'),
            len(str(q.get('question') or '')),
        )
        for q in questions
        if _whole_number(q.get('promptChars')) and _whole_number(q.get('deliveredPromptChars'))
    ]
    if triples:
        broken = [(qid, ev, tot) for qid, ev, tot, _ in triples if tot < ev]
        # A prompt that does not contain its own question is not a prompt this reader sent, and the
        # subtraction is the only place the artifact states it. `-1` marks "the question does not
        # fit", which is what a length measured from a different string looks like.
        unasked = [(qid, ev, tot, qlen) for qid, ev, tot, qlen in triples if tot - ev < qlen]
        decor = sorted({tot - ev - qlen for _, ev, tot, qlen in triples if tot - ev >= qlen})
        median_total = _median([float(tot) for _, _, tot, _ in triples]) or 0.0
        share = (decor[len(decor) // 2] / median_total * 100) if decor and median_total else 0.0
        detail = (
            f'{len(triples)} record(s) carry both terms; after the evidence and the question, '
            f'{len(decor)} distinct decoration size(s) {decor} character(s), the median '
            f'{share:.1f}% of a median prompt of {median_total:.0f} -- this is the instruction '
            'block plus the four labels, and it is the whole of what the budget does not spend on '
            'evidence'
        )
        if broken:
            detail = (
                f'{len(broken)} record(s) carry more evidence than prompt, first {broken[0][0]} '
                f'({broken[0][1]} evidence in {broken[0][2]}); one of the two numbers was read '
                'from a different prompt'
            )
        elif unasked:
            detail = (
                f'{len(unasked)} record(s) cannot hold their own question, first {unasked[0][0]} '
                f'({unasked[0][1]} evidence and {unasked[0][3]} question characters in '
                f'{unasked[0][2]}); the evidence or the question was measured from a different '
                'string than the one sent'
            )
        check('prompt-overhead', not broken and not unasked, detail)
    else:
        lines.append(
            '  SKIP  prompt-overhead no record carries deliveredPromptChars (this artifact '
            'predates §13.231); the overhead is then only bounded by maxPromptChars minus '
            'promptChars, and what it is made of cannot be recovered from it'
        )

    # 11. Every verdict was produced by an instrument that answered.
    #
    # Run `41585013786` is the reason the field exists: 500 answers and 342 verdicts, then one
    # judge call whose retry ladder ran out (`attempts=4, retried=3, elapsedMs=134163`), and the
    # rejection left the scoring loop and killed the process. Nothing was written, so the reading
    # that could have been taken from 499 judged questions over 500 was not taken at all.
    #
    # `AblationResult.unjudged` now carries the questions each side's scorer could not decide, and
    # the count is judged here rather than in the report: an artifact whose instrument failed has
    # a number that is pessimistic by at most `unjudged / total` points, and the reader is owed
    # both the number and that bound. The check fails because red is how a human learns to look;
    # the artifact still exists, which is the half this field was added for.
    ablation_block = report.get('ablation') if isinstance(report.get('ablation'), dict) else {}
    census = ablation_block.get('unjudged')
    if isinstance(census, dict):
        sides = {name: census.get(name) or [] for name in ('feature', 'baseline')}
        unjudged_total = sum(len(v) for v in sides.values())
        if unjudged_total == 0:
            check(
                'unjudged',
                True,
                'both sides carry an empty census: every verdict in this artifact came from '
                'the instrument that was asked for it',
            )
        else:
            first = next(
                (item for side in ('feature', 'baseline') for item in sides[side] if item),
                {},
            )
            per_side = ', '.join(f'{name} {len(v)}' for name, v in sides.items())
            check(
                'unjudged',
                False,
                f'{unjudged_total} question(s) were never judged ({per_side}); first '
                f'{first.get("questionId")} -- {str(first.get("cause"))[:120]}. Each one is '
                f'scored incorrect, so every accuracy in this artifact is pessimistic by at most '
                f'{unjudged_total / max(1, len(questions)) * 100:.2f} points, and a pair with one '
                'side unjudged is a discordance the instrument invented rather than a flip',
            )
    else:
        lines.append(
            '  SKIP  unjudged this artifact predates the census (cortex-eval#unjudged); the '
            'verdict count is then only bounded by the scorer-channel line in the run log, which '
            'expires with the job'
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

    ## The TOTAL, which used to be a clamp of the sums

    §13.214. Each row clamps two differences that point in opposite directions, and the first
    version summed `pool` and `carried` across capabilities and clamped the **totals**. That makes
    a capability with a surplus cancel one with a shortfall before either clamp runs, so the TOTAL
    is not the sum of the column above it: on run `41284575092` the rows hold 707 cut turns and 53
    beyond-pool turns, while the TOTAL printed 654 and **zero**. A zero where the data says 53 is
    the false-zero class this campaign refuses, and it is worse here than a missing number because
    the "arrived from outside the pool" note keys off that column and therefore never fired either.

    The columns are now accumulated per record and the TOTAL is their sum, so a reader can add the
    column and get the printed number.
    """
    by_capability: dict[str, list[tuple[int, int, int, int, int]]] = {}
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
        # The two clamps are applied **here**, per record, and never to a sum. See the docblock:
        # a clamp of the sums lets one capability's surplus cancel another's shortfall.
        by_capability.setdefault(capability, []).append(
            (total, carried, pool, max(0, pool - carried), max(0, carried - pool))
        )

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
    cut_total = 0
    for capability in sorted(by_capability):
        rows = by_capability[capability]
        gold = sum(row[0] for row in rows)
        carried = sum(row[1] for row in rows)
        pool = sum(row[2] for row in rows)
        # The two directions are different quantities and only one of them can be positive per
        # record. Below the pool's width the room refuses gold the ranking offered; above it the
        # room reaches gold the ranking never offered, because the selection continues past the
        # scored set. Printing the second as a negative first would report a cut that ran
        # backwards -- which is what the first version of this table did on run `39180819474`.
        #
        # Summed from the records rather than recomputed from `pool - carried`: a capability whose
        # aggregate floats one turn above the pool can hold records on both sides, and
        # `max(0, sum)` would report the wrong one of them (§13.214).
        cut = sum(row[3] for row in rows)
        beyond = sum(row[4] for row in rows)
        lines.append(
            f'  {capability:<10}{len(rows):>5}{gold:>7}{gold - pool:>16}{cut:>19}'
            f'{beyond:>17}{carried:>11}'
        )
        totals[0] += gold
        totals[1] += carried
        totals[2] += pool
        beyond_total += beyond
        cut_total += cut
    lines.append(
        f'  {"TOTAL":<10}{measured:>5}{totals[0]:>7}{totals[0] - totals[2]:>16}'
        f'{cut_total:>19}{beyond_total:>17}{totals[1]:>11}'
    )
    lines.append(
        '  "never surfaced" is the ranking\'s reach; "cut by the budget" is the order above '
        'the cut; "beyond the pool" is gold the room reached that the ranking never offered, '
        'which is possible only when the window is wider than the pool.'
    )
    if beyond_total:
        # §13.214. The four numbers read as destinations and are not: "never surfaced" is
        # `total - pool`, so it includes the gold the room carried from beyond the pool, which
        # "delivered" counts again. Without this line a reader who added the columns would find
        # a sum larger than `gold` and conclude the table was broken rather than double-counting.
        lines.append(
            f'  the columns are NOT a partition: "never surfaced" counts every gold turn the '
            f'ranking did not offer, including the {beyond_total} the room delivered from beyond '
            f'the pool -- so those {beyond_total} appear in two columns, and the sum of the '
            f'columns exceeds `gold` by exactly {beyond_total}. Only the per-row direction is a '
            'destination; the aggregate is three marginal counts over one gold list.'
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


def composition_section(questions: list[dict]) -> tuple[str, int]:
    """How much of each window the ranking could order at all.

    ## The question, and the account that could not answer it

    `--pool` reports where the **gold** went. That account is conditioned on the turns the
    dataset annotated, so on a question whose annotation names one turn it says nothing about
    the other two hundred the reader also read. The consequence is a specific blindness: a
    window that is 40% unscored leftovers and a window that is fully scored produce the same
    `--pool` row, and they call for opposite work.

    ## Why the split is where the ranking's reach ends

    The index answers a floor of `-2` for a turn it was never asked about, and the selection
    sorts descending, so an unscored turn is admitted **only** by room the scored turns left
    over. That makes "the window overflowed past the pool" a measured event, and it puts the
    two columns in different worlds: the left one is room a re-rank can re-spend, the right
    one is room no re-rank can reach, because the turns in it have no score to reorder.

    ## Why the total is the sum of the rows

    `§13.214` is the reason this is spelled out. That table computed its TOTAL from summed
    `pool` and `carried` before clamping two of the four columns, so a capability delivering
    past the pool cancelled one cut short of it, and 53 gold turns printed as 0. Here the
    rows are accumulated and every TOTAL cell is the sum of the cells above it; the test
    asserts the identity per column, so a column added later cannot silently stop adding up.

    ## Why the character columns are turn texts and not the prompt

    `sum(turn.length)`, not the length of the string the model received: the prompt carries
    per-turn decoration and the session note, so the denominator of `maxPromptChars` is larger
    than this total. The share this prints is a share of **delivered evidence**, which is the
    quantity the two columns partition. It is not a share of the budget, and the heading says
    so rather than leaving a reader to divide it by 48,000 and get a number that describes
    neither.
    """
    by_capability: dict[str, list[int]] = {}
    measured = 0
    for question in questions:
        composition = question.get('windowComposition')
        if not isinstance(composition, dict):
            continue
        try:
            turns = int(composition['turns'])
            offered = int(composition['offered'])
            offered_chars = int(composition['offeredChars'])
            unscored_chars = int(composition['unscoredChars'])
        except (KeyError, TypeError, ValueError):
            continue
        row = by_capability.setdefault(str(question.get('capability', '?')), [0, 0, 0, 0, 0])
        row[0] += 1
        row[1] += turns
        row[2] += offered
        row[3] += offered_chars
        row[4] += unscored_chars
        measured += 1

    if measured == 0:
        return '', 0

    lines = [
        '=== where the room went (delivered evidence, by turn and by character) ===',
        '  a turn is in the left column when the ranking scored it; an unscored turn is '
        'admitted only by room the scored ones left over, so no re-rank can reorder it',
        '',
        f'  {"capability":<10}{"n":>5}{"turns":>7}{"offered":>9}{"offered chars":>15}'
        f'{"unscored chars":>16}{"total chars":>13}',
    ]
    totals = [0, 0, 0, 0, 0, 0]
    for capability in sorted(by_capability):
        n, turns, offered, offered_chars, unscored_chars = by_capability[capability]
        total_chars = offered_chars + unscored_chars
        lines.append(
            f'  {capability:<10}{n:>5}{turns:>7}{offered:>9}{offered_chars:>15}'
            f'{unscored_chars:>16}{total_chars:>13}'
        )
        totals[0] += n
        totals[1] += turns
        totals[2] += offered
        totals[3] += offered_chars
        totals[4] += unscored_chars
        totals[5] += total_chars

    lines.append(
        f'  {"TOTAL":<10}{totals[0]:>5}{totals[1]:>7}{totals[2]:>9}{totals[3]:>15}'
        f'{totals[4]:>16}{totals[5]:>13}'
    )

    if totals[5] > 0:
        share = 100.0 * totals[3] / totals[5]
        lines.append('')
        lines.append(
            f'  share of delivered evidence the ranking could order: {share:.1f}%  '
            f'({totals[3]} of {totals[5]} characters)'
        )
        lines.append(
            f'  share it could not: {100.0 - share:.1f}%  ({totals[4]} characters on turns '
            'the ranking never scored)'
        )
        if totals[4] == 0:
            lines.append(
                '  every delivered character was scored, so the levers left in this window are '
                "the ranking's ORDER and the POOL's WIDTH -- not the selection, which had "
                'nothing unscored to spend on.'
            )
        else:
            lines.append(
                '  the unscored share is room a re-rank cannot reach: those turns carry no '
                "score to reorder, so the only repairs that move them are a wider POOL or a "
                'selection that refuses the unscored tail.'
            )
    if totals[2] > totals[1]:
        lines.append(
            f'  {totals[2]} offered against {totals[1]} delivered: a record counts a turn it '
            'was offered more than once, so a repeat is a caller defect reported rather than '
            'clamped'
        )
    return '\n'.join(lines), measured


def _whole_count(value: object) -> int:
    """A count, or `ValueError`. `bool` is an `int` in Python, so it is refused by name.

    The same rule `--spend` applies one section over: a producer that serialised a flag into a
    counter must not read as a count of 1, because 1 is a plausible count and nothing downstream
    would ever question it.
    """
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError('not a non-negative whole number')
    return value


# The three states `transport_section` can be in, and they are not two: an artifact written
# before the field existed and an artifact whose block is corrupt both print nothing, and they
# mean opposite things about the run.
TRANSPORT_OK = 'ok'
TRANSPORT_ABSENT = 'absent'
TRANSPORT_CORRUPT = 'corrupt'


def transport_section(report: dict) -> tuple[str, str]:
    """What the provider did with the requests: attempts, retries, and the `429` count.

    ## Why a run's wall clock is not visible anywhere else

    `--spend` counts the calls that RETURNED. A call rejected six times and then served is one
    call there and seven requests on the wire, and before `13.216` nothing in the artifact could
    tell the two apart. Run `41346610318` died on a `429` at question 13 of 20 and left twelve
    graded answers, a stack trace, and no number saying a rate limit had been hit -- the
    counters existed and were printed to stderr, which is the channel that expires first.

    ## Why absence and corruption are separate answers

    A table of zeros would say "nothing was throttled". Absence says "this run predates the
    field". A block that is present and malformed says a third thing: the producer wrote
    something this reader cannot substantiate. Folding that into "absent" would let a broken
    producer hide behind an old artifact's excuse.

    ## Why the reading line is not left to the reader

    Eight counters and no sentence is how a `429` count gets read as "the provider was slow".
    The three states below call for different work, so the section names which one it is.

    `provider` and `scope` are printed rather than assumed: the counters are process-wide, and a
    reader who took them for the reader's alone would attribute the embedding backend's failures
    to the LLM.
    """
    block = report.get('transportRetry')
    if block is None:
        return '', TRANSPORT_ABSENT
    if not isinstance(block, dict):
        return '', TRANSPORT_CORRUPT
    try:
        calls = _whole_count(block['calls'])
        attempts = _whole_count(block['attempts'])
        retried = _whole_count(block['retried'])
        retried_calls = _whole_count(block['retriedCalls'])
        clean_calls = _whole_count(block['cleanCalls'])
        exhausted = _whole_count(block['exhaustedCalls'])
        rate_limited = _whole_count(block['rateLimited'])
        honoured = _whole_count(block['retryAfterHonoured'])
        # Optional, and absence is a reading rather than a zero: `refusedCalls` was added after
        # `41393748964`, and an artifact written before it cannot report one. Requiring it would
        # refuse every earlier record, which is the check that passes on everything written after
        # the field and rejects the archives.
        refused = _whole_count(block['refusedCalls']) if 'refusedCalls' in block else None
    except (KeyError, ValueError):
        return '', TRANSPORT_CORRUPT

    rate = 0.0 if calls == 0 else 100.0 * retried_calls / calls
    lines = [
        '=== transport (what the provider did with the requests) ===',
        f'  scope: {block.get("scope", "?")}, provider: {block.get("provider", "?")}  '
        '(process-wide counters; not attributable to one backend)',
        '',
        f'  {"calls":<26}{calls:>8}',
        f'  {"requests issued":<26}{attempts:>8}',
        f'  {"retries":<26}{retried:>8}',
        f'  {"served on the first attempt":<26}{clean_calls:>8}',
        f'  {"calls that retried":<26}{retried_calls:>8}',
        f'  {"calls that never settled":<26}{exhausted:>8}',
        f'  {"attempts answered 429":<26}{rate_limited:>8}',
        f'  {"Retry-After honoured":<26}{honoured:>8}',
    ]
    if refused is None:
        lines.append(
            f'  {"retries the ladder declined":<26}{"predates":>8}'
        )
    else:
        lines.append(f'  {"retries the ladder declined":<26}{refused:>8}')
    lines += [
        '',
        f'  retry rate: {rate:.2f}%  ({retried_calls} of {calls} calls)',
    ]
    # Two identities, because the artifact has two vintages and each one has to close against
    # the terms it actually carries. Checking the four-term sum against a record that predates
    # the fourth term would report a defect in a correct older artifact -- and skipping the
    # check entirely would let a broken legacy record through, which is the check that only
    # passes on the records written after it.
    if refused is None:
        if clean_calls + retried_calls + exhausted != calls:
            lines.append(
                f'  NOT A PARTITION: {clean_calls} + {retried_calls} + {exhausted} != {calls}. '
                'The counts were read across a boundary, so no rate above can be trusted.'
            )
    elif clean_calls + retried_calls + exhausted + refused != calls:
        lines.append(
            f'  NOT A PARTITION: {clean_calls} + {retried_calls} + {exhausted} + {refused} '
            f'!= {calls}. The counts were read across a boundary, so no rate above can be '
            'trusted.'
        )
    if calls == 0:
        lines.append(
            '  NOT WIRED: no call reached the retry layer, which a run that graded answers '
            'cannot do -- this is the instrument, not the provider.'
        )
    elif retried == 0:
        lines.append(
            '  reading: nothing was throttled; every call was served on its first attempt, '
            'so this run spent no wall clock waiting for a window to reopen.'
        )
    elif rate_limited == 0:
        lines.append(
            f'  reading: {retried} retries, none of them a 429 -- transport failures or 5xx. '
            'The provider was not throttling; the network or the server was.'
        )
    else:
        lines.append(
            f'  reading: the provider throttled {rate_limited} of {attempts} requests and the '
            f'ladder absorbed {retried_calls} of {calls} calls. The cost is wall clock, not '
            'tokens, and the next dispatch inherits it.'
        )
    return '\n'.join(lines), TRANSPORT_OK


# The keys a partial record cannot be read without, and the two it can.
#
# `completed` and `transportRetry` are OPTIONAL on purpose, and the archives say so rather than a
# preference: `/workspace/cortex-run-38941095220-partial.json` -- a real failure record from this
# campaign -- carries six keys and neither of them. A reader that demanded `completed` would call
# that file "not a partial", which is the shape of defect this whole family is about: the check
# would pass on everything written after the field and refuse the only records that exist.
PARTIAL_REQUIRED = ('system', 'reached', 'total', 'run', 'baselineAnswers', 'featureAnswers')


def partial_section(record: dict) -> tuple[str, str]:
    """Read a `PartialAblation`: how far the run got, and what the transport saw on the way.

    ## The loss this reads, and why the report reader could not

    `13.216` gave the report the retry counters and `13.216.8` gave them to the partial, because a
    run that dies produces no report at all: `41346610318` left one log file, twelve graded answers
    and no number saying a rate limit had been hit. The field is now written -- and until this
    section existed, nothing in the pipeline could read it. A field with no reader is the same
    defect as no field, one commit later.

    The archived record is the fixture this section is built from, key for key:

        {"system": "cortex-memory", "reached": 12, "total": 20, "run": 0,
         "baselineAnswers": [...20 answers...], "featureAnswers": [...12 answers...],
         "completed": []}

    A complete baseline, twelve of twenty feature answers, and -- in that file -- no counters,
    because it was written before they existed. Both facts are printed, and the second is printed
    as an absence rather than as a zero.

    ## Why the prohibited readings are named

    A partial invites three subtractions, and each produces a number that looks like a measurement:

    - **an accuracy**, over whichever side happens to be complete. The baseline here has all twenty
      answers, so scoring it alone yields a rate that is real and that belongs to no arm;
    - **a delta**, which is `featureAggregate.avg - baselineAggregate.avg` over the same index, so
      a short side makes it arithmetic over a comparison that was never paired;
    - **a per-capability table**, in which an unanswered capability renders as `0/0` -- identical
      to a measured zero.

    So the section states the extent, states that the answers are ungraded (scoring them needs the
    dataset, which the record does not carry), and names `delta` as absent rather than leaving a
    reader to notice.

    Returns the block and the state of the counter block (`'ok'`, `'absent'`, `'corrupt'`), because
    the exit code says which of the three happened and a printed line cannot.
    """
    report_shaped = _questions(record) is not None or 'ablation' in record
    if report_shaped:
        raise ValueError(
            'this is a complete report, not a partial record. Nothing was lost, so read it '
            'without --partial: a partial reader pointed at a finished run would report an '
            'extent of zero for a run that reached every question.'
        )
    missing = [key for key in PARTIAL_REQUIRED if key not in record]
    if missing:
        raise ValueError(
            f'no {", ".join(missing)} -- keys: {sorted(record)}. A partial record carries the '
            'side that was running, how far it got, and the answers on both sides.'
        )
    try:
        reached = _whole_count(record['reached'])
        total = _whole_count(record['total'])
        ordinal = _whole_count(record['run'])
        baseline = record['baselineAnswers']
        feature = record['featureAnswers']
        if not isinstance(baseline, list) or not isinstance(feature, list):
            raise ValueError('answers are not lists')
    except (KeyError, ValueError):
        raise ValueError(
            'the extent is unreadable: `reached`, `total` and `run` must be non-negative whole '
            'numbers and both answer fields must be lists (a bool is a flag, not a count).'
        ) from None
    if not isinstance(record['system'], str) or record['system'] == '':
        raise ValueError('`system` is missing or empty, so there is no side to attribute this to.')

    share = 'no questions in the dataset' if total == 0 else f'{100.0 * reached / total:.1f}% of it'
    lines = [
        '=== partial measurement (the run did not finish) ===',
        f'  died on: {record["system"]}, repetition {ordinal}',
        f'  reached: {reached} of {total} questions ({share})',
        f'  answers kept -- baseline: {len(baseline)}, feature: {len(feature)}',
    ]
    completed = record.get('completed')
    if completed is None:
        # `completed` predates nothing -- it is the younger of the two optional fields, and an
        # artifact without it can still say how many repetitions finished, because the ordinal
        # does: the repetitions are sequential, so `run: i` means `0..i-1` completed on BOTH
        # sides. `cortex-run-38941095220-partial.json` is exactly this case -- `run: 1`, no
        # `completed`, and two thousand graded answers that were in memory and were not written.
        # Saying "not recorded" alone would understate what the record proves.
        finished = (
            '  repetitions finished before it: not recorded -- this artifact predates the field'
            if ordinal == 0
            else f'  repetitions finished before it: {ordinal} (the ordinal says 0..{ordinal - 1} '
            'completed on both sides); their answers are NOT in this record, which predates the '
            'field that carries them'
        )
        lines.append(finished)
    elif not isinstance(completed, list):
        raise ValueError('`completed` is present and is not a list.')
    elif completed == []:
        lines.append(
            '  repetitions finished before it: 0 -- the failure was in the first repetition, so '
            'nothing earlier was lost with it'
        )
    else:
        ordinals = []
        for entry in completed:
            if not isinstance(entry, dict):
                raise ValueError('`completed` carries a non-object entry.')
            pair = (entry.get('baselineAnswers'), entry.get('featureAnswers'))
            if not all(isinstance(value, list) for value in pair):
                raise ValueError('a `completed` entry is missing one of its two answer lists.')
            ordinals.append(
                f'run {entry.get("run", "?")}: {len(pair[0])} + {len(pair[1])} answers'
            )
        lines.append(f'  repetitions finished before it: {len(completed)} ({"; ".join(ordinals)})')

    lines += [
        '',
        '  What this record CAN say: how far the run got, and what the transport saw before it died.',
        '  What it cannot: any accuracy and any delta. These answers are ungraded -- scoring them',
        '  needs the dataset, which this record does not carry -- and `delta` subtracts two',
        '  aggregates over the same index, so a short side would be arithmetic over a comparison',
        '  that never happened. A per-capability table is absent for the same reason: an unanswered',
        '  capability renders as 0/0, which is identical to a measured zero.',
    ]

    counters, state = transport_section(record)
    if state == TRANSPORT_ABSENT:
        lines += [
            '',
            '  counters: not in this record. The partial carries `transportRetry` from 13.216.8',
            '  onward, so absence here means the artifact predates the field -- NOT that the run',
            '  was never throttled, which a table of zeroes would claim.',
        ]
    elif state == TRANSPORT_CORRUPT:
        lines += [
            '',
            '  counters: PRESENT AND UNREADABLE. Every count must be a non-negative whole number,',
            '  so this is a producer defect on the one record whose purpose is to explain a',
            '  failure -- not an old artifact, and not a run that never retried.',
        ]
    else:
        lines += ['', counters]
    return '\n'.join(lines), state


# The cut points the rank curve reports.
#
# Three, and they are the three the argument needs rather than a sweep: 8 is roughly the
# head of a window a model reads attentively, 16 is a third of the pool, and 32 is half of
# it. A deeper sweep would describe the curve without changing the decision it feeds.
RANK_CUTS = (8, 16, 32)


def served_in_full(question: dict) -> bool | None:
    """Whether every gold turn the pool **surfaced** reached the window.

    `None` when the record cannot answer the question: no `goldOverlap`, no `goldRanks`, no
    `windowComposition.turns`, or no gold turn the pool surfaced at all (a question whose gold the
    ranking never reached is neither full nor partial -- what it needs is a wider pool, and folding
    it into "partial" would price a room change as a reading change).

    The definition is `rank >= 0` means "this gold turn was offered by the retrieval", and
    `rank < turns` means "the window had room for it". So a question is partial exactly when
    retrieval did its job and the room did not, which is the population a coverage treatment can
    move.
    """
    overlap = question.get('goldOverlap')
    composition = question.get('windowComposition')
    if not isinstance(overlap, dict) or not isinstance(composition, dict):
        return None
    ranks = overlap.get('goldRanks')
    turns = composition.get('turns')
    if not isinstance(ranks, list) or not isinstance(turns, int):
        return None
    surfaced = [rank for rank in ranks if isinstance(rank, int) and rank >= 0]
    if not surfaced:
        return None
    return all(rank < turns for rank in surfaced)


def split_section(questions: list[dict]) -> tuple[str, int]:
    """Accuracy at full and at partial coverage, per capability.

    ## Why this is a mode and not a paragraph

    §13.243.2 chose the next MR experiment from this split -- *"accuracy, full coverage 75 -> 82,
    84.0% -> 89.0%; accuracy, partial coverage 65.2% -> 48.7%"* -- and computed it with a script
    that was never committed. Run `41860773768` then could not be read against it: the same run read
    through `--coverage`'s five bands says nothing about this partition, because `--coverage` bands
    `carried / total` and this splits on **where the surfaced gold sat**. Two definitions, both
    legitimate, and a reader who takes one for the other gets 85 against 75 questions and a
    completely different story about what limits MR.

    So the definition lives here, with a test, and a run can be read against another one.

    ## What each half licenses

    A **partial** question is one where retrieval offered a gold turn the window could not hold. Any
    change to the room moves population between the bands without touching the reading, which is what
    §13.243 measured and why its headline did not move. A **full** question has every surfaced gold
    turn in front of the reader, so its accuracy is a statement about the contract and the reader
    with the retrieval variable held fixed -- the only population on which an ask change is cleanly
    attributable.
    """
    rows: list[tuple[str, list[dict], list[dict], list[dict]]] = []
    measured = 0
    for capability in sorted({question.get('capability') for question in questions if question.get('capability')}):
        roster = [question for question in questions if question.get('capability') == capability]
        full = [question for question in roster if served_in_full(question) is True]
        partial = [question for question in roster if served_in_full(question) is False]
        measured += len(full) + len(partial)
        if not full and not partial:
            continue
        rows.append((capability, roster, full, partial))
    if not rows:
        return '', 0

    def accuracy(roster: list[dict]) -> tuple[int, float]:
        correct = sum(1 for question in roster if question.get('correct'))
        return correct, (100.0 * correct / len(roster) if roster else 0.0)

    lines: list[str] = [
        '',
        'coverage split (a question is full when every gold turn the pool surfaced reached the window)',
        f"  {'capability':10s} {'n':>4s} {'acc':>7s}   {'full n':>6s} {'acc':>7s}   {'part n':>6s} {'acc':>7s}   {'depth':>6s}",
    ]
    for capability, roster, full, partial in rows:
        correct, overall = accuracy(roster)
        full_correct, full_accuracy = accuracy(full)
        part_correct, part_accuracy = accuracy(partial)
        depths = [
            question['windowComposition']['turns']
            for question in roster
            if isinstance(question.get('windowComposition'), dict)
            and isinstance(question['windowComposition'].get('turns'), int)
        ]
        depth = f'{sum(depths) / len(depths):.1f}' if depths else '-'
        lines.append(
            f'  {capability:10s} {len(roster):4d} {overall:6.2f}%   '
            f'{len(full):6d} {full_accuracy:6.2f}%   {len(partial):6d} {part_accuracy:6.2f}%   {depth:>6s}'
        )
        del correct, full_correct, part_correct
    lines.append(
        '  a partial question is one where retrieval offered a gold turn the room could not hold, so a'
    )
    lines.append(
        '  room change moves population between the bands; a full question is where an ask change is cleanly readable'
    )
    # The split's labels say more than the definition supports, and this line is the measurement
    # of that gap rather than a footnote about it (§13.253.2). `partial` here means "the window did
    # not cover the ranking's prefix", which is not the same as "a gold turn did not arrive": the
    # window is not a prefix of the ranking, and unscored gold is admitted by leftover room. So
    # some partial questions delivered everything, and a reader comparing this table against
    # `--strata` is owed the count rather than a warning.
    partial_all = [
        question
        for _, _, _, partial in rows
        for question in partial
        if isinstance(question.get('goldOverlap'), dict)
        and question['goldOverlap'].get('carried') == question['goldOverlap'].get('total')
    ]
    partial_total = sum(len(partial) for _, _, _, partial in rows)
    lines.append(
        f'  {len(partial_all)} of {partial_total} partial questions delivered every gold turn anyway'
        ' (carried == total): the label is about the ranking prefix, not about missing evidence'
    )
    return '\n'.join(lines), measured


# The four states `--strata` separates. Three are a partition of every question the artifact can
# decide; the fourth is what an artifact that predates `goldDelivered` leaves behind, printed as a
# count rather than guessed at.
STRATUM_COMPLETE = 'complete'
STRATUM_ROOM_CUT = 'room-cut'
STRATUM_UNSURFACED = 'unsurfaced'
STRATUM_UNDECIDABLE = 'undecidable'
STRATA = (STRATUM_COMPLETE, STRATUM_ROOM_CUT, STRATUM_UNSURFACED, STRATUM_UNDECIDABLE)


def stratum_of(question: dict) -> str | None:
    """Which stratum a record is in, or `None` when it does not carry the evidence to say.

    ## What this replaced, and why the replacement was itself wrong

    §13.252 read delivery off `goldRanks` -- `rank < turns` meant "the window held it" and `rank < 0`
    meant "the ranking never surfaced it". Both readings are invalid, and `41860773768` shows it
    twice:

    * `turns` counts **every** delivered turn, including ones the ranking never scored, and the
      admission loop skips a turn that does not fit and keeps going -- so the delivered set is not a
      prefix of the ranking. **48 questions carry a gold ranked beyond `turns` that the reader
      nevertheless received**, and the old rule filed all 48 under "depth-limited".
    * a gold the ranking never scored is admitted by leftover room, so `rank < 0` does not mean the
      reader did not get it. **16 questions were filed as "pool-missing" with `carried == total`.**

    `GoldOverlap.carried` is the delivery count and `goldDelivered` is the delivery itself. The rank
    array answers a different question -- "did the ranking ever offer it" -- and the two only agree
    when the window is a prefix of the ranking and nothing is admitted past the pool.

    ## The four states

    `complete` -- every gold turn reached the reader. Whatever the ranks say, nothing is missing, so
    neither a deeper room nor a better ranking can change the evidence this question was answered
    from.

    `room-cut` -- not every gold arrived, **and** every gold the dataset names was surfaced. The
    missing part was in the pool and the window did not buy it. This is the population a depth
    treatment targets, and the only one it can target.

    `unsurfaced` -- not every gold arrived, and at least one that did not arrive was never surfaced
    either. No window reaches it.

    `undecidable` -- not every gold arrived and some gold was never surfaced, but the record has no
    `goldDelivered`, so "the unsurfaced gold" and "the gold that did not arrive" cannot be shown to
    be the same turn. On `41860773768` this is **145 questions**, and it is why the field exists: the
    archived artifact can say that 145 questions lack a gold turn and that 145 contain an unsurfaced
    gold, and it cannot say how many lack *because* it was unsurfaced.

    `None` rather than a fifth state for a record that cannot be classified at all: no `goldOverlap`
    (no gold was measured), no ranks (no ranking was consulted, so the surfaced question is
    meaningless), or flags that disagree with `carried` -- a summary that contradicts its own
    measurement is a producer defect, not a population.
    """
    overlap = question.get('goldOverlap')
    if not isinstance(overlap, dict):
        return None
    carried = overlap.get('carried')
    total = overlap.get('total')
    ranks = overlap.get('goldRanks')
    if not isinstance(carried, int) or not isinstance(total, int) or total <= 0:
        return None
    if not isinstance(ranks, list) or len(ranks) != total:
        return None
    if any(not isinstance(rank, int) for rank in ranks):
        return None
    # The flags first, when the record has them, because they are the measurement `carried`
    # summarises. A summary that disagrees with its own measurement is a producer defect: the record
    # is dropped rather than classified from whichever column the classifier trusts more.
    delivered = overlap.get('goldDelivered')
    if isinstance(delivered, list) and len(delivered) == total:
        if any(not isinstance(flag, bool) for flag in delivered):
            return STRATUM_UNDECIDABLE
        if sum(delivered) != carried:
            return None
        missing = [index for index, flag in enumerate(delivered) if not flag]
        if not missing:
            return STRATUM_COMPLETE
        return STRATUM_ROOM_CUT if all(ranks[index] >= 0 for index in missing) else STRATUM_UNSURFACED
    # The archived path: `carried` still answers "how many", and the ranks answer "did the ranking
    # ever offer it", but the intersection is not observable.
    if carried >= total:
        return STRATUM_COMPLETE
    if all(rank >= 0 for rank in ranks):
        return STRATUM_ROOM_CUT
    return STRATUM_UNDECIDABLE


def _gold_total(question: dict) -> int:
    """The gold turns this question's policy admits, or `0` when the record cannot say."""
    overlap = question.get('goldOverlap')
    total = overlap.get('total') if isinstance(overlap, dict) else None
    return total if isinstance(total, int) else 0


def strata_section(questions: list[dict]) -> tuple[str, int]:
    """Where each question stands, in four states, each beside its own accuracy.

    ## What the first version of this table said, and what it cost

    §13.252 replaced a column that had restated its own row above it with a three-way split --
    exact 197 / depth 142 / pool 161 -- and drew two conclusions from it: that a deeper window is
    worth nothing because the 142 it would reach already read 93.66%, and that MR's room does matter
    for 17 of them. Both rest on reading delivery off the rank array, and neither survives being
    read off `carried` (§13.253).

    ## What the corrected table says

    On `41860773768`: **255 complete at 93.33%, 100 room-cut at 95.00%, 145 undecidable at 82.07%,
    and 0 unsurfaced** -- zero because an artifact without `goldDelivered` cannot prove that the
    gold it did not deliver was the gold the ranking never surfaced.

    The room is exonerated exactly rather than by inference: `room-cut` is by definition the
    population a deeper window would change, and on this run it reads **above** the complete
    population. What is left at 82.07% is a population whose deficit cannot be attributed to
    retrieval from this artifact at all, which is the finding that replaces the one the first table
    claimed.

    ## Why the price of the missing turns is not printed here

    The artifact carries the delivered turn texts and their count. It does not carry the ranking's
    per-candidate cost, so the characters a deeper cut would spend cannot be read; and because
    delivery is not a prefix of the ranking, a gold's `rank` is not the number of turns that would
    have to be added either. The column that used to report `max(rank) + 1 - turns` in turns was
    therefore measuring a quantity that does not exist. `--room` prices the smaller direction exactly
    for the same reason a prefix can be priced: it is the one direction the artifact fully describes.
    """
    by_capability: dict[str, dict[str, list[dict]]] = {}
    measured = 0
    undecidable = 0
    for question in questions:
        stratum = stratum_of(question)
        if stratum is None:
            continue
        measured += 1
        if stratum == STRATUM_UNDECIDABLE:
            undecidable += 1
        capability = str(question.get('capability', '?'))
        by_capability.setdefault(capability, {}).setdefault(stratum, []).append(question)
    if measured == 0:
        return '', 0

    def cell(roster: list[dict]) -> tuple[str, str]:
        if not roster:
            return '0', '-'
        correct = sum(1 for question in roster if question.get('correct'))
        return str(len(roster)), f'{100.0 * correct / len(roster):.2f}%'

    def surfaced_in_full(roster: list[dict]) -> int:
        return sum(
            1
            for question in roster
            if all(rank >= 0 for rank in question['goldOverlap']['goldRanks'])
        )

    header = f'  {"capability":<10}{"n":>5}'
    for name in STRATA:
        header += f'{name:>12}{"acc":>9}'
    lines: list[str] = [
        '',
        'where each question stands (complete / room-cut / unsurfaced / undecidable), each beside its own accuracy',
        header + f'{"reach":>8}',
    ]
    pooled: dict[str, list[dict]] = {name: [] for name in STRATA}
    reach_total = 0
    for capability in sorted(by_capability):
        groups = by_capability[capability]
        roster = [question for population in groups.values() for question in population]
        reach = surfaced_in_full(roster)
        reach_total += reach
        row = f'  {capability:<10}{len(roster):5d}'
        for name in STRATA:
            here = groups.get(name, [])
            pooled[name].extend(here)
            count, accuracy = cell(here)
            row += f'{count:>12}{accuracy:>9}'
        row += f'{100.0 * reach / len(roster):>7.1f}%'
        lines.append(row)
    # The TOTAL carries the same cells as a row rather than a sum of the count columns alone: the
    # run's four accuracies are the numbers a reader quotes, and a total that printed only counts
    # would send them to compute the pooled figure from four separate denominators.
    total_row = f'  {"TOTAL":<10}{measured:5d}'
    for name in STRATA:
        count, accuracy = cell(pooled[name])
        total_row += f'{count:>12}{accuracy:>9}'
    total_row += f'{100.0 * reach_total / measured:>7.1f}%'
    lines.append(total_row)
    lines.append(
        '  complete = every gold turn reached the reader; room-cut = not all arrived, but all were'
    )
    lines.append(
        '  surfaced (the only population a deeper window can change); unsurfaced = a gold that did not'
    )
    lines.append(
        '  arrive was never surfaced either, so no window reaches it; undecidable = the record has no'
    )
    lines.append(
        '  goldDelivered, so those two states cannot be told apart -- an instrument gap, not a finding'
    )
    lines.append('  reach = share of the row whose every gold was surfaced by the ranking, at any depth')
    if measured != len(questions):
        # A dropped record moves every denominator, so it is printed rather than absorbed: the four
        # columns are a partition of `n`, and a reader who does not see this line would take the
        # roster for the artifact's whole population.
        lines.append(
            f'  {len(questions) - measured} record(s) could not be classified and are in no column '
            '(no goldRanks, a non-integer rank, or flags that disagree with carried)'
        )
    if undecidable:
        lines.append(
            f'  {undecidable} of {measured} records predate goldDelivered: re-run to convert undecidable into the other three'
        )
    # The confounder, printed where the table it confounds is read. How many gold turns a question
    # names predicts its accuracy on its own -- 100.00 / 100.00 / 97.62 / 92.75 / 84.21 across the
    # buckets on `41860773768` -- and the four strata are not independent of it: a big gold set is
    # likelier to lose one. So the table above is a comparison of populations, not of treatments, and
    # the only sentences it supports are the ones that survive holding the bucket fixed. Printing the
    # cut here is cheaper than a footnote nobody re-derives.
    buckets: list[tuple[str, int, int]] = [
        ('1-4', 1, 4),
        ('5-8', 5, 8),
        ('9-16', 9, 16),
        ('17+', 17, 1 << 30),
    ]
    lines.append('')
    lines.append('  the same columns, holding the size of the gold set fixed (the confounder, on the page)')
    confounded = f'  {"gold turns":<10}{"n":>5}'
    for name in STRATA:
        confounded += f'{name:>12}{"acc":>9}'
    lines.append(confounded)
    for label, low, high in buckets:
        here = [
            question
            for question in questions
            if low <= _gold_total(question) <= high
        ]
        if not here:
            continue
        row = f'  {label:<10}{len(here):5d}'
        for name in STRATA:
            count, accuracy = cell([q for q in here if stratum_of(q) == name])
            row += f'{count:>12}{accuracy:>9}'
        lines.append(row)
    lines.append(
        '  the characters a deeper window would spend are NOT in this artifact, and neither is the depth'
    )
    lines.append(
        '  in turns: delivery is not a prefix of the ranking, so a gold rank is not a number of turns to add'
    )
    return '\n'.join(lines), measured



def instrument_section(questions: list[dict]) -> tuple[str, int]:
    """Whether the artifact carries `goldDelivered`, and whether it agrees with what it summarises.

    ## Why this is a mode and not three lines of judgment

    §13.253.7's gates are all structural -- the field on every record, its length equal to `total`,
    its sum equal to `carried`, and the four strata summing to the roster. Those are the gates a run
    that changes no behaviour is judged by, and a gate re-typed at readback is a gate that gets
    typed differently the second time. So the numbers are printed from one function, and the
    judgement is a comparison against bars already written down.

    ## What the two failure modes look like, and why they are counted apart

    A record **without** the field is an artifact that predates it; a record **with** it and with
    `sum != carried` is a producer that computed two things from two lists. The first is an
    instrument gap and the second is a defect, and a single "inconsistent" count would make them
    look like one problem with one repair.
    """
    present = 0
    wrong_length = 0
    wrong_sum = 0
    delivered = 0
    named = 0
    for question in questions:
        overlap = question.get('goldOverlap')
        if not isinstance(overlap, dict):
            continue
        total = overlap.get('total')
        if not isinstance(total, int) or total <= 0:
            continue
        named += total
        flags = overlap.get('goldDelivered')
        if not isinstance(flags, list):
            continue
        present += 1
        if len(flags) != total:
            wrong_length += 1
            continue
        delivered += sum(1 for flag in flags if flag is True)
        if sum(1 for flag in flags if flag is True) != overlap.get('carried'):
            wrong_sum += 1
    # The partition is reported here as well as in `--strata`, because gate 3 is a statement about
    # this function's own counts: the three decided states must add up to the roster.
    decided = 0
    counts: dict[str, int] = {name: 0 for name in STRATA}
    for question in questions:
        stratum = stratum_of(question)
        if stratum is None:
            continue
        decided += 1
        counts[stratum] += 1
    lines = [
        '',
        'instrument: does the artifact carry the delivery flags, and do they agree with the count',
        f'  records with gold                         {len(questions):5d}',
        f'  carrying goldDelivered                    {present:5d}',
        f'  whose length differs from total           {wrong_length:5d}',
        f'  whose sum differs from carried            {wrong_sum:5d}',
        f'  delivered gold turns                      {delivered:5d} of {named}'
        + (f' ({100.0 * delivered / named:.2f}%)' if named else ''),
        f'  classified                                {decided:5d}',
        '  partition                                 '
        + ' / '.join(f'{counts[name]} {name}' for name in STRATA),
        '  the bars: 500 records carrying the field, 0 wrong length, 0 wrong sum, four columns summing'
        ' to the roster',
    ]
    return '\n'.join(lines), present


def _turn_chars(question: dict) -> int | None:
    """The characters the delivered turns actually carry, or `None` when the record cannot say.

    `promptChars` minus this is the *overhead* — instructions, question, section header — which the
    room does not pay for. Recomputing it per record rather than assuming a constant is what lets the
    simulation be compared against a real run instead of against an idealised one.
    """
    turns = question.get('turns')
    prompt = question.get('promptChars')
    if not isinstance(turns, list) or not isinstance(prompt, int):
        return None
    if any(not isinstance(turn, dict) or not isinstance(turn.get('text'), str) for turn in turns):
        return None
    return sum(len(turn['text']) for turn in turns)


def _surfaced(question: dict) -> list[int]:
    """The gold's ranks that the retrieval actually offered, in pool order."""
    overlap = question.get('goldOverlap')
    if not isinstance(overlap, dict):
        return []
    ranks = overlap.get('goldRanks')
    if not isinstance(ranks, list):
        return []
    return [rank for rank in ranks if isinstance(rank, int) and rank >= 0]


def room_section(questions: list[dict], target: int) -> tuple[str, int]:
    """What a smaller `maxPromptChars` would do, simulated as a prefix of the delivered window.

    ## Why this is exact, and what it is exact about

    The window is an ordered list of turns and the budget admits a prefix of it — asserted over all
    500 records of `41860773768` (`turns[i].index == i`). So "a smaller room" is not a heuristic
    simulation: it is the same prefix the arm would have built, priced by its own turn text, with the
    per-record overhead held fixed. `--split` and `--coverage` read what the window *did*; this reads
    what a different window *would have done*, and it is the only one of the three that answers a
    counterfactual.

    ## What it cannot simulate

    A different **selection** (that needs the retriever), a cascade, or a test-time assembly. So a
    failure here refutes one hypothesis — *the room is too large* — and says nothing about the two it
    cannot express. §13.249 uses it for exactly that: the uniform cut loses 17 points of reachability,
    which closes "shrink the budget" and leaves the predictor family open.

    ## Why the oracle column is not a target

    `oracle` sizes each room to the deepest surfaced gold turn, which is answer information. It is
    printed to score a rule against, never to be encoded — §13.249.4's gate 3.
    """
    rows: dict[str, list[float]] = {}
    for question in questions:
        capability = question.get('capability')
        if not isinstance(capability, str):
            continue
        chars = _turn_chars(question)
        surfaced = _surfaced(question)
        if chars is None or not surfaced:
            continue
        turns = question['turns']
        overhead = question['promptChars'] - chars
        room = target - overhead
        taken = 0
        depth = 0
        for index, turn in enumerate(turns):
            if taken + len(turn['text']) > room:
                break
            taken += len(turn['text'])
            depth = index + 1
        deepest = max(surfaced) + 1
        coverable = deepest <= len(turns)
        oracle = sum(len(turn['text']) for turn in turns[:deepest]) if coverable else None
        row = rows.setdefault(capability, [0, 0, 0, 0.0, 0, 0.0, 0.0])
        row[0] += 1
        row[1] += 1 if all(rank < len(turns) for rank in surfaced) else 0
        row[2] += 1 if all(rank < depth for rank in surfaced) else 0
        row[3] += taken + overhead
        if oracle is not None:
            row[4] += 1
            row[5] += oracle + overhead
        row[6] += question['promptChars']
    if not rows:
        return '', 0

    lines: list[str] = [
        '',
        f'room simulation at {target:,} characters (a smaller room is a prefix of the delivered window)',
        f"  {'capability':10s} {'n':>4s} {'reach@now':>10s} {'reach@target':>13s} {'chars':>8s} {'oracle':>8s} {'ratio':>6s}",
    ]
    totals = [0, 0, 0, 0.0, 0, 0.0, 0.0]
    for capability in sorted(rows):
        count, now, at_target, simulated, coverable, oracle, actual = rows[capability]
        for index, value in enumerate((count, now, at_target, simulated, coverable, oracle, actual)):
            totals[index] += value
        oracle_mean = f'{oracle / coverable:,.0f}' if coverable else '-'
        ratio = f'{(oracle / coverable) / (actual / count):.2f}x' if coverable and actual else '-'
        lines.append(
            f'  {capability:10s} {int(count):4d} {100 * now / count:9.1f}% {100 * at_target / count:12.1f}% '
            f'{simulated / count:8,.0f} {oracle_mean:>8s} {ratio:>6s}'
        )
    count, now, at_target, simulated, coverable, oracle, actual = totals
    if count:
        oracle_mean = f'{oracle / coverable:,.0f}' if coverable else '-'
        ratio = f'{(oracle / coverable) / (actual / count):.2f}x' if coverable and actual else '-'
        lines.append(
            f'  {"ALL":10s} {int(count):4d} {100 * now / count:9.1f}% {100 * at_target / count:12.1f}% '
            f'{simulated / count:8,.0f} {oracle_mean:>8s} {ratio:>6s}'
        )
    lines.append(
        '  `reach` is the share of questions where every surfaced gold turn fits; `oracle` sizes each room'
    )
    lines.append(
        '  to the deepest surfaced gold turn and is a score to beat, never a target to encode'
    )
    return '\n'.join(lines), int(totals[0])


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
        'top 32 and surfaced is what a larger ROOM could buy; below surfaced the ranking never '
        'reached the gold at all, and the only thing that can is a selection that draws on a '
        'wider universe than the scored pool -- `--pool` counts it in its "beyond the pool" column.'
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
DEFAULT_PROMPT_BUDGET_CHARS = 48_000


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
    product's default: 48,000 since §13.213, 24,000 before it. So absence is decided, not unknown,
    and the table names which divisor it used so a historical artifact is still readable and a
    current one is checkable.

    **This constant is a copy of a TypeScript one, and copies drift.** `prompt.ts` owns the value
    and `test_prompt_budget_parity.py` reads it out of the source and compares, so the two cannot
    disagree silently -- the failure mode `test_ask_table_parity.py` exists for, at the other
    place in this repository where one number lives in two languages.

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


# The configuration block's fields that are not configuration.
#
# `voteCounts` is the run's own tally of how many times each verdict came back (§13.104). It lives in
# `memoryArmConfig` because that is where the arm writes everything it wants an artifact to carry, and
# it differs between any two runs that voted -- so comparing it would fail every legitimately paired
# self-consistency run, which is the shape of check that teaches a reader to skip the output.
RUNTIME_CONFIG_FIELDS = frozenset({'voteCounts'})

# Fields that stay whole even though they are objects, because the object **is** the value.
#
# `maxPromptCharsByRoute` is one budget carried as a map (`{multi-session: 48460}`), and the
# flattening above would turn it into `maxPromptCharsByRoute.multi-session` and make every
# comparison per-route. That reads well until the registration has to be parsed: the dispatch sends
# the whole map as one string, `multi-session:48460`, so a per-route path has no registered value to
# be compared with and the tool falls through to `coerce_to_artifact("multi-session:48460", 48460)`
# -- `int()` on a colon. §13.327 is where that was found: `test_preregistration_config.py` compared
# §10.3 with the table, the two agreed, and this tool -- the only one that reads an artifact -- had
# no shape for the value the arm has been shipping since §13.295.
ATOMIC_CONFIG_FIELDS = frozenset({'maxPromptCharsByRoute'})

# What the dispatch calls a field, and the artifact field or fields it writes.
#
# Most entries are one-to-one. The ones that are not are why the table exists:
#
#   * `cortex_memory_max_turn_chars=400:ellipsis` is ONE input the artifact records as `maxTurnChars`
#     400 and `turnCutMarker` "ellipsis" (§13.188.3), so a registration naming the dispatch value has
#     named both fields. A tool comparing artifact fields alone would call every marker run a
#     two-field pair and refuse it.
#   * `cortex_memory_ask` writes `ask` and `askRoutes`, because the second is what the arm computed
#     the first to reach (§13.200.2). It has never had a dispatch input of its own, and requiring a
#     writer to declare it separately would only teach them to paste it in. The artifact path `ask` is
#     listed for the same reason and not out of symmetry: `askRoutes` is a *function* of `ask`, so
#     there is no configuration in which one moved and the other did not.
#   * `thinking` writes `reader.thinking` and, from §13.198, `reader.thinkingRoutes` — one dispatch
#     value, two artifact fields, the same shape as the cut marker. Left one-to-one, every route-scoped
#     reader run would read as an undeclared pair.
#   * `turnCutMarker` is deliberately NOT reachable from the artifact path `maxTurnChars`. It rides the
#     same input string, but it is a second switch rather than a value derived from the width, so a
#     writer who declares only the width has declared only the width.
#   * `model` lands at `reader.model` rather than at a top-level key (§13.192.6).
DISPATCH_FIELD_ALIASES = {
    'ask': ('ask', 'askRoutes'),
    'cortex_memory_ask': ('ask', 'askRoutes'),
    'cortex_memory_prompt_contract': ('promptContract',),
    'cortex_memory_relevance': ('relevanceSignal',),
    'cortex_memory_relevance_top_k': ('relevanceTopK',),
    'cortex_memory_relevance_units': ('relevanceUnits',),
    'cortex_memory_search_unit': ('relevanceUnits',),
    # One input, two shapes: a scalar for one room on every route, a map for the route-scoped room
    # §13.295 adopted. Both are listed, and whichever the artifact carries is compared while the
    # other is counted as derived -- because an artifact cannot carry both, and requiring a writer
    # to declare the shape they did not run would teach them to paste it in.
    'cortex_memory_max_prompt_chars': ('maxPromptChars', 'maxPromptCharsByRoute'),
    'cortex_memory_max_turn_chars': ('maxTurnChars', 'turnCutMarker'),
    'cortex_memory_max_turn_chars_routes': ('maxTurnCharsRoutes',),
    'cortex_memory_evidence_roles': ('evidenceRoles',),
    'cortex_memory_evidence_roles_routes': ('evidenceRolesRoutes',),
    'cortex_memory_review_pass': ('reviewPass',),
    'cortex_memory_rerank': ('rerank',),
    'cortex_memory_query_expansion': ('queryExpansion',),
    'cortex_memory_self_consistency': ('selfConsistency',),
    'cortex_memory_threshold': ('threshold',),
    'cortex_memory_retrieval_threshold': ('retrievalThreshold',),
    'cortex_memory_source_trust': ('sourceTrust',),
    'model': ('reader.model',),
    'thinking': ('reader.thinking', 'reader.thinkingRoutes'),
    'cortex_memory_thinking': ('reader.thinking', 'reader.thinkingRoutes'),
}

# Conditions the registration implies without a dispatch input of its own.
#
# §10.3 registers an arm; not everything that changes what its number *means* is one of the arm's
# fields. `evidenceSource` is the pool each question was graded against, and no dispatch input names
# it: the oracle condition is a repository variable, because the workflow sits at 24 of GitHub's 25
# `workflow_dispatch` inputs and `test_dispatch_inputs.py` refuses a workflow that reaches the limit
# (`docs/MEASURE-ORACLE-CEILING.md`). So the gate had nothing to compare it against, and run
# `42500412709` is what that costs: a 500-question artifact graded against gold sessions passed the
# twenty field comparisons it had and would have reached *"this run is the registered configuration,
# field for field, so its numbers are quotable as the arm's"* -- the one verdict that publishes a
# reader ceiling as the arm's score. The gate refused the run for a different reason (the dispatcher
# declared `oracleEvidence`, a name that resolves to no artifact field), which is why this table is
# keyed on the **artifact's** field rather than on the switch's name: the declaration must name
# something a reader can look at.
#
# Absence reads as the registered value, and that is a claim with a date: `toMemoryArmConfig` writes
# `evidenceSource` on every run since `0ed3541`, and the oracle transform cannot produce an artifact
# that omits it, so an artifact without the field predates it and graded the shipped corpus. An
# artifact produced under the oracle condition can therefore never be silent about it, which is the
# property the whole entry buys.
REGISTERED_CONDITIONS: dict[str, tuple[str, str]] = {
    'evidenceSource': ('evidenceSource', 'corpus'),
    # §13.334. The reply-contract repair changes what a decline count means, not what the run did: a run
    # that answered eight refusals by re-asking has a different `bareRetry` population from one that did
    # not, and the two artifacts would agree about every input. `off` is the registered value, so a
    # treatment run must declare `replyRepair` and a control run is compared against `off`.
    'replyRepair': ('replyRepair', 'off'),
}

ABSENT = '<-absent->'


def _arm_config(report: dict, side: str) -> dict:
    """The `memoryArmConfig` block, or a refusal.

    A missing block is not an empty configuration: two artifacts that carry none agree about every
    field they have, and printing that agreement is the one answer this tool must never give.
    """
    config = report.get('memoryArmConfig')
    if not isinstance(config, dict) or not config:
        raise SystemExit(
            f'{side}: no memoryArmConfig block, so there is nothing to compare. '
            f'Keys present: {sorted(report)}'
        )
    return config


def _flatten_config(config: dict, prefix: str = '') -> tuple[dict, dict]:
    """`config` as dotted paths, split into the configuration and the runtime census.

    Nested dicts are paths rather than values so that a difference names `reader.model` instead of
    printing two five-key dicts and leaving the reader to diff them by eye -- which is the work this
    tool exists to do.
    """
    configuration: dict = {}
    runtime: dict = {}
    for key, value in config.items():
        path = f'{prefix}{key}'
        if key in RUNTIME_CONFIG_FIELDS and not prefix:
            runtime[path] = value
        elif key in ATOMIC_CONFIG_FIELDS:
            configuration[path] = value
        elif isinstance(value, dict) and value:
            nested_config, nested_runtime = _flatten_config(value, f'{path}.')
            configuration.update(nested_config)
            runtime.update(nested_runtime)
        else:
            configuration[path] = value
    return configuration, runtime


def _value_text(value: object) -> str:
    return ABSENT if value is ABSENT else json.dumps(value)


def _claimed_paths(treatment: list[str], known: set[str]) -> tuple[list[str], list[str]]:
    """The artifact paths `--treatment` claims, and the names in it that claim nothing.

    A treatment name that resolves to nothing would license a pair while naming no field, which is the
    `--set` defect's shape applied to the declaration instead of the dispatch: the record would
    describe an intention that never reached the comparison. So it is refused rather than ignored.
    """
    claimed: list[str] = []
    unknown: list[str] = []
    for name in treatment:
        aliases = DISPATCH_FIELD_ALIASES.get(name)
        if aliases is not None:
            claimed.extend(aliases)
        elif name in known or any(path.startswith(f'{name}.') for path in known):
            claimed.append(name)
        else:
            unknown.append(name)
    return claimed, unknown


def _covers(claim: str, path: str) -> bool:
    return path == claim or path.startswith(f'{claim}.')


def diff_section(
    control_report: dict, run_report: dict, treatment: list[str]
) -> tuple[str, int]:
    """The two artifacts' configurations side by side, and how many differences were not declared.

    ## Why this is a gate rather than a report

    `41203245999` ran the composite ask at the *registered* budget while its control ran at the one
    the campaign had been using, so two fields differed and the six readings pinned to that control
    were unreadable (§13.200). Nothing errored: the run was `success`, the artifact was complete, and
    the difference was visible to exactly the reader who thought to look.

    The gate makes looking mandatory. A pair is licensed when every differing field is one the caller
    declared as the treatment; anything else is printed with `control -> run` and the pair is refused,
    because a reading taken across an undeclared field measures that field and the treatment together
    and cannot separate them after the fact.

    ## What is deliberately not a difference

    `voteCounts` is a census, reported under its own heading (§13.104). An **absent** field prints as
    `<-absent->` and never equals `null` by silence, so a run that stopped sending a key is visible.
    And a declared field that did not move is not a failure -- it is printed, because a registration
    that names a field the run did not move describes an intention rather than what ran.
    """
    control = _arm_config(control_report, 'control')
    run = _arm_config(run_report, 'run')
    control_config, control_runtime = _flatten_config(control)
    run_config, run_runtime = _flatten_config(run)

    known = set(control_config) | set(run_config)
    claimed, unknown = _claimed_paths(treatment, known)
    if unknown:
        raise SystemExit(
            f'--treatment names {unknown}, which is neither a dispatch input this tool knows nor a '
            f'field of either artifact. A treatment that resolves to nothing licenses the pair while '
            f'naming no field, so it is refused. Known paths: {sorted(known)}'
        )

    differences = [
        (path, control_config.get(path, ABSENT), run_config.get(path, ABSENT))
        for path in sorted(known)
        if _value_text(control_config.get(path, ABSENT)) != _value_text(run_config.get(path, ABSENT))
    ]
    runtime_paths = sorted(set(control_runtime) | set(run_runtime))

    declared = [(path, left, right) for path, left, right in differences if any(_covers(c, path) for c in claimed)]
    undeclared = [(path, left, right) for path, left, right in differences if not any(_covers(c, path) for c in claimed)]
    idle = [name for name in claimed if not any(_covers(name, path) for path, _, _ in differences)]

    lines: list[str] = []
    lines.append(f'  same     {len(known) - len(differences)} field(s)')
    lines.append(f'  differ   {len(differences)} field(s):')
    for path, left, right in differences:
        mark = 'declared  ' if any(_covers(c, path) for c in claimed) else 'UNDECLARED'
        lines.append(f'    {mark}  {path}: {_value_text(left)} -> {_value_text(right)}')

    for type_name, block in (('control', control_runtime), ('run', run_runtime)):
        for path, value in sorted(block.items()):
            lines.append(f'    runtime   {path} ({type_name}): {_value_text(value)}')
    if runtime_paths:
        lines.append(
            f'  runtime: {len(runtime_paths)} field(s) differ or are carried here and they are not '
            'configuration -- a census of the run\'s own answers, not a value that was dispatched'
        )

    if idle:
        lines.append(
            f'  declared but unchanged: {sorted(idle)} -- the registration names a field this pair '
            'did not move, so what ran is not what the registration describes'
        )

    if not differences:
        lines.append(
            '  verdict: 0 field(s) differ — this pair is the same configuration twice, so any movement '
            'between the two runs is the same-prompt noise floor (§13.175.5) rather than a treatment'
        )
        return '\n'.join(lines), 0

    if undeclared:
        lines.append(
            f'  verdict: {len(differences)} field(s) differ, {len(declared)} declared by --treatment, '
            f'{len(undeclared)} undeclared: {[path for path, _, _ in undeclared]}'
        )
        lines.append(
            '  readings from this pair are not attributable: each undeclared field moved with the '
            'treatment and no arithmetic over the two artifacts separates them afterwards'
        )
        return '\n'.join(lines), len(undeclared)

    lines.append(
        f'  verdict: {len(differences)} field(s) differ and every one of them is declared — the pair '
        'is a reading, and what it measures is the declared set and nothing else'
    )
    return '\n'.join(lines), 0


# ---------------------------------------------------------------------------------------------
# `--registration`: ONE artifact against the dispatch table.
#
# `--config` compares two artifacts. It cannot answer the question a reader of a *single* run has:
# is what ran the thing this arm says it runs? Three separate values had drifted out of §10.3 by
# 2026-10-31 -- `maxPromptChars` 96,000 against a registered 48,000, `turnCutMarker` `ellipsis`
# against a bare 400, and `ask` `operands` against a registered `enumerated` -- and every one of
# them was found by a person re-reading 22,000 lines rather than by a check (§13.192.7.3,
# §13.203.2). A prose record cannot fail; this can.
#
# The registered side is imported rather than restated. A second copy of the table is the defect
# these sections keep finding: the copy in the document disagrees with the copy that runs, and the
# one nobody executes is the one that reads as authoritative.
# ---------------------------------------------------------------------------------------------

# The artifact records these inputs nowhere, because they are not the arm's configuration.
PRESENCE_INPUTS = {
    'cortex_memory': 'the block\'s presence is the flag: a report with no memoryArmConfig has no arm '
    'to check, and `_arm_config` refuses it rather than comparing nothing',
}
HARNESS_INPUTS = {
    'limit': 'how many questions were asked, not how the arm is configured',
    'ablation_runs': 'how many repetitions, not how the arm is configured',
}


def dispatch_inputs() -> dict:
    """`tools/dispatch-cortex-memory-ab.py`'s `INPUTS`, imported rather than copied."""
    import importlib.util

    path = Path(__file__).with_name('dispatch-cortex-memory-ab.py')
    spec = importlib.util.spec_from_file_location('dispatch_cortex_memory_ab', path)
    if spec is None or spec.loader is None:
        raise SystemExit(f'{path}: cannot be imported, so there is no registration to compare against')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    inputs = getattr(module, 'INPUTS', None)
    if not isinstance(inputs, dict) or not inputs:
        raise SystemExit(f'{path}: has no INPUTS dict, so there is no registration to compare against')
    return dict(inputs)


def two_field_expectation(name: str, raw: str) -> dict | None:
    """The inputs whose one value writes two fields, and what each field must read.

    Two shapes, both registered rather than inferred (§13.188.3, §13.198.1):

      * `cortex_memory_max_turn_chars=400:ellipsis` is a width and a marker. The marker is `none`
        when the value states none, which is the identity §13.188 shipped.
      * `thinking` is a mode, until it is a route list; a list means `enabled` on those routes and
        the shipped state everywhere else. `readThinkingReach` owns that grammar in the product --
        this mirror exists because the artifact records the *result* and a reader must be able to
        say which dispatch value would have produced it. The three spellings are pinned by test.

    A name this function does not recognise returns `None` and is compared one-to-one.
    """
    if name == 'cortex_memory_ask':
        return {'ask': raw}
    if name == 'cortex_memory_max_turn_chars':
        width, _, marker = raw.partition(':')
        return {'maxTurnChars': int(width), 'turnCutMarker': marker or 'none'}
    if name in ('thinking', 'cortex_memory_thinking'):
        if raw in ('enabled', 'disabled') or raw == '':
            return {'reader.thinking': raw or 'disabled', 'reader.thinkingRoutes': ABSENT}
        return {
            'reader.thinking': 'enabled',
            'reader.thinkingRoutes': [part.strip() for part in raw.split('+') if part.strip()],
        }
    return None


def coerce_to_artifact(raw: str, target: object):
    """The dispatch string read as the artifact field's type, or `ValueError` if it cannot be.

    The artifact is authoritative for the type, so there is no second type table to keep in step
    with it: a field the artifact holds as an `int` is read as an `int`, one it holds as a list is
    split on commas, and anything else is compared as text.
    """
    if isinstance(target, bool):
        return raw not in ('', '0', 'false', 'False')
    if isinstance(target, int):
        return int(raw)
    if isinstance(target, float):
        return float(raw)
    if isinstance(target, list):
        return [part.strip() for part in raw.split(',') if part.strip()]
    if isinstance(target, dict):
        # The route room. `readPromptBudget` sends `route:chars` pairs in one string and the artifact
        # holds the map, so the registered value is read back into the map's shape. A scalar
        # registration against a map artifact reaches here too and is refused by the `int()` below,
        # which is correct: the two are different configurations, not two spellings of one.
        rooms = {}
        for part in raw.split(','):
            route, _, chars = part.partition(':')
            rooms[route.strip()] = int(chars)
        return rooms
    return raw


def _shape_disagrees(raw: str, target: object) -> bool:
    """The registered string and the artifact's value are different *shapes*, not different types.

    Since §13.327 one input carries two shapes: `cortex_memory_max_prompt_chars` is a scalar for one
    room on every route and a `route:chars` map for the route-scoped room. A run that registered the
    map and executed the scalar has **departed**, and that verdict is the whole point of this
    section -- but the coercion below cannot reach it, because `int("multi-session:48460")` fails and
    a failed coercion is reserved for a value the field cannot hold at all. Those are two different
    situations and this is the boundary between them:

    | registered | artifact | verdict |
    | --- | --- | --- |
    | `multi-session:48460` | `96000` | departure -- the two are different requests |
    | `big` | `96000` | refusal -- nothing in the artifact could hold `big` |
    | `48000` | `{multi-session: 48460}` | departure -- the same, in the other direction |
    """
    if isinstance(target, (int, float)) and ":" in raw:
        return True
    if isinstance(target, dict) and ":" not in raw:
        return True
    return False


def registration_section(report: dict, departed: list[str]) -> tuple[str, int]:
    """This artifact's configuration against the dispatch table, and how much of it was not declared.

    ## What "departed" means

    §10.3 registers the arm. A run that moves a value registers *as an experiment* by naming the
    fields it moved -- the same contract `--config --treatment` puts on a pair, applied to a single
    artifact. A departure that is named is printed as `declared`; one that is not is printed as
    `UNDECLARED` and makes the exit code non-zero, because a run whose own registration does not
    describe it cannot be reproduced from the record it left behind.

    ## What is not compared, and why each one is not

    A **derived** field (`askRoutes` from `ask`) has no dispatch input of its own and is computed by
    the product, so comparing it would compare the product to this tool. A **harness** input
    (`limit`, `ablation_runs`) is not the arm's configuration. The **presence** input (`cortex_memory`)
    is the block itself. Each is counted in the header rather than dropped, because a comparison that
    silently covers less than it appears to is the shape §13.191 found in the pair tool.

    A **condition** (`REGISTERED_CONDITIONS`) is the fourth category and the newest: something the
    registration implies, that no dispatch input carries, and that changes what the number means
    rather than what the run did. It is compared unconditionally and declareable like an input, so
    an artifact produced under one cannot pass as the arm's -- which is the defect the first oracle
    run found. It is *not* a place for a field someone forgot to register: a condition that ever
    acquires a dispatch input must be deleted from here rather than kept, or the same value would be
    compared twice under two names.
    """
    config = _arm_config(report, 'report')
    flat, _runtime = _flatten_config(config)
    inputs = dispatch_inputs()

    compared: list[tuple[str, str, object, object]] = []
    derived: list[tuple[str, str]] = []
    harness: list[str] = []
    presence: list[str] = []

    for name in sorted(inputs):
        raw = str(inputs[name])
        if name in HARNESS_INPUTS:
            harness.append(name)
            continue
        if name in PRESENCE_INPUTS:
            presence.append(name)
            continue
        aliases = DISPATCH_FIELD_ALIASES.get(name)
        if aliases is None:
            harness.append(name)
            continue
        expectation = two_field_expectation(name, raw)
        if expectation is not None:
            for path, expected in expectation.items():
                compared.append((name, path, expected, flat.get(path, ABSENT)))
            for alias in aliases:
                if not any(_covers(alias, path) for path in expectation):
                    derived.append((name, alias))
            continue
        for alias in aliases:
            paths = [path for path in flat if _covers(alias, path)]
            if not paths:
                derived.append((name, alias))
                continue
            for path in paths:
                if _shape_disagrees(raw, flat[path]):
                    # Compared as text so the difference is printed with both values. Coercing
                    # first would turn a departure into a refusal to run.
                    compared.append((name, path, raw, flat[path]))
                    continue
                try:
                    expected = coerce_to_artifact(raw, flat[path])
                except ValueError:
                    raise SystemExit(
                        f'{name}={raw!r} cannot be read as the type the artifact holds at {path} '
                        f'({type(flat[path]).__name__}), so the registration cannot be compared. '
                        'This is a mismatch between the two records, not a value to skip: a field '
                        'the tool silently declines to compare is the shape §13.191 found.'
                    )
                compared.append((name, path, expected, flat[path]))

    def differs(expected: object, actual: object) -> bool:
        if expected is ABSENT or actual is ABSENT:
            return expected is not actual
        return _value_text(expected) != _value_text(actual)

    # The conditions, after the inputs. They are compared on every artifact rather than only when
    # declared, because that is the whole difference between a condition and a departure: a reader
    # who did not ask for an oracle run is exactly the reader who must be told they are holding one.
    for name, (path, registered) in sorted(REGISTERED_CONDITIONS.items()):
        actual = flat.get(path, ABSENT)
        compared.append((name, path, registered, registered if actual is ABSENT else actual))

    moved = [(name, path, expected, actual) for name, path, expected, actual in compared if differs(expected, actual)]
    undeclared = [entry for entry in moved if entry[0] not in departed]
    idle = [name for name in departed if not any(entry[0] == name for entry in moved)]
    unknown = [name for name in departed if name not in inputs and name not in REGISTERED_CONDITIONS]

    lines: list[str] = []
    lines.append(
        f'  registration: {len(compared)} field(s) compared, {len(derived)} derived (no dispatch '
        f'input of their own), {len(harness)} harness, {len(presence)} presence'
    )
    lines.append(f'  same         {len(compared) - len(moved)} field(s)')
    for name, path, expected, actual in moved:
        mark = 'declared  ' if name in departed else 'UNDECLARED'
        lines.append(f'    {mark}  {path}: {_value_text(expected)} (registered) -> {_value_text(actual)} (ran)')
    for name, alias in derived:
        lines.append(f'    derived     {alias} is computed from {name} and is not compared here')

    if unknown:
        lines.append(
            f'  refused: --departs names {unknown}, which neither the dispatch table sends nor the '
            'artifact records as a condition. A departure that resolves to nothing declares '
            'nothing, which is the `--set` defect (§13.192.7.3) applied to the declaration.'
        )
        return '\n'.join(lines), len(unknown)

    if idle:
        lines.append(
            f'  declared but unchanged: {sorted(idle)} -- the departure names a field this run did '
            'not move, so the record describes an intention rather than what ran'
        )

    if not moved:
        lines.append(
            '  verdict: this run is the registered configuration, field for field, so its numbers '
            'are quotable as the arm\'s and need no line in §10.3'
        )
        return '\n'.join(lines), 0

    if undeclared:
        lines.append(
            f'  verdict: {len(moved)} field(s) departed from the registration and '
            f'{len(undeclared)} was not declared: {[path for _, path, _, _ in undeclared]}'
        )
        lines.append(
            '  the run is an experiment that has not said so. §10.3 describes the adopted '
            'configuration, so this artifact cannot be quoted as the arm without naming each '
            'departure beside it (§13.202.6)'
        )
        return '\n'.join(lines), len(undeclared)

    lines.append(
        f'  verdict: {len(moved)} field(s) departed and every one of them is declared — the run is '
        'an experiment whose registration is its departure list, and §10.3 still describes what it '
        'did not run'
    )
    return '\n'.join(lines), 0


def _feature_bits(report: dict, side: str) -> list[str]:
    """The feature side's per-run correctness bits, one string per repetition, in roster order.

    Without this there is no per-question reading: `questions[].correct` is the majority verdict
    across repetitions, which is exactly the aggregation that hides a flip. A report that predates
    the field cannot answer the question this section asks, and saying so is better than answering
    it with the majority.
    """
    ablation = report.get('ablation')
    bits = ablation.get('featureCorrectByRun') if isinstance(ablation, dict) else None
    if not isinstance(bits, list) or not bits or not all(isinstance(entry, str) for entry in bits):
        raise ValueError(f'{side} has no per-run correctness bits (ablation.featureCorrectByRun)')
    return bits


def population_section(run_report: dict, control_report: dict, spec: dict) -> tuple[str, int]:
    """Whether a registered population moved, read question by question rather than by mean.

    ## Why a population read exists at all

    §13.203.4 measured the pair's noise floor and it is not small: 4.8% of 1,880 paired reads
    flip on **byte-identical** prompts, and the 2σ band for a capability-sized difference is
    **9.3 questions**. So a claim of the form "this ask converts the four questions it was
    written for" cannot be read off a capability's total -- the total cannot see four questions,
    and the reader's own churn is larger than the effect. The only readable claim at that size is
    a set of questions named **before** the run, counted one by one.

    ## Why each question's verdict is a boundary crossing rather than a majority

    With four repetitions three is a majority and two is a coin, so the read asks one question of
    each question: did it cross the decisive boundary of three, and in which direction? `0011` on
    the control against `1100` on the run has not crossed anything, whatever the four reads look
    like individually, and calling it a conversion would publish the reader's churn as a treatment
    effect. A read that moved without crossing -- 1 of 4 to 2 of 4, or 4 of 4 to 3 of 4 -- is printed
    as `mixed` and counted in no direction, because that is the state the measured flip rate
    produces on its own.

    ## What the two groups mean

    `converts` is the population the ask was written for and its bar is a **floor**: at least
    `bar` of them must move. `guard` is a set the ask must not damage, and its bar is a
    **ceiling**: at most `bar` may move the wrong way. Everything else about the reading --
    which questions, how many, which direction -- comes from the registration file rather than
    from this function, so a population cannot be edited at read time.

    A missing id, a repeated id, or a group with no bar is a refusal: a population read that
    silently skips a question reports a smaller denominator and a larger rate, which is the
    failure mode every other refusal in this file exists to prevent.
    """
    run_questions = _questions(run_report)
    control_questions = _questions(control_report)
    if run_questions is None or control_questions is None:
        raise ValueError('one side has no per-question roster, so the population cannot be read')

    def index_of(questions: list[dict], side: str) -> dict[str, int]:
        index: dict[str, int] = {}
        for position, record in enumerate(questions):
            identifier = record.get('questionId')
            if identifier in index:
                raise ValueError(f'the {side} roster repeats {identifier!r}, so the read is ambiguous')
            index[identifier] = position
        return index

    run_index = index_of(run_questions, 'run')
    control_index = index_of(control_questions, 'control')

    run_bits = _feature_bits(run_report, 'run')
    control_bits = _feature_bits(control_report, 'control')
    for bits, questions, side in (
        (run_bits, run_questions, 'run'),
        (control_bits, control_questions, 'control'),
    ):
        if any(len(entry) != len(questions) for entry in bits):
            raise ValueError(f'the {side} correctness bits are not one per question')
    if len(run_bits) != len(control_bits):
        raise ValueError(
            f'the two sides have {len(run_bits)} and {len(control_bits)} repetitions, '
            'so a per-question comparison would mix a decisive read with a coin'
        )

    repetitions = len(run_bits)
    decisive = repetitions // 2 + 1

    lines = [f'population: {spec.get("name", "(unnamed)")}   repetitions: {repetitions}   decisive: {decisive} of {repetitions}']
    failures = 0
    for group in ('converts', 'guard'):
        block = spec.get(group)
        if not isinstance(block, dict):
            raise ValueError(f'the population names no {group!r} group')
        identifiers = block.get('ids')
        bar = block.get('bar')
        if not isinstance(identifiers, list) or not identifiers:
            raise ValueError(f'the {group!r} group names no questions')
        if not isinstance(bar, int) or isinstance(bar, bool):
            raise ValueError(f'the {group!r} group has no integer bar')

        rows: list[tuple[str, str, str, str]] = []
        converted = 0
        worsened = 0
        held = 0
        mixed = 0
        for identifier in identifiers:
            if identifier not in run_index:
                raise ValueError(f'{identifier!r} is in the population but absent from the run')
            if identifier not in control_index:
                raise ValueError(f'{identifier!r} is in the population but absent from the control')
            run_reads = ''.join(entry[run_index[identifier]] for entry in run_bits)
            control_reads = ''.join(entry[control_index[identifier]] for entry in control_bits)
            run_right = run_reads.count('1')
            control_right = control_reads.count('1')
            if control_right < decisive <= run_right:
                verdict = 'converted'
                converted += 1
            elif run_right < decisive <= control_right:
                verdict = 'worsened'
                worsened += 1
            elif run_right == control_right:
                verdict = 'held'
                held += 1
            else:
                # Moved in reads without crossing the decisive boundary: 1 of 4 -> 2 of 4, or
                # 2 -> 1. Printed because it is the reader wobbling on a question the registration
                # named, and counted in no direction because a read that did not cross the boundary
                # is the churn §13.203.4 measured rather than a treatment effect.
                verdict = 'mixed'
                mixed += 1
            rows.append((identifier, control_reads, run_reads, verdict))

        lines.append('')
        lines.append(f'{group}: {len(identifiers)} question(s), bar {bar}')
        for identifier, control_reads, run_reads, verdict in rows:
            lines.append(f'  {identifier}  control {control_reads}  run {run_reads}  {verdict}')
        lines.append(
            f'  converted {converted}   worsened {worsened}   held {held}   mixed {mixed}'
        )

        if group == 'converts':
            if converted >= bar:
                lines.append(
                    f'  verdict: {converted} of {len(identifiers)} converted, at or above the registered '
                    f'floor of {bar} — the screen is the variable on this population'
                )
            else:
                failures += 1
                lines.append(
                    f'  verdict: {converted} of {len(identifiers)} converted, BELOW the registered floor '
                    f'of {bar} — this population does not carry the claim, and §13.205.6 names what the '
                    'next candidate would then be'
                )
        else:
            if worsened <= bar:
                lines.append(
                    f'  verdict: {worsened} of {len(identifiers)} worsened, at or below the registered '
                    f'ceiling of {bar} — the ask did not buy its conversions from this set'
                )
            else:
                failures += 1
                lines.append(
                    f'  verdict: {worsened} of {len(identifiers)} worsened, ABOVE the registered ceiling '
                    f'of {bar} — the screen is moving the reader\'s attention, not its thoroughness'
                )

    if failures:
        lines.append('')
        lines.append(
            'a registered bar was missed; the counts above are the reading and the registration is the '
            'authority, so this pair is reported as a failed prediction rather than as a null result'
        )
    return '\n'.join(lines), failures


_SEARCH_BUDGET: object | None = None


def search_budget():  # noqa: ANN201 - a module, loaded by path, see the docstring
    """`tools/search-budget.py`, loaded by path so `E[max_k]` has exactly one definition.

    The file name has a hyphen and cannot be imported by name, so this loads it by path and caches
    it. Re-deriving the integral here would be a second definition of the same number, which is the
    failure this module's own docstring already forbids about the scorer channel -- and the two
    definitions would drift the first time either changed. `test_the_count_comes_from_the_one_
    definition_of_the_integral` asserts the value rather than the wiring, so a rewrite of either
    side fails there.
    """
    global _SEARCH_BUDGET
    if _SEARCH_BUDGET is None:
        import importlib.util

        path = Path(__file__).resolve().parent / 'search-budget.py'
        spec = importlib.util.spec_from_file_location('search_budget', path)
        if spec is None or spec.loader is None:
            raise ImportError(f'{path} could not be loaded')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _SEARCH_BUDGET = module
    return _SEARCH_BUDGET


def null_section(  # noqa: PLR0912, PLR0915 - the branches are the verdicts
    run_report: dict,
    control_report: dict,
    search_effect: float | None = None,
) -> tuple[str, int]:
    """Each pair's own noise floor, measured on the questions whose prompt did not change.

    ## Why a pair needs a null of its own

    §13.194.4 pinned `KU` to `{61, 62}` from eight observations (two runs of four repetitions) and
    the next independent run read `60` twice. The band was not wrong about the arm; it was too
    narrow about the reader, and the artifact that falsified it also measured why: 470 of 500
    prompts in `41222844945` were **byte-identical** to its control's, and those 470 still moved by
    `+3, -1, +1, -5` across four repetitions -- a 4.8% flip rate on identical input.

    That stratum is the null, and it is free: it is computed from the two artifacts, needs no extra
    dispatch, and is specific to the pair in hand rather than borrowed from a run three sections
    earlier. Any other arm's band is a claim; this one is a measurement.

    ## What the numbers are

    `flips` counts question-reads that changed verdict in either direction on identical prompts,
    `p` is that rate, and `sd` is the standard deviation of a net difference of the same size under
    a symmetric null (`sqrt(F * (1 - p))`, with `F` the expected flips). The verdict compares the
    differing stratum's delta against `2 sd`, which is the band the identical stratum implies for a
    stratum of that size -- stated as a bound rather than a test, because the thing being bounded is
    the reader, not the treatment.

    ## `search_effect`, and why the bar is an argument rather than a constant

    The same `sd` answers a second question: how many candidate configurations could be compared on
    this pair before taking the best of them is indistinguishable from taking a maximum. That is
    `AUDIT-PARAMETER-SELF-EVOLUTION.md`, and it needs two more inputs -- a `sigma` and an effect --
    and both are already either measured here or named by the caller.

    `sigma` is measured: it is this pair's own `sd`, printed to two decimals, and the candidate count
    is computed from the printed value rather than the unrounded one so that a reader who checks the
    arithmetic by hand arrives at the tool's answer.

    `effect` is not measured and cannot be: it is the movement the caller would call a result, and it
    has to be written down before the reading for the same reason every registration in this campaign
    is. A tool that defaulted it -- to the `2 sd` band, or to the last registered effect -- would be
    choosing the bar to fit the answer.
    """
    run_questions = _questions(run_report)
    control_questions = _questions(control_report)
    if run_questions is None or control_questions is None:
        raise ValueError('one side has no per-question roster, so no question can be paired')
    control_index = {record.get('questionId'): position for position, record in enumerate(control_questions)}
    if len(control_index) != len(control_questions):
        raise ValueError('the control roster repeats a questionId, so pairing is ambiguous')
    missing = [record.get('questionId') for record in run_questions if record.get('questionId') not in control_index]
    if missing:
        raise ValueError(f'{len(missing)} question(s) in the run are absent from the control, e.g. {missing[:3]}')

    run_bits = _feature_bits(run_report, 'run')
    control_bits = _feature_bits(control_report, 'control')
    if any(len(bits) != len(run_questions) for bits in run_bits):
        raise ValueError('the run\'s correctness bits are not one per question')
    if any(len(bits) != len(control_questions) for bits in control_bits):
        raise ValueError('the control\'s correctness bits are not one per question')

    identical: list[int] = []
    differing: list[int] = []
    differing_caps: dict[str, int] = {}
    unmeasured = 0
    for position, record in enumerate(run_questions):
        control_record = control_questions[control_index[record.get('questionId')]]
        left = control_record.get('promptDigest')
        right = record.get('promptDigest')
        if left is None or right is None:
            unmeasured += 1
            continue
        if left == right:
            identical.append(position)
        else:
            differing.append(position)
            capability = str(record.get('capability'))
            differing_caps[capability] = differing_caps.get(capability, 0) + 1

    def per_run(stratum: list[int]) -> dict:
        """Per-repetition counts, the flip count, and the questions that moved the same way every time.

        The last of those is the statistic the aggregate cannot see. A stratum of thirty questions can
        gain exactly one in each of four repetitions -- four flips, a delta of +1, well inside any band
        a 4.8% flip rate implies for that size -- and still be the strongest reading in the artifact,
        because the alternative is that one specific question converted every single time. The
        aggregate calls that churn; the per-question view calls it a mechanism, and it is the per-question
        view that §13.194.4's criterion 1 was written about (`6456829e_abs`).
        """
        control_counts: list[int] = []
        run_counts: list[int] = []
        flips = 0
        votes: dict[int, list[tuple[str, str]]] = {position: [] for position in stratum}
        for repetition in range(min(len(run_bits), len(control_bits))):
            run_total = 0
            control_total = 0
            for position in stratum:
                control_position = control_index[run_questions[position].get('questionId')]
                left = control_bits[repetition][control_position]
                right = run_bits[repetition][position]
                control_total += left == '1'
                run_total += right == '1'
                flips += left != right
                votes[position].append((left, right))
            control_counts.append(control_total)
            run_counts.append(run_total)
        gained = sorted(
            str(run_questions[position].get('questionId'))
            for position, pairs in votes.items()
            if pairs and all(left == '0' and right == '1' for left, right in pairs)
        )
        lost = sorted(
            str(run_questions[position].get('questionId'))
            for position, pairs in votes.items()
            if pairs and all(left == '1' and right == '0' for left, right in pairs)
        )
        return {
            'control': control_counts,
            'run': run_counts,
            'flips': flips,
            'gained': gained,
            'lost': lost,
            'repetitions': len(control_counts),
        }

    lines: list[str] = []
    lines.append(
        f'  prompt identity: {len(identical)}/{len(run_questions)} byte-identical, '
        f'{len(differing)} differ' + (f', {unmeasured} unmeasured' if unmeasured else '')
    )
    if differing_caps:
        lines.append(f'    differing by capability: {dict(sorted(differing_caps.items()))}')
    header = (
        f'  {"stratum":<18} {"n":>4} {"control":>8} {"run":>8} {"delta":>7} {"flips":>6} {"p":>7} '
        f'{"sd":>5} {"unanim":>7} {"E[unanim]":>10}'
    )
    lines.append(header)

    summary: dict[str, dict] = {}
    for name, stratum in (('identical-prompt', identical), ('differing', differing)):
        if not stratum:
            lines.append(f'  {name:<18} {0:>4} {"-":>8} {"-":>8} {"-":>7} {"-":>6} {"-":>7} {"-":>5} {"-":>7} {"-":>10}')
            continue
        stats = per_run(stratum)
        repetitions = stats['repetitions']
        mean_control = sum(stats['control']) / repetitions
        mean_run = sum(stats['run']) / repetitions
        delta = mean_run - mean_control
        observations = len(stratum) * repetitions
        rate = stats['flips'] / observations if observations else 0.0
        deviation = ((rate * len(stratum)) * (1 - rate)) ** 0.5
        unanimous = len(stats['gained']) + len(stats['lost'])
        # Under a symmetric null each question-read flips one way with probability rate/2, so the
        # chance a given question moves the same way in every repetition is (rate/2)**repetitions,
        # and there are two directions to move in.
        expected_unanimous = len(stratum) * 2 * (rate / 2) ** repetitions if repetitions else 0.0
        summary[name] = {
            'delta': delta,
            'sd': deviation,
            'rate': rate,
            'unanimous': unanimous,
            'expected': expected_unanimous,
            'stats': stats,
        }
        lines.append(
            f'  {name:<18} {len(stratum):>4} {mean_control:>8.2f} {mean_run:>8.2f} {delta:>+7.2f} '
            f'{stats["flips"]:>6} {rate * 100:>6.1f}% {deviation:>5.2f} {unanimous:>7} {expected_unanimous:>10.2e}'
        )
        lines.append(
            f'    per repetition delta: {[right - left for left, right in zip(stats["control"], stats["run"])]}'
            + (f'   unanimous gains: {stats["gained"]}' if stats['gained'] else '')
            + (f'   unanimous losses: {stats["lost"]}' if stats['lost'] else '')
        )

    if search_effect is not None and search_effect <= 0:
        raise ValueError(
            'search_effect must be positive: a search cannot be bounded by a movement nobody would '
            'call a result, and zero would make every candidate count trivially readable'
        )

    if 'identical-prompt' in summary:
        block = summary['identical-prompt']
        lines.append(
            f'  null: a change of up to {2 * block["sd"]:.1f} question(s) on the identical stratum is '
            f'the reader, not the treatment (observed {block["delta"]:+.2f}, 2 sd = {2 * block["sd"]:.2f})'
        )
        if search_effect is not None:
            # The printed sigma, not the unrounded one: a reader who does this arithmetic by hand has
            # only the printed digits, and a tool whose answer changes at the third decimal is a tool
            # that cannot be checked.
            sigma = round(block['sd'], 2)
            budget = search_budget()
            widest = budget.candidates_for_readability(search_effect, sigma)
            boundary = budget.expected_maximum(sigma, widest + 1)
            tail = (
                f'{widest + 1} does not ({boundary:.2f})'
                if boundary >= search_effect
                else f'{widest + 1} also does ({boundary:.2f})'
            )
            lines.append(
                f'  search: at this pair\'s sigma ({sigma:.2f}) a search of {widest} candidate(s) '
                f'stays under the {search_effect:.2f} question effect '
                f'(E[max] {budget.expected_maximum(sigma, widest):.2f}); {tail}'
            )
            lines.append(
                '    sigma is this pair\'s own measurement and the effect is the caller\'s '
                'statement; neither is inferred here, and a search wider than this count reports '
                'its maximum rather than its treatment'
            )
    elif search_effect is not None:
        lines.append(
            '  search: this pair has no identical-prompt stratum, so its sigma is not measured here '
            'and the candidate count is not printed -- a sigma borrowed from another pair is a claim '
            'rather than a measurement'
        )
    if 'differing' not in summary:
        return '\n'.join(lines), 0

    block = summary['differing']
    band = 2 * block['sd']
    outside = abs(block['delta']) > band
    if outside:
        lines.append(
            f'  verdict: the differing stratum moved {block["delta"]:+.2f} with a 2 sd band of '
            f'{band:.2f} -- outside it, so this pair carries a movement the identical stratum does '
            f'not explain'
        )
    elif (block['stats']['gained'] or block['stats']['lost']) and block['expected'] < 0.001:
        lines.append(
            f'  verdict: the aggregate ({block["delta"]:+.2f}) is inside the {band:.2f} band, but '
            f'{block["unanimous"]} question(s) moved in every one of {block["stats"]["repetitions"]} '
            f'repetitions and the null expects {block["expected"]:.1e} of them -- the reading is those '
            f'questions, not the mean, which churn elsewhere on the stratum cancels'
        )
    elif block["stats"]["gained"] or block["stats"]["lost"]:
        lines.append(
            f'  verdict: the differing stratum moved {block["delta"]:+.2f} with a 2 sd band of '
            f'{band:.2f} -- inside it, and although {block["unanimous"]} question(s) moved in every '
            f'repetition, a flip rate of {block["rate"] * 100:.1f}% expects {block["expected"]:.2f} of '
            f'them, so unanimity here is not evidence'
        )
    else:
        lines.append(
            f'  verdict: the differing stratum moved {block["delta"]:+.2f} with a 2 sd band of '
            f'{band:.2f} -- inside it, and no question moved the same way every repetition, so nothing '
            f'on this stratum survives the reader\'s own churn'
        )
    return '\n'.join(lines), block['unanimous']
    return '\n'.join(lines), 0


def congruence_note(report: dict) -> str:
    """One line, printed only when the artifact does not describe the configuration it ran.

    `--registration` prints the whole comparison and exits non-zero when a field moved without being
    declared. That is a check, not a mechanism: nothing consumed it, so the campaign's headline
    numbers were quoted for two rounds while both sides of their pair ran at a budget §13.202.6 had
    declined. The repair is the same one `AUDIT-SCORING-RULE-AS-CONDITION.md` arrives at from a
    different direction -- the condition has to live in the artifact that consumes the number, and
    the consumer here is this default report.

    Deliberately quiet when the artifact agrees with the table: a warning that fires on every run is
    a warning nobody reads.
    """
    try:
        _text, code = registration_section(report, [])
    except SystemExit:
        # An artifact this tool cannot compare -- no dispatch table, an unreadable field -- is a
        # separate failure and `--registration` already names it. Saying nothing here keeps the
        # default report usable on a competitor's artifact, which has no registration at all.
        return ''
    if code == 0:
        return ''
    return (
        'configuration: this artifact departs from the registered dispatch on at least one field '
        'and declares none of them. `--registration` names them; every number above is a reading at '
        'those values, not at the registration\'s, and quoting it without that condition is the '
        'defect §13.202.6 recorded.'
    )


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
        '--room',
        type=int,
        metavar='CHARS',
        help='simulate a smaller maxPromptChars: reachability, characters and the oracle beside it',
    )
    parser.add_argument(
        '--split',
        action='store_true',
        help='print the full/partial coverage split instead of the run summary',
    )
    parser.add_argument(
        '--instrument',
        action='store_true',
        help='print the goldDelivered coverage and its agreement with carried, instead of the run summary',
    )
    parser.add_argument(
        '--strata',
        action='store_true',
        help='print the exact / depth-limited / pool-missing strata with each one\'s accuracy',
    )
    parser.add_argument(
        '--declines',
        action='store_true',
        help='print the decline table by Step 1 content instead of the run summary',
    )
    parser.add_argument(
        '--reply-repair',
        action='store_true',
        help=(
            'print the reply-contract repair\'s census divided by `runs`, with §13.334.4\'s E3.1 '
            'verdict as the exit code (1 when the paired count fails, 2 when it cannot be applied)'
        ),
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
        '--composition',
        action='store_true',
        help='print where the room went: how much of each window the ranking could order',
    )
    parser.add_argument(
        '--transport',
        action='store_true',
        help='print what the provider did with the requests: attempts, retries, 429s (§13.216)',
    )
    parser.add_argument(
        '--partial',
        action='store_true',
        help='read a benchmark-cortex-memory-partial.json: how far a failed run got, and what '
        'the transport saw before it died (§13.216.8)',
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
        '--attribution',
        type=Path,
        metavar='BEFORE',
        help=(
            'split the paired ledger by whether the prompt changed, and print both sides\' four-pass '
            'spreads (BEFORE is the control)'
        ),
    )
    parser.add_argument(
        '--config',
        type=Path,
        metavar='CONTROL',
        help=(
            'diff this report\'s memoryArmConfig against the CONTROL report\'s and exit non-zero '
            'when any differing field is not named by --treatment'
        ),
    )
    parser.add_argument(
        '--treatment',
        default='',
        metavar='FIELDS',
        help=(
            'comma-separated fields --config may move without refusing the pair; accepts artifact '
            f'paths (`reader.model`) and dispatch names (`model`), known names: '
            f'{", ".join(sorted(DISPATCH_FIELD_ALIASES))}'
        ),
    )
    parser.add_argument(
        '--null',
        type=Path,
        metavar='CONTROL',
        help=(
            'measure this pair\'s own noise floor on the questions whose prompt is byte-identical '
            'to CONTROL\'s, and report whether the changed stratum moves outside it'
        ),
    )
    parser.add_argument(
        '--search-effect',
        type=float,
        metavar='QUESTIONS',
        help=(
            'with --null, print how many candidate configurations this pair\'s measured sigma can '
            'support against an effect of this many questions (see AUDIT-PARAMETER-SELF-EVOLUTION.md)'
        ),
    )
    parser.add_argument(
        '--registration',
        action='store_true',
        help=(
            'compare this report\'s memoryArmConfig against the dispatch table (INPUTS) and exit '
            'non-zero when any field departed without being named by --departs'
        ),
    )
    parser.add_argument(
        '--departs',
        default='',
        metavar='FIELDS',
        help=(
            'comma-separated dispatch inputs --registration may depart from without refusing the '
            'run; refuses a name the dispatch table does not send'
        ),
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
    parser.add_argument(
        '--wired',
        type=Path,
        metavar='REPLAY',
        help='the JSON that tools/window-wired.mjs --json printed for this artifact; the audit '
        'uses it to read the window mechanism idempotence fingerprint, which is the only '
        'statement about that mechanism the artifact cannot make about itself',
    )
    parser.add_argument(
        '--spend',
        action='store_true',
        help='print the provider spend this artifact reports, and read its prefix-cache share '
        'against the bands 13.147.3 registers',
    )
    parser.add_argument(
        '--population',
        type=Path,
        metavar='SPEC',
        help='a registered population (`tools/populations/*.json`): reads the questions it names '
        'against `--control` and counts conversions and regressions against its own bars. Requires '
        '--control, because a bar without a comparison side is a number about nothing',
    )
    parser.add_argument(
        '--control',
        type=Path,
        metavar='REPORT',
        help='the artifact this run is read against; required by --population and unused otherwise',
    )
    args = parser.parse_args(argv)

    try:
        report = json.loads(args.report.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as error:
        print(f'{args.report}: {error}', file=sys.stderr)
        return 2

    # Before the roster guard, and that order is the whole reason this branch works: a partial
    # record has no `questions` and no `ablation`, so the guard below would reject it with
    # "no per-question roster and no ablation block" -- a true sentence about a file it was never
    # meant to describe. The one artifact a failure leaves is the one the guard cannot see.
    if args.partial:
        try:
            section, state = partial_section(report)
        except ValueError as error:
            print(f'{args.report}: {error}', file=sys.stderr)
            return 2
        print(section)
        # The extent is readable in all three cases; the exit code is about the counters. A
        # corrupt block is a producer defect on the record that exists to explain a failure, so it
        # is not allowed to exit 0 just because the rest of the sentence was legible.
        return 2 if state == TRANSPORT_CORRUPT else 0

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

    if args.room is not None:
        section, measured = room_section(questions, args.room)
        if measured == 0:
            print(
                f'{args.report}: no record carries both a turn list with text and a `goldRanks` with a '
                'surfaced entry. The simulation needs the window it would have built, not a summary of it.',
                file=sys.stderr,
            )
            return 2
        print(section)
        return 0

    if args.split:
        section, measured = split_section(questions)
        if measured == 0:
            print(
                f'{args.report}: no `goldRanks` beside a `windowComposition.turns`. The split needs '
                'both: which gold turns retrieval surfaced, and how deep the window went.',
                file=sys.stderr,
            )
            return 2
        print(section)
        return 0

    if args.instrument:
        section, measured = instrument_section(questions)
        if measured == 0:
            print(
                f'{args.report}: no record carries `goldDelivered`, so there is nothing to audit. '
                'The field was added in §13.253; every artifact before it answers "not recorded".',
                file=sys.stderr,
            )
            return 2
        print(section)
        return 0

    if args.strata:
        section, measured = strata_section(questions)
        if measured == 0:
            print(
                f'{args.report}: no record could be classified. Each lacks `goldRanks` beside '
                '`windowComposition.turns`, or carries a non-integer rank, or has `goldDelivered` '
                'disagreeing with `carried`. The strata need which gold arrived and which the ranking surfaced.',
                file=sys.stderr,
            )
            return 2
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

    if args.spend:
        try:
            print(spend_section(report))
        except ValueError as error:
            print(f'{args.report}: {error}', file=sys.stderr)
            return 2
        return 0

    if args.audit:
        replay = None
        if args.wired is not None:
            try:
                replay = json.loads(args.wired.read_text(encoding='utf-8'))
            except (OSError, json.JSONDecodeError) as error:
                print(f'{args.wired}: {error}', file=sys.stderr)
                return 2
        block, failed = audit_section(report, questions, replay)
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

    if args.population:
        if args.control is None:
            print('--population needs --control: a bar is a comparison', file=sys.stderr)
            return 2
        try:
            spec = json.loads(args.population.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError) as error:
            print(f'{args.population}: {error}', file=sys.stderr)
            return 2
        try:
            control = json.loads(args.control.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError) as error:
            print(f'{args.control}: {error}', file=sys.stderr)
            return 2
        print(f'control: {args.control}')
        print(f'run:     {args.report}')
        try:
            section, failures = population_section(report, control, spec)
        except ValueError as error:
            print(f'{args.report}: {error}', file=sys.stderr)
            return 2
        print(section)
        return 1 if failures else 0

    if args.null:
        try:
            control = json.loads(args.null.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError) as error:
            print(f'{args.null}: {error}', file=sys.stderr)
            return 2
        print(f'control: {args.null}')
        print(f'run:     {args.report}')
        try:
            section, _outside = null_section(report, control, args.search_effect)
        except ValueError as error:
            print(f'{args.report}: {error}', file=sys.stderr)
            return 2
        print(section)
        # A movement outside the band is the reading, not an error: this section answers "is the
        # difference bigger than the reader's own churn", and both answers are informative. The
        # exit code stays 0 so that the tool is usable in a loop over many pairs, unlike
        # `--config` and `--registration`, which refuse.
        return 0

    if args.registration:
        departed = [name.strip() for name in args.departs.split(',') if name.strip()]
        print(f'report:  {args.report}')
        print(f'against: tools/dispatch-cortex-memory-ab.py INPUTS')
        print(f'departs: {departed if departed else "none declared"}')
        section, failures = registration_section(report, departed)
        print(section)
        return 1 if failures else 0

    if args.config:
        try:
            control = json.loads(args.config.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError) as error:
            print(f'{args.config}: {error}', file=sys.stderr)
            return 2
        treatment = [name.strip() for name in args.treatment.split(',') if name.strip()]
        print(f'control: {args.config}')
        print(f'run:     {args.report}')
        print(f'treatment: {treatment if treatment else "none declared"}')
        section, failures = diff_section(control, report, treatment)
        print(section)
        return 1 if failures else 0

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

    if args.attribution:
        try:
            control = json.loads(args.attribution.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError) as error:
            print(f'{args.attribution}: {error}', file=sys.stderr)
            return 2
        try:
            section, failures = attribution_section(report, control)
        except ValueError as error:
            print(f'{args.report}: {error}', file=sys.stderr)
            return 2
        print(section)
        return 1 if failures else 0

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

    if args.transport:
        section, state = transport_section(report)
        if state == TRANSPORT_ABSENT:
            print(
                f'{args.report}: no transportRetry block. An artifact produced before '
                '§13.216 predates the field, and this is not a run that never retried -- '
                'which is what a table of zeroes would say. The counters are attached '
                'unconditionally, so absence only ever means the field did not exist.',
                file=sys.stderr,
            )
            return 2
        if state == TRANSPORT_CORRUPT:
            # Separate from the branch above on purpose: this block EXISTS and cannot be read,
            # so "the run predates the field" would be a false explanation for a present field.
            print(
                f'{args.report}: the transportRetry block is present and unreadable -- every '
                'count must be a non-negative whole number (a bool is a flag, not a count). '
                'This is a producer defect, not an old artifact.',
                file=sys.stderr,
            )
            return 2
        print(section)
        return 0

    if args.composition:
        section, measured = composition_section(questions)
        if measured == 0:
            print(
                f'{args.report}: no record carries a windowComposition. A run with '
                '`relevanceSignal: none` has none, and an artifact produced before '
                '§13.215 predates the field -- so this is not a window that was '
                'entirely unscored, which is what a table of zeroes would say.',
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

    if args.reply_repair:
        # An unreadable field is exit 2 rather than a verdict: "the artifact does not say" and "the
        # mechanism failed" are different statements, and the four-state classifier's whole
        # argument is that collapsing them hides a real fault behind a plausible zero.
        try:
            section, passed = reply_repair_section(report)
        except ValueError as error:
            print(f'{args.report}: {error}', file=sys.stderr)
            return 2
        print(section)
        return 0 if passed else 1

    if args.declines:
        section, read = declines_section(questions)
        if read == 0:
            print(f'{args.report}: no declines in this roster.', file=sys.stderr)
            return 2
        print(f'declines read: {read}')
        print(section)
        return 0

    print(describe(report, args.reference))
    note = congruence_note(report)
    if note:
        print()
        print(note)
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
