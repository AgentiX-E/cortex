"""What the prompt did to each gold turn, and the two defects a first implementation of it carried.

## Why this section is a tool and not a paragraph

`PREREGISTRATION-TURN-WINDOW-MATCH.md` §3 puts B3 ahead of the accuracy criteria, because a window that moves the
cut point and does not raise accuracy means something different from a window that never moved. Until this
section existed the only implementation of that measurement was the script behind `ANALYSIS-AGGREGATION-GAP.md`
§2.2 -- exactly the debt `readout-arm-run.py`'s own header names: *a registered prediction whose input came from a
script that was run once*. `--goldcut` retires it.

## Defect one: `'0'` is truthy

`ablation.featureCorrectByRun` is a list of **strings** of `'0'` and `'1'` -- 500 characters each. The obvious
`if mask[i]` reads `'0'` as true, so every question comes out "always right" and the outcome table reports **0**
always-wrong questions on an artifact whose accuracy is 91.2%. That is not a plausible-looking number: it is the
reading that would have let a window claim credit for exactly the questions it is supposed to fix. So the fixture
carries string masks and `test_a_string_mask_reads_zero_as_wrong` fails if the reader ever treats them as truthy.

## Defect two: a prefix test cannot see a middle slice, and B3 was measured with one

The first classifier asked whether the prompt still held the **beginning** of the turn, and answered `cut` when
the head was there and the tail was not. That is correct for `turnWindow: 'head'`, which truncates from the right.

Run `45100881559` dispatched `turnWindow: 'match'`, which keeps a slice **around the question's densest match** and
drops both ends. Under that window a truncated gold turn has no head, so the classifier scored it `absent` -- the
bucket reserved for a turn the prompt never carried, which is a *selection* result. On `MR` it read `cut`
245 -> 109 and `absent` 30 -> 164, and the criterion's rate fell 13.37% -> 5.95% **with nothing recovered at all**:
`whole` went 1557 -> 1559.

That is the worst failure a measurement can have in this repository's terms: a number moved because the classifier
changed which bucket a turn fell into, and the number was the one a pre-registered criterion was written against.
The fix is not a new threshold -- it is to ask the question that does not depend on *where* the kept slice is,
which is what `whole` / `partial` / `absent` does. `test_a_middle_slice_is_partial_and_not_absent` is the guard:
under the old rule it is `absent`, under the new one it is `partial`, and the baseline's own counts are unchanged
by the fix (its truncations all keep the head, so they were and remain `partial`).

## What the fixture is, and why it is synthetic

The real artifact is 60 MB and is not in this repository. The fixture is five questions whose prompts are written
by hand to reach one state each, because the property to pin is the classification rule, not a number from one
dispatch. The dispatched numbers are recorded in the pre-registration and quoted above; a test that asserted them
would be a test that cannot run without a 60 MB download.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "readout-arm-run.py"

WHOLE = 'I moved to Porto in January and have been working from the bakery since then. '
LONG = (
    'We adopted a second cat in March, and the vet said the two of them need separate feeding stations '
    'because the older one eats too fast and the younger one will not defend her bowl at all, which is '
    'why the kitchen now has two of everything and the hallway has a third for the water.'
)


def report() -> dict:
    """Five questions covering every state the classifier can reach."""
    questions = [
        {
            'questionId': 'q-whole',
            'capability': 'IE',
            'goldOverlap': {'goldTurns': [WHOLE]},
        },
        {
            'questionId': 'q-head-cut',
            'capability': 'MR',
            # The prompt carries the first 160 characters and nothing after them: a turn truncated from the
            # right, which is the state `turnWindow: 'head'` produces.
            'goldOverlap': {'goldTurns': [LONG]},
        },
        {
            'questionId': 'q-middle-slice',
            'capability': 'MR',
            # The head is **gone** and a middle stretch is present -- the state `turnWindow: 'match'` produces,
            # and the one the prefix test called "the prompt never carried this turn".
            'goldOverlap': {'goldTurns': [LONG]},
        },
        {
            'questionId': 'q-absent',
            'capability': 'TR',
            'goldOverlap': {'goldTurns': ['A sentence that appears in no prompt at all, at any length.']},
        },
        {
            'questionId': 'q-short-fragment',
            'capability': 'KU',
            # Fifty characters of the turn, well under the 120-character floor: near-accidental overlap, and
            # counting it as carried would make the table report delivery it never observed.
            'goldOverlap': {'goldTurns': [LONG]},
        },
    ]
    prompts = [
        f'EVIDENCE:\n1. {WHOLE}\n\nQUESTION: where?',
        f'EVIDENCE:\n1. {LONG[:160]}\n\nQUESTION: how many?',
        f'EVIDENCE:\n1. \u2026{LONG[100:260]}\u2026\n\nQUESTION: how many again?',
        'EVIDENCE:\n1. something else entirely\n\nQUESTION: when?',
        f'EVIDENCE:\n1. {LONG[10:60]}\n\nQUESTION: which one?',
    ]
    # A question is always-wrong when every run missed it: '0' in every mask. Strings, not booleans, because
    # that is what the artifact carries and `'0'` is truthy. Position 1 (`q-head-cut`) is '0' in all four runs,
    # position 2 (`q-middle-slice`) is mixed, and the rest are '1' throughout.
    feature = ['10111', '10011', '10111', '10111']
    return {
        'dataset': 'fixture',
        'questionCount': len(questions),
        'questions': questions,
        'ablation': {'featurePromptTexts': prompts, 'featureCorrectByRun': feature},
    }


def run(tmp_path: Path, payload: dict, *args: str) -> subprocess.CompletedProcess:
    path = tmp_path / 'report.json'
    path.write_text(json.dumps(payload))
    return subprocess.run(
        [sys.executable, str(TOOL), *args, str(path)],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )


def row(out: str, name: str) -> list[str]:
    """One printed row's numeric cells, whitespace-split. The table is fixed-width, so this is exact."""
    line = next(line for line in out.splitlines() if line.strip().startswith(name))
    return line.split()[1:]


