"""The recovery-reach tool, checked on hand-built artifacts.

`declinedItems`/`asksForCount` have their own unit tests, and so does the route table. This file tests
the **tool**: that it names the pass's population with the product's own predicate rather than with a
copy of it, that it reads the population from the control because the treatment's record overwrites the
reply that made the question reachable, that it prints a gross flow rather than a net, and that it
refuses the four artifacts that would otherwise print as a reading.

The refusals are the part that matters in practice. An artifact whose treatment consulted nothing looks
exactly like a pass that converted nothing, and the difference between those two is the difference
between an assembly failure and a measurement -- which is §13.141.1's own criterion, applied to a tool.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "recovery-reach.mjs"

# A decline that contradicts its own list: the shape `declinedItems` counts.
LISTED_DECLINE = (
    'Step 1 - items from the evidence:\n'
    '- the novel finished in January at 320 pages\n'
    '- the book priced at twelve dollars\n'
    '\n'
    'Step 2 - can the question be answered:\n'
    'INSUFFICIENT_EVIDENCE'
)

# The same shape, with the only bullet reporting an absence rather than an item.
ABSENCE_DECLINE = (
    'Step 1 - items from the evidence:\n'
    '- No item in the evidence states a novel finished in January with a page count.\n'
    '\n'
    'Step 2 - can the question be answered:\n'
    'INSUFFICIENT_EVIDENCE'
)

BARE_DECLINE = 'INSUFFICIENT_EVIDENCE'


def record(
    question_id: str,
    *,
    capability: str = 'MR',
    correct: bool = False,
    answer: str | None = None,
    raw: str | None = BARE_DECLINE,
    question: str = 'What colour was the van?',
) -> dict:
    """One question record in the envelope the memory arm writes."""
    return {
        'questionId': question_id,
        'question': question,
        'capability': capability,
        'groundTruth': 'blue',
        'answer': answer,
        'rawOutput': raw,
        'correct': correct,
        'grounded': answer is not None,
        'turns': [],
        'promptChars': 100,
        'evidenceTurns': 1,
        'evidenceChars': 100,
        'goldOverlap': 0,
    }


def artifact(questions: list[dict], *, attempted: int = 0, answered: int = 0, runs: int = 4) -> dict:
    return {
        'dataset': 'longmemeval/s/100',
        'questionCount': len(questions),
        'questions': questions,
        'recovery': {'attempted': attempted, 'answered': answered},
        'bareRetry': {'attempted': 0, 'answered': 0},
        'runs': runs,
    }


def run(tmp_path: Path, control: dict, treatment: dict, *extra: str) -> subprocess.CompletedProcess:
    left = tmp_path / 'control.json'
    right = tmp_path / 'treatment.json'
    left.write_text(json.dumps(control), encoding='utf-8')
    right.write_text(json.dumps(treatment), encoding='utf-8')
    return subprocess.run(
        ['node', str(TOOL), '--control', str(left), '--treatment', str(right), *extra],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )


# --------------------------------------------------------------------- the population


def test_counts_a_listed_decline_and_not_the_shapes_that_only_look_like_one(tmp_path: Path) -> None:
    """Three declines, one of them reachable: the census has to agree with the product's predicate."""
    control = artifact(
        [
            record('reachable', raw=LISTED_DECLINE),
            record('absent', raw=ABSENCE_DECLINE),
            record('bare', raw=BARE_DECLINE),
            record('answered', correct=True, answer='blue', raw='blue'),
        ]
    )
    treatment = artifact([record('reachable', correct=True, answer='blue', raw='blue')], attempted=1, answered=1)

    completed = run(tmp_path, control, treatment)

    assert completed.returncode == 0, completed.stderr
    assert 'Population: 1 questions' in completed.stdout
    assert 'reachable  items=2' in completed.stdout
    assert 'absent' not in completed.stdout
    assert 'bare' not in completed.stdout


def test_the_population_is_the_route_and_not_the_capability_name(tmp_path: Path) -> None:
    """A listed decline on a temporal route is not in the pass's population, however it is shaped."""
    control = artifact([record('on-route', capability='MR', raw=LISTED_DECLINE)])
    control['questions'].append(record('off-route', capability='TR', raw=LISTED_DECLINE))
    treatment = artifact(
        [record('on-route', correct=True, answer='blue', raw='blue'), record('off-route', raw=BARE_DECLINE)],
        attempted=1,
        answered=1,
    )

    completed = run(tmp_path, control, treatment)

    assert completed.returncode == 0, completed.stderr
    assert 'Population: 1 questions -- declines on multi-session' in completed.stdout
    assert 'on-route  items=2' in completed.stdout
    assert 'off-route  items' not in completed.stdout
    # The temporal row is still in the census, with its own route named.
    assert 'TR' in completed.stdout
    assert 'temporal' in completed.stdout


