"""B1 and B2 read off prompt digests, and the string `correct` that would have inverted them.

## Why the criteria are read here and not from the report's own summary

`PREREGISTRATION-TURN-WINDOW-MATCH.md` §3 states B1 as *every `MR`/`TR` prompt digest changed* and B2 as *`IE`,
`KU` and `ABS` unchanged*. Both are comparisons **between two dispatches**, so neither can be computed from one
artifact, and the artifact does not carry a field that says whether a prompt moved. `digest-reach.py` is the pair
reader; these tests pin the two ways it can be wrong.

## The trap

`questions[].correct` is the **string** `"True"`/`"False"` in this artifact, so `bool(question['correct'])` is true
for every question -- the same defect `featureCorrectByRun`'s `'0'`/`'1'` characters produced in `--goldcut`. The
digest comparison does not read `correct` at all, but the fixture carries it spelled the artifact's way and
`test_a_string_false_is_not_a_correct_answer` pins the reader against the day it starts to.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "digest-reach.py"


def artifact(rows: list[tuple[str, str, str, str]]) -> dict:
    """One artifact from `(questionId, capability, digest, correct)` rows, spelled as the run spells them."""
    return {
        'questions': [
            {
                'questionId': question_id,
                'capability': capability,
                'route': 'multi-session' if capability == 'MR' else 'flat',
                'promptDigest': digest,
                'promptVariants': 1,
                'deliveredPromptChars': 1000,
                # The string, not a boolean, because that is what the artifact carries.
                'correct': correct,
            }
            for question_id, capability, digest, correct in rows
        ]
    }


def run(tmp_path: Path, before: dict, after: dict) -> subprocess.CompletedProcess:
    first = tmp_path / 'before.json'
    second = tmp_path / 'after.json'
    first.write_text(json.dumps(before))
    second.write_text(json.dumps(after))
    return subprocess.run(
        [sys.executable, str(TOOL), str(first), str(second)],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


def test_a_window_that_reaches_every_question_it_claims_passes_b1(tmp_path: Path) -> None:
    before = artifact([('m1', 'MR', 'aaa', 'False'), ('t1', 'TR', 'ccc', 'True')])
    after = artifact([('m1', 'MR', 'bbb', 'True'), ('t1', 'TR', 'ddd', 'True')])
    completed = run(tmp_path, before, after)
    assert completed.returncode == 0, completed.stderr
    assert 'B1  reached routes with an unchanged prompt: 0' in completed.stdout, completed.stdout


def test_a_reached_route_whose_prompt_did_not_move_fails_b1(tmp_path: Path) -> None:
    """The state that voided run `45100881559`'s predecessor: a window that changed nothing."""
    before = artifact([('m1', 'MR', 'aaa', 'True'), ('t1', 'TR', 'ccc', 'True')])
    after = artifact([('m1', 'MR', 'aaa', 'True'), ('t1', 'TR', 'ddd', 'True')])
    completed = run(tmp_path, before, after)
    assert 'B1  reached routes with an unchanged prompt: 1' in completed.stdout, completed.stdout
    assert 'm1' in completed.stdout, completed.stdout


def test_a_control_route_whose_prompt_moved_fails_b2(tmp_path: Path) -> None:
    before = artifact([('i1', 'IE', 'aaa', 'True'), ('k1', 'KU', 'ccc', 'True')])
    after = artifact([('i1', 'IE', 'bbb', 'True'), ('k1', 'KU', 'ccc', 'True')])
    completed = run(tmp_path, before, after)
    assert 'B2  control routes with a changed prompt:   1' in completed.stdout, completed.stdout
    assert 'i1' in completed.stdout, completed.stdout


def test_a_control_route_that_held_still_passes_b2(tmp_path: Path) -> None:
    before = artifact([('i1', 'IE', 'aaa', 'False'), ('a1', 'ABS', 'eee', 'True')])
    after = artifact([('i1', 'IE', 'aaa', 'True'), ('a1', 'ABS', 'eee', 'True')])
    completed = run(tmp_path, before, after)
    assert 'B2  control routes with a changed prompt:   0' in completed.stdout, completed.stdout


def test_the_capability_table_counts_text_identical_and_moved_prompts_separately(tmp_path: Path) -> None:
    before = artifact([('i1', 'IE', 'aaa', 'True'), ('i2', 'IE', 'bbb', 'True')])
    after = artifact([('i1', 'IE', 'aaa', 'True'), ('i2', 'IE', 'zzz', 'True')])
    completed = run(tmp_path, before, after)
    line = next(row for row in completed.stdout.splitlines() if row.strip().startswith('IE'))
    # n, same, changed, no digest, chars delta
    assert line.split()[:4] == ['IE', '2', '1', '1'], line


def test_a_string_false_is_not_a_correct_answer(tmp_path: Path) -> None:
    """`bool("False")` is true. The digest reader must not be the next place that reads it that way."""
    before = artifact([('m1', 'MR', 'aaa', 'False')])
    after = artifact([('m1', 'MR', 'aaa', 'False')])
    completed = run(tmp_path, before, after)
    # The prompt did not move, so B1 reports it; nothing in either line claims the answer was correct.
    assert 'correct' not in completed.stdout.lower(), completed.stdout
    assert 'B1  reached routes with an unchanged prompt: 1' in completed.stdout, completed.stdout