def test_the_three_states_are_counted_per_capability(tmp_path: Path) -> None:
    completed = run(tmp_path, report(), '--goldcut')
    assert completed.returncode == 0, completed.stderr
    out = completed.stdout
    # gold, whole, partial, absent, whole%
    assert row(out, 'MR') == ['2', '0', '2', '0', '0.00%'], out
    assert row(out, 'IE') == ['1', '1', '0', '0', '100.00%'], out
    assert row(out, 'TR') == ['1', '0', '0', '1', '0.00%'], out


def test_a_middle_slice_is_partial_and_not_absent(tmp_path: Path) -> None:
    """The defect run `45100881559` exposed: a prefix test scores every `match` truncation as never carried."""
    completed = run(tmp_path, report(), '--goldcut')
    out = completed.stdout
    # MR holds the two truncations and both are carried in part, one at the head and one in the middle. Under
    # the prefix rule the second is `absent`, which is how a 56% "improvement" was read off a run that
    # recovered two gold turns.
    assert row(out, 'MR')[2] == '2', out


def test_a_fragment_under_the_floor_is_absent(tmp_path: Path) -> None:
    """Fifty characters of a long turn is not delivery, and the floor is what says so."""
    completed = run(tmp_path, report(), '--goldcut')
    assert row(completed.stdout, 'KU') == ['1', '0', '0', '1', '0.00%'], completed.stdout


def test_the_whole_carried_rate_is_the_headline_number(tmp_path: Path) -> None:
    """`whole%` is the quantity a window change is supposed to raise; the other two columns qualify it."""
    completed = run(tmp_path, report(), '--goldcut')
    total = row(completed.stdout, 'TOTAL')
    assert total == ['5', '1', '2', '2', '20.00%'], total


def test_a_string_mask_reads_zero_as_wrong(tmp_path: Path) -> None:
    """`if mask[i]` on `'0'` says every question was always right, and hides the questions at issue."""
    completed = run(tmp_path, report(), '--goldcut')
    out = completed.stdout
    assert 'always wrong' in out, out
    line = next(line for line in out.splitlines() if line.strip().startswith('always wrong'))
    # q-head-cut is '0' in every one of the four masks; nothing else is.
    assert line.split()[2] == '1', line


def test_an_artifact_without_gold_turns_refuses(tmp_path: Path) -> None:
    """A report that cannot answer the question says so, rather than printing an empty table of zeroes."""
    payload = report()
    payload['questions'] = [{'questionId': 'q', 'capability': 'IE'} for _ in range(4)]
    # Prompts trimmed to match: the shape check fires first otherwise, and this test is about the other refusal.
    payload['ablation']['featurePromptTexts'] = payload['ablation']['featurePromptTexts'][:4]
    completed = run(tmp_path, payload, '--goldcut')
    assert completed.returncode == 2, completed.stdout
    assert 'goldOverlap' in completed.stdout, completed.stdout