def test_the_population_comes_from_the_control_because_the_treatment_overwrote_the_reply(tmp_path: Path) -> None:
    """The treatment's own record of a consulted question carries the retry's list-less decline."""
    control = artifact([record('consulted', raw=LISTED_DECLINE), record('untouched', raw=LISTED_DECLINE)])
    treatment = artifact(
        [
            # the pass consulted and lost: the record now holds the retry's bare decline
            record('consulted', raw=BARE_DECLINE),
            record('untouched', raw=LISTED_DECLINE),
        ],
        attempted=1,
        answered=0,
    )

    completed = run(tmp_path, control, treatment)

    assert completed.returncode == 0, completed.stderr
    # Two, not zero: a tool that read the treatment would report an empty reach on a pass that fired.
    assert 'Population: 2 questions' in completed.stdout
    assert 'consulted  items=2' in completed.stdout


# --------------------------------------------------------------------- the transitions


def test_a_purchase_and_a_loss_are_both_named_because_a_net_hides_a_cancellation(tmp_path: Path) -> None:
    """Two flips in opposite directions are a gross flow of two and a net of zero."""
    control = artifact(
        [
            record('bought', raw=LISTED_DECLINE),
            record('sold', correct=True, answer='red', raw='red'),
        ]
    )
    treatment = artifact(
        [
            record('bought', correct=True, answer='blue', raw='blue'),
            record('sold', correct=False, raw=BARE_DECLINE),
        ],
        attempted=1,
        answered=1,
    )

    completed = run(tmp_path, control, treatment)

    assert completed.returncode == 0, completed.stderr
    assert 'population (reached)' in completed.stdout
    assert 'bought= 1 sold= 1 net=  0' in completed.stdout or 'bought= 1 sold= 1' in completed.stdout
    assert 'roster' in completed.stdout


def test_the_route_it_cannot_reach_is_split_out_from_every_other_capability(tmp_path: Path) -> None:
    """The comparison the section makes is same-route churn against the pass's own purchases."""
    control = artifact(
        [
            record('reachable', raw=LISTED_DECLINE),
            record('same-route-churn', correct=True, answer='red', raw='red'),
            record('other-cap-churn', capability='IE', correct=True, answer='red', raw='red'),
        ]
    )
    treatment = artifact(
        [
            record('reachable', correct=True, answer='blue', raw='blue'),
            record('same-route-churn', correct=False, raw=BARE_DECLINE),
            record('other-cap-churn', capability='IE', correct=False, raw=BARE_DECLINE),
        ],
        attempted=1,
        answered=1,
    )

    completed = run(tmp_path, control, treatment)

    assert completed.returncode == 0, completed.stderr
    assert 'untouched, multi-session' in completed.stdout
    assert 'untouched, other caps' in completed.stdout


# --------------------------------------------------------------------- the registered claims


def test_the_conversion_claim_is_falsified_when_the_pass_converts_fewer_than_four(tmp_path: Path) -> None:
    """§13.141.5 claim 1 is a floor of four on the reachable population, not a sign test."""
    control = artifact([record(f'q{n}', raw=LISTED_DECLINE) for n in range(10)])
    treatment = artifact(
        [record('q0', correct=True, answer='blue', raw='blue')]
        + [record(f'q{n}', raw=BARE_DECLINE) for n in range(1, 10)],
        attempted=10,
        answered=1,
    )

    completed = run(tmp_path, control, treatment)

    assert completed.returncode == 0, completed.stderr
    assert 'measured 1 converted -> FALSIFIED' in completed.stdout


def test_the_conversion_claim_holds_at_four(tmp_path: Path) -> None:
    """The boundary is inclusive, so four of ten is a pass and three is not."""
    control = artifact([record(f'q{n}', raw=LISTED_DECLINE) for n in range(10)])
    treatment = artifact(
        [record(f'q{n}', correct=True, answer='blue', raw='blue') for n in range(4)]
        + [record(f'q{n}', raw=BARE_DECLINE) for n in range(4, 10)],
        attempted=10,
        answered=4,
    )

    completed = run(tmp_path, control, treatment)

    assert completed.returncode == 0, completed.stderr
    assert 'measured 4 converted -> HOLDS' in completed.stdout


def test_the_counting_claim_is_falsified_by_its_own_stated_falsifier(tmp_path: Path) -> None:
    """Zero counting conversions while non-counting ones convert is the registered falsifier."""
    control = artifact(
        [
            record('counting', raw=LISTED_DECLINE, question='How many books did I finish?'),
            record('other', raw=LISTED_DECLINE),
        ]
    )
    treatment = artifact(
        [
            record('counting', raw=BARE_DECLINE, question='How many books did I finish?'),
            record('other', correct=True, answer='blue', raw='blue'),
        ],
        attempted=2,
        answered=1,
    )

    completed = run(tmp_path, control, treatment)

    assert completed.returncode == 0, completed.stderr
    assert 'measured 0 of 1 counting, 1 of 1 not -> FALSIFIED' in completed.stdout


