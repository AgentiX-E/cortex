"""The expansion reading's own contract, proved on artifacts built to break it.

`tools/expansion-reading.py` decides whether five pre-registered criteria are readable, and its most
important output is not a verdict but the word `unread`: the earlier attempt at this experiment
(`44159514514`) died on a provider and produced a partial artifact, and the campaign's rule is that a
dispatch which did not run is not evidence about a mechanism. A tool whose only failure mode is
"prints a number anyway" would erase exactly that distinction, so every test here builds the state
that must be refused and asserts the refusal names it.

The estimator is pinned from the other side as well: `questions[].correct` is the campaign's majority
verdict (>= 3 of 4), and recomputing over `ablation.featureCorrectByRun` instead returns 101 on `S16`
where the artifact's own field returns 102. One question is the difference between "+5" and "+4" on a
121-question population, which is why the tool keeps one estimator and this suite pins it.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import importlib.util

TOOL = Path(__file__).resolve().parents[1] / 'expansion-reading.py'
_spec = importlib.util.spec_from_file_location('expansion_reading', TOOL)
expansion_reading = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(expansion_reading)

# The control's published per-capability counts, so a synthetic control that reproduces them makes the
# floor arithmetic comparable to the real reading rather than to an invented one.
CONTROL_COUNTS = {'IE': 137, 'ABS': 30, 'MR': 102, 'TR': 120, 'KU': 67}
POPULATION = {'IE': 150, 'ABS': 30, 'MR': 121, 'TR': 127, 'KU': 72}


def questions(correct: dict[str, int], digest_prefix: str, **overrides: object) -> list[dict]:
    """One record per question, `correct` of each capability answered right.

    The first `correct[capability]` questions of a capability are the correct ones, which makes a
    test's intent readable from its numbers instead of from an index list.
    """
    records = []
    for capability, size in POPULATION.items():
        for position in range(size):
            record = {
                'questionId': f'{capability}-{position}',
                'capability': capability,
                'correct': position < correct.get(capability, 0),
                'promptDigest': f'{digest_prefix}{capability}{position:04d}',
                'promptChars': 20_000,
            }
            record.update(overrides)
            records.append(record)
    return records


def artifact(correct: dict[str, int], digest_prefix: str, **config: object) -> dict:
    arm = {
        'queryExpansion': 'none',
        'selfIndex': {'queries': 2000, 'indexes': 2000},
        'queryExpansionCounts': None,
    }
    arm.update(config)
    return {
        'questions': questions(correct, digest_prefix),
        'memoryArmConfig': arm,
        'costEfficiency': {'promptTokensPerQuestion': 7447.783},
    }


def treatment(**overrides: object) -> dict:
    """The treatment side: `MR` five better, and the census a plan that landed would leave."""
    correct = dict(CONTROL_COUNTS)
    correct['MR'] += 5
    base = {
        'queryExpansion': 'llm',
        'selfIndex': {'queries': 2405, 'indexes': 2000},
        'queryExpansionCounts': {'questions': 121, 'phrases': 468, 'empty': 0},
    }
    base.update(overrides)
    # The same digest prefix as the control, because the two sides are supposed to differ in ONE thing:
    # a fixture whose digests all differ would make every test look like a drifted baseline, and the
    # drift reading would then be untestable in the direction that matters.
    return artifact(correct, 'a', **base)


def read(control: dict, treated: dict) -> dict:
    return expansion_reading.read(control, treated)


def test_mr_delta_is_read_from_the_majority_verdict_field():
    reading = read(artifact(CONTROL_COUNTS, 'a'), treatment())
    assert reading['mr']['control'] == 102
    assert reading['mr']['treatment'] == 107
    assert reading['mr']['delta'] == 5
    assert reading['criteria']['E1']['verdict'] == 'pass'


def test_a_gain_below_the_threshold_is_a_failed_criterion_and_not_a_dispatch_failure():
    # `fail` is a reading about the mechanism; the run happened and it did not buy the five. The tool
    # must not conflate this with `unread`, which is what the earlier attempt produced.
    correct = dict(CONTROL_COUNTS)
    correct['MR'] += 3
    reading = read(artifact(CONTROL_COUNTS, 'a'), artifact(correct, 'a', queryExpansion='llm',
                                                            selfIndex={'queries': 2405, 'indexes': 2000},
                                                            queryExpansionCounts={'questions': 121, 'phrases': 400, 'empty': 0}))
    assert reading['criteria']['E1']['verdict'] == 'fail'
    assert reading['mr']['delta'] == 3


def test_a_treatment_that_does_not_say_llm_is_refused():
    # §13.377.1's defect: the phrases were produced, counted, and never reached a ranking. An artifact
    # of that run would publish the control's accuracy under the treatment's name, and every field in it
    # would agree with every other field.
    try:
        read(artifact(CONTROL_COUNTS, 'a'), artifact(CONTROL_COUNTS, 'b', queryExpansion='none'))
    except expansion_reading.Unreadable as error:
        assert 'queryExpansion' in str(error)
    else:  # pragma: no cover - the assertion below is the point
        raise AssertionError('a non-llm treatment was read as one')


def test_two_rosters_that_differ_are_refused():
    control = artifact(CONTROL_COUNTS, 'a')
    treated = treatment()
    treated['questions'] = [record for record in treated['questions'] if record['questionId'] != 'MR-0']
    try:
        read(control, treated)
    except expansion_reading.Unreadable as error:
        assert 'same questions' in str(error)
    else:  # pragma: no cover
        raise AssertionError('a pair over two populations was read as a paired comparison')


def test_a_duplicated_question_id_is_refused():
    control = artifact(CONTROL_COUNTS, 'a')
    control['questions'].append(dict(control['questions'][0]))
    try:
        read(control, treatment())
    except expansion_reading.Unreadable as error:
        assert 'appears twice' in str(error)
    else:  # pragma: no cover
        raise AssertionError('an ambiguous record was read as a verdict')


def test_a_missing_index_census_makes_E4_and_E5_unreadable_rather_than_passing():
    treated = treatment()
    del treated['memoryArmConfig']['selfIndex']
    reading = read(artifact(CONTROL_COUNTS, 'a'), treated)
    assert reading['criteria']['E4']['verdict'] == 'unread'
    assert reading['criteria']['E5']['verdict'] == 'unread'


def test_the_receipt_reads_the_product_s_own_counters():
    reading = read(artifact(CONTROL_COUNTS, 'a'), treatment())
    assert reading['criteria']['E4']['verdict'] == 'pass'
    assert 'queries 2405 vs indexes 2000' in reading['criteria']['E4']['measured']


def test_a_plan_that_never_reached_a_ranking_fails_the_receipt():
    # `queries == indexes` is one query per retrieval, which is the question's own wording: the
    # configuration said `llm` and the ranking never saw a phrase.
    treated = treatment(selfIndex={'queries': 2000, 'indexes': 2000})
    reading = read(artifact(CONTROL_COUNTS, 'a'), treated)
    assert reading['criteria']['E4']['verdict'] == 'fail'


def test_a_refusal_share_above_the_registered_bound_fails_the_receipt():
    treated = treatment(queryExpansionCounts={'questions': 121, 'phrases': 400, 'empty': 13})
    reading = read(artifact(CONTROL_COUNTS, 'a'), treated)
    assert reading['criteria']['E4']['verdict'] == 'fail'


def test_a_prompt_that_moved_outside_mr_is_a_leak():
    control = artifact(CONTROL_COUNTS, 'a')
    treated = treatment()
    for record in treated['questions']:
        if record['questionId'] == 'IE-7':
            record['promptDigest'] = 'moved'
    reading = read(control, treated)
    assert reading['criteria']['E3']['verdict'] == 'fail'
    assert reading['promptIdentity']['moved'][0]['questionId'] == 'IE-7'


def test_a_baseline_that_drifted_everywhere_is_unread_rather_than_leaky():
    # The two dispatches are days apart and the arm's table can move between them. When most prompts
    # moved, the floor criterion cannot attribute a delta to the expansion, and calling that a leak
    # would send the next iteration looking for a mechanism that is not there.
    control = artifact(CONTROL_COUNTS, 'a')
    treated = treatment()
    for record in treated['questions']:
        if record['capability'] != 'MR':
            record['promptDigest'] = f"moved-{record['questionId']}"
    reading = read(control, treated)
    assert reading['criteria']['E3']['verdict'] == 'unread'
    assert 'do not share a prompt baseline' in reading['criteria']['E3']['measured']


def test_a_capability_three_below_the_control_breaks_the_floor():
    treated_counts = dict(CONTROL_COUNTS)
    treated_counts['MR'] += 5
    treated_counts['TR'] -= 3
    reading = read(
        artifact(CONTROL_COUNTS, 'a'),
        artifact(treated_counts, 'a', queryExpansion='llm',
                 selfIndex={'queries': 2405, 'indexes': 2000},
                 queryExpansionCounts={'questions': 121, 'phrases': 468, 'empty': 0}),
    )
    assert reading['criteria']['E3']['verdict'] == 'fail'
    assert any(row['capability'] == 'TR' and row['belowFloor'] for row in reading['floor'])


def test_the_bill_is_read_from_the_artifact_and_compared_to_the_ceiling():
    treated = treatment()
    treated['costEfficiency'] = {'promptTokensPerQuestion': 8_700.0}
    reading = read(artifact(CONTROL_COUNTS, 'a'), treated)
    assert reading['criteria']['E2']['verdict'] == 'fail'
    assert reading['bill']['ceiling'] == 8600.0


def test_a_missing_bill_is_unreadable():
    treated = treatment()
    del treated['costEfficiency']
    try:
        read(artifact(CONTROL_COUNTS, 'a'), treated)
    except expansion_reading.Unreadable as error:
        assert 'promptTokensPerQuestion' in str(error)
    else:  # pragma: no cover
        raise AssertionError('a run with no bill was read as a bill under the ceiling')


def test_mcnemar_is_exact_on_a_pair_small_enough_to_compute_by_hand():
    # b=1, c=9: two-sided exact p = 2 * (C(10,0) + C(10,1)) / 2^10 = 22 / 1024.
    assert expansion_reading.exact_mcnemar(1, 9) == 22 / 1024


def test_mcnemar_returns_one_when_nothing_discordant_happened():
    assert expansion_reading.exact_mcnemar(0, 0) == 1.0


def test_the_renderer_prints_every_criterion_including_the_unreadable_ones():
    treated = treatment()
    del treated['memoryArmConfig']['selfIndex']
    text = expansion_reading.render(read(artifact(CONTROL_COUNTS, 'a'), treated))
    for name in ('E1', 'E2', 'E3', 'E4', 'E5'):
        assert f'`{name}`' in text
    assert 'unread' in text


def test_the_selftest_pins_the_estimator_to_the_published_count(tmp_path):
    # The control's 102 of 121 was counted from `questions[].correct`, and a tool that recomputed over
    # the per-run bitstrings instead would return 101 on the same artifact -- off by one against a
    # threshold that is five apart from the control.
    control = tmp_path / 'control.json'
    control.write_text(json.dumps(artifact(CONTROL_COUNTS, 'a')), encoding='utf-8')
    treated = tmp_path / 'treatment.json'
    treated.write_text(json.dumps(treatment()), encoding='utf-8')
    assert expansion_reading.main(['--control', str(control), '--treatment', str(treated),
                                   '--selftest', '--json']) == 0
