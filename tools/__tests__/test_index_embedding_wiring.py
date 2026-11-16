#!/usr/bin/env python3
"""The index channel can be withheld by a dispatch, and every link of that chain is checked.

## Why this file exists

`SearchIndexOptions.embed` has been optional since the index was built, and the manual says what its
absence means. Nothing could measure it. The chain a treatment travels is

    workflow env → `cortex-eval` reader → `CortexMemoryArmOptions` → `run-ablation` constructor
                 → `CortexMemory`/`SearchIndex` → prompt bytes → artifact

and two of those links are TypeScript (checked by
`packages/cortex-eval/src/__tests__/index-embedding-arm.test.ts` and by the assemble test that drives
the option through the composition root). The rest are here, because the failure they share is not a
type error: it is a run that publishes the registered arm's number under the lexical arm's name.

## What each check would catch, stated as the failure rather than the rule

| check | the failure it prevents |
| --- | --- |
| the workflow forwards the variable | the arm reads it, the workflow never sets it, and every dispatch is the registered configuration whatever the operator asked for |
| the fallback is the literal `injected` | an unset variable and a variable set to the empty string become the same bytes in the dispatch record, so "nobody chose" and "the default was chosen" cannot be told apart |
| the dispatcher writes it on every dispatch | a `none` left behind withholds a capability from the next run, which would reproduce the registered configuration with a hole in it and no dispatch asked for the hole |
| the dispatcher declares the departure | the registration gate reads `memoryArmConfig.indexEmbedding`; an undeclared `none` is a measurement of a configuration nobody registered, refused after the money is spent |
| the arm's names and the constructor's test agree | a value added on one side only: the arm records `none`, the constructor keeps the embedder, and the artifact publishes the registered arm as the lexical one -- which is the direction that reads as *good news* about a deployment with no embedder |
| absence, not `undefined` | `SearchIndex` decides on `!== undefined`, so a present-but-undefined `embed` key reads as configured and the lexical arm silently keeps a vector channel |

## What it deliberately does not check

Whether the channel is worth having. That is `S12`'s acceptance criterion: it needs a dispatch, and a
direction asserted here would make this file fail for a result rather than for a defect.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / '.github/workflows/benchmark-cortex-memory.yml'
DISPATCH = ROOT / 'tools/dispatch-cortex-memory-ab.py'
ARM = ROOT / 'packages/cortex-eval/src/bench-memory-arm.ts'
CONSTRUCTOR = ROOT / 'packages/cortex-memory/bench/run-ablation.ts'

VARIABLE = 'CORTEX_MEMORY_INDEX_EMBEDDING'


def read(path: Path) -> str:
    return path.read_text(encoding='utf-8')


def load_dispatch():
    """The dispatcher as a module, for the pure functions it keeps for exactly this."""
    spec = importlib.util.spec_from_file_location('dispatch_cortex_memory_ab', DISPATCH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_workflow_forwards_the_variable_with_a_literal_fallback() -> None:
    """`vars.X || 'injected'` rather than a bare `vars.X`.

    A bare `vars.X` arrives as the empty string when the variable does not exist. The reader maps that
    to `injected` too, so the run is right either way -- and the workflow cannot say whether the
    variable was absent or empty. The literal states the intended value in the file that would
    otherwise inherit it.
    """
    forward = f"{VARIABLE}: ${{{{ vars.{VARIABLE} || 'injected' }}}}"
    assert forward in read(WORKFLOW), (
        f'{WORKFLOW.name} does not forward {VARIABLE} as `{forward}`. A variable the arm reads and '
        'the workflow never sets is a knob that reaches nothing, and the dispatch would be the '
        'registered arm every time while the log said otherwise.'
    )


def test_the_dispatcher_writes_the_variable_before_it_dispatches() -> None:
    """Unconditionally, and before the POST.

    Before, because the workflow reads the variable when the job starts. Unconditionally, because the
    reset is the protection: an inherited `none` is a withheld capability nobody named, and the
    artifact -- which records the channel -- would be accurate about the wrong run.
    """
    dispatch = read(DISPATCH)
    write = 'write_variable(INDEX_EMBEDDING_VARIABLE, index_embedding)'
    assert write in dispatch, f'{DISPATCH.name} never writes {VARIABLE}.'
    assert dispatch.index(write) < dispatch.index(
        'actions/workflows/{WORKFLOW}/dispatches'
    ), 'the variable is written after the dispatch, so it describes the next run rather than this one'


def test_the_dispatcher_refuses_a_channel_the_arm_cannot_administer() -> None:
    """Executed rather than grepped, for the reason the superseded switch is.

    A source-level assertion that a `raise` exists passes on a function that raises only on a branch
    nothing reaches, which is the mutation this check is worth nothing against. So the switch is
    imported and called: `test_dispatch_overrides.py` records that importing this module must not
    require a credential, and `token()` is lazy for that reason.
    """
    module = load_dispatch()
    for bad in ('lexical', 'off', 'INJECTED', 'true', '0', 'vector'):
        with pytest.raises(SystemExit):
            module.index_embedding_switch({VARIABLE: bad})
    # A refusal that refuses everything is not a grammar, so the legal states are asserted too.
    assert module.index_embedding_switch({}) == 'injected'
    assert module.index_embedding_switch({VARIABLE: ' none '}) == 'none'
    assert module.index_embedding_switch({VARIABLE: 'injected'}) == 'injected'


def test_the_departure_is_declared_only_when_the_channel_moves() -> None:
    """Declared when withheld, absent when `injected` -- read from the declaration itself.

    Scoped to the `declared = sorted({...})` block rather than to the file, because the same comparison
    appears in the line that prints the value: a file-wide search passes on a declaration that has been
    made unconditional, which is the defect the superseded test was rewritten for.
    """
    block = re.search(r'declared = sorted\(\s*\{.*?\n    \)\n', read(DISPATCH), re.S)
    assert block is not None, 'the dispatcher has no `declared = sorted({...})` block'
    entry = re.search(
        r'\*\(\(["\']indexEmbedding["\'],\) if index_embedding != ["\']injected["\'] else \(\)\)',
        block.group(0),
    )
    assert entry is not None, (
        'the departure declaration does not name `indexEmbedding` under the `!= injected` condition, '
        'so a lexical dispatch is filed as a measurement of the configuration the project ships, or '
        'every registered dispatch names a field it did not move'
    )


def test_the_arms_names_are_the_dispatchers_names_and_the_constructors_condition() -> None:
    """Three copies of one two-valued vocabulary, held to each other by reading all three.

    The dependency direction makes the copies unavoidable: `cortex-eval` cannot import
    `cortex-memory`, and the dispatcher is Python. What is avoidable is a copy that drifts, and the
    drift's shape is specific -- the arm records `none`, the constructor keeps the embedder, and the
    artifact publishes the registered arm's accuracy as the lexical arm's. That reads as good news
    about a deployment that owns no embedder.
    """
    arm = re.search(r'const INDEX_EMBEDDINGS = \{(.*?)\} as const;', read(ARM), re.S)
    assert arm is not None, 'the arm has no `INDEX_EMBEDDINGS` table'
    arm_names = sorted(re.findall(r'^\s*(\w+):', arm.group(1), re.M))

    module = load_dispatch()
    assert arm_names == sorted(module.INDEX_EMBEDDINGS), (
        f'the arm accepts {arm_names} and the dispatcher accepts {sorted(module.INDEX_EMBEDDINGS)}.'
    )

    constructor = read(CONSTRUCTOR)
    assert "armOptions.indexEmbedding !== 'none'" in constructor, (
        'the constructor does not test the channel, so `none` reaches the product as a configuration '
        'it never sees -- and the arm would embed while the artifact said it did not'
    )
    # The withheld key is expressed by ABSENCE. `SearchIndex` decides on `!== undefined`, so a
    # present-but-undefined `embed` is a vector channel that tests as configured.
    assert '{ embed: (texts: string[]) => embedding.embed(texts) }' in constructor, (
        'the constructor passes `embed` unconditionally, or passes it as a spread object holding '
        '`undefined`: the first keeps the vector channel on the lexical arm, the second is a key '
        '`SearchIndex` reads as configured'
    )
    conditional = re.search(
        r'\.\.\.\(productIndexEmbedded \? \{ embed: [^}]*\} : \{\}\)', constructor
    )
    assert conditional is not None, (
        'the channel is not spread conditionally, so the lexical arm is expressed by something other '
        'than the absence of `embed`'
    )
