"""Tests for tools/browser-reading-check.mjs — the committed browser readings, compared.

## What this file protects

The two browser gates (`§10.2` items 1 and 2) cannot run inside `pnpm check`: one needs a bundler and a
Chromium, the other needs a second engine. Their evidence is therefore a committed artifact --
`test/browser/last-run.json` and `last-run-firefox.json` -- and an artifact has a failure mode a test
does not: it can stop describing the tree while continuing to say `24/24`.

Three specific ways that happens, each with a test below:

  * **A check is renamed in `page.html`.** The suite still runs, the old reading still says 24 passes,
    and the two engines now run different check lists. Nobody notices, because nobody diffs two JSON
    files by hand.
  * **A check disappears.** 24 becomes 23 and the reading is silently about less.
  * **A reading was taken on the IndexedDB fallback.** Every check passes and every one of them is
    about a different engine than the file claims; the tier is a criterion, not a detail.

The first test needs no browser at all: it compares the two *committed* readings, so the gate-2
criterion "the 24 names are identical in order and string" is enforced on every push rather than once,
by hand, on the day it was measured.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CHECK = REPO / 'tools' / 'browser-reading-check.mjs'
COMMITTED = REPO / 'packages' / 'cortex-storage' / 'test' / 'browser' / 'last-run.json'
COMMITTED_FIREFOX = REPO / 'packages' / 'cortex-storage' / 'test' / 'browser' / 'last-run-firefox.json'


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['node', str(CHECK), *args],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=120,
    )


def reading(tmp_path: Path, name: str, mutate) -> Path:
    """A copy of the committed Chromium reading with one thing changed."""
    data = json.loads(COMMITTED.read_text())
    mutate(data)
    path = tmp_path / name
    path.write_text(json.dumps(data))
    return path


def test_the_two_committed_readings_run_the_same_checks() -> None:
    # Gate 2's third criterion, enforced on every push without a browser: two engines, one check list,
    # identical in order and in string.
    result = run('--committed', str(COMMITTED), '--fresh', str(COMMITTED_FIREFOX))
    assert result.returncode == 0, result.stdout
    assert 'identical in order and string' in result.stdout
    assert '24 checks' in result.stdout


def test_a_renamed_check_is_reported_with_both_names(tmp_path: Path) -> None:
    original = json.loads(COMMITTED.read_text())['checks'][7]['name']

    def rename(data: dict) -> None:
        data['checks'][7]['name'] = 'opfs: delete, but on a different engine'

    fresh = reading(tmp_path, 'renamed.json', rename)
    result = run('--committed', str(COMMITTED), '--fresh', str(fresh))
    assert result.returncode == 1, result.stdout
    assert f'check 8 is "{original}"' in result.stdout
    assert 'opfs: delete, but on a different engine' in result.stdout


def test_a_dropped_check_is_reported_by_name(tmp_path: Path) -> None:
    def drop(data: dict) -> None:
        dropped = data['checks'].pop(0)['name']
        data['checks'].insert(0, dropped)  # keep order, lose nothing yet
        data['checks'] = data['checks'][1:]

    fresh = reading(tmp_path, 'dropped.json', drop)
    result = run('--committed', str(COMMITTED), '--fresh', str(fresh))
    assert result.returncode == 1, result.stdout
    assert 'the committed reading has 24 checks and this run has 23' in result.stdout
    assert 'was not asserted by this run' in result.stdout


def test_a_reading_taken_on_the_idb_fallback_is_refused(tmp_path: Path) -> None:
    def fallback(data: dict) -> None:
        data['phases']['write']['tier'] = 'idb'

    fresh = reading(tmp_path, 'fallback.json', fallback)
    result = run('--committed', str(COMMITTED), '--fresh', str(fresh))
    assert result.returncode == 1, result.stdout
    assert 'wrote on idb, not opfs' in result.stdout


def test_a_run_that_did_not_read_its_own_digest_is_refused(tmp_path: Path) -> None:
    def unread(data: dict) -> None:
        data['summary']['digestMatches'] = False

    fresh = reading(tmp_path, 'unread.json', unread)
    result = run('--committed', str(COMMITTED), '--fresh', str(fresh))
    assert result.returncode == 1, result.stdout
    assert 'did not read back the digest it wrote' in result.stdout


def test_a_missing_argument_is_reported_rather_than_crashing() -> None:
    result = run('--committed', str(COMMITTED))
    assert result.returncode == 1, result.stdout
    assert '--fresh is required' in result.stdout
    assert 'Traceback' not in result.stdout + result.stderr
