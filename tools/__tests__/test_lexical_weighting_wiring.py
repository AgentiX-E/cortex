#!/usr/bin/env python3
"""The term weighting can be selected by a dispatch, and every link of that chain is checked.

## Why this file exists

`§13.380` priced `idf` at **+190 gold turns and ten questions out of zero-recall** on the offline
instrument, and `§13.381` registered what has to be measured next: the thirty abstention questions, paired,
on a real reader. That measurement needs the arm to *run* under `idf`.

Three of the four links already existed. `SearchIndex` prices terms, `CortexMemory` refuses a name it does
not administer, and `bench-memory-arm.ts` has read `CORTEX_MEMORY_LEXICAL_WEIGHTING` since `§13.379` with
`flat` and `idf` as its grammar. **The fourth did not**: the workflow never forwarded the variable, and the
dispatcher never wrote or declared it. So the treatment was priced on a path that no accuracy dispatch could
reach -- the eval side's number was real and the product could be configured to produce it, while the only
harness that produces an *accuracy* number could not be asked for it.

That is requirement ⑯ read one level up from where it usually bites. The earlier failures in this family
were "the product cannot do what the eval measured"; this one is "the arm cannot be dispatched in the
configuration the eval measured", and it is invisible in both directions: the arm's own tests pass (it
parses the variable), the product's tests pass (the option works), and the gap is in the two places that
sit between them and are written in different languages.

## What each check would catch, stated as the failure rather than the rule

| check | the failure it prevents |
| --- | --- |
| the workflow forwards the variable | the arm reads it, the workflow never sets it, and every dispatch is the registered arm whatever the operator asked for |
| the fallback is the literal `flat` | an unset variable and a variable set to the empty string become the same bytes, so "nobody chose" and "the default was chosen" cannot be told apart |
| the dispatcher writes it on every dispatch | an `idf` left behind turns the next control run into a treatment, and its artifact would be accurate about the wrong run |
| the dispatcher declares the departure | the registration gate compares `memoryArmConfig.lexicalWeighting`; an undeclared `idf` is refused after the money is spent |
| the declaration is conditional | declaring `flat` on a control run is the "names a field this run did not move" case the gate reports as an intention |
| the gate holds the condition at the shipped value | a gate holding a wrong constant refuses every registered run, which is a gate that gets read as noise |
| the two vocabularies agree | the arm accepts `idf`, the dispatcher accepts something else, and the dispatch is refused at the preflight for a name the arm would have honoured |

## What it deliberately does not check

Whether `idf` is worth adopting. That needs the paired abstention reading `§13.381.2` registers, on a
dispatch, and asserting a direction here would make this file fail for a result rather than for a defect.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / '.github/workflows/benchmark-cortex-memory.yml'
DISPATCH = ROOT / 'tools/dispatch-cortex-memory-ab.py'
READOUT = ROOT / 'tools/readout-arm-run.py'
ARM = ROOT / 'packages/cortex-eval/src/bench-memory-arm.ts'

VARIABLE = 'CORTEX_MEMORY_LEXICAL_WEIGHTING'


def read(path: Path) -> str:
    return path.read_text(encoding='utf-8')


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_workflow_forwards_the_variable_with_a_literal_fallback() -> None:
    """`vars.X || 'flat'` rather than a bare `vars.X`.

    A bare `vars.X` arrives as the empty string when the repository variable does not exist. The arm's
    reader maps that to `flat` as well, so the run is right either way -- and the workflow cannot say
    whether the variable was absent or empty. The literal states the intended value in the file that
    would otherwise inherit it, which is the difference between a default and an accident.
    """
    forward = f"{VARIABLE}: ${{{{ vars.{VARIABLE} || 'flat' }}}}"
    assert forward in read(WORKFLOW), (
        f'{WORKFLOW.name} does not forward {VARIABLE} as `{forward}`. This is the line whose absence '
        'made the `idf` candidate unreachable from the arm: the reader honoured the variable and nothing '
        'could set it.'
    )


def test_the_workflow_did_not_spend_a_dispatch_input_on_it() -> None:
    """The reason it is a repository variable: GitHub caps `workflow_dispatch` at 25 inputs.

    Read from the file rather than asserted in prose, because the tempting repair -- "add an input, it is
    one line" -- is the one that puts this workflow at the ceiling and breaks the next mechanism that
    genuinely needs an input.
    """
    workflow = read(WORKFLOW)
    block = re.search(r'\non:\n(.*?)\n\w', workflow, re.S)
    assert block is not None, 'the workflow has no `on:` block'
    inputs = re.findall(r'^      (\w+):$', block.group(1), re.M)
    assert 0 < len(inputs) < 25, (
        f'{WORKFLOW.name} declares {len(inputs)} dispatch inputs; GitHub refuses more than 25 and this '
        'repository keeps one in hand. A new condition travels as a repository variable instead.'
    )
    assert 'lexical_weighting' not in inputs, (
        'the weighting was added as a dispatch input as well as a repository variable: two sources for '
        'one field, and the artifact cannot say which one won.'
    )


def test_the_dispatcher_writes_the_variable_before_it_dispatches() -> None:
    """Unconditionally, and before the POST.

    Before, because the workflow reads the variable when the job starts. Unconditionally, because the
    reset is the protection: an inherited `idf` is a treatment nobody named on a run that was meant to
    be the control, and the artifact -- which records the weighting -- would be accurate about it.
    """
    dispatch = read(DISPATCH)
    write = 'write_variable(LEXICAL_WEIGHTING_VARIABLE, lexical_weighting)'
    assert write in dispatch, f'{DISPATCH.name} never writes {VARIABLE}.'
    assert dispatch.index(write) < dispatch.index(
        'actions/workflows/{WORKFLOW}/dispatches'
    ), 'the variable is written after the dispatch, so it describes the next run rather than this one'


def test_the_dispatcher_refuses_a_weighting_the_arm_cannot_administer() -> None:
    """Executed rather than grepped: a `raise` on an unreachable branch passes a source-level check.

    `test_dispatch_overrides.py` records that importing this module must not require a credential, so the
    switch can be called directly. A refusal that refuses everything is not a grammar, so the legal states
    are asserted beside it -- including the absent one, which is the registration.
    """
    module = load(DISPATCH, 'dispatch_cortex_memory_ab')
    for bad in ('tf-idf', 'FLAT', 'bm25', 'none', 'true', '0', ' '):
        if bad == ' ':
            # Whitespace only: an unset variable as GitHub writes it, which is the registered arm.
            assert module.lexical_weighting_switch({VARIABLE: bad}) == 'flat'
            continue
        with pytest.raises(SystemExit):
            module.lexical_weighting_switch({VARIABLE: bad})
    assert module.lexical_weighting_switch({}) == 'flat'
    assert module.lexical_weighting_switch({VARIABLE: ' idf '}) == 'idf'
    assert module.lexical_weighting_switch({VARIABLE: 'flat'}) == 'flat'


def test_the_departure_is_declared_only_when_the_weighting_moves() -> None:
    """Read from the declaration block itself, not from the file.

    The same comparison appears in the line that prints the value, so a file-wide search passes on a
    declaration that has been made unconditional -- and an unconditional one makes every control run
    report a departure it did not make.
    """
    block = re.search(r'declared = sorted\(\s*\{.*?\n    \)\n', read(DISPATCH), re.S)
    assert block is not None, 'the dispatcher has no `declared = sorted({...})` block'
    entry = re.search(
        r'\*\(\(["\']lexicalWeighting["\'],\) if lexical_weighting != ["\']flat["\'] else \(\)\)',
        block.group(0),
    )
    assert entry is not None, (
        'the departure declaration does not name `lexicalWeighting` under the `!= flat` condition, so an '
        '`idf` dispatch is filed as a measurement of the configuration the project ships'
    )


def test_the_gate_holds_the_condition_at_the_value_the_shipped_arm_writes() -> None:
    """The value, not just the name: a wrong registered constant refuses every registered run.

    `flat` is read from the dispatcher's own default rather than typed again here, so the two files cannot
    disagree about what "unset" means.
    """
    module = load(DISPATCH, 'dispatch_cortex_memory_ab')
    gate = load(READOUT, 'readout_arm_run')
    shipped = module.lexical_weighting_switch({})
    assert 'lexicalWeighting' in gate.REGISTERED_CONDITIONS, (
        'the registration gate has no seat for `lexicalWeighting`, so a declared `idf` run is refused '
        'after the money is spent -- the `S14` failure in the other direction'
    )
    path, registered = gate.REGISTERED_CONDITIONS['lexicalWeighting']
    assert path == 'lexicalWeighting', (
        f'the condition is compared at {path!r}: a path that is not its own name compares a different '
        'field and reports agreement it never read'
    )
    assert registered == shipped, (
        f'the gate holds {registered!r} and the shipped arm writes {shipped!r}, so every run that leaves '
        'the weighting alone departs from the registration'
    )


def test_the_arms_vocabulary_is_the_dispatchers_vocabulary() -> None:
    """Two copies of one two-valued grammar, held to each other by reading both.

    The dependency direction makes the copies unavoidable: `cortex-eval` cannot import a Python tool. What
    is avoidable is drift, and the drift's shape here is specific -- the dispatcher accepts a name the arm
    refuses, so the preflight passes and the run dies in the reader, or the reverse, and the dispatch
    silently runs the registered arm under the candidate's label.
    """
    module = load(DISPATCH, 'dispatch_cortex_memory_ab')
    arm = read(ARM)
    grammar = re.search(r'const LEXICAL_WEIGHTINGS: readonly string\[\] = \[(.*?)\];', arm, re.S)
    assert grammar is not None, 'the arm has no `LEXICAL_WEIGHTINGS` grammar'
    arm_names = sorted(re.findall(r"'(\w+)'", grammar.group(1)))
    assert arm_names == sorted(module.LEXICAL_WEIGHTINGS), (
        f'the arm accepts {arm_names} and the dispatcher accepts {sorted(module.LEXICAL_WEIGHTINGS)}.'
    )
    default = re.search(r"const DEFAULT_LEXICAL_WEIGHTING = '(\w+)'", arm)
    assert default is not None and default.group(1) == module.lexical_weighting_switch({}), (
        'the arm default and the dispatcher default disagree, so an unset variable means two things '
        'depending on which side of the dispatch is asked'
    )
