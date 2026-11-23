"""Tests for tools/readings-in-place.mjs — the suites must not write into the checkout.

## What this file protects

Four browser readings are committed, because `§10.2` gates 1 and 2 need evidence a `pnpm check` cannot
produce. Each probe can be pointed elsewhere by an environment variable, and `CORTEX_RESULTS_BUNDLE`
was defined for that and set nowhere: CI re-ran the probe, it wrote over the committed
`bundle-run.json`, and the comparison that would have used both files did not exist. Every step stayed
green and the repository's evidence was silently replaced by that run's output.

The property that catches it is one line long — *on a clean checkout, the suites change no tracked
file* — and these four tests are about the three ways the implementation could be wrong rather than
the property: reporting a clean tree as dirty (the build's ignored output), missing an untracked new
file, and failing without naming what changed.

## Why the fixture is a real repository

`git status --porcelain` is the thing under test, and a stubbed `execFileSync` would test the mock. The
fixtures are `git init` + one commit, which is fast enough to afford and is the only way to know that
ignored paths are excluded for the reason the tool claims (`.gitignore`) rather than by accident.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'readings-in-place.mjs'


def git(repo: Path, *args: str) -> None:
    subprocess.run(
        ['git', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', *args],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    )


def clean_checkout(tmp_path: Path, gitignore: str = 'dist/\n') -> Path:
    repo = tmp_path / 'repo'
    repo.mkdir()
    (repo / '.gitignore').write_text(gitignore)
    (repo / 'bundle-run.json').write_text('{"summary": {"failed": 0}}\n')
    git(repo, 'init', '--quiet')
    git(repo, 'add', '-A')
    git(repo, 'commit', '--quiet', '-m', 'the committed reading')
    return repo


def run(repo: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['node', str(TOOL), '--repo', str(repo)],
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_a_clean_checkout_with_build_output_passes(tmp_path: Path) -> None:
    # The build is supposed to write `dist/`, and it is ignored. A tool that reported it would fail on
    # every run and be deleted, so this is the control the other three need.
    repo = clean_checkout(tmp_path)
    git(repo, 'status', '--porcelain')
    (repo / 'dist').mkdir()
    (repo / 'dist' / 'opfs.js').write_text('export const x = 1;\n')

    result = run(repo)
    assert result.returncode == 0, result.stdout
    assert 'the checkout is unchanged' in result.stdout


def test_a_reading_rewritten_in_place_is_named(tmp_path: Path) -> None:
    repo = clean_checkout(tmp_path)
    (repo / 'bundle-run.json').write_text('{"summary": {"failed": 0}, "rows": 400}\n')

    result = run(repo)
    assert result.returncode == 1, result.stdout
    assert 'bundle-run.json' in result.stdout
    assert '1 path(s) changed' in result.stdout
    # The message has to say what to do, because the reader of a red CI job is often not the author of
    # the probe: the fix is an environment variable, and its name is part of the failure.
    assert 'CORTEX_RESULTS_BUNDLE' in result.stdout


def test_a_new_file_counts_as_writing_into_the_checkout(tmp_path: Path) -> None:
    # A probe writing `last-run-firefox.json` for the first time is the same defect as rewriting one.
    repo = clean_checkout(tmp_path)
    (repo / 'last-run-firefox.json').write_text('{}\n')

    result = run(repo)
    assert result.returncode == 1, result.stdout
    assert 'last-run-firefox.json' in result.stdout


def test_a_directory_that_is_not_a_repository_fails_with_a_reason() -> None:
    result = subprocess.run(
        ['node', str(TOOL), '--repo', '/tmp'],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 1, result.stdout
    assert 'could not read the checkout state' in result.stdout
    assert 'Traceback' not in result.stdout
