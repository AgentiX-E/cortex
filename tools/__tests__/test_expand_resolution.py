"""The expand-resolution tool, checked on hand-built artifacts.

The tool prices the retrieval axis before a retrieval mechanism is dispatched, and its whole value is
that it separates two ceilings §13.126 had conflated: a **permutation** ceiling (wrong questions whose
best gold turn is already deep in a delivered list) and a **region** ceiling (wrong questions with an
eligible gold turn the reader was never shown). A permutation cannot produce a turn that was not
delivered, so the second ceiling bounds the second class of mechanism and the first does not.

This file tests the tool rather than the artifact format: that each of the three buckets is computed
from the record's own numbers, that the pool split degrades honestly on a record written before the
pool existed, that a malformed record is refused rather than read, and that the two ceilings are
reported as two numbers.

The refusals are what a later refactor is most likely to lose, because each of them replaces a number
that looks plausible with a number that would be wrong in a direction nobody would notice: `carried`
above `total` makes `missing` negative, and a negative missing gold reads as a question with room to
spare.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "expand-resolution.mjs"


def record(
    question_id: str,
    *,
    capability: str = 'MR',
    correct: bool = False,
    question: str = 'What colour was the van?',
    overlap: dict | None | object = ...,
) -> dict:
    """One question record with the two fields this tool reads plus the envelope around them."""
    if overlap is ...:
        overlap = {'carried': 1, 'total': 1, 'pool': 1, 'goldRanks': [0]}
    return {
        'questionId': question_id,
        'question': question,
        'capability': capability,
        'groundTruth': 'blue',
        'answer': 'blue' if correct else None,
        'rawOutput': 'blue',
        'correct': correct,
        'grounded': correct,
        'turns': [],
        'promptChars': 100,
        'evidenceTurns': 1,
        'evidenceChars': 100,
        'goldOverlap': overlap,
    }


def artifact(questions: list[dict]) -> dict:
    return {
        'dataset': 'longmemeval/s/100',
        'questionCount': len(questions),
        'questions': questions,
        'runs': 4,
    }


def run(tmp_path: Path, body: dict, *extra: str) -> subprocess.CompletedProcess:
    path = tmp_path / 'artifact.json'
    path.write_text(json.dumps(body), encoding='utf-8')
    return subprocess.run(
        ['node', str(TOOL), '--artifact', str(path), *extra],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )


def json_of(tmp_path: Path, body: dict) -> dict:
    completed = run(tmp_path, body, '--json')
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


# ------------------------------------------------------------------------ the three buckets


def test_a_question_whose_golds_were_all_delivered_is_not_reachable(tmp_path: Path) -> None:
    """Complete delivery is the state a region change cannot improve, so it is not in the ceiling."""
    body = artifact([record('full', overlap={'carried': 3, 'total': 3, 'pool': 3, 'goldRanks': [0, 1, 4]})])

    reading = json_of(tmp_path, body)

    assert reading['totals']['reachable'] == 0
    assert reading['totals']['deepInPoolGold'] == 0
    assert reading['totals']['outsidePoolGold'] == 0


def test_a_gold_the_index_saw_and_the_delivery_dropped_is_the_cheap_bucket(tmp_path: Path) -> None:
    """Pool 5, carried 2: three golds need no new retrieval, only a wider delivery."""
    body = artifact([record('deep', overlap={'carried': 2, 'total': 5, 'pool': 5, 'goldRanks': [0, 1, 40, 80, 160]})])

    reading = json_of(tmp_path, body)

    assert reading['totals']['reachable'] == 1
    assert reading['totals']['deepInPoolGold'] == 3
    assert reading['totals']['outsidePoolGold'] == 0


def test_a_gold_the_index_never_surfaced_is_the_expensive_bucket(tmp_path: Path) -> None:
    """Pool 2 of 5 with both delivered: the three missing golds need a different query, not a wider one."""
    body = artifact([record('outside', overlap={'carried': 2, 'total': 5, 'pool': 2, 'goldRanks': [0, 1, -1, -1, -1]})])

    reading = json_of(tmp_path, body)

    assert reading['totals']['reachable'] == 1
    assert reading['totals']['deepInPoolGold'] == 0
    assert reading['totals']['outsidePoolGold'] == 3


def test_a_delivery_wider_than_the_pool_is_read_at_its_tight_side(tmp_path: Path) -> None:
    """`carried` above `pool` means the record delivered turns the pool did not rank, so the split is a
    lower bound on the deep bucket rather than an identity. Reporting a negative would be arithmetic on
    two different sets."""
    body = artifact([record('mixed', overlap={'carried': 4, 'total': 6, 'pool': 2, 'goldRanks': [0, 3, -1, -1, -1, -1]})])

    reading = json_of(tmp_path, body)

    assert reading['totals']['reachable'] == 1
    assert reading['totals']['deepInPoolGold'] == 0
    assert reading['totals']['outsidePoolGold'] == 2


def test_a_record_without_a_pool_is_still_priced_for_its_missing_golds(tmp_path: Path) -> None:
    """Artifacts written before `poolGold` existed carry two fields. The missing count survives, the
    split does not, and a split invented from an absent pool would claim the index never saw a gold it
    was never asked about."""
    body = artifact([record('old', overlap={'carried': 1, 'total': 4})])
    body['questions'].append(record('old-correct', correct=True, overlap={'carried': 1, 'total': 4}))

    reading = json_of(tmp_path, body)

    assert reading['totals']['reachable'] == 1
    assert reading['totals']['deepInPoolGold'] == 0
    assert reading['totals']['outsidePoolGold'] == 0
    assert reading['totals']['correct'] == 1


def test_a_correct_question_never_enters_the_ceiling(tmp_path: Path) -> None:
    """A ceiling is headroom, so a question already answered has none however thin its evidence was."""
    body = artifact(
        [
            record('right', correct=True, overlap={'carried': 1, 'total': 3, 'pool': 2, 'goldRanks': [0, -1, -1]}),
            record('wrong', overlap={'carried': 1, 'total': 3, 'pool': 2, 'goldRanks': [0, -1, -1]}),
        ]
    )

    reading = json_of(tmp_path, body)

    assert reading['totals']['correct'] == 1
    assert reading['totals']['reachable'] == 1


# ------------------------------------------------------------------------ the two ceilings


def test_the_two_ceilings_are_two_numbers_and_the_region_one_dominates(tmp_path: Path) -> None:
    """§13.126's count reads the **best** rank, so a question with one shallow gold and five undelivered
    ones is invisible to it. That is the whole reason this tool exists."""
    body = artifact(
        [
            # best rank 0 (shallow, so §13.126 cannot see it) but four of five golds undelivered
            record('hidden', overlap={'carried': 1, 'total': 5, 'pool': 5, 'goldRanks': [0, 12, 40, 90, 200]}),
            # best rank 20: visible to both
            record('both', overlap={'carried': 1, 'total': 2, 'pool': 2, 'goldRanks': [20, 30]}),
            # best rank 0 and everything delivered: neither
            record('neither', overlap={'carried': 2, 'total': 2, 'pool': 2, 'goldRanks': [0, 3]}),
        ]
    )

    reading = json_of(tmp_path, body)
    mr = reading['capabilities']['MR']

    assert mr['permutation'] == 1
    assert mr['reachable'] == 2
    assert mr['reachable'] >= mr['permutation']


def test_a_question_with_no_gold_in_the_pool_is_not_a_permutation_target(tmp_path: Path) -> None:
    """A permutation needs something delivered to permute. All-negative ranks mean nothing was, so the
    question belongs to the region ceiling and to no other."""
    body = artifact([record('none', overlap={'carried': 0, 'total': 3, 'pool': 0, 'goldRanks': [-1, -1, -1]})])

    reading = json_of(tmp_path, body)

    assert reading['capabilities']['MR']['permutation'] == 0
    assert reading['capabilities']['MR']['reachable'] == 1


def test_the_ceiling_is_reported_in_points_because_that_is_the_unit_it_is_compared_in(tmp_path: Path) -> None:
    """Twenty questions of a hundred-question roster is 20 points, and a reader compares it against a
    published accuracy rather than against a count."""
    body = artifact([record(f'q{index}', overlap={'carried': 1, 'total': 2, 'pool': 1, 'goldRanks': [0, -1]}) for index in range(20)])
    body['questions'] += [record(f'ok{index}', correct=True) for index in range(80)]

    reading = json_of(tmp_path, body)

    assert reading['totals']['reachable'] == 20
    assert reading['ceilingPoints'] == 20.0


# ------------------------------------------------------------------------ the decomposition


def test_a_question_with_no_cue_is_one_sub_query(tmp_path: Path) -> None:
    body = artifact([record('plain', question='What colour was the van?')])

    reading = json_of(tmp_path, body)

    assert reading['capabilities']['MR']['subQueries'] == 1
    assert reading['capabilities']['MR']['decomposable'] == 0


def test_a_named_period_is_a_temporal_cue(tmp_path: Path) -> None:
    body = artifact([record('when', question='How many books did I finish in April?')])

    reading = json_of(tmp_path, body)

    # cardinality (`how many`) and temporal (`april`) -- two classes, two keys
    assert reading['capabilities']['MR']['subQueries'] == 2


def test_a_conjunction_names_two_things_at_once(tmp_path: Path) -> None:
    """The class a whole-question query most reliably blurs, and the one whose extra key is a second
    retrieval rather than a narrower one: `X and Y` asks for one per operand **plus** the combined
    phrase, which is the reference pipeline's own retention rule."""
    body = artifact([record('pair', question='How many items did I pick up and return?')])

    reading = json_of(tmp_path, body)

    # cardinality + conjunction + one extra for the second operand
    assert reading['capabilities']['MR']['subQueries'] == 3


