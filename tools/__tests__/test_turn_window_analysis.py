#!/usr/bin/env python3
"""Tests for `cortex-docs/evidence/longmemeval/scripts/turn_window_analysis.py`.

## The defect this file is written against

`S10` reads `paired.deltaQuestions` from `turn-window.json`, and the analysis that produces it pairs **two
dispatches** rather than two sides of one pass -- which is the opposite of `S12`'s instrument, where the pair
is inside a single artifact. Two artifacts of one population can be mispaired in ways one artifact cannot:

| mistake | what it publishes |
| --- | --- |
| pairing by position | two questions swapped, and a delta that is the sum of two unrelated differences |
| pairing across different populations | a delta over the intersection, reported as the whole |
| pairing across different readers | every difference attributed to the window |

The first is silent and the third is the one `PREREGISTRATION` §2.2 exists for, so each gets a refusal or an
alignment rule here rather than a comment.

## What the fixture is and is not

Four questions, two repetitions, hand-built. The registered instrument is 500 x 4; every rule under test is
about **shape** -- which key is written, what is refused, how a vector aligns -- and a 500-question fixture
would be slow enough that someone would eventually stop running it.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = (
    REPO.parent / 'cortex-docs' / 'evidence' / 'longmemeval' / 'scripts' / 'turn_window_analysis.py'
)
CANDIDATES = (SCRIPT, REPO / 'cortex-docs' / 'evidence' / 'longmemeval' / 'scripts' / 'turn_window_analysis.py')

IDS = ['q1', 'q2', 'q3', 'q4']


def artifact(
    *,
    bits: list[str],
    window: dict | None = None,
    reader: str = 'deepseek-chat',
    ids: list[str] | None = None,
    shuffle: bool = False,
) -> dict:
    """One dispatch: `runs` repetitions of `bits`, over `ids`, with an optional window census."""
    slots = list(ids if ids is not None else IDS)
    if shuffle:
        slots = [slots[2], slots[0], slots[3], slots[1]]
    return {
        'kind': 'memory-arm',
        'dataset': 'longmemeval',
        'questionCount': len(slots),
        'runs': len(bits),
        'memoryArmConfig': {
            'reader': {'model': reader},
            'judge': {'model': 'deepseek-chat'},
            'maxTurnChars': 400,
        },
        'questions': [{'questionId': qid} for qid in slots],
        'ablation': {
            'baselineCorrectByRun': ['0' * len(slots) for _ in bits],
            'featureCorrectByRun': bits,
        },
        **({} if window is None else {'turnWindow': window}),
    }


def analyse(*pairs: tuple[dict, dict], extra: list[str] | None = None) -> subprocess.CompletedProcess[str]:
    """Run the script on `control`/`treatment` pairs, returning the process with its output."""
    with tempfile.TemporaryDirectory() as scratch:
        paths: list[str] = []
        for index, (control, treatment) in enumerate(pairs):
            for side, document in (('control', control), ('treatment', treatment)):
                path = Path(scratch) / f'{side}-{index}.json'
                path.write_text(json.dumps(document), encoding='utf-8')
                paths.append(str(path))
        return subprocess.run(
            [sys.executable, str(SCRIPT), *paths, *(extra or [])],
            capture_output=True,
            text=True,
            check=False,
        )


def evidence_of(control: dict, treatment: dict, *extra: str) -> dict:
    with tempfile.TemporaryDirectory() as scratch:
        control_path = Path(scratch) / 'control.json'
        treatment_path = Path(scratch) / 'treatment.json'
        target = Path(scratch) / 'out.json'
        control_path.write_text(json.dumps(control), encoding='utf-8')
        treatment_path.write_text(json.dumps(treatment), encoding='utf-8')
        done = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                str(control_path),
                str(treatment_path),
                '--write',
                str(target),
                *extra,
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        assert done.returncode == 0, done.stdout + done.stderr
        assert target.exists(), f'the script reported success but wrote nothing: {done.stdout}'
        return json.loads(target.read_text(encoding='utf-8'))


def test_the_key_s10_reads_is_written_over_the_paired_questions() -> None:
    """`paired.deltaQuestions` is the sum of per-question mean differences, not a difference of totals."""
    control = artifact(bits=['1111', '1111'])
    treatment = artifact(bits=['1011', '1111'])

    evidence = evidence_of(control, treatment, '--run-control', '1', '--run-treatment', '2')

    assert evidence['paired']['n'] == 4
    # One question lost on one of two repetitions: -0.5 in total, which is not -1 and not 0.
    assert evidence['paired']['deltaQuestions'] == -0.5
    assert evidence['mcnemar'] == {'p': 1.0, 'b': 1, 'c': 0}
    assert evidence['sources'] == {'control': '1', 'treatment': '2'}


def test_the_vectors_align_by_question_id_not_by_position() -> None:
    """A shuffled treatment roster is the same population; pairing by index would swap two questions."""
    control = artifact(bits=['1111', '1111'])
    treatment = artifact(bits=['1111', '1111'], shuffle=True)

    evidence = evidence_of(control, treatment)

    assert evidence['paired']['n'] == 4
    assert evidence['paired']['deltaQuestions'] == 0.0


def test_different_populations_are_refused_by_name() -> None:
    """A delta over the intersection, reported as the whole, is the mistake a set comparison prevents."""
    control = artifact(bits=['1111', '1111'])
    treatment = artifact(bits=['111', '111'], ids=['q1', 'q2', 'q3'])

    done = analyse((control, treatment))

    assert done.returncode != 0, done.stdout
    assert 'q4' in done.stderr, 'the refusal has to name the questions that are not on both sides'


def test_different_readers_are_refused() -> None:
    """The window is not the only thing that can differ between two dispatches, and this is the one that
    would make every difference its own."""
    control = artifact(bits=['1111', '1111'])
    treatment = artifact(bits=['1111', '1111'], reader='zhipu:glm-4.6')

    done = analyse((control, treatment))

    assert done.returncode != 0, done.stdout
    assert 'reader' in done.stderr


def test_the_window_census_is_carried_on_both_sides() -> None:
    """`P1` needs both numerators: the control's cut count and the treatment's marked count."""
    control = artifact(bits=['1111'], window={'cut': 3, 'marked': 0, 'whole': 7, 'questions': 4, 'unreported': 0})
    treatment = artifact(bits=['1111'], window={'cut': 0, 'marked': 0, 'whole': 10, 'questions': 4, 'unreported': 0})

    evidence = evidence_of(control, treatment)

    assert evidence['turnWindow']['control'] == {
        'cut': 3,
        'marked': 0,
        'whole': 7,
        'questions': 4,
        'unreported': 0,
    }
    assert evidence['turnWindow']['treatment']['cut'] == 0
    # The control cut three turns and the treatment marked none of them, so the window reached nothing --
    # `0.0`, which is a measurement. The ratio is published beside the counts it came from rather than
    # instead of them, because it is an approximation across two run-level totals (see `reachedBasis`).
    assert evidence['turnWindow']['reached'] == 0.0
    assert 'not an item-level pairing' in evidence['turnWindow']['reachedBasis']


def test_a_control_that_cut_nothing_has_no_reach_ratio() -> None:
    """`0/0` is not a measurement, and a reader must not be able to mistake it for one."""
    control = artifact(bits=['1111'], window={'cut': 0, 'marked': 0, 'whole': 10, 'questions': 4, 'unreported': 0})
    treatment = artifact(bits=['1111'], window={'cut': 0, 'marked': 0, 'whole': 10, 'questions': 4, 'unreported': 0})

    assert evidence_of(control, treatment)['turnWindow']['reached'] is None


def test_a_missing_census_makes_p1_unread_rather_than_zero() -> None:
    """Absent and zero are different facts, and only one of them is a measurement of the mechanism."""
    evidence = evidence_of(artifact(bits=['1111']), artifact(bits=['1111']))

    assert 'turnWindow' not in evidence


def test_repetitions_must_agree_between_the_two_sides() -> None:
    """Two repetitions against four pairs a mean over two against a mean over four, which is not a pair."""
    done = analyse((artifact(bits=['1111', '1111']), artifact(bits=['1111'])))

    assert done.returncode != 0, done.stdout
    assert 'repetition' in done.stderr


def test_the_script_is_where_one_of_the_two_checkouts_puts_it() -> None:
    """The layout this file resolves is the layout CI builds, and a missing script is not a skip."""
    found = next((path for path in CANDIDATES if path.exists()), None)
    assert found is not None, (
        f'turn_window_analysis.py is missing; tried {", ".join(str(path) for path in CANDIDATES)}. '
        'It lives in the sibling repository, checked out at `path: cortex-docs` by '
        '`.github/workflows/verify.yml`.'
    )
