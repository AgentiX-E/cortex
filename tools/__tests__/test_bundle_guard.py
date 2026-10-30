"""Tests for tools/bundle-guard.mjs — what a consumer's bundler does with the published subpaths.

## What this file protects

The entry guard (`test_entry_guard.py`) walks sources and answers "can this reach a native module".
It cannot see three things that only exist after a build: whether `exports` points at a file that was
actually emitted, whether a **browser** bundle of that entry succeeds, and what the user pays in
gzipped bytes. All three are properties of the published artefact, and all three are invisible to a
unit test that imports `src/`.

## The failure modes worth pinning

  * **The guard must be able to say no.** A guard that only ever prints PASS is a log line. The
    over-budget case is tested by shrinking the recorded baseline, which is exactly the regression a
    new dependency would cause.
  * **An unclassified subpath must fail.** The platform of each entry is data in the tool, so a new
    backend cannot arrive without someone deciding whether it belongs in a browser. The alternative --
    inferring the platform from whether the browser build happens to succeed -- would turn a genuine
    portability regression into a *silent reclassification*.
  * **The worker finding must reach the output.** `./opfs` references `./opfs-worker.js` through
    `new URL(..., import.meta.url)`, and esbuild does not emit it. That is the fact the package's
    docstring denied for several iterations, and the one `test/browser/bundle-probe.mjs` then turned
    into an empty error message. If this line ever disappears from the report, the next reader of a
    green run learns nothing about the deployment problem.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
GUARD = REPO / 'tools' / 'bundle-guard.mjs'
BASELINE = REPO / 'tools' / 'bundle-guard-baseline.json'
PACKAGE = REPO / 'packages' / 'cortex-storage'


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['node', str(GUARD), *args],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=300,
    )


def test_the_published_package_bundles_for_every_declared_platform() -> None:
    result = run()
    assert result.returncode == 0, result.stdout + result.stderr
    # Every subpath in `exports` appears, bucketed by platform, with a byte count.
    for subpath in ('.', './idb', './opfs', './opfs/worker', './pg', './sqlite'):
        assert subpath in result.stdout, subpath
    assert 'browser' in result.stdout and 'node' in result.stdout
    # The root is deliberately empty; a byte count that grew here would mean a backend re-export.
    assert 'no baseline' not in result.stdout
    assert result.stdout.rstrip().endswith('PASS')


def test_the_worker_asset_is_reported_as_not_emitted() -> None:
    result = run()
    assert result.returncode == 0, result.stdout
    assert 'worker: ./opfs-worker.js NOT emitted' in result.stdout
    assert 'opfs/worker' in result.stdout


def test_a_shrunk_baseline_fails_the_run_and_names_the_overspend(tmp_path: Path) -> None:
    baseline = json.loads(BASELINE.read_text())
    entry = baseline['entries']['./opfs']
    original = entry['gzip']
    baseline['entries']['./opfs']['gzip'] = max(1, original // 2)
    shrunk = tmp_path / 'baseline.json'
    shrunk.write_text(json.dumps(baseline))

    result = run('--baseline', str(shrunk))
    assert result.returncode == 1, result.stdout
    assert 'over budget' in result.stdout
    assert result.stdout.rstrip().endswith('FAIL')


def test_a_subpath_without_a_declared_platform_is_refused(tmp_path: Path) -> None:
    package = tmp_path / 'fake-package'
    (package / 'dist').mkdir(parents=True)
    (package / 'dist' / 'known.js').write_text('export const value = 1;\n')
    (package / 'dist' / 'unclassified.js').write_text('export const value = 2;\n')
    (package / 'package.json').write_text(
        json.dumps(
            {
                'name': 'fake',
                'exports': {
                    '.': {'types': './dist/known.d.ts', 'import': './dist/known.js'},
                    './surprise': {'types': './dist/unclassified.d.ts', 'import': './dist/unclassified.js'},
                },
            }
        )
    )
    result = run('--package', str(package))
    assert result.returncode == 1, result.stdout
    assert 'carries no declared platform' in result.stderr
    assert './surprise' in result.stderr


def test_the_self_test_can_fail() -> None:
    result = run('--self-test')
    assert result.returncode == 0, result.stdout + result.stderr
    lines = [line for line in result.stdout.splitlines() if line.startswith('self-test:')]
    assert len(lines) == 6, result.stdout
    assert all(line.endswith('ok') for line in lines), result.stdout
    # The control that makes the others meaningful: a native addon that resolves must be *named*.
    assert any('native addon' in line for line in lines)


def test_the_reading_is_machine_readable(tmp_path: Path) -> None:
    result = run('--json')
    assert result.returncode == 0, result.stderr
    reading = json.loads(result.stdout)
    assert reading['package'] == 'packages/cortex-storage'
    by_subpath = {entry['subpath']: entry for entry in reading['entries']}
    assert by_subpath['./opfs']['platform'] == 'browser'
    assert by_subpath['./sqlite']['platform'] == 'node'
    assert by_subpath['./opfs']['workerAssets'] == [
        {'specifier': './opfs-worker.js', 'emitted': False}
    ]
    assert by_subpath['./idb']['workerAssets'] == []
    # A browser entry that reaches a native module is a violation; on a node entry it is the point.
    assert by_subpath['./sqlite']['forbidden'] == ['better-sqlite3']
    assert by_subpath['./opfs']['forbidden'] == []
    verdicts = {verdict['subpath']: verdict['verdict'] for verdict in reading['verdicts']}
    assert set(verdicts.values()) == {'within'}


def test_the_baseline_records_every_subpath_it_measured() -> None:
    baseline = json.loads(BASELINE.read_text())
    manifest = json.loads((PACKAGE / 'package.json').read_text())
    assert set(baseline['entries']) == set(manifest['exports'])
    for subpath, entry in baseline['entries'].items():
        if subpath == '.':
            # The root is `export {}`, so its bundle is empty and gzip's 20-byte header is the whole
            # cost. That is the assertion: the root stays free.
            assert entry['bytes'] == 0
            continue
        assert entry['gzip'] > 0, subpath
        assert entry['bytes'] >= entry['gzip'], subpath


def test_a_missing_baseline_is_reported_rather_than_silently_skipped(tmp_path: Path) -> None:
    result = run('--baseline', str(tmp_path / 'absent.json'))
    assert result.returncode == 0, result.stdout
    assert 'no baseline for' in result.stdout
    assert shutil.which('node') is not None