def test_the_holdout_counts_the_questions_the_rules_were_not_chosen_against(tmp_path: Path) -> None:
    """The families were read off the wrong questions' own text, so their coverage of those questions is
    a fitted number. The same families read against the correct ones is the only coverage that can
    argue the rules generalise, and a tool that reported only the fitted number would be hiding it."""
    body = artifact(
        [
            record('wrong-split', question='How many hats and scarves?'),
            record('wrong-plain', question='What colour was the van?'),
            record('right-split', correct=True, question='How many hats and scarves?'),
            record('right-plain', correct=True, question='What colour was the van?'),
        ]
    )

    reading = json_of(tmp_path, body)
    mr = reading['capabilities']['MR']

    assert mr['decomposable'] == 1
    assert mr['wrong'] == 2
    assert mr['correctDecomposable'] == 1
    assert mr['correct'] == 2


def test_a_relative_period_is_a_cue_because_the_roster_says_so(tmp_path: Path) -> None:
    """`in the last month` is the phrasing this dataset uses; `in March` is the phrasing the first
    version of the rule set matched. Both are periods and only one of them carries the roster."""
    body = artifact(
        [
            record('relative', question='How many plants did I acquire in the last month?'),
            record('absolute', question='How many bikes did I service in March?'),
        ]
    )

    reading = json_of(tmp_path, body)
    mr = reading['capabilities']['MR']

    assert mr['decomposable'] == 2
    # relative-period + cardinality = 2, absolute-period + cardinality = 2
    assert mr['subQueries'] == 4


