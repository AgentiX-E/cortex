"""Where `<repo>/...` is read from, proved in both layouts that actually occur.

`tools/workspace-root.mjs` exists because the two repositories are arranged differently on the two
machines that run these tools: beside each other on a developer's, and **nested** on CI, where
`actions/checkout`'s `path:` resolves against `$GITHUB_WORKSPACE` and puts the documents repository at
`cortex/cortex-docs`.

Every reader of evidence resolved against `path.resolve(REPO, '..')` only, which is the first layout. The
failure did not look like a failure: a criterion whose evidence is in the documents repository printed
`unrun`, a document marker printed `skipped (no value in this checkout)`, and `S8` spent three rounds
`unrun` while the workflow had been checking the repository out the whole time. A wrong root and an absent
file produced the same word, and that word was read as "no reading yet".

The suite pins the behaviour and not the implementation: the nested layout resolves, the sibling layout
resolves, a `cortex/…` path never double-nests, an absent file stays absent, and an explicit `--root`
replaces the default so a fixture cannot read the real evidence behind the operator's back.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

MODULE = Path(__file__).resolve().parents[1] / 'workspace-root.mjs'

# A runner that imports the real file from the fixture, so `REPO` is the fixture's `repo/` and not this
# repository. The alternative -- importing in place and monkeypatching the layout -- would test a copy of
# the rule rather than the rule, and the rule is one function.
RUNNER = (
    "import { locate } from './tools/workspace-root.mjs';"
    "const found = locate(process.env.REL, process.env.EXPLICIT || undefined);"
    "process.stdout.write(found ?? '');"
)


def fixture(tmp_path: Path) -> Path:
    """A checkout at `tmp/repo` with the module installed, and the workspace around it."""
    repo = tmp_path / 'repo'
    (repo / 'tools').mkdir(parents=True)
    shutil.copy2(MODULE, repo / 'tools' / 'workspace-root.mjs')
    return repo


def locate(repo: Path, relative: str, explicit: str | None = None) -> str:
    env = os.environ | {'REL': relative, 'EXPLICIT': explicit or ''}
    done = subprocess.run(
        ['node', '--input-type=module', '-e', RUNNER],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
    )
    assert done.returncode == 0, done.stderr
    return done.stdout


def test_the_ci_layout_resolves_the_documents_repository_inside_the_checkout(tmp_path: Path) -> None:
    repo = fixture(tmp_path)
    evidence = repo / 'cortex-docs' / 'evidence' / 'longmemeval' / 'x.json'
    evidence.parent.mkdir(parents=True)
    evidence.write_text('{}', encoding='utf8')

    assert Path(locate(repo, 'cortex-docs/evidence/longmemeval/x.json')) == evidence


def test_the_developer_layout_resolves_the_documents_repository_beside_the_checkout(
    tmp_path: Path,
) -> None:
    repo = fixture(tmp_path)
    evidence = tmp_path / 'cortex-docs' / 'evidence' / 'x.json'
    evidence.parent.mkdir(parents=True)
    evidence.write_text('{}', encoding='utf8')

    assert Path(locate(repo, 'cortex-docs/evidence/x.json')) == evidence


def test_an_absent_file_stays_absent(tmp_path: Path) -> None:
    repo = fixture(tmp_path)

    assert locate(repo, 'cortex-docs/evidence/absent.json') == ''
    assert locate(repo, 'cortex/evidence/absent.json') == ''


def test_a_code_checkout_path_resolves_against_the_workspace_and_not_inside_it(tmp_path: Path) -> None:
    """`cortex/packages/...` is workspace-relative; resolving it against the checkout would give
    `cortex/cortex/packages/...`, which is the double-nesting that cost six readings their value when
    `--root` moved."""
    repo = fixture(tmp_path)
    reading = repo / 'packages' / 'cortex-storage' / 'test' / 'browser' / 'last-run.json'
    reading.parent.mkdir(parents=True)
    reading.write_text('{}', encoding='utf8')

    assert Path(locate(repo, 'cortex/packages/cortex-storage/test/browser/last-run.json')) == reading


def test_an_explicit_root_replaces_the_developer_default(tmp_path: Path) -> None:
    """`--root` is a statement about this run, so a fixture that lacks a file must not fall back to the
    real workspace: reading the real evidence while an operator asked for a fixture is the silent-wrong-
    number defect this campaign keeps paying for."""
    repo = fixture(tmp_path)
    beside = tmp_path / 'cortex-docs' / 'evidence' / 'x.json'
    beside.parent.mkdir(parents=True)
    beside.write_text('{}', encoding='utf8')
    other = tmp_path / 'other'
    other.mkdir()

    assert locate(repo, 'cortex-docs/evidence/x.json', str(other)) == ''


def test_an_explicit_root_is_the_only_place_the_documents_repository_is_looked_for(
    tmp_path: Path,
) -> None:
    """The nested checkout is a fallback for the default workspace, not for a named one.

    Without this, `--root` could not describe a workspace that has no documents repository, and the
    "absent is skipped, not failed" path in the registry check would have no way to be exercised at all --
    `test_reading_render.py` builds exactly that fixture and would start reading the real evidence.
    """
    repo = fixture(tmp_path)
    evidence = repo / 'cortex-docs' / 'evidence' / 'x.json'
    evidence.parent.mkdir(parents=True)
    evidence.write_text('{}', encoding='utf8')
    other = tmp_path / 'other'
    other.mkdir()

    assert locate(repo, 'cortex-docs/evidence/x.json', str(other)) == ''


# The bug this file was written for survived its own unit tests, because the rule was right and both
# callers handed it the resolved default as if the operator had named it: `locate(relative, root)` with
# `root = flag('--root') ?? path.resolve(REPO, '..')` makes every path look explicitly rooted, which
# suppresses the nested `cortex-docs` candidate. Locally that is invisible -- the default root *is* the
# right place there -- and on CI it turned the matrix and a third of the markers unreadable again, with
# the same word as before. So the callers are pinned, in the only way that costs nothing: they must pass
# what the flag said.
CALLERS = ('acceptance-check.mjs', 'docs-crosscheck.mjs')


@pytest.mark.parametrize('caller', CALLERS)
def test_no_caller_passes_the_resolved_default_as_an_explicit_root(caller: str) -> None:
    source = (MODULE.parent / caller).read_text()
    assert 'const rootFlag = flag(' in source, (
        f'{caller} must keep what the caller said in its own name; without it there is nothing to pass '
        'to the resolver that distinguishes "no flag" from "a flag naming the default"'
    )
    offenders = [
        line.strip()
        for line in source.splitlines()
        if not line.strip().startswith('//') and re.search(r'\b(locate|candidates)\([^)]*,\s*root\s*\)', line)
    ]
    assert offenders == [], (
        f'{caller} hands the resolved default to the resolver: {offenders}. Pass `rootFlag`, or the '
        'nested documents repository is never tried and CI reads nothing'
    )
