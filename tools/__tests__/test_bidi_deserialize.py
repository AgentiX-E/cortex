"""Tests for the WebDriver BiDi client the Firefox suite runs on — without a browser.

## What this file protects

`§10.2` gate 2 needs the OPFS persistence to reproduce on a second engine, and the second engine is
Firefox over WebDriver BiDi. The suite itself can only run where a Firefox exists, so its *protocol
layer* would otherwise be the least tested code in the repository: it is executed once by hand and
then trusted.

That trade failed on the first run. WebDriver BiDi does **not** send an object as an object — a plain
object arrives as an ordered list of `[key, RemoteValue]` pairs — so `evaluate` returning
`outcome.result.value` handed the shared restart suite an array where it expected
`{ digest: { hash } }`, and the run died with `Cannot read properties of undefined (reading 'hash')`
three lines into `restart-suite.mjs`. Nothing was wrong with Firefox's OPFS. The runner was holding
the wire format.

## The failure modes worth pinning

  * **The pair-list encoding stays deserialised.** The mutation test below reverts exactly that one
    branch and requires the self-test to fail by name, so the fix cannot quietly regress to
    `remote.value` the next time someone tidies the function.
  * **The four numbers JSON cannot carry.** `NaN`, `-0`, `Infinity` and `-Infinity` arrive as
    strings; a passthrough turns `NaN` into `"NaN"` and `-0` into `0`, which a digest comparison
    would not notice and a numeric assertion would.
  * **An exception is thrown, not returned.** A page that throws must reach the caller as a rejected
    await; returning `undefined` would make a failing check look like a passing one.
  * **Nothing runs on import.** `probe-firefox.mjs` imports this module. A self-test that fired on
    import would print its own lines into the probe's report and, on failure, set the probe's exit
    status from a test of the test.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BIDI = REPO / 'packages' / 'cortex-storage' / 'test' / 'browser' / 'bidi.mjs'

#: Every case the self-test is expected to report. Deleting or renaming one is a coverage loss, so
#: the list is asserted rather than only counted.
CASES = [
    'a number comes back a number',
    'an object is a pair list on the wire, and an object here',
    'an array keeps its order and its null',
    'undefined stays undefined, not the string "undefined"',
    'the four numbers JSON cannot carry',
    'an object with no pairs is an empty object',
    'a nested pair list inside an array is deserialised too',
    'an exception is thrown, not returned as a value',
]


def run(*args: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['node', str(BIDI), *args],
        cwd=cwd or REPO,
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_the_self_test_passes_without_a_browser() -> None:
    result = run('--self-test')
    assert result.returncode == 0, result.stdout + result.stderr
    assert '8 passed, 0 failed' in result.stdout, result.stdout
    assert 'FAIL' not in result.stdout, result.stdout


def test_every_case_is_reported_by_name() -> None:
    result = run('--self-test')
    assert result.returncode == 0, result.stdout
    for name in CASES:
        assert f'PASS  {name}' in result.stdout, name


def test_reverting_the_object_branch_fails_the_self_test_by_name(tmp_path: Path) -> None:
    # The mutation is the defect that shipped: an object left as its pair list. It is expressed as a
    # literal replacement so that a reformat of the branch makes this test fail loudly (the assert
    # below) rather than silently stop mutating anything.
    source = BIDI.read_text()
    mutated = source.replace(
        '      return Object.fromEntries(remote.value.map(([key, value]) => [key, deserialize(value)]));',
        '      return remote.value;',
    )
    assert mutated != source, 'the object branch moved; update the mutation to match'
    target = tmp_path / 'bidi-mutated.mjs'
    target.write_text(mutated)

    result = subprocess.run(
        ['node', str(target), '--self-test'],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 1, result.stdout
    assert 'FAIL  an object is a pair list on the wire, and an object here' in result.stdout
    # Targeted, not destructive: the cases whose result is not an object still pass, so the failure
    # names a branch rather than a broken file. Four of the eight build an object, which is the
    # branch's real blast radius -- and the suite the fix exists for reads every result that way.
    assert 'PASS  an array keeps its order and its null' in result.stdout
    assert 'PASS  a number comes back a number' in result.stdout
    assert '4 passed, 4 failed' in result.stdout, result.stdout


def test_importing_the_module_runs_no_test(tmp_path: Path) -> None:
    importer = tmp_path / 'importer.mjs'
    importer.write_text(
        f'const module = await import({str(BIDI.as_uri())!r});\n'
        "console.log(Object.keys(module).sort().join(','));\n"
    )
    # `--self-test` is on the command line and the module must still stay quiet: the guard is on
    # *which file is the entry point*, not on whether the flag is present.
    result = subprocess.run(
        ['node', str(importer), '--self-test'],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    assert 'passed,' not in result.stdout
    assert result.stdout.strip() == (
        'BiDiConnection,deserialize,findFirefox,launchFirefox,valueOf,waitForReady'
    ), result.stdout
