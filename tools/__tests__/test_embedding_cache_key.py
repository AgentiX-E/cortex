#!/usr/bin/env python3
"""A cache save must not contend for the key its own restore asked for.

## The waste this pins

Both failed runs of `benchmark-cortex-memory.yml` ended the same way, after the arm had
already died:

    Failed to save: Unable to reserve cache with key longmemeval-embedding-<hash>,
    another job may be creating this cache.

`38520676669` had graded two repetitions of both systems; `38566578567` had spent thirty
minutes embedding. Each had paid for vectors, and each lost them, because the save step
re-used the exact key the restore step had requested. Two runs writing one key contend,
and one of them is told to go away.

The failure path in the entry point does the opposite on purpose -- it persists the
embedding cache on the way out, because "a run that dies at question 300 of 500 has still
paid for its embeddings" -- so the cache is the one artifact that is deliberately salvaged
from a failure. Losing it in the workflow is the same mistake made one layer up, and it is
invisible: the step reports a warning and the job continues.

## Why this is a check rather than a comment

`actions/cache` documents the pattern (a unique save key, matched by a prefix
`restore-keys` entry) and nothing in the repository enforced it. The defect has no symptom
in any single run -- the run that fails to save is usually a run that already failed -- so
the only way to notice is to look for the shape, which is what this does.

## What it deliberately does not check

Whether a workflow caches at all, or what it caches. A workflow with no cache is a
workflow with no contention, and asserting that every workflow has one would fail for a
reason that is not a defect.
"""

from __future__ import annotations

import pathlib
import re

WORKFLOWS = pathlib.Path(__file__).resolve().parents[2] / '.github' / 'workflows'

# `actions/cache/save@v4` and `actions/cache/restore@v4` in either order, anywhere in the
# file. The steps are matched by the action they use rather than by position, because a
# workflow is free to order them as it likes.
SAVE_ACTION = 'actions/cache/save@'
RESTORE_ACTION = 'actions/cache/restore@'


def workflow_files() -> list[pathlib.Path]:
    return sorted(WORKFLOWS.glob('*.yml'))


def steps(path: pathlib.Path) -> list[str]:
    """The workflow's steps, split on the `      - name: ` that introduces each one.

    A split rather than a regular expression over the whole document, and the reason is
    measured: the first version of this file matched a step with a lazy `.*` and a
    lookahead, which over-ran into the rest of the job -- so the `restore-keys` list it
    read contained the environment block, the comments and the following steps, and the
    guard failed with a message nobody could act on. Position-based parsing has no such
    failure mode, and `test_the_parser_finds_the_steps` pins that it found the real steps
    rather than one chunk.
    """
    text = path.read_text()
    chunks = text.split('\n      - name: ')
    # The first chunk is everything above the first step -- jobs, inputs, comments -- and
    # carries no step boundary, so it cannot be a step.
    return chunks[1:]


def steps_using(action: str) -> list[tuple[pathlib.Path, str]]:
    """Every workflow step that uses `action`, as (file, step text)."""
    found: list[tuple[pathlib.Path, str]] = []
    for path in workflow_files():
        for step in steps(path):
            if re.search(rf'^\s+uses: {re.escape(action)}', step, re.MULTILINE):
                found.append((path, step))
    return found


def restore_prefixes(step: str) -> list[str]:
    """The entries under a step's `restore-keys: |` block, in order."""
    block = re.search(r'restore-keys: \|\n((?:\s+\S.*\n)+)', step)
    assert block is not None
    return [line.strip() for line in block.group(1).splitlines() if line.strip()]


def key_of(step: str) -> str | None:
    match = re.search(r'^\s+key: (.+)$', step, re.MULTILINE)
    return match.group(1).strip() if match else None


def test_every_cache_save_key_is_unique_per_run():
    saves = steps_using(SAVE_ACTION)
    assert saves, 'no actions/cache/save step found; the guard would pass vacuously'

    for path, step in saves:
        key = key_of(step)
        assert key is not None, f'{path.name}: a save step with no key'
        assert 'github.run_id' in key, (
            f'{path.name}: the save key is {key!r}, which two runs can collide on. '
            'A collision is reported as "Unable to reserve cache" and the vectors the run '
            'paid for are discarded; put ${{ github.run_id }} in the key.'
        )


def test_the_parser_finds_the_steps():
    """Guard the guard: a split that stopped working would make the checks below vacuous."""
    for path in workflow_files():
        found = steps(path)
        assert len(found) > 3, f'{path.name}: only {len(found)} steps found'
        for step in found:
            assert step.splitlines()[0].strip(), f'{path.name}: an unnamed step'


def test_every_restore_prefixes_the_same_expression_the_save_extends():
    """A unique save key is only useful if a later run can find it.

    The restore's `restore-keys` must therefore contain a **prefix** of the save key, or
    the unique key would make the cache write-only: each run would save under a name no run
    ever looks up. This is the half of the pattern that is easy to get wrong, because the
    cache still appears to work -- it just grows without ever being read.
    """
    for path, restore in steps_using(RESTORE_ACTION):
        assert key_of(restore) is not None, f'{path.name}: a restore step with no key'
        prefixes = [
            prefix for prefix in restore_prefixes(restore) if '${{' in prefix
        ]
        assert prefixes, (
            f'{path.name}: this workflow saves a run-unique key, so it must restore by '
            'prefix; a restore with no restore-keys can only ever match one exact key.'
        )

        for save_path, save in steps_using(SAVE_ACTION):
            if save_path != path:
                continue
            save_key = key_of(save)
            assert save_key is not None
            assert any(save_key.startswith(prefix) for prefix in prefixes), (
                f'{path.name}: save key {save_key!r} starts with none of the restore '
                f'prefixes {prefixes!r} -- the cache it writes can never be read back.'
            )


def test_the_dataset_hash_still_keys_the_cache():
    """Both workflows must keep resolving to one vector set.

    The comparability argument is that the main benchmark and the arm share vectors keyed
    on the dataset. A run-unique key must therefore ADD to that expression rather than
    replace it, or a dataset change would silently serve vectors embedded from the old one.
    """
    for path, save in steps_using(SAVE_ACTION):
        key = key_of(save)
        assert key is not None
        assert 'hashFiles(' in key, (
            f'{path.name}: the save key {key!r} no longer keys on the dataset, so a changed '
            'dataset would restore vectors that were never embedded from it.'
        )
