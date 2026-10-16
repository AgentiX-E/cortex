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


def path_of(step: str) -> str | None:
    """The step's `path:`, so a restore can be paired with the save of the SAME cache.

    A workflow may cache more than one thing, and a restore of one paired with the
    save of another would produce a message about the wrong file.
    """
    match = re.search(r'^\s+path: (.+)$', step, re.MULTILINE)
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


def test_no_restore_primary_key_can_only_ever_name_a_stale_entry():
    """The half of the pattern the checks above do not cover, and the one that cost money.

    A restore's `key:` is an **exact** name, not a pattern. `actions/cache` tries it
    first and consults `restore-keys` only after it MISSES. So a primary key that no
    current save writes is not merely unhelpful -- if an entry happens to exist under
    it, every restore HITS it, the prefix list is never reached, and the entries the
    saves keep writing are read by nothing.

    That is what was live in this repository, and the cache list says so outright:

    | cache | size | created | last accessed |
    | --- | --- | --- | --- |
    | `7119462708` | 691 MB | 2026-08-29 | 2026-10-16 (every run) |
    | `9009810001` | 1099 MB | 2026-10-15 | 2026-10-15 (never) |
    | `9030207266` | 1100 MB | 2026-10-16 | 2026-10-16 (never) |

    `last_accessed_at == created_at` on every run-keyed entry is the proof that the
    `restore-keys` path had never once run. The cost, measured from three consecutive
    runs: each restored the same 170,095 vectors while each saving a strictly larger
    cache, and each spent 1h38m-1h49m of a ~3h21m job -- half the wall clock -- inside
    `buildRetrievalRelevanceIndex`, re-embedding turns the previous run had already
    paid for and saved under a key nothing read. `38910134192` died from it: 11,476
    live embedding requests, then `429` / `code 1113` / "余额不足" with
    `progress: no question was started before the failure`.

    The rule below is exact and needs no knowledge of the cache store:

      * if the save writes a name that STRICTLY EXTENDS the restore's primary key,
        then the restore's name is one no save produces, so any hit on it is an entry
        written by an older revision -- the oldest one -- and it suppresses the
        prefix fallback;
      * if the restore's primary key strictly extends the save's, the restore asks for
        a name nothing writes, which is the same defect with the sign flipped.

    Both are refused. The repair is to make the primary key name the entry this very
    run will write, and let the prefix list do the reading of earlier ones.
    """
    pairs = 0
    for restore_path, restore in steps_using(RESTORE_ACTION):
        restore_key = key_of(restore)
        assert restore_key is not None, f'{restore_path.name}: a restore step with no key'
        target = path_of(restore)
        assert target is not None, f'{restore_path.name}: a restore step with no path'

        for save_path, save in steps_using(SAVE_ACTION):
            if save_path != restore_path or path_of(save) != target:
                continue
            pairs += 1
            save_key = key_of(save)
            assert save_key is not None

            assert not (save_key.startswith(restore_key) and save_key != restore_key), (
                f'{restore_path.name}: the save writes {save_key!r}, which strictly '
                f'extends the restore\'s primary key {restore_key!r}. The primary key '
                'is tried first and an exact hit suppresses every restore-key, so on '
                'any entry left under it the restore serves the OLDEST cache and never '
                'looks at the fresh ones. Make the primary key the name this run '
                'writes, so a miss is what happens and the prefix list resolves.'
            )
            assert not (restore_key.startswith(save_key) and restore_key != save_key), (
                f'{restore_path.name}: the restore asks for {restore_key!r}, which no '
                f'save writes -- the save writes {save_key!r}. A name nothing produces '
                'is a name that can only ever be satisfied by a stale entry.'
            )

    assert pairs > 0, (
        'no restore/save pair sharing a path was found in any workflow; the guard would '
        'pass vacuously, which is the failure mode it exists to prevent.'
    )
