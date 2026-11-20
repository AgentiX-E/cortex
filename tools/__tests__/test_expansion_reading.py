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
        'queryExpansionCounts': {'questions': 121, 'phrases': 468, 'refused': 0},
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
                                                            queryExpansionCounts={'questions': 121, 'phrases': 400, 'refused': 0}))
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
    treated = treatment(queryExpansionCounts={'questions': 121, 'phrases': 400, 'refused': 13})
    reading = read(artifact(CONTROL_COUNTS, 'a'), treated)
    assert reading['criteria']['E4']['verdict'] == 'fail'


def test_the_refusal_limit_cannot_pass_on_a_field_the_artifact_does_not_write():
    # Found on the real `S17` artifact: this file read `queryExpansionCounts.empty`, which
    # `MemoryArmConfig.queryExpansionCounts` does not declare, so the count came back `None`,
    # `(None or 0) <= 12` held, and half of `E4` was never read. The fixture carried the same wrong
    # name, which is why sixteen tests agreed with a criterion that could not fail. The artifact
    # writes `{questions, phrases, refused}`; anything else is an unreadable receipt.
    treated = treatment(queryExpansionCounts={'questions': 121, 'phrases': 400, 'empty': 0})
    reading = read(artifact(CONTROL_COUNTS, 'a'), treated)
    assert reading['criteria']['E4']['verdict'] == 'unread'
    assert 'refused' in reading['criteria']['E4']['measured']


def test_a_zero_refusal_rate_is_read_and_not_treated_as_a_missing_field():
    # `0` is falsy and `None` is not, which is why the clause reads the field rather than its truthiness.
    treated = treatment(queryExpansionCounts={'questions': 121, 'phrases': 356, 'refused': 0})
    reading = read(artifact(CONTROL_COUNTS, 'a'), treated)
    assert reading['criteria']['E4']['verdict'] == 'pass'
    assert 'refused 0' in reading['criteria']['E4']['measured']


def test_the_discordant_pair_is_counted_on_the_population_the_criterion_names():
    # `S17` printed `fixed 6, broken 5` under the label "Discordant on `MR`" where `MR` itself was 3 / 3:
    # the five other flips were the drift `E3` reports. On a 121-question cell the difference between 6
    # and 3 is the difference between a p of 0.30 and a p of 1.00, so the population is not a detail.
    treated_counts = dict(CONTROL_COUNTS)
    control = artifact(CONTROL_COUNTS, 'a')
    # The treatment starts from the control's counts, because the shape being tested is a zero delta with
    # six flips in it -- `S17`'s own shape.
    treated = artifact(treated_counts, 'a', queryExpansion='llm',
                       selfIndex={'queries': 2405, 'indexes': 2000},
                       queryExpansionCounts={'questions': 121, 'phrases': 468, 'refused': 0})
    by_id = {record['questionId']: record for record in treated['questions']}
    # MR-0..2 answered right by the control and wrong by the treatment; MR-102..104 the other way, which
    # leaves the cell at 102 -- exactly the zero-delta shape `S17` published.
    for key in ('MR-0', 'MR-1', 'MR-2'):
        by_id[key]['correct'] = False
    for key in ('MR-102', 'MR-103', 'MR-104'):
        by_id[key]['correct'] = True
    for key in ('IE-0', 'IE-1'):
        by_id[key]['correct'] = False
    reading = read(control, treated)
    assert reading['mr']['treatment'] == 102
    assert reading['mr']['discordant'] == {'fixed': 3, 'broken': 3}
    assert reading['mr']['discordantAll'] == {'fixed': 3, 'broken': 5}
    assert reading['mr']['mcnemarP'] == 1.0
    assert reading['mr']['mcnemarAllP'] < 1.0


def test_a_configuration_surface_the_control_does_not_carry_is_named_beside_the_reading():
    # `S17`'s control was written four features earlier than its treatment, and nothing in the
    # registration asked the two arms to share a tree. The artifact can say so: `memoryArmConfig` is
    # projected from the code that produced it, so a key on one side only is a merged feature.
    control = artifact(CONTROL_COUNTS, 'a')
    treated = treatment(sessionClock=False, lexicalWeighting='flat')
    reading = read(control, treated)
    assert reading['configuration']['undeclaredOnControl'] == ['lexicalWeighting', 'sessionClock']
    # A diagnostic, not a verdict: the prompts decide `E3`, and naming a surface must not move it.
    assert reading['criteria']['E3']['verdict'] == 'pass'


def test_a_surface_the_treatment_dropped_is_named_too():
    control = artifact(CONTROL_COUNTS, 'a', supersededRendering='off')
    reading = read(control, treatment())
    assert reading['configuration']['absentOnTreatment'] == ['supersededRendering']


