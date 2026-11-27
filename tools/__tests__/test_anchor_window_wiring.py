#!/usr/bin/env python3
"""The fourth evidence unit can be reached by a dispatch, and every link of that chain is checked.

## Why this file exists

`anchor-window` is the one mechanism in this repository that had **every** link of requirement (16) and
still no reading: an implementation (`selectByAnchorWindow`), a compile-enforced forwarding table, an
arm-side grammar, a workflow input, and a dispatcher that can set it. What it did not have was a
dispatch, and the tracking report stopped mentioning it for about nine thousand lines after it was
registered (`04-execution-tracking-report.md` §17,924 against a file then well past §27,000).

`semanticCarry` failed the other way -- the mechanism existed and the link that would *administer* it
did not -- so the two failures are the same claim from two sides: a capability is only real when a
dispatch can reach it. The five links below are what this file pins, and each one is silent when it
breaks: no unit test of any single file fails, and the mechanism simply never runs.

| link | file | the failure if it is missing |
| --- | --- | --- |
| the product renders it | `packages/cortex-memory/src/prompt.ts` | the branch is unreachable and the unit silently degrades to `turn` |
| the arm parses it | `packages/cortex-eval/src/bench-memory-arm.ts` | an unrecognised value is refused at parse time, so the dispatch dies before spending |
| the arm can request it | `packages/cortex-memory/bench/run-ablation.ts` | the option is read and never forwarded -- `semanticCarry`'s exact failure |
| the workflow forwards it | `.github/workflows/benchmark-cortex-memory.yml` | every dispatch is the control whatever the operator asked for |
| the dispatcher can send it | `tools/dispatch-cortex-memory-ab.py` | the value is not in the table, so `--set` refuses it and the experiment cannot be asked for |

## What it deliberately does not check

Whether the unit raises accuracy. That is the dispatch's question, and its four predictions are
registered in `cortex-docs/docs/PREREGISTRATION-ANCHOR-WINDOW.md` before the run. Asserting a
direction here would make this file fail for a result rather than for a defect.

It also does not check the radius. ±2 is frozen from the reference implementation and is *not* a
dispatch axis, which is a decision recorded in the arm's own docblock and asserted below as an
absence: a radius input would be a second variable in a dispatch whose whole value is that it has one.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / '.github/workflows/benchmark-cortex-memory.yml'
DISPATCH = ROOT / 'tools/dispatch-cortex-memory-ab.py'
ARM = ROOT / 'packages/cortex-eval/src/bench-memory-arm.ts'
BENCH = ROOT / 'packages/cortex-memory/bench/run-ablation.ts'
PROMPT = ROOT / 'packages/cortex-memory/src/prompt.ts'

UNIT = 'anchor-window'
INPUT = 'cortex_memory_relevance_units'


def read(path: Path) -> str:
    return path.read_text(encoding='utf-8')


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_product_dispatches_to_the_anchor_selection_by_name() -> None:
    """The branch exists, it is keyed on the unit's own name, and it passes the validated radius.

    A branch that ran unconditionally would move every route's delivered set, which is why the guard is
    asserted rather than the call. A branch that passed `plan.windowRadius` straight through would hand
    the selection `undefined` and rely on a default one layer down -- the radius is validated at the
    dispatch point so the refusal names the value the caller supplied.
    """
    prompt = read(PROMPT)
    assert "plan.relevanceUnits === 'anchor-window'" in prompt, (
        'nothing in prompt.ts branches on the anchor unit, so `relevanceUnits=anchor-window` would be '
        'recorded by the arm and answered by the turn unit -- the §13.286.2 defect'
    )
    assert 'selectByAnchorWindow(' in prompt, (
        'the unit is named and no selection implements it, so the branch would fall through to the '
        'relevance prefix'
    )
    assert 'validateWindowRadius(plan.windowRadius)' in prompt, (
        'the radius reaches the selection unvalidated, so a fractional or negative radius would name no '
        'neighbourhood while the artifact reported the value the dispatch sent'
    )


def test_the_selection_can_never_carry_less_than_the_turn_unit() -> None:
    """The ladder's last rung, asserted on the source rather than trusted.

    The walk shrinks the window before the anchor and stops only when the anchor itself does not fit.
    That is what makes a tight room a fair comparison: at radius zero the delivered set is the turn
    unit's set, character for character, so a dispatch of this unit cannot be read as "the budget got
    smaller" when it is read as "the unit changed".
    """
    prompt = read(PROMPT)
    start = prompt.index('function selectByAnchorWindow(')
    body = prompt[start : start + 2600]
    assert 'for (let radius = windowRadius; radius >= 0; radius -= 1)' in body, (
        'the ladder does not descend to zero, so a room too small for a neighbourhood would end the '
        'pass with less evidence than the turn unit delivers'
    )
    assert 'if (!admitted) break;' in body, (
        'the walk does not stop when the anchor itself does not fit, so it would loop over the whole '
        'ranking after the room was gone'
    )


def test_the_arm_parses_the_unit_and_defaults_to_the_turn_unit() -> None:
    """Both halves, because either alone makes the artifact lie.

    An arm that did not accept the name would refuse the dispatch at parse time (cheap), while an arm
    whose default was the anchor unit would make every archived control a treatment.
    """
    arm = read(ARM)
    assert f"'{UNIT}': '{UNIT}'" in arm, (
        f'the arm grammar does not name {UNIT!r}, so readRelevanceUnits refuses every dispatch that '
        'asks for it'
    )
    assert re.search(r"const DEFAULT_RELEVANCE_UNITS = RELEVANCE_UNITS\.turn;", arm), (
        'the default unit is not `turn`: every archived artifact was produced under the turn unit and '
        'a different default would make each of them a treatment'
    )


def test_the_bench_forwards_the_unit_to_the_product() -> None:
    """`Record<RelevanceUnits, …>` is the guard; this checks the value, not the type.

    The table is exhaustive by construction, so a fifth unit cannot be added without naming its
    forwarding rule. What it cannot check is that the rule is *right*: mapping the anchor unit to
    `undefined` would compile, forward nothing, and run the turn unit under a configuration line that
    says otherwise.

    ## Why this is three assertions and used to be two

    The single line `relevanceUnits: forwardedUnit` was the edge between "the value was computed" and
    "the value reached the constructor", and it stopped existing when `CORTEX_MEMORY_AB=units` arrived:
    the wire is still one edge, but it now runs through `relevanceUnitOption`, because both sides of a
    `units` pair have to take the *same* path from an arm-level name to the constructor. A test that
    kept grepping for the old literal would have gone red on a correct change, and one that simply
    dropped the assertion would have stopped covering the `§13.286.2` defect it exists for -- the
    computed value travelling nowhere. So the edge is asserted where it now is, in three pieces: the
    helper, the call, and the translation the helper must not bypass.
    """
    bench = read(BENCH)
    assert f"'{UNIT}': '{UNIT}'," in bench, (
        'RELEVANCE_UNIT_FORWARDING does not map the anchor unit to itself, so the option would be '
        'dropped on the way to CortexMemory'
    )
    # 1. The helper is the only thing that turns an arm-level name into the constructor's option.
    assert re.search(
        r"function relevanceUnitOption\(units: RelevanceUnits\).*?return forwarded === undefined \? \{\} : \{ relevanceUnits: forwarded \};",
        bench,
        re.S,
    ), (
        'relevanceUnitOption does not build `{ relevanceUnits: forwarded }`, so the forwarded value '
        'would have no way to reach the constructor'
    )
    # 2. It reads the table rather than the name, because a second translation is a second place to be wrong.
    helper = bench.split('function relevanceUnitOption', 1)
    assert len(helper) == 2, 'the bench has no `relevanceUnitOption` to read'
    assert 'relevanceUnitToForward(units)' in helper[1][:400], (
        'relevanceUnitOption does not call relevanceUnitToForward, so it would forward an arm-level '
        'name the table never validated'
    )
    # 3. The constructor spreads it. This is the assertion the old literal carried.
    assert '...relevanceUnitOption(treatment.units)' in bench, (
        'the forwarded value is computed and never handed to the product'
    )


def test_the_workflow_forwards_the_input_and_says_the_value_exists() -> None:
    """Two failures, one line and one description.

    The env line is what carries the value; the description is what an operator reads *before* choosing
    it. `anchor-window` was reachable and undescribed for as long as it existed, which is the gap this
    round closes -- a mechanism with no reading and no documentation is one nobody can ask for.
    """
    workflow = read(WORKFLOW)
    assert (
        'CORTEX_MEMORY_RELEVANCE_UNITS: ${{ github.event.inputs.cortex_memory_relevance_units }}'
        in workflow
    ), f'{WORKFLOW.name} does not forward {INPUT} into the environment'
    description = re.search(
        r'cortex_memory_relevance_units:\n\s+description: \'(.*?)\'\n', workflow, re.S
    )
    assert description is not None, 'the input has no description'
    assert UNIT in description.group(1), (
        'the description does not name the anchor unit, so an operator reading the dispatch form cannot '
        'learn that the value exists'
    )


def test_the_dispatcher_can_send_the_unit_and_would_declare_it() -> None:
    """Executed, not grepped: `--set` is what an experiment uses, and the declaration is derived from it.

    The departure list is computed from the difference between the merged inputs and the registered
    table, so a value set through `--set` is declared without a second line to keep in step. That is
    why the assertion is on the *behaviour*: a table entry that normalised the value would still pass a
    grep and fail here.
    """
    module = load(DISPATCH, 'dispatch_cortex_memory_ab')
    assert INPUT in module.INPUTS, (
        f'{DISPATCH.name} does not send {INPUT}, so --set refuses the key and the experiment cannot be '
        'asked for'
    )
    assert module.INPUTS[INPUT] == 'turn', (
        'the registered configuration is not the turn unit, so every control dispatch would be filed as '
        'a departure it did not make'
    )
    merged = module.apply_overrides(module.INPUTS, [f'{INPUT}={UNIT}'])
    assert merged[INPUT] == UNIT
    assert module.departures(merged) == [INPUT], (
        'a --set of the unit does not appear as a departure, so the gate would refuse the run after the '
        'money was spent -- or, worse, accept it as the registered configuration'
    )


def test_the_radius_is_not_a_dispatch_axis() -> None:
    """An absence, asserted because the temptation to add it is real and the cost is a lost input slot.

    The workflow sits at 24 of GitHub's 25 dispatch inputs and the radius is the reference
    implementation's frozen value. A radius axis would make every future anchor reading a two-variable
    one, and the first thing a reader would want -- "which radius was this?" -- is answered by the unit
    name and the product default rather than by a field.
    """
    workflow = read(WORKFLOW)
    assert 'window_radius' not in workflow and 'WINDOW_RADIUS' not in workflow, (
        'a radius input or variable exists: it would be a second variable in a dispatch whose value is '
        'that it has one, and it would spend the last input slot'
    )
    prompt = read(PROMPT)
    assert 'const DEFAULT_WINDOW_RADIUS' in prompt, (
        'the product has no frozen radius, so "anchor-window" alone does not name a window'
    )
