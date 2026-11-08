"""Tests for tools/coverage-per-file.mjs — the gate that refuses a package mean.

## What this file protects

The four `thresholds` blocks in the packages' `vitest.config.ts` files compare against the **package
mean**, so a single file at 86% disappears into a 98% average. The first run of the tool this file
tests found sixteen such files. Every test below is one of the four ways that can go wrong, built
as a real miniature repository on disk and run through the real entry point — no monkeypatching of
the tool's internals, because the thing worth testing is what a pipeline sees: an exit code and a
sentence.

## The failure modes worth pinning

  * **A file under the floor must fail, and the message must name it.** A gate whose output is
    "coverage below threshold" sends the reader to a 40-row table to find which row. The key and the
    dimension are asserted verbatim.
  * **95 is not enough; the ratchet is what closes the last five points.** `99/100` clears the floor
    and still has to fail against a recorded `100/100`. Without that rule, every repair is free to
    be undone by the next commit that touches the file, which is exactly how a file sits at 92 for
    a year.
  * **`0/0` must not read as a pass.** A barrel of `export … from` produces an entry with no
    statements, and every reporter prints it as 100%. It is legitimate — and it is indistinguishable
    in the report from a file the instrumenter silently failed on, which is why the record carries
    the kind rather than the file merely being absent.
  * **Absence must fail.** `cortex-core` once reported one file while `src/` held forty-one, and the
    mean over that report was 100.00 on all four dimensions. A missing file is not covered or
    uncovered; it is unmeasured, and unmeasured cannot fail a threshold.
  * **Writing the baseline must not be a laundering step.** Recording today's debt is allowed and is
    how a gate lands green on day one; doing it silently is not. Both refusals are asserted, and so
    is the fact that the record holds counts rather than percentages — two roundings of two
    different rationals compare differently depending on a decimal place nobody printed.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
GATE = REPO / 'tools' / 'coverage-per-file.mjs'


def entry(path: str, statements: list[tuple[int, int]], functions: dict[int, int] | None = None,
          branches: dict[int, list[int]] | None = None) -> dict:
    """One istanbul-shaped file entry, with the minimum a v8 report carries.

    `statements` is a list of `(line, hits)` rather than a mapping, because two statements can
    start on one line — `a; b` or `if (x) go()` on a single line — and a dict keyed by line would
    silently keep only the last. The line rule is exactly the case that distinction decides.
    """
    statement_map = {
        str(index): {'start': {'line': line, 'column': 0}, 'end': {'line': line, 'column': 10}}
        for index, (line, _) in enumerate(statements)
    }
    fn_map = {
        str(index): {'name': f'fn{index}', 'loc': {'start': {'line': 1, 'column': 0}, 'end': {'line': 1, 'column': 1}}}
        for index in (functions or {})
    }
    branch_map = {
        str(index): {
            'type': 'if',
            'loc': {'start': {'line': 1, 'column': 0}, 'end': {'line': 1, 'column': 1}},
            'locations': [{'start': {'line': 1, 'column': 0}, 'end': {'line': 1, 'column': 1}} for _ in arms],
        }
        for index, arms in (branches or {}).items()
    }
    return {
        'path': path,
        'statementMap': statement_map,
        'fnMap': fn_map,
        'branchMap': branch_map,
        's': {str(index): hits for index, (_, hits) in enumerate(statements)},
        'f': {str(index): hits for index, hits in enumerate((functions or {}).values())},
        'b': {str(index): arms for index, arms in enumerate((branches or {}).values())},
    }


def build(root: Path, files: dict[str, dict], sources: list[str] | None = None) -> Path:
    """A miniature repository: one package, one report, and the sources the report is about."""
    package = root / 'packages' / 'demo'
    (package / 'src').mkdir(parents=True, exist_ok=True)
    (package / 'coverage').mkdir(parents=True, exist_ok=True)
    (package / 'vitest.config.ts').write_text('export default {};\n')
    for name in (sources if sources is not None else [f'src/{Path(key).name}' for key in files]):
        path = package / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('export const x = 1;\n')
    report = {}
    for key, value in files.items():
        report[str(package / key)] = value
    (package / 'coverage' / 'coverage-final.json').write_text(json.dumps(report))
    return package


def run(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['node', str(GATE), '--root', str(root), *args],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=120,
    )


def baseline(root: Path, exempt: dict | None = None, files: dict | None = None) -> None:
    (root / 'tools').mkdir(parents=True, exist_ok=True)
    (root / 'tools' / 'coverage-per-file-baseline.json').write_text(
        json.dumps({'policy': {'floor': 95, 'dimensions': ['statements', 'branches', 'functions', 'lines']},
                    'exempt': exempt or {}, 'files': files or {}}, indent=2)
    )


CLEAN = {'src/clean.ts': entry('src/clean.ts', [(1, 1), (2, 1)], {0: 1}, {0: [1, 1]})}


def test_a_clean_package_passes(tmp_path: Path) -> None:
    build(tmp_path, CLEAN)
    result = run(tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'ok: 1 files gated on 4 dimensions' in result.stdout


def test_a_file_under_the_floor_fails_and_the_message_names_it(tmp_path: Path) -> None:
    build(tmp_path, {'src/thin.ts': entry('src/thin.ts', [(1, 1), (2, 1), (3, 1), (4, 0)], {0: 1}, {0: [1, 0]})})
    result = run(tmp_path)
    assert result.returncode == 1
    assert 'demo/src/thin.ts branches: 1/2 (50.00%) is below the 95% floor' in result.stdout
    assert 'demo/src/thin.ts statements: 3/4 (75.00%) is below the 95% floor' in result.stdout


def test_the_ratchet_refuses_a_file_that_only_fell_below_its_own_record(tmp_path: Path) -> None:
    """99 of 100 statements clears the floor, and still has to fail against a recorded 100/100."""
    build(tmp_path, {'src/clean.ts': entry('src/clean.ts', [(index, 1) for index in range(100)], {0: 1}, {0: [1]})})
    baseline(
        tmp_path,
        files={
            'demo/src/clean.ts': {
                'statements': [100, 100],
                'branches': [1, 1],
                'functions': [1, 1],
                'lines': [1, 1],
            }
        },
    )
    green = run(tmp_path)
    assert green.returncode == 0, green.stdout + green.stderr

    dropped = entry('src/clean.ts', [(index, 1) for index in range(99)] + [(99, 0)], {0: 1}, {0: [1]})
    build(tmp_path, {'src/clean.ts': dropped})
    result = run(tmp_path)
    assert result.returncode == 1
    assert 'demo/src/clean.ts statements: 99/100 (99.00%) is below the recorded 100/100' in result.stdout


def test_a_zero_by_zero_entry_is_not_a_pass(tmp_path: Path) -> None:
    build(tmp_path, {'src/barrel.ts': entry('src/barrel.ts', {})})
    result = run(tmp_path)
    assert result.returncode == 1
    assert 'demo/src/barrel.ts: 0 statements, 0 branches, 0 functions, 0 lines' in result.stdout
    assert 'and not recorded as nothing-to-execute' in result.stdout

    baseline(tmp_path, exempt={'demo/src/barrel.ts': {'kind': 'nothing-to-execute', 'reason': 're-exports only'}})
    assert run(tmp_path).returncode == 0


def test_a_source_file_missing_from_the_report_fails(tmp_path: Path) -> None:
    build(tmp_path, CLEAN, sources=['src/clean.ts', 'src/unmeasured.ts'])
    result = run(tmp_path)
    assert result.returncode == 1
    assert 'demo/src/unmeasured.ts: absent from the report and not recorded as not-instrumented' in result.stdout

    baseline(tmp_path, exempt={'demo/src/unmeasured.ts': {'kind': 'not-instrumented', 'reason': 'browser-only'}})
    assert run(tmp_path).returncode == 0


def test_an_exemption_that_outlived_its_cause_fails(tmp_path: Path) -> None:
    build(tmp_path, CLEAN)
    baseline(tmp_path, exempt={'demo/src/clean.ts': {'kind': 'nothing-to-execute', 'reason': 'was a barrel'}})
    result = run(tmp_path)
    assert result.returncode == 1
    assert 'demo/src/clean.ts: exempt as nothing-to-execute but the report now carries 2 statements' in result.stdout


def test_an_exemption_for_a_file_that_no_longer_exists_fails(tmp_path: Path) -> None:
    build(tmp_path, CLEAN)
    baseline(tmp_path, exempt={'demo/src/gone.ts': {'kind': 'not-instrumented', 'reason': 'deleted last month'}})
    result = run(tmp_path)
    assert result.returncode == 1
    assert 'demo/src/gone.ts: recorded as not-instrumented but no such source file exists' in result.stdout


def test_an_untyped_exemption_is_refused(tmp_path: Path) -> None:
    """A bare string cannot say which of the two absences it is excusing."""
    build(tmp_path, CLEAN)
    baseline(tmp_path, exempt={'demo/src/clean.ts': 'declarations only'})
    result = run(tmp_path)
    assert result.returncode == 2
    assert 'needs {kind, reason}' in result.stderr


def test_a_missing_report_fails_rather_than_measuring_nothing(tmp_path: Path) -> None:
    build(tmp_path, CLEAN)
    (tmp_path / 'packages' / 'demo' / 'coverage' / 'coverage-final.json').unlink()
    result = run(tmp_path)
    assert result.returncode == 1
    assert 'demo: no report at packages/demo/coverage/coverage-final.json' in result.stdout


def test_write_baseline_refuses_new_debt_and_records_it_when_told(tmp_path: Path) -> None:
    build(tmp_path, {'src/thin.ts': entry('src/thin.ts', [(1, 1), (2, 1), (3, 1), (4, 0)], {0: 1}, {0: [1, 0]})})
    refused = run(tmp_path, '--write-baseline')
    assert refused.returncode == 2
    assert 'refusing to record new debt without --accept-debt' in refused.stderr
    assert 'demo/src/thin.ts' in refused.stdout

    accepted = run(tmp_path, '--write-baseline', '--accept-debt')
    assert accepted.returncode == 0, accepted.stdout + accepted.stderr
    recorded = json.loads((tmp_path / 'tools' / 'coverage-per-file-baseline.json').read_text())
    assert recorded['files']['demo/src/thin.ts'] == {
        'statements': [3, 4],
        'branches': [1, 2],
        'functions': [1, 1],
        'lines': [3, 4],
    }
    assert run(tmp_path).returncode == 0, 'a recorded debt is ratcheted, not a violation'


def test_write_baseline_refuses_to_lower_a_recorded_rate(tmp_path: Path) -> None:
    build(tmp_path, {'src/clean.ts': entry('src/clean.ts', [(1, 1), (2, 0)], {0: 1}, {0: [1]})})
    baseline(
        tmp_path,
        files={
            'demo/src/clean.ts': {
                'statements': [2, 2],
                'branches': [1, 1],
                'functions': [1, 1],
                'lines': [2, 2],
            }
        },
    )
    refused = run(tmp_path, '--write-baseline')
    assert refused.returncode == 2
    assert 'refusing to lower a recorded rate without --allow-lower' in refused.stderr
    assert 'demo/src/clean.ts statements: 100.00% -> 50.00%' in refused.stdout

    allowed = run(tmp_path, '--write-baseline', '--allow-lower')
    assert allowed.returncode == 0, allowed.stdout + allowed.stderr
    recorded = json.loads((tmp_path / 'tools' / 'coverage-per-file-baseline.json').read_text())
    assert recorded['files']['demo/src/clean.ts']['statements'] == [1, 2]


def test_the_counts_are_statements_functions_branch_arms_and_distinct_lines(tmp_path: Path) -> None:
    """The arithmetic, read back through the record rather than asserted on internals.

    One line carrying two statements where only one ran must count as one covered line of one: the
    line rule is "any statement on it executed", and a naive count of statements would report the
    line as half covered or the total as two lines. The branch point has two arms with one taken,
    which is `[1, 2]` — not one branch point, not two covered.
    """
    build(
        tmp_path,
        {
            'src/shape.ts': entry(
                'src/shape.ts',
                [(1, 1), (1, 0), (4, 1), (9, 0)],
                {0: 3, 1: 0},
                {0: [1, 0], 1: [2, 2, 0]},
            )
        },
    )
    assert run(tmp_path, '--write-baseline', '--accept-debt').returncode == 0
    recorded = json.loads((tmp_path / 'tools' / 'coverage-per-file-baseline.json').read_text())
    assert recorded['files']['demo/src/shape.ts'] == {
        'statements': [2, 4],
        'branches': [3, 5],
        'functions': [1, 2],
        'lines': [2, 3],
    }
