"""The gold-turn cut rate, and the string mask that would have reported zero always-wrong questions.

## Why this section is a tool and not a paragraph

`PREREGISTRATION-TURN-WINDOW-MATCH.md` §3 puts B3 -- "the share of gold turns cut at the cap falls from
13.4% to below 5%" -- ahead of the accuracy criteria, because a window that moves the cut point and does not
raise accuracy means something different from a window that never moved. Until now the only implementation of
that measurement was the script behind `ANALYSIS-AGGREGATION-GAP.md` §2.2, which is exactly the debt
`readout-arm-run.py`'s own header names: *a registered prediction whose input came from a script that was run
once*. `--goldcut` retires it, and these four tests are what makes the retirement real rather than nominal.

## The trap, which the first implementation of this section walked into

`ablation.featureCorrectByRun` is a list of **strings** of `'0'` and `'1'` -- 500 characters each. The obvious
`if mask[i]` reads `'0'` as true, so every question comes out "always right" and the outcome table reports
**0** always-wrong questions on an artifact whose accuracy is 91.2%. That is not a plausible-looking number:
it is the reading that would have let a window claim credit for exactly the questions it is supposed to fix.

So the fixture below carries string masks, and `test_a_string_mask_reads_zero_as_wrong` fails if the reader
ever starts treating the characters as truthy again.

## What the fixture is, and why it is synthetic

The real artifact is 58 MB and is not in this repository. The fixture is four questions whose prompts are
written by hand to produce one of each state -- whole, cut, absent -- because the property to pin is the
classification rule, not a number from one dispatch. The numbers from the baseline run are recorded in the
pre-registration and quoted in the section's own docstring; a test that asserted them would be a test that
cannot run without a 58 MB download.
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
    """Four questions, three states, and masks spelled the way the arms spell them."""
    questions = [
        {
            'questionId': 'q-whole',
            'capability': 'IE',
            'goldOverlap': {'goldTurns': [WHOLE]},
        },
        {
            'questionId': 'q-cut',
            'capability': 'MR',
            # The prompt carries the first 160 characters and nothing after them: a turn cut at a cap whose
            # tail is gone, which is the state the window is supposed to remove.
            'goldOverlap': {'goldTurns': [LONG]},
        },
        {
            'questionId': 'q-absent',
            'capability': 'TR',
            'goldOverlap': {'goldTurns': ['A sentence that appears in no prompt at all, at any length.']},
        },
        {
            'questionId': 'q-second-whole',
            'capability': 'MR',
            'goldOverlap': {'goldTurns': [WHOLE]},
        },
    ]
    prompts = [
        f'EVIDENCE:\n1. {WHOLE}\n\nQUESTION: where?',
        f'EVIDENCE:\n1. {LONG[:160]}\n\nQUESTION: how many?',
        'EVIDENCE:\n1. something else entirely\n\nQUESTION: when?',
        f'EVIDENCE:\n1. {WHOLE}\n\nQUESTION: where again?',
    ]
    # A question is always-wrong when every run missed it: '0' in every mask. Strings, not booleans, because
    # that is what the artifact carries and `'0'` is truthy. Position 1 (`q-cut`) is '0' in all four runs,
    # position 2 (`q-absent`) is mixed, and the two whole ones are '1' throughout.
    feature = ['1001', '1011', '1001', '1011']
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


def test_the_three_states_are_counted_per_capability(tmp_path: Path) -> None:
    completed = run(tmp_path, report(), '--goldcut')
    assert completed.returncode == 0, completed.stderr
    out = completed.stdout
    # `MR` has two gold turns and one of them is cut; `IE` and `TR` have one each, whole and absent.
    assert 'MR' in out and '13.37' not in out
    assert '50.00%' in out, out  # MR: 1 cut of 2
    assert '0.00%' in out, out  # IE: 0 cut of 1


def test_a_turn_cut_at_the_cap_is_not_counted_as_absent(tmp_path: Path) -> None:
    """The distinction the section exists for: a rendering result is not a selection result."""
    completed = run(tmp_path, report(), '--goldcut')
    out = completed.stdout
    # TR's single turn is absent; MR's pair is one whole and one cut, so the TOTAL row is 2 whole, 1 cut, 1 absent.
    total_line = next(line for line in out.splitlines() if line.strip().startswith('TOTAL'))
    numbers = total_line.split()[1:]
    assert numbers == ['4', '2', '1', '1', '25.00%'], total_line


def test_a_string_mask_reads_zero_as_wrong(tmp_path: Path) -> None:
    """`if mask[i]` on `'0'` says every question was always right, and hides the questions at issue."""
    completed = run(tmp_path, report(), '--goldcut')
    out = completed.stdout
    assert 'always wrong' in out, out
    line = next(line for line in out.splitlines() if line.strip().startswith('always wrong'))
    # q-cut is '0' in every one of the four masks; nothing else is.
    assert line.split()[2] == '1', line


def test_an_artifact_without_gold_turns_refuses(tmp_path: Path) -> None:
    """A report that cannot answer the question says so, rather than printing an empty table of zeroes."""
    payload = report()
    payload['questions'] = [{'questionId': 'q', 'capability': 'IE'} for _ in range(4)]
    completed = run(tmp_path, payload, '--goldcut')
    assert completed.returncode == 2, completed.stdout
    assert 'goldOverlap' in completed.stdout, completed.stdout