def test_an_ordering_question_is_a_different_key_from_a_cardinality_one(tmp_path: Path) -> None:
    body = artifact(
        [
            record('order', question='What is the order of the three trips I took, earliest to latest?'),
            record('count', question='What is the total number of siblings I have?'),
        ]
    )

    reading = json_of(tmp_path, body)
    mr = reading['capabilities']['MR']

    # the ordering question fires `ordering` (+ `conjunction` for the comma list is not a pattern here)
    assert mr['subQueries'] >= 2


def test_the_text_reading_prints_the_holdout(tmp_path: Path) -> None:
    body = artifact([record('q', question='How many hats and scarves?')])
    path = tmp_path / 'artifact.json'
    path.write_text(json.dumps(body), encoding='utf-8')

    completed = subprocess.run(
        ['node', str(TOOL), '--artifact', str(path)],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert 'The holdout the rule set has to survive' in completed.stdout


def test_the_decomposable_count_is_over_wrong_questions_and_the_reach_is_a_subset(tmp_path: Path) -> None:
    body = artifact(
        [
            record('splittable-and-reachable', question='How many hats and scarves?', overlap={'carried': 1, 'total': 3, 'pool': 1, 'goldRanks': [0, -1, -1]}),
            record('splittable-and-complete', question='How many hats and scarves?', overlap={'carried': 3, 'total': 3, 'pool': 3, 'goldRanks': [0, 1, 2]}),
            record('unsplittable-but-reachable', question='What colour was the van?', overlap={'carried': 1, 'total': 2, 'pool': 1, 'goldRanks': [0, -1]}),
        ]
    )

    reading = json_of(tmp_path, body)
    mr = reading['capabilities']['MR']

    assert mr['decomposable'] == 2
    assert mr['reachable'] == 2
    assert mr['reachableAndDecomposable'] == 1


# ------------------------------------------------------------------------ the refusals


def test_refuses_a_delivery_that_exceeds_its_own_denominator(tmp_path: Path) -> None:
    body = artifact([record('bad', overlap={'carried': 4, 'total': 2, 'pool': 2, 'goldRanks': [0, 1]})])

    completed = run(tmp_path, body)

    assert completed.returncode == 1
    assert 'carried 4' in completed.stderr


def test_refuses_a_pool_larger_than_its_denominator(tmp_path: Path) -> None:
    """`pool` is a subset of the eligible golds by construction, so a larger count means the two were
    computed over different sets."""
    body = artifact([record('bad', overlap={'carried': 1, 'total': 2, 'pool': 5, 'goldRanks': [0, 1]})])

    completed = run(tmp_path, body)

    assert completed.returncode == 1
    assert 'pool 5' in completed.stderr


def test_refuses_a_verdict_that_is_not_a_boolean(tmp_path: Path) -> None:
    """Python's `True` is an `int` in JSON terms for a truthiness test, and a string verdict is worse."""
    body = artifact([record('bad')])
    body['questions'][0]['correct'] = 'true'

    completed = run(tmp_path, body)

    assert completed.returncode == 1
    assert 'not a boolean' in completed.stderr


def test_refuses_a_report_with_no_roster(tmp_path: Path) -> None:
    completed = run(tmp_path, {'dataset': 'longmemeval/s/100'})

    assert completed.returncode == 1
    assert 'no `questions` array' in completed.stderr


def test_an_absent_overlap_is_unjudgeable_rather_than_complete(tmp_path: Path) -> None:
    """`null` overlap means "this question has no gold turns to measure". A zeroed ledger would file it
    as a question whose evidence was complete, which is a different and false statement."""
    body = artifact([record('no-gold', overlap=None), record('zero', overlap={'carried': 0, 'total': 0})])

    reading = json_of(tmp_path, body)

    assert reading['totals']['reachable'] == 0
    assert reading['capabilities']['MR']['unjudgeable'] == 2
    assert reading['capabilities']['MR']['wrong'] == 2


def test_refuses_a_rank_list_that_does_not_match_its_denominator(tmp_path: Path) -> None:
    """One entry per gold, so a shorter list was computed over fewer golds and its ranks cannot be
    compared against `total` -- the same failure as a pool larger than the set it is a subset of."""
    body = artifact([record('bad', overlap={'carried': 1, 'total': 3, 'pool': 1, 'goldRanks': [0]})])

    completed = run(tmp_path, body)

    assert completed.returncode == 1
    assert 'goldRanks carries 1 entries for 3' in completed.stderr


def test_an_unknown_flag_is_a_usage_error_not_a_reading(tmp_path: Path) -> None:
    body = artifact([record('q')])

    completed = run(tmp_path, body, '--control', 'somewhere.json')

    assert completed.returncode == 2
    assert 'unknown argument' in completed.stderr


def test_the_text_reading_carries_the_same_population_as_the_machine_one(tmp_path: Path) -> None:
    body = artifact(
        [
            record('hole', overlap={'carried': 1, 'total': 4, 'pool': 2, 'goldRanks': [0, 8, -1, -1]}),
            record('fine', correct=True, overlap={'carried': 2, 'total': 2, 'pool': 2, 'goldRanks': [0, 1]}),
        ]
    )
    path = tmp_path / 'artifact.json'
    path.write_text(json.dumps(body), encoding='utf-8')

    machine = subprocess.run(
        ['node', str(TOOL), '--artifact', str(path), '--json'],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    text = subprocess.run(
        ['node', str(TOOL), '--artifact', str(path)],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )

    assert machine.returncode == 0, machine.stderr
    assert text.returncode == 0, text.stderr
    reading = json.loads(machine.stdout)
    assert 'Region ceiling: 1 of 1 wrong questions' in text.stdout
    assert f'which is {reading["ceilingPoints"]:.2f} points' in text.stdout
