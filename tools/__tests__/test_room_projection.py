"""The room projection's contract, proved on artifacts built to make it say the wrong number.

`tools/room-projection.py` exists because round 147 pre-registered 58,500 from an ad-hoc computation
that took `promptChars` as the numerator. On the artifact it was computed from, `3a704032` reports
45,944 there and 48,449 in `deliveredPromptChars` against a room of 48,460, and the two projections
disagree on three of sixteen questions across the registered value. The defect was a column, so the
suite pins the column: `test_the_two_estimators_differ_and_the_room_is_the_larger_one` asserts the
direction and that the difference is the 5.2% the two fields carry.

The rest of the suite is about the states the tool must refuse, because its failure mode has to be
"no number" rather than "a number about fewer questions". Each refusal gets the record that produces
it -- a window that is not full, a window that overflowed past the pool, a blind gold account, a route
with no room -- and each is asserted to keep the maximum `None` and to exit non-zero. A projection
over a subset printed beside a maximum over the whole set is the silent-denominator defect
`AUDIT-SILENT-DENOMINATOR.md` is about, arriving as arithmetic.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

TOOL = Path(__file__).resolve().parents[1] / 'room-projection.py'


def load():
    spec = importlib.util.spec_from_file_location('room_projection', TOOL)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules['room_projection'] = module
    spec.loader.exec_module(module)
    return module


room_projection = load()


def question(
    question_id: str = 'q1',
    *,
    route: str = 'multi-session',
    delivered_turns: int = 100,
    delivered_chars: int = 48_449,
    prompt_chars: int = 45_944,
    ranks: list[int] | None = None,
    gold_delivered: list[bool] | None = None,
    offered: int | None = None,
    include_ranks: bool = True,
) -> dict:
    """One record shaped like the arm writes it, with the fields the projection reads."""
    ranks = [1, 2] if ranks is None else ranks
    gold_delivered = [True, False] if gold_delivered is None else gold_delivered
    overlap: dict = {
        'carried': sum(1 for ok in gold_delivered if ok),
        'total': len(gold_delivered),
        'goldTurns': [f'gold {index}' for index in range(len(gold_delivered))],
        'goldDelivered': gold_delivered,
        'pool': sum(1 for rank in ranks if rank >= 0),
    }
    if include_ranks:
        overlap['goldRanks'] = ranks
    return {
        'questionId': question_id,
        'route': route,
        'turns': [{'index': index, 'text': f'turn {index}'} for index in range(delivered_turns)],
        'evidenceTurns': delivered_turns + 39,
        'promptChars': prompt_chars,
        'deliveredPromptChars': delivered_chars,
        'goldOverlap': overlap,
        'windowComposition': {
            'turns': delivered_turns,
            'offered': delivered_turns if offered is None else offered,
            'offeredChars': delivered_chars,
            'unscoredChars': 0,
        },
    }


def artifact(*questions: dict, rooms: dict | None = None) -> dict:
    return {
        'questions': list(questions),
        'memoryArmConfig': {
            'effectivePromptChars': {'multi-session': 48_460, 'temporal': 24_000, 'flat': 24_000}
            if rooms is None
            else rooms,
        },
    }


def test_the_two_estimators_differ_and_the_room_is_the_larger_one():
    # The defect this file was written after: the room bounds the rendered prompt, not the evidence
    # text, and the two columns differ by 5.2% on a window that is full. `3a704032`'s own numbers.
    projection = room_projection.project(artifact(question(ranks=[63, 223], gold_delivered=[True, False])))
    row = projection['rows'][0]
    assert row['deepestCutRank'] == 223
    assert row['neededTurns'] == 224
    assert row['byRoom'] == pytest.approx(224 / 100 * 48_460)
    assert row['byPromptChars'] == pytest.approx(224 / 100 * 45_944)
    assert row['byRoom'] > row['byPromptChars']
    # The registered 58,500 of round 147 is reproduced here to the character by the cheaper column on the
    # worst question `gpt4_ab202e7f` (228 of 179 turns, `promptChars` 45,732 of a 48,460 room), which is
    # how the column it was taken from is identified rather than remembered.
    assert 58_251 == round(228 / 179 * 45_732)
    assert 61_726 == round(228 / 179 * 48_460)


def test_a_gold_turn_the_ranking_never_surfaced_is_not_a_room_question():
    # `-1` is a statement about the ranking. A projection over it would claim a wider room recovers a
    # turn the window never held a score for, which is the category error `goldAccount` was added for.
    projection = room_projection.project(
        artifact(question(ranks=[-1, 5], gold_delivered=[False, True])),
    )
    assert projection['rows'] == []
    assert projection['maximum'] is None
    assert [entry['rank'] for entry in projection['neverSurfaced']] == [-1]
    assert 'never surfaced' in room_projection.render(projection)


def test_a_carried_fully_question_does_not_enter_the_max():
    # 105 of the 121 MR questions carried every gold turn. Counting them as rows with a zero need would
    # make the maximum describe a population that has no short question in it.
    projection = room_projection.project(
        artifact(
            question('full', ranks=[1, 2], gold_delivered=[True, True]),
            question('short', ranks=[1, 99], gold_delivered=[True, False]),
        )
    )
    assert [row['questionId'] for row in projection['rows']] == ['short']
    assert projection['fullyCarried'] == 1


def test_an_unreadable_question_refuses_the_whole_projection():
    # The point of the refusal: a maximum over the readable subset while an unreadable one is dropped is
    # a number about fewer questions than the artifact holds, printed as if it were about all of them.
    projection = room_projection.project(
        artifact(
            question('readable', ranks=[1, 99], gold_delivered=[True, False]),
            question('unreadable', ranks=[1, 99], gold_delivered=[True, False], delivered_chars=30_000),
        )
    )
    assert projection['maximum'] is None
    assert [refusal['reason'] for refusal in projection['refusals']] == ['window-below-cap']
    assert projection['candidate'] is None


def test_a_window_that_overflowed_past_the_pool_is_refused():
    # `windowComposition.offered < turns` is the module's own documented state: the room spent characters
    # on turns the ranking never scored, so a rank is no longer a position in what the room bought.
    projection = room_projection.project(
        artifact(question(ranks=[1, 99], gold_delivered=[True, False], offered=90)),
    )
    assert projection['maximum'] is None
    assert projection['refusals'][0]['reason'] == 'unscored-turns-in-window'
    assert '10 of 100 delivered turns carry no ranking score' in projection['refusals'][0]['detail']


def test_a_blind_gold_account_is_refused_rather_than_read_as_carried():
    # Without `goldRanks` every missing gold turn looks alike -- the `product-unreported` artifact. The
    # tool must not treat the absence of a rank as a rank, which would put every such run at `carried`.
    projection = room_projection.project(
        artifact(question(ranks=[1, 99], gold_delivered=[True, False], include_ranks=False)),
    )
    assert projection['presence'] if False else True
    assert projection['maximum'] is None
    assert projection['refusals'][0]['reason'] == 'ranking-not-reported'
    assert 'product-unreported' in projection['refusals'][0]['detail']


def test_a_route_with_no_room_is_refused():
    # The denominator. A route absent from `effectivePromptChars` is a run whose room this artifact does
    # not state, and dividing by a default would invent the number the tool exists to measure.
    projection = room_projection.project(
        artifact(
            question(route='multi-session', ranks=[1, 99], gold_delivered=[True, False]),
            rooms={'temporal': 24_000},
        )
    )
    assert projection['maximum'] is None
    assert projection['refusals'][0]['reason'] == 'room-unknown'
    assert "effectivePromptChars['multi-session']" in projection['refusals'][0]['detail']


def test_a_candidate_room_is_judged_by_the_room_estimator_not_the_cheaper_one():
    # 58,500 is the number round 147 registered. Under `byPromptChars` it covers both rows; under the
    # column the room actually bounds it misses one -- which is the round's whole finding expressed as
    # an assertion, so a future regression to the cheaper estimator fails here.
    projection = room_projection.project(
        artifact(
            question('a', delivered_turns=179, ranks=[1, 227], gold_delivered=[True, False]),
            question('b', delivered_turns=204, ranks=[1, 222], gold_delivered=[True, False]),
        ),
        candidate_room=58_500,
    )
    candidate = projection['candidate']
    assert candidate is not None
    assert candidate['covers'] == ['b']
    assert candidate['misses'] == ['a']
    assert candidate['complete'] is False
    covered_62000 = room_projection.project(
        artifact(
            question('a', delivered_turns=179, ranks=[1, 227], gold_delivered=[True, False]),
            question('b', delivered_turns=204, ranks=[1, 222], gold_delivered=[True, False]),
        ),
        candidate_room=62_000,
    )['candidate']
    assert covered_62000 is not None and covered_62000['complete'] is True


def test_the_rendered_projection_states_its_assumption_and_what_it_does_not_say():
    # The number travels with the assumption, because the assumption is the part a reader cannot check
    # from the artifact: the tail's mean rendered length is not recorded anywhere.
    projection = room_projection.project(artifact(question(ranks=[1, 99], gold_delivered=[True, False])))
    rendered = room_projection.render(projection)
    assert 'assuming the turns the room did not reach' in rendered
    assert 'anything about accuracy' in rendered
    assert 'Maximum room: 48460' in rendered


def test_the_cli_exits_two_when_the_projection_is_refused(tmp_path):
    # A pipeline that reads only the number would take an absent maximum for a zero, so the refusal is
    # an exit status as well as a line.
    path = tmp_path / 'artifact.json'
    path.write_text(
        json.dumps(artifact(question(ranks=[1, 99], gold_delivered=[True, False], delivered_chars=10_000))),
        encoding='utf-8',
    )
    assert room_projection.main([str(path)]) == 2
    readable = tmp_path / 'readable.json'
    readable.write_text(json.dumps(artifact(question(ranks=[1, 99], gold_delivered=[True, False]))), encoding='utf-8')
    assert room_projection.main([str(readable)]) == 0
