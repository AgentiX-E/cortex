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

## The fourth way, which this file did not cover either

`bundle-run.json` is a third committed reading -- the only evidence for the `workerUrl` contract, the
one that quotes the product's own refusal text -- and until the tool could read a tier the bundle
suite records at `facts.tier` rather than `phases.write.tier`, nothing could be pointed at it. A
reading no gate compares is not evidence; it is a file that agrees with itself. The last four tests
are about that: the bundle reading must be readable at all, its tier must be a criterion for it too,
and the verdict must name the two files it read so that the local invocation -- which compares two
artefacts and runs no browser -- cannot be read as a claim about the tree.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CHECK = REPO / 'tools' / 'browser-reading-check.mjs'
COMMITTED = REPO / 'packages' / 'cortex-storage' / 'test' / 'browser' / 'last-run.json'
COMMITTED_FIREFOX = REPO / 'packages' / 'cortex-storage' / 'test' / 'browser' / 'last-run-firefox.json'
COMMITTED_BUNDLE = REPO / 'packages' / 'cortex-storage' / 'test' / 'browser' / 'bundle-run.json'


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


def copy_of(tmp_path: Path, source: Path, name: str, mutate) -> Path:
    """A copy of any committed reading with one thing changed."""
    data = json.loads(source.read_text())
    mutate(data)
    path = tmp_path / name
    path.write_text(json.dumps(data))
    return path


def test_the_bundle_reading_can_be_read_at_all() -> None:
    # The bundle suite records its tier at `facts.tier` and has no `phases` at all. Before the reader
    # knew that, this invocation reported "wrote on no recorded tier" for a correct reading -- so the
    # tool could not be pointed at the file, and the file went uncompared by anything.
    result = run('--committed', str(COMMITTED_BUNDLE), '--fresh', str(COMMITTED_BUNDLE))
    assert result.returncode == 0, result.stdout
    assert '4 checks' in result.stdout


def test_a_bundle_run_that_fell_back_to_idb_is_refused(tmp_path: Path) -> None:
    def fallback(data: dict) -> None:
        data['facts']['tier'] = 'idb'

    fresh = copy_of(tmp_path, COMMITTED_BUNDLE, 'bundle-fallback.json', fallback)
    result = run('--committed', str(COMMITTED_BUNDLE), '--fresh', str(fresh))
    assert result.returncode == 1, result.stdout
    assert 'this run wrote on idb, not opfs' in result.stdout


def test_a_bundle_run_whose_read_digest_differs_is_refused(tmp_path: Path) -> None:
    # The bundle reading has no `summary.digestMatches`: it runs once, so the page compares the two
    # numbers and records them. A reader that only knew `summary` would skip the criterion for this
    # reading silently -- which is the failure this assertion is aimed at, not the digest itself.
    def mismatched(data: dict) -> None:
        data['facts']['roundTrip']['read'] = data['facts']['roundTrip']['written'] + 1

    fresh = copy_of(tmp_path, COMMITTED_BUNDLE, 'bundle-digest.json', mismatched)
    result = run('--committed', str(COMMITTED_BUNDLE), '--fresh', str(fresh))
    assert result.returncode == 1, result.stdout
    assert 'this run did not read back the digest it wrote' in result.stdout


def test_a_reading_that_records_no_tier_is_refused(tmp_path: Path) -> None:
    def untiered(data: dict) -> None:
        del data['phases']['write']['tier']

    fresh = reading(tmp_path, 'untiered.json', untiered)
    result = run('--committed', str(COMMITTED), '--fresh', str(fresh))
    assert result.returncode == 1, result.stdout
    assert 'this run records no tier anywhere this check can read' in result.stdout


def test_the_verdict_names_the_file_it_compared_and_not_the_tree() -> None:
    # `pnpm check` passes a second committed artefact as the fresh side and runs no browser. A verdict
    # that says "the committed reading still describes this tree" in that case is claiming evidence
    # nobody collected, so the sentence names both paths instead.
    result = run('--committed', str(COMMITTED), '--fresh', str(COMMITTED_FIREFOX))
    assert result.returncode == 0, result.stdout
    assert f'{COMMITTED_FIREFOX} agrees with {COMMITTED}' in result.stdout
    assert 'describes this tree' not in result.stdout
