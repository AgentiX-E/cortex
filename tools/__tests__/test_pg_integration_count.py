#!/usr/bin/env python3
"""Tests for `tools/pg-integration-count.mjs` -- the check that refuses a skipped suite.

## The defect this file is written against

The PostgreSQL integration suite is conditional: `CORTEX_PG_URL` unset means `describe.skip`, and
`vitest run` exits **0** for a file whose only `describe` was skipped. So the failure mode of the CI
job that runs it is not a red build. It is a green build that connected to nothing -- the same shape
as the defect `verify.yml` was written to fix, one level down: a check that reports success without
executing.

`pg-integration-count.mjs` is what closes that, which makes it a gate. A gate that has only ever
been observed passing is indistinguishable from one whose thresholds are wrong, so every refusal it
claims to make is exercised here against a synthetic report:

| Report | Must refuse because |
| --- | --- |
| no tests at all | the suite took its skip branch |
| one pending | a conditional block skipped one assertion beside the others |
| one fewer than the floor | assertions were deleted |
| a failing assertion | it failed |
| no file, or not JSON | there is no reading, which is not a pass |

The floor in the tool is a constant on purpose, and `test_the_floor_matches_the_suite` compares it
with the number of `it(` blocks in the real suite. Without that comparison the constant could fall
behind the suite and start accepting a run with half the assertions -- and the check would still say
"floor 30" while 30 was no longer what the suite contains.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'pg-integration-count.mjs'
SUITE = REPO / 'packages' / 'cortex-storage' / 'test' / 'pg' / 'integration.test.ts'


def floor() -> int:
    """The tool's own lower bound, read rather than repeated.

    Hard-coding 30 here is how this file broke the first time the suite grew: the constant in the
    tool moved to 31 and the fixture stayed at 30, so the "a full green report passes" case started
    failing for a reason unrelated to the assertion it names.
    """
    match = re.search(r'const FLOOR = (\d+);', TOOL.read_text(encoding='utf-8'))
    assert match is not None, 'no FLOOR constant in the tool'
    return int(match.group(1))


def run(path: Path | str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['node', str(TOOL), str(path)],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=60,
    )


def report(tmp_path: Path, name: str, *, total: int, passed: int, failed: int = 0,
           pending: int = 0, todo: int = 0, success: bool = True) -> Path:
    payload = {
        'numTotalTests': total,
        'numPassedTests': passed,
        'numFailedTests': failed,
        'numPendingTests': pending,
        'numTodoTests': todo,
        'success': success,
        'testResults': [],
    }
    path = tmp_path / name
    path.write_text(json.dumps(payload), encoding='utf-8')
    return path


class TestTheGateAcceptsARealRun:
    def test_a_full_green_report_passes(self, tmp_path: Path) -> None:
        bound = floor()
        result = run(report(tmp_path, 'ok.json', total=bound, passed=bound))
        assert result.returncode == 0, result.stderr
        assert f'{bound}/{bound}' in result.stdout
        assert '0 skipped' in result.stdout


class TestTheGateRefuses:
    def test_an_empty_report_is_a_skip_not_a_pass(self, tmp_path: Path) -> None:
        result = run(report(tmp_path, 'empty.json', total=0, passed=0))
        assert result.returncode == 1
        assert 'no tests at all' in result.stderr
        assert 'skip branch' in result.stderr

    def test_a_pending_assertion_is_refused(self, tmp_path: Path) -> None:
        result = run(report(tmp_path, 'pending.json', total=floor(), passed=floor() - 1, pending=1))
        assert result.returncode == 1
        assert '1 pending' in result.stderr

    def test_a_todo_is_refused(self, tmp_path: Path) -> None:
        result = run(report(tmp_path, 'todo.json', total=floor(), passed=floor() - 1, todo=1))
        assert result.returncode == 1
        assert 'todo' in result.stderr

    def test_a_short_count_is_refused(self, tmp_path: Path) -> None:
        result = run(report(tmp_path, 'short.json', total=floor() - 1, passed=floor() - 1))
        assert result.returncode == 1
        assert 'the floor is' in result.stderr

    def test_a_failure_is_refused(self, tmp_path: Path) -> None:
        result = run(report(tmp_path, 'failed.json', total=floor(), passed=floor() - 1,
                           failed=1, success=False))
        assert result.returncode == 1
        assert '1 assertions failed' in result.stderr

    def test_a_missing_report_is_refused(self, tmp_path: Path) -> None:
        result = run(tmp_path / 'absent.json')
        assert result.returncode == 1
        assert 'cannot read' in result.stderr

    def test_a_report_that_is_not_json_is_refused(self, tmp_path: Path) -> None:
        path = tmp_path / 'broken.json'
        path.write_text('{ not json', encoding='utf-8')
        result = run(path)
        assert result.returncode == 1
        assert 'cannot read' in result.stderr


class TestTheFloorTracksTheSuite:
    def test_the_floor_matches_the_suite(self) -> None:
        """The constant in the tool must equal the number of `it(` blocks in the real suite.

        A floor that is lower than the suite accepts a run where assertions were removed; a floor
        that is higher refuses a correct run forever. Both are silent, so the equality is asserted
        rather than maintained by memory.
        """
        tool = TOOL.read_text(encoding='utf-8')
        match = re.search(r'const FLOOR = (\d+);', tool)
        assert match is not None, 'no FLOOR constant found: the check has no lower bound'
        floor = int(match.group(1))

        suite = SUITE.read_text(encoding='utf-8')
        # `it(` at the start of a statement; `expect(` is counted nowhere and `it` inside a comment
        # would have to be written as a line starting with `it(` to be miscounted.
        assertions = len(re.findall(r'^\s{4}it\(', suite, flags=re.MULTILINE))
        assert assertions > 0, 'the suite has no assertions to count'
        assert floor == assertions, (
            f'FLOOR is {floor} but {SUITE.name} declares {assertions} assertions. '
            'Raise the constant in the same commit that grows the suite.'
        )

    def test_the_suite_cleans_up_before_it_asserts(self) -> None:
        """A suite that deletes at the end leaves rows behind when it dies halfway.

        The deletion has to be in `beforeAll`, because the run that fails is precisely the one that
        never reaches an `afterAll`.
        """
        suite = SUITE.read_text(encoding='utf-8')
        before = suite.index('beforeAll(')
        delete = suite.index('DELETE FROM cortex_kv')
        assert before < delete < suite.index('afterAll('), (
            'the DELETE must run in beforeAll: a cleanup at the end never runs after a failure'
        )
