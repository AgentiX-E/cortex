"""Tests for tools/judge-agreement.py -- the per-question half of a two-judge comparison.

## What this file protects

`judge-cross-vendor.mjs` compares two deltas and prints a verdict from the gap between them. The gap
is a difference of differences: 2 questions, in the reading this was written for. A gap of 2 is
compatible with two judges that reject **the same** questions and with two judges that reject
disjoint questions, and those two worlds support different claims about the artifact -- in the first,
the artifact accepted 11 answers that are wrong by two independent instruments; in the second, it
accepted 11 answers that one model dislikes.

So the overlap table is a different quantity, not a finer version of the same one, and its cells have
to be counted rather than inferred from the marginals. These tests construct vectors whose cells are
known by hand, including the two that a naive implementation gets wrong: a shadowed question id (which
would double-count) and a population mismatch (which would silently pair by intersection).
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'judge-agreement.py'


def vector(rows: list[tuple[str, bool, list[bool]]]) -> list[dict[str, object]]:
    """`(id, recorded, verdicts)` triples as the vector `judge-regrade.mjs --verdicts` writes."""
    return [
        {'questionId': question, 'recorded': recorded, 'verdicts': verdicts}
        for question, recorded, verdicts in rows
    ]


def write(tmp_path: Path, name: str, rows: list[tuple[str, bool, list[bool]]]) -> Path:
    path = tmp_path / f'{name}.json'
    path.write_text(json.dumps(vector(rows)), encoding='utf-8')
    return path


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['python3', str(TOOL), *args], capture_output=True, text=True, cwd=REPO, timeout=60
    )


def test_the_four_cells_are_counted_by_hand(tmp_path: Path) -> None:
    """Eight questions, four of which the artifact accepted and the judges disagree about in every way.

    `q1` both revoke, `q2` only A, `q3` only B, `q4` both accept. The other four the artifact rejected
    and both judges accept -- the *rescue* direction, which no delta table shows.
    """
    a = write(
        tmp_path,
        'a',
        [
            ('q1', True, [False, False]),
            ('q2', True, [False, False]),
            ('q3', True, [True, True]),
            ('q4', True, [True, True]),
            ('q5', False, [True, True]),
            ('q6', False, [True, True]),
            ('q7', False, [True, True]),
            ('q8', False, [True, True]),
        ],
    )
    b = write(
        tmp_path,
        'b',
        [
            ('q1', True, [False, False]),
            ('q2', True, [True, True]),
            ('q3', True, [False, False]),
            ('q4', True, [True, True]),
            ('q5', False, [True, True]),
            ('q6', False, [True, True]),
            ('q7', False, [True, True]),
            ('q8', False, [True, True]),
        ],
    )
    out = tmp_path / 'table.json'
    result = run('--a', str(a), '--b', str(b), '--write', str(out), '--run-a', '1', '--run-b', '2')
    assert result.returncode == 0, result.stdout + result.stderr
    table = json.loads(out.read_text(encoding='utf-8'))
    assert table['judged'] == 8
    assert table['recordedCorrect'] == 4
    assert table['both'] == 1
    assert table['aOnly'] == 1
    assert table['bOnly'] == 1
    assert table['union'] == 3
    # Four questions the artifact called wrong and both judges accept: the direction a delta of two
    # numbers cannot show at all.
    assert table['rescued'] == 4
    assert table['judgeDisagreement'] == 2
    assert table['bothIds'] == ['q1']


def test_a_tie_counts_as_rejected_not_accepted(tmp_path: Path) -> None:
    """1-1 is not a win for either side, and a two-pass reading must not manufacture agreement."""
    a = write(tmp_path, 'a', [('q1', True, [True, False])])
    b = write(tmp_path, 'b', [('q1', True, [False, False])])
    result = run('--a', str(a), '--b', str(b))
    assert result.returncode == 0, result.stdout + result.stderr
    # A's tie is `false`, so A revokes and B revokes: both.
    assert 'both judges            1' in result.stdout


def test_two_populations_are_refused_rather_than_intersected(tmp_path: Path) -> None:
    """The questions one reading could not grade are the ones a disagreement is most likely about."""
    a = write(tmp_path, 'a', [('q1', True, [False]), ('q2', True, [True])])
    b = write(tmp_path, 'b', [('q1', True, [False])])
    result = run('--a', str(a), '--b', str(b))
    assert result.returncode == 1
    assert 'not over the same population' in result.stderr
    assert "'q2'" in result.stderr


def test_a_repeated_question_id_is_refused(tmp_path: Path) -> None:
    """A repeated id means the vector is not one verdict per question."""
    a = write(tmp_path, 'a', [('q1', True, [False]), ('q1', True, [True])])
    b = write(tmp_path, 'b', [('q1', True, [False])])
    result = run('--a', str(a), '--b', str(b))
    assert result.returncode == 1
    assert 'twice' in result.stderr


def test_a_missing_recorded_side_is_refused(tmp_path: Path) -> None:
    """Without the artifact's own verdict there is no direction: revoke and rescue are indistinguishable."""
    a = tmp_path / 'a.json'
    a.write_text(json.dumps([{'questionId': 'q1', 'verdicts': [False]}]), encoding='utf-8')
    b = write(tmp_path, 'b', [('q1', True, [False])])
    result = run('--a', str(a), '--b', str(b))
    assert result.returncode == 1
    assert 'does not record what the artifact said' in result.stderr


def test_write_without_both_run_ids_is_refused(tmp_path: Path) -> None:
    """An evidence file has to state where it came from -- two readings means two runs."""
    a = write(tmp_path, 'a', [('q1', True, [False])])
    b = write(tmp_path, 'b', [('q1', True, [False])])
    result = run('--a', str(a), '--b', str(b), '--write', str(tmp_path / 't.json'), '--run-a', '1')
    assert result.returncode == 1
    assert '--run-a and --run-b' in result.stderr
    assert not (tmp_path / 't.json').exists()


def test_an_empty_vector_is_not_a_table(tmp_path: Path) -> None:
    """Zero questions has no agreement rate, and a rate of zero would read as perfect disagreement."""
    a = write(tmp_path, 'a', [('q1', True, [False])])
    b = tmp_path / 'b.json'
    b.write_text('[]', encoding='utf-8')
    result = run('--a', str(a), '--b', str(b))
    assert result.returncode == 1
    assert 'not over the same population' in result.stderr
