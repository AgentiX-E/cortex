"""Tests for tools/entry-guard.mjs — the check that keeps native modules out of a portable entry.

## What this file protects

`cortex-storage` split into a portable root plus one subpath per backend. The property that makes
the split worth anything is that the **root reaches nothing**: not `better-sqlite3`, not `pg`, not
a `node:` builtin. A size budget cannot see that, because the root is two kilobytes and would pass
any threshold while quietly importing a database.

So the guard is a closure walk, and its failure modes are the interesting part:

  * it must reject a portable entry that reaches a native module (the mutation case);
  * it must reject a package with no guard plan, rather than silently guarding nothing;
  * it must not read imports out of comments -- the root's docstring quotes an import line as an
    example, and the first version of this guard reported the package as importing itself.

The third case is why this file exists as a separate suite: a guard that fires on prose gets
switched off, and the same blind spot would let a commented-out native import turn a clean build
red for a reason nobody can find.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
GUARD = REPO / 'tools' / 'entry-guard.mjs'
PACKAGE = REPO / 'packages' / 'cortex-storage'


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['node', str(GUARD), *args],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_the_real_package_passes_and_its_control_sees_the_native_module() -> None:
    result = run('--package', 'packages/cortex-storage', '--self-test')
    assert result.returncode == 0, result.stdout + result.stderr
    # The control line is the evidence that the walk works at all: if this ever reads
    # "bare: []", the portable result above is vacuous.
    assert 'bare: [better-sqlite3' in result.stdout
    assert 'self-test: a portable entry importing better-sqlite3 is rejected' in result.stdout


def test_a_portable_entry_that_reaches_a_native_module_is_rejected(tmp_path: Path) -> None:
    # A package with the same shape as cortex-storage, but whose root imports the addon. The
    # plan is per-package, so the mutation is written to the package the plan already names --
    # done by pointing the guard at a copy of the tree rather than by editing the real source.
    copy = tmp_path / 'repo'
    (copy / 'packages' / 'cortex-storage' / 'src').mkdir(parents=True)
    (copy / 'tools').mkdir()
    (copy / 'packages' / 'cortex-storage' / 'src' / 'index.ts').write_text(
        "import Database from 'better-sqlite3';\nexport const x = Database;\n"
    )
    (copy / 'tools' / 'entry-guard.mjs').write_text(GUARD.read_text())

    result = subprocess.run(
        ['node', str(copy / 'tools' / 'entry-guard.mjs'), '--package', 'packages/cortex-storage'],
        cwd=copy,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 1
    assert 'reaches better-sqlite3' in result.stderr


def test_a_package_without_a_plan_fails_instead_of_guarding_nothing(tmp_path: Path) -> None:
    copy = tmp_path / 'repo'
    (copy / 'tools').mkdir(parents=True)
    (copy / 'tools' / 'entry-guard.mjs').write_text(GUARD.read_text())

    result = subprocess.run(
        ['node', str(copy / 'tools' / 'entry-guard.mjs'), '--package', 'packages/nowhere'],
        cwd=copy,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 1
    assert 'no guard plan' in result.stderr


def test_comments_do_not_count_as_imports() -> None:
    # The real root quotes an import line in its docstring. If the guard read it, the package
    # would be reported as importing itself, and the fix would look like "delete the docs".
    source = (PACKAGE / 'src' / 'index.ts').read_text()
    assert 'from' in source and 'import' in source, 'fixture drifted: the root no longer quotes an import'
    result = run('--package', 'packages/cortex-storage')
    assert result.returncode == 0, result.stderr
    portable_line = next(line for line in result.stdout.splitlines() if 'src/index.ts' in line)
    assert 'bare: []' in portable_line, portable_line


def test_the_manifest_and_the_guard_agree_on_which_entries_exist() -> None:
    manifest = json.loads((PACKAGE / 'package.json').read_text())
    subpaths = [key for key in manifest['exports'] if key != '.']
    assert subpaths, 'the package declares no backend subpaths'
    for subpath in subpaths:
        target = manifest['exports'][subpath]['import'].replace('./dist/', '').replace('.js', '.ts')
        assert (PACKAGE / 'src' / target).is_file(), f'{subpath} points at a source file that is gone'
