#!/usr/bin/env python3
"""The layered rendering can be reached by a dispatch, and every link of that chain is checked.

## Why this file exists

`§14.133.2` registers `C7`: the same room, printed by form, so the selector -- untouched -- reaches further
down the same ranking. It is the only remaining path to `C1` (6,000 prompt tokens against the registered
7,448), because both measured cost routes pay in accuracy and the instruction block is 0.76% of a prompt.

`resolution.ts` is unit-tested against six invariants and both builders are covered by
`resolution-reach.test.ts`. Neither can show that a *dispatch* can ask for it, and this repository has paid
for that distinction once already: `semanticCarry` existed, was documented, had tests, and had no on-switch
in any measurement this project can run, so exit criterion `E6` was recorded as `unrun` as though the
obstacle were a dispatch.

| link | file | the failure if it is missing |
| --- | --- | --- |
| the product renders it | `packages/cortex-memory/src/prompt.ts` | the module exists and every turn prints whole |
| the budget agrees with it | `packages/cortex-memory/src/memory.ts` | a plan that budgets raw lengths against a by-form rendering -- the `43259468403` defect, and this mechanism creates its opportunity |
| the arm can ask for it | `packages/cortex-memory/bench/run-ablation.ts` | the option exists, the variable is parsed, and the treatment is never administered |
| the arm records it | `packages/cortex-eval/src/bench-memory-arm.ts` + `report.ts` | a by-form run is indistinguishable from one that predates the field |
| the workflow forwards it | `.github/workflows/benchmark-cortex-memory.yml` | every dispatch is the control whatever the operator asked for |
| the dispatcher writes and declares it | `tools/dispatch-cortex-memory-ab.py` | a stale `layered` renders the next control run by form, and an undeclared one is refused after the money is spent |

## What it deliberately does not check

Whether the forms raise accuracy or lower the bill. Both need a dispatch in which the control and the
treatment are the same job (`§11.13`: the cross-dispatch floor is 0.70 points), and asserting a direction
here would make this file fail for a result rather than for a defect.
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
BENCH = ROOT / 'packages/cortex-memory/bench/run-ablation.ts'
PROMPT = ROOT / 'packages/cortex-memory/src/prompt.ts'
MEMORY = ROOT / 'packages/cortex-memory/src/memory.ts'

VARIABLE = 'CORTEX_MEMORY_RESOLUTION'


def read(path: Path) -> str:
    return path.read_text(encoding='utf-8')


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_renderer_has_a_branch_that_no_other_option_can_reach() -> None:
    """The first link. Gated on the option *and* on the question, because a form with no question is the
    head cut wearing a new name: `excerpt` is chosen by whether the turn shares a term with it.
    """
    prompt = read(PROMPT)
    assert "cap.resolution === 'layered'" in prompt, (
        'cappedContent never branches on the resolution, so the module is a function no prompt calls'
    )
    assert 'resolveCappedTurn(cap.focusQuery, turn.content, max)' in prompt, (
        'the branch is present and the form is not computed from the question, which is the same failure '
        'one line later: every turn would render as the head'
    )
    # The dateline is not the ceiling's to spend, and the shared function is what guarantees it for both
    # the renderer and the budget.
    assert 'function needsQuestion(' in prompt, (
        'the two builders decide independently whether to hand the renderer the question; that is how a '
        'route ends up rendering the head under a configuration line that names the form list'
    )


def test_the_budget_and_the_renderer_call_one_function() -> None:
    """`43259468403` is the reason this is asserted rather than assumed.

    That dispatch was cancelled because a plan budgeted raw lengths against a 400-character rendering. The
    layered rendering makes the same mistake available in a new place: `min(length, cap)` is no longer what
    a turn costs, so an estimate left unchanged would under-fund the room on exactly the turns the
    mechanism shortens.
    """
    memory = read(MEMORY)
    assert 'resolveCappedTurn(question, turn.content, cap).chars' in memory, (
        '#renderedChars still estimates min(length, cap) under `layered`, so the plan and the prompt '
        'disagree about what a turn costs -- the defect `43259468403` was cancelled for'
    )
    assert 'this.#renderedChars(question, turns, route)' in memory, (
        'the question is not passed to the estimate, so the excerpt form cannot be reproduced there'
    )


def test_the_product_refuses_the_configurations_that_could_not_act() -> None:
    """Two guards, both executed by `resolution-reach.test.ts`; asserted here because a guard that is only
    in a test file's fixtures is a guard no product run passes through.
    """
    memory = read(MEMORY)
    assert "options.resolution === 'layered' && options.maxTurnChars === undefined" in memory, (
        'layering without a width is accepted: the two form ceilings are ratios of the width, so there is '
        'no scale to take a ratio of and the option would do nothing'
    )
    assert "options.resolution === 'layered' && options.turnWindow === 'match'" in memory, (
        'the window and the excerpt form can both be on: two renderers deciding which characters of one '
        'turn survive, and no reading could attribute a movement to either'
    )


def test_the_arm_forwards_the_form_through_a_compile_enforced_table() -> None:
    """The link whose absence made `semanticCarry` unmeasurable for six rounds.

    A table rather than a cast, for `RELEVANCE_UNIT_FORWARDING`'s reason: a form added to the product's
    union has to be a build error here rather than a value that reaches a prompt as a string no renderer
    branched on. `raw` maps to `undefined` because that rendering is expressed by *not* passing the key.
    """
    bench = read(BENCH)
    table = re.search(r'const RESOLUTION_FORWARDING: Record<ResolutionMode, ResolutionMode \| undefined> = \{(.*?)\};', bench, re.S)
    assert table is not None, (
        'run-ablation.ts has no RESOLUTION_FORWARDING table: a form the product documents would have no '
        'forwarding rule and would silently render as `raw`'
    )
    entries = dict(re.findall(r"(\w+): (?:'(\w+)'|undefined)", table.group(1)))
    assert entries.get('layered') == 'layered', (
        f'`layered` forwards {entries.get("layered")!r}; a form that forwards nothing renders the control '
        'under the treatment\'s name'
    )
    assert entries.get('raw', None) in (None, ''), (
        '`raw` forwards a value: the historical rendering is expressed by not passing the key, so a run '
        'that names it must reproduce every archived prompt byte for byte'
    )
    assert "resolution: forwardedResolution ?? 'raw'" in bench, (
        'the table exists and its value never reaches the treatment the constructor is built from, which '
        'is the same failure one line later and the exact shape of `semanticCarry`'
    )
    assert 'resolution: treatment.resolution,' in bench, (
        'the treatment exists and its form never reaches CortexMemory. The chain is three links -- table to '
        '`armTreatment`, `armTreatment` to the constructor -- and a check on the first alone would pass a '
        'run in which the middle link still read `armOptions`, which is the control-against-control shape '
        'one flag over: `layered` would be `layered` per process and the pair would compare it to itself.'
    )
    # Named unconditionally, and that changed on the day the product's default did. The spread this line
    # replaces was `...(treatment.resolution === 'raw' ? {} : {...})`, whose comment said `raw` is
    # "expressed by not passing the key so the control reproduces every archived prompt byte for byte".
    # True while the class read an absent field as the head cut; false from `45543010618` on, because
    # `assembleMemory` now resolves the registered rendering -- so an omitted key renders **layered** on
    # the side whose artifact says `resolution=raw`, which is the configuration line and the prompt
    # disagreeing about which arm was administered. Asserted as an absence rather than left to the line
    # above: a spread reintroduced beside it would still contain the string that assertion looks for.
    assert "treatment.resolution === 'raw' ? {}" not in bench, (
        'the per-side rendering is spread conditionally again: `raw` is no longer expressed by omitting the '
        'key, so a control side that omits it renders the adopted forms under the control\'s label'
    )


def test_the_workflow_forwards_the_variable_with_a_literal_fallback() -> None:
    """`vars.X || 'raw'` rather than a bare `vars.X`, for the reason the switch uses `'off'`.

    A bare `vars.X` arrives as the empty string when the repository variable does not exist, and the arm's
    reader maps that to `raw` as well -- so the run is right either way and the workflow cannot say whether
    the variable was absent or empty.
    """
    forward = f"{VARIABLE}: ${{{{ vars.{VARIABLE} || 'raw' }}}}"
    assert forward in read(WORKFLOW), (
        f'{WORKFLOW.name} does not forward {VARIABLE} as `{forward}`. Without it the mechanism is '
        'reachable from no dispatch at all.'
    )


def test_the_workflow_did_not_spend_a_dispatch_input_on_it() -> None:
    """The reason it is a repository variable: GitHub caps `workflow_dispatch` at 25 inputs, and this
    workflow keeps one in hand.
    """
    workflow = read(WORKFLOW)
    block = re.search(r'\non:\n(.*?)\n\w', workflow, re.S)
    assert block is not None, 'the workflow has no `on:` block'
    inputs = re.findall(r'^      (\w+):$', block.group(1), re.M)
    assert 0 < len(inputs) < 25, (
        f'{WORKFLOW.name} declares {len(inputs)} dispatch inputs; GitHub refuses more than 25 and this '
        'repository keeps one in hand.'
    )
    assert 'resolution' not in inputs, (
        'the resolution was added as a dispatch input as well as a repository variable: two sources for '
        'one field, and the artifact cannot say which one won'
    )


def test_the_dispatcher_writes_the_variable_before_it_dispatches() -> None:
    """Before, because the workflow reads it when the job starts. Unconditionally, because the reset is the
    protection: an inherited `layered` renders a run that asked for the control by form.
    """
    dispatch = read(DISPATCH)
    write = 'write_variable(RESOLUTION_VARIABLE, resolution)'
    assert write in dispatch, f'{DISPATCH.name} never writes {VARIABLE}.'
    assert dispatch.index(write) < dispatch.index(
        'actions/workflows/{WORKFLOW}/dispatches'
    ), 'the variable is written after the dispatch, so it describes the next run rather than this one'


def test_the_dispatcher_refuses_a_rendering_the_arm_cannot_administer() -> None:
    """Executed rather than grepped, and `layerd` is in the list on purpose: a misspelling is the obvious
    outcome of dispatching by hand, and it must be a refusal rather than a silently-rendered control
    published under the treatment's name.
    """
    module = load(DISPATCH, 'dispatch_cortex_memory_ab')
    for bad in ('layerd', 'Layered', 'true', 'on', '1', 'RAW'):
        with pytest.raises(SystemExit):
            module.resolution_switch({VARIABLE: bad})
    assert module.resolution_switch({}) == 'raw'
    assert module.resolution_switch({VARIABLE: '   '}) == 'raw'
    assert module.resolution_switch({VARIABLE: ' layered '}) == 'layered'
    assert module.resolution_switch({VARIABLE: 'raw'}) == 'raw'


def test_the_departure_is_declared_only_when_the_form_moves() -> None:
    """Read from the declaration block itself, not from the file: the same comparison appears in the line
    that prints the value, so a file-wide search passes on a declaration that has been made unconditional
    -- and an unconditional one makes every control run report a departure it did not make.
    """
    block = re.search(r'declared = sorted\(\s*\{.*?\n    \)\n', read(DISPATCH), re.S)
    assert block is not None, 'the dispatcher has no `declared = sorted({...})` block'
    entry = re.search(
        r'\*\(\(["\']resolution["\'],\) if resolution != ["\']raw["\'] else \(\)\)',
        block.group(0),
    )
    assert entry is not None, (
        'the departure declaration does not name `resolution` under the `!= raw` condition, so a '
        '`layered` dispatch is filed as a measurement of the configuration the project ships'
    )


def test_the_gate_holds_the_condition_at_the_value_the_shipped_arm_writes() -> None:
    """The value, not just the name: a wrong registered constant refuses every registered run."""
    module = load(DISPATCH, 'dispatch_cortex_memory_ab')
    gate = load(READOUT, 'readout_arm_run')
    shipped = module.resolution_switch({})
    assert 'resolution' in gate.REGISTERED_CONDITIONS, (
        'the registration gate has no seat for `resolution`, so a declared `layered` run is refused after '
        'the money is spent -- the `S14` failure in the other direction'
    )
    path, registered = gate.REGISTERED_CONDITIONS['resolution']
    assert path == 'resolution', (
        f'the condition is compared at {path!r}: a path that is not its own name compares a different '
        'field and reports agreement it never read'
    )
    assert registered == shipped, (
        f'the gate holds {registered!r} and the shipped arm writes {shipped!r}, so every run that leaves '
        'the rendering alone departs from the registration'
    )


def test_the_arms_vocabulary_is_the_dispatchers_vocabulary() -> None:
    """Two copies of one two-valued grammar, held to each other by reading both."""
    module = load(DISPATCH, 'dispatch_cortex_memory_ab')
    arm = read(ARM)
    grammar = re.search(r'const RESOLUTIONS: readonly string\[\] = \[(.*?)\];', arm, re.S)
    assert grammar is not None, 'the arm has no `RESOLUTIONS` grammar'
    arm_names = sorted(re.findall(r"'(\w+)'", grammar.group(1)))
    assert arm_names == sorted(module.RESOLUTIONS), (
        f'the arm accepts {arm_names} and the dispatcher accepts {sorted(module.RESOLUTIONS)}.'
    )
    default = re.search(r"const DEFAULT_RESOLUTION = '(\w+)'", arm)
    assert default is not None and default.group(1) == module.resolution_switch({}), (
        'the arm default and the dispatcher default disagree, so an unset variable means two things '
        'depending on which side of the dispatch is asked'
    )


def test_the_artifact_records_the_form_on_every_run() -> None:
    """Projected rather than conditional: `raw` is a state a run is dispatched to.

    Without an always-present field, an artifact that omitted it and one that recorded `raw` would be the
    same bytes, and a reader comparing a by-form run against an archived control could not tell which of
    the two it was looking at.
    """
    arm = read(ARM)
    assert 'resolution: options.resolution ?? DEFAULT_RESOLUTION' in arm, (
        'the artifact projection omits the rendering when it is unset, so "ran the control" and "predates '
        'the field" are the same row'
    )
    report = read(ROOT / 'packages/cortex-eval/src/report.ts')
    assert 'resolution=${memoryArm.resolution ?? ' in report, (
        'the run line does not print the rendering, so a reader comparing two runs has to open the JSON to '
        'learn which one printed by form'
    )
