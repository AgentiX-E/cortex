#!/usr/bin/env python3
"""The marker can be named by a dispatch, and every link of that chain is checked.

## Why this file exists

`§18` built the inline superseded rendering in the product and priced nothing with it. The chain a
treatment travels is

    workflow env → `cortex-eval` reader → `CortexMemoryArmOptions` → `run-ablation` constructor
                 → `CortexMemory` → prompt bytes → artifact

and a single missing link anywhere in it produces the same artifact: one that reads exactly like the
control and says nothing about why. Two of those links are TypeScript (checked by
`packages/cortex-eval/src/__tests__/superseded-arm.test.ts`), and three are not: the workflow's `env:`
forward, the dispatcher's repository-variable write, and the product union the arm's grammar is a copy
of. The last one is the interesting one, because the dependency runs the other way -- `cortex-eval`
cannot import `cortex-memory` -- so the copy is held to the original by reading both sources.

## What each check would catch, stated as the failure rather than the rule

| check | the failure it prevents |
| --- | --- |
| the workflow forwards the variable | the arm reads `CORTEX_MEMORY_SUPERSEDED`, the workflow never sets it, every dispatch renders the control, and the artifact is honest about a run nobody asked for |
| the fallback is the literal `off` | an unset repository variable arrives as `''`, which the reader also reads as `off` -- but a *deleted* variable and a variable set to the empty string would then be indistinguishable in the dispatch record |
| the dispatcher writes it on every dispatch | a `mark` left behind by the previous experiment administers a rendering this dispatch did not name, and the artifact records what the product applied, so it would be **accurate about the wrong run** |
| the dispatcher declares the departure | the registration gate reads `memoryArmConfig.supersededRendering` against the registered arm; an undeclared departure is reported as an experiment that has not said so, and the run fails after having produced a perfectly good measurement |
| the two name lists agree | a rendering added on one side only: the dispatch names it, the product ignores it, and the delta is the control's reading published under the treatment's name |

## What it deliberately does not check

Whether `mark` helps. That is `§18`'s acceptance criterion and it needs a dispatch; asserting a
direction here would make the file fail for a result rather than for a defect.
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
PRODUCT = ROOT / 'packages/cortex-memory/src/superseded.ts'
CONSTRUCTOR = ROOT / 'packages/cortex-memory/bench/run-ablation.ts'

VARIABLE = 'CORTEX_MEMORY_SUPERSEDED'


def read(path: Path) -> str:
    return path.read_text(encoding='utf-8')


def load_dispatch():
    """The dispatcher as a module, for the pure functions it keeps for exactly this.

    `token()` is lazy on purpose -- `test_dispatch_overrides.py` records the CI failure that made it so
    -- so importing this file on a machine with no credential is a supported operation rather than an
    accident that happens to work here.
    """
    spec = importlib.util.spec_from_file_location('dispatch_cortex_memory_ab', DISPATCH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_workflow_forwards_the_variable_with_a_literal_fallback() -> None:
    """`vars.X || 'off'` rather than a bare `vars.X`.

    The two are not the same behaviour, and the difference is the dispatch record: a bare `vars.X`
    arrives as the empty string when the variable does not exist, which the reader maps to `off` -- so
    the run is correct and the *workflow* cannot say whether the variable was absent or empty. The
    literal fallback states the intended value in the file that would otherwise inherit it.
    """
    workflow = read(WORKFLOW)
    forward = f"{VARIABLE}: ${{{{ vars.{VARIABLE} || 'off' }}}}"
    assert forward in workflow, (
        f'{WORKFLOW.name} does not forward {VARIABLE} as `{forward}`. A variable the arm reads and '
        'the workflow never sets is a knob that reaches nothing.'
    )


def test_the_dispatcher_writes_the_variable_before_it_dispatches() -> None:
    """Unconditionally, and before the POST.

    Before, because the workflow reads the variable when the job starts: written after, it would
    describe the next run rather than this one. Unconditionally, because the reset is the protection --
    an inherited `mark` is a treatment nobody named, and the artifact cannot contradict it.
    """
    dispatch = read(DISPATCH)
    write = f'write_variable(SUPERSEDED_VARIABLE, superseded)'
    assert write in dispatch, (
        f'{DISPATCH.name} never writes {VARIABLE}. A rendering left behind by the previous '
        'experiment would be administered by this dispatch and recorded accurately.'
    )
    assert dispatch.index(write) < dispatch.index(
        'actions/workflows/{WORKFLOW}/dispatches'
    ), 'the variable is written after the dispatch, so it describes the next run rather than this one'


def test_the_dispatcher_refuses_a_rendering_the_arm_cannot_apply() -> None:
    """A typo is refused rather than defaulted to `off`, and the refusal is **executed** here.

    Asserting that the source contains a `raise` would pass on a function that raises only on a branch
    nothing reaches -- which is exactly the mutation a "does the text mention it" test cannot see. So
    the switch is imported and called, the way `test_dispatch_overrides.py` imports the pure parts of
    this module: the file's own docblock records that importing it must not require a credential.
    """
    module = load_dispatch()
    for bad in ('marker', 'MARK', 'true', '1'):
        with pytest.raises(SystemExit):
            module.superseded_switch({VARIABLE: bad})
    # And the three legal spellings, plus the unset state, are accepted -- a refusal that refuses
    # everything is not a grammar.
    assert module.superseded_switch({}) == 'off'
    assert module.superseded_switch({VARIABLE: ' mark '}) == 'mark'
    assert module.superseded_switch({VARIABLE: 'collapse'}) == 'collapse'


def test_the_departure_is_declared_only_when_the_rendering_moves() -> None:
    """Declared when on, absent when `off` -- read from the declaration itself.

    Scoped to the `declared = sorted({...})` block rather than to the file, because the same comparison
    appears in the line that prints the value: a file-wide search for `superseded != 'off'` passes on a
    declaration that has been made unconditional.
    """
    dispatch = read(DISPATCH)
    block = re.search(r'declared = sorted\(\s*\{.*?\n    \)\n', dispatch, re.S)
    assert block is not None, 'the dispatcher has no `declared = sorted({...})` block'
    entry = re.search(r'\*\(\(["\']supersededRendering["\'],\) if superseded != ["\']off["\'] else \(\)\)', block.group(0))
    assert entry is not None, (
        'the departure declaration does not name `supersededRendering` under the `!= off` condition, '
        'so either a marker dispatch is reported as an experiment that has not said so, or every '
        'control dispatch names a field it did not move'
    )


def test_the_arms_grammar_is_the_products_union() -> None:
    """The copy and the original, read from both files because nothing can import both.

    `cortex-eval` cannot see `cortex-memory` -- the dependency runs the other way -- so the arm carries
    its own table of legal names, exactly as it carries `PROMPT_CONTRACTS`. A name added on one side
    only is a dispatch that asks for a rendering the product silently ignores.
    """
    arm = re.search(
        r'const SUPERSEDED_RENDERINGS = \{(.*?)\} as const;', read(ARM), re.S
    )
    assert arm is not None, 'the arm has no `SUPERSEDED_RENDERINGS` table'
    arm_names = sorted(re.findall(r'^\s*(\w+):', arm.group(1), re.M))

    union = re.search(r'export type SupersededRendering =([^;]+);', read(PRODUCT))
    assert union is not None, 'the product has no `SupersededRendering` union'
    product_names = sorted(re.findall(r"'(\w+)'", union.group(1)))

    assert arm_names == product_names, (
        f'the arm accepts {arm_names} and the product applies {product_names}. A name in the arm and '
        'not the product is a treatment that silently renders nothing; a name in the product and not '
        'the arm is a rendering no dispatch can ask for.'
    )
    assert sorted(re.findall(r'"(\w+)"', re.search(
        r'SUPERSEDED_RENDERINGS = \([^)]*\)', read(DISPATCH)
    ).group(0))) == product_names, (
        'the dispatcher and the product disagree about the legal renderings, so a dispatch the script '
        'accepts would be refused by the arm after the run had started'
    )


def test_the_constructor_passes_it_and_absence_is_the_archived_state() -> None:
    """Conditional spread, for the reason every other treatment here is conditional.

    `off` is the shipped behaviour and is expressed by NOT passing the key, so a run that names nothing
    reproduces every archived prompt byte for byte -- which is the property the digest comparison in the
    product's own tests depends on.
    """
    constructor = read(CONSTRUCTOR)
    assert 'supersededRendering: armOptions.supersededRendering as SupersededRendering' in constructor, (
        'the constructor never passes the rendering to the product, so the arm option reaches nothing '
        'past `CortexMemoryArmOptions`'
    )
    assert "armOptions.supersededRendering === 'off'" in constructor, (
        'the rendering is passed unconditionally, so `off` is a present key rather than the archived '
        'absence -- and a present-but-inert key reads as configured to every `!== undefined` check'
    )