def test_a_census_field_on_one_side_only_is_named_and_makes_E5_unread():
    # The control of `S17` carries `selfIndex` without `queries`: the counter was merged between the two
    # dispatches. `E5` cannot be read there, and the reason is not "the control refuses to report" but
    # "the control's code did not have the field" -- two different repairs.
    control = artifact(CONTROL_COUNTS, 'a')
    control['memoryArmConfig']['selfIndex'] = {'indexes': 2000, 'turns': 742080}
    treated = treatment(selfIndex={'queries': 2405, 'indexes': 2000, 'turns': 742080})
    reading = read(control, treated)
    assert reading['configuration']['censusFieldsOneSide'] == ['queries']
    assert reading['criteria']['E5']['verdict'] == 'unread'
    assert 'no `queries` field' in reading['criteria']['E5']['measured']


def test_a_moved_prompt_records_whether_the_evidence_moved_with_it():
    # Same delivered bytes under a different digest is a renderer change; different bytes is a retrieval
    # change. `S17` was the first case on all fifty of its moved prompts, which is why the pair is not a
    # reading about the expansion at all.
    control = artifact(CONTROL_COUNTS, 'a')
    treated = treatment()
    for record in control['questions']:
        record['evidenceChars'] = 60_000
        record['evidenceTurns'] = 300
    for record in treated['questions']:
        record['evidenceChars'] = 60_000
        record['evidenceTurns'] = 300
    for record in treated['questions']:
        if record['questionId'] == 'TR-3':
            record['promptDigest'] = 'moved'
            record['evidenceChars'] = 61_000
        if record['questionId'] == 'TR-4':
            record['promptDigest'] = 'moved-too'
    reading = read(control, treated)
    moved = {row['questionId']: row for row in reading['promptIdentity']['moved']}
    assert moved['TR-3']['evidenceSame'] is False
    assert moved['TR-4']['evidenceSame'] is True
    assert reading['promptIdentity']['evidenceSame'] == 1


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
                 queryExpansionCounts={'questions': 121, 'phrases': 468, 'refused': 0}),
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


# ---------------------------------------------------------------- `E0`: one flag apart, or one tree?

SHA_A = 'a' * 40
SHA_B = 'b' * 40


def with_revision(document: dict, **revision: object) -> dict:
    document['revision'] = revision
    return document


def test_a_pair_at_one_commit_is_attributable():
    # The shape `§13.377.9` was registered for: two dispatches at one sha, and the artifact saying so.
    reading = read(
        with_revision(artifact(CONTROL_COUNTS, 'a'), sha=SHA_A),
        with_revision(treatment(), sha=SHA_A, runId='44711018477'),
    )
    assert reading['criteria']['E0']['verdict'] == 'pass'
    assert reading['revision']['comparable'] is True
    assert '44444444444' not in reading['criteria']['E0']['measured']


def test_two_commits_are_a_failed_precondition_and_both_are_named():
    # `S17` against `S16` was this, and nothing could see it: the pair differed by four merged
    # features and the only symptom was fifty moved prompts. A reader now gets the two shas.
    reading = read(
        with_revision(artifact(CONTROL_COUNTS, 'a'), sha=SHA_A),
        with_revision(treatment(), sha=SHA_B),
    )
    assert reading['criteria']['E0']['verdict'] == 'fail'
    assert SHA_A[:12] in reading['criteria']['E0']['measured']
    assert SHA_B[:12] in reading['criteria']['E0']['measured']


def test_an_artifact_that_predates_the_field_is_unread_rather_than_different():
    # Every archived artifact is this case. `fail` would rewrite four generations of published deltas;
    # `pass` would certify a pair nobody checked -- and two empty strings comparing equal is exactly
    # the defect class this campaign is written against.
    reading = read(artifact(CONTROL_COUNTS, 'a'), with_revision(treatment(), sha=SHA_A))
    assert reading['criteria']['E0']['verdict'] == 'unread'
    assert 'control artifact carries no `revision`' in reading['criteria']['E0']['measured']
    reading = read(artifact(CONTROL_COUNTS, 'a'), treatment())
    assert reading['criteria']['E0']['verdict'] == 'unread'
    assert 'neither artifact carries' in reading['criteria']['E0']['measured']


def test_the_rendered_reading_refuses_to_call_an_unattributable_delta_attributable():
    # The sentence is the deliverable: a table of five verdicts over two code versions reads as a
    # measurement of the flag unless the document says it is not one.
    rendered = expansion_reading.render(
        read(
            with_revision(artifact(CONTROL_COUNTS, 'a'), sha=SHA_A),
            with_revision(treatment(), sha=SHA_B),
        )
    )
    assert '| `E0` | **fail**' in rendered
    assert '**The delta above is not attributable to the declared flag.**' in rendered
    attributed = expansion_reading.render(
        read(
            with_revision(artifact(CONTROL_COUNTS, 'a'), sha=SHA_A),
            with_revision(treatment(), sha=SHA_A),
        )
    )
    assert 'not attributable' not in attributed