def test_a_flow_inside_the_readers_own_spread_is_not_called_a_falsification(tmp_path: Path) -> None:
    """5.4% against a 5.0% floor from 379 questions is one question, not a signal."""
    control = artifact([record('reachable', raw=LISTED_DECLINE)] + [
        record(f'a{n}', correct=True, answer='red', raw='red') for n in range(99)
    ])
    # Five flips of a hundred answered questions is 5.0%: the floor exactly.
    treatment = artifact(
        [record('reachable', correct=True, answer='blue', raw='blue')]
        + [record(f'a{n}', correct=n % 20 != 0, answer='red' if n % 20 != 0 else None, raw='red' if n % 20 != 0 else BARE_DECLINE) for n in range(99)],
        attempted=1,
        answered=1,
    )

    completed = run(tmp_path, control, treatment)

    assert completed.returncode == 0, completed.stderr
    assert 'floor 5.0 +/- ' in completed.stdout
    assert '-> HOLDS' in completed.stdout


# --------------------------------------------------------------------- the refusals


def test_refuses_the_same_file_twice(tmp_path: Path) -> None:
    """Every transition would be "unchanged" by construction, which prints as a null result."""
    body = artifact([record('q', raw=LISTED_DECLINE)])
    path = tmp_path / 'one.json'
    path.write_text(json.dumps(body), encoding='utf-8')

    completed = subprocess.run(
        ['node', str(TOOL), '--control', str(path), '--treatment', str(path)],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )

    assert completed.returncode == 2
    assert 'same file' in completed.stderr


def test_refuses_a_population_question_the_treatment_does_not_carry(tmp_path: Path) -> None:
    """An unpaired question's "no change" would be fabricated."""
    control = artifact([record('present', raw=LISTED_DECLINE), record('missing', raw=LISTED_DECLINE)])
    treatment = artifact([record('present', raw=BARE_DECLINE)], attempted=1, answered=0)

    completed = run(tmp_path, control, treatment)

    assert completed.returncode == 2
    assert 'absent from the treatment' in completed.stderr
    assert 'missing' in completed.stderr


def test_refuses_an_absent_answer_field_because_absent_is_not_a_decline(tmp_path: Path) -> None:
    """The §13.107 rule: a field that was never written is not a zero."""
    control = artifact([record('q', raw=LISTED_DECLINE)])
    broken = record('q', raw=LISTED_DECLINE)
    del broken['answer']
    treatment = artifact([broken], attempted=1, answered=0)

    completed = run(tmp_path, control, treatment)

    assert completed.returncode == 2
    assert 'no answer field' in completed.stderr


def test_refuses_a_verdict_that_is_not_a_boolean(tmp_path: Path) -> None:
    """A grading failure read as `false` buys a question for free."""
    control = artifact([record('q', raw=LISTED_DECLINE)])
    treatment = artifact([record('q', correct=None, raw=BARE_DECLINE)], attempted=1, answered=0)

    completed = run(tmp_path, control, treatment)

    assert completed.returncode == 2
    assert 'not a boolean' in completed.stderr


def test_refuses_a_control_with_no_reachable_population(tmp_path: Path) -> None:
    """An empty population is a wrong control far more often than an empty reach."""
    control = artifact([record('q', raw=BARE_DECLINE)])
    treatment = artifact([record('q', raw=BARE_DECLINE)], attempted=0, answered=0)

    completed = run(tmp_path, control, treatment)

    assert completed.returncode == 2
    assert 'no population to reach' in completed.stderr


def test_a_treatment_that_consulted_nothing_is_an_assembly_failure_not_a_reading(tmp_path: Path) -> None:
    """`attempted: 0` against a non-empty population means the pass was not on."""
    control = artifact([record('q', raw=LISTED_DECLINE)])
    treatment = artifact([record('q', raw=BARE_DECLINE)], attempted=0, answered=0)

    completed = run(tmp_path, control, treatment)

    assert completed.returncode == 1
    assert 'assembly failure' in completed.stderr


def test_json_mode_carries_the_same_numbers_as_the_text(tmp_path: Path) -> None:
    """A machine reader and a human reader must not get two different populations."""
    control = artifact([record('q', raw=LISTED_DECLINE)])
    treatment = artifact([record('q', correct=True, answer='blue', raw='blue')], attempted=1, answered=1)

    completed = run(tmp_path, control, treatment, '--json')

    assert completed.returncode == 0, completed.stderr
    body = json.loads(completed.stdout)
    assert body['route'] == 'multi-session'
    assert [entry['questionId'] for entry in body['population']] == ['q']
    assert body['transitions']['population']['bought'] == 1
    assert body['transitions']['population']['sold'] == 0
    assert body['claims'][0]['verdict'] == 'falsified'
