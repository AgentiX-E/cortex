#!/usr/bin/env python3
"""The boundary clock can be reached by a dispatch, and every link of that chain is checked.

## Why this file exists

`§13.386` ships a rendering mechanism -- each session boundary carries the date its block states -- because
the failure it addresses is measured: in `44017278305` (`S16`) a reply that repeats one date across three or
more items occurs in **17 of the 57** questions that are ever wrong (29.8%) and in **39 of the 443** that
never are (8.8%), 3.39 times the rate,
and 0 of that artifact's 41,822 delivered turns lack a timestamp. The product can now render the label; what
this file pins is that a dispatch can *ask for it*.

That distinction is the whole point, and it has already cost this project six rounds once. `semanticCarry`
existed, was documented, had tests, and had no on-switch in any measurement this project can run -- so exit
criterion E6 was recorded as `unrun` as though the obstacle were a dispatch. Here the chain has five links,
and any one of them missing makes the mechanism unmeasurable while every unit test stays green:

| link | file | the failure if it is missing |
| --- | --- | --- |
| the product renders it | `packages/cortex-memory/src/memory.ts` | the module exists and no prompt ever carries it |
| the arm can ask for it | `packages/cortex-memory/bench/run-ablation.ts` | the option is documented, the variable is parsed, and the treatment is never administered -- `semanticCarry`'s exact failure |
| the arm records it | `packages/cortex-eval/src/bench-memory-arm.ts` + `report.ts` | a run that administered it is indistinguishable from one that predates the field |
| the workflow forwards it | `.github/workflows/benchmark-cortex-memory.yml` | every dispatch is the control whatever the operator asked for |
| the dispatcher writes and declares it | `tools/dispatch-cortex-memory-ab.py` | a stale `on` labels the next control run's boundaries, and an undeclared `on` is refused after the money is spent |

## What it deliberately does not check

Whether the label raises accuracy. That needs a dispatch in which the control and the treatment are the same
job -- `§11.13` measured the cross-dispatch floor at **0.70 points**, and this mechanism's plausible effect is
smaller than that -- so asserting a direction here would make this file fail for a result rather than for a
defect.
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
PRODUCT = ROOT / 'packages/cortex-memory/src/memory.ts'

VARIABLE = 'CORTEX_MEMORY_SESSION_CLOCK'


def read(path: Path) -> str:
    return path.read_text(encoding='utf-8')


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_product_applies_the_label_on_the_route_that_draws_boundaries() -> None:
    """The first link, and the one a unit test of the module cannot cover.

    `annotateSessionBoundaries` being correct is not the same as any prompt carrying it: the call has to sit
    on the multi-session path, after the budget, and be gated by the option. Asserted as three separate facts
    because each one alone is a mechanism that does nothing.
    """
    product = read(PRODUCT)
    assert 'annotateSessionBoundaries(assembled.prompt)' in product, (
        'the multi-session path never applies the label, so the mechanism is a function nobody calls'
    )
    assert 'this.#options.sessionClock === true' in product, (
        'the label is applied unconditionally: an unmeasured mechanism would then move the scored path '
        'silently, which is the rule every treatment in this package follows'
    )
    # After the assembly, not inside it: the clip path ends inside a turn, so a label computed from the
    # selected turns can print a date the reader never received.
    assert product.index('buildSessionPrompt(') < product.index(
        'annotateSessionBoundaries(assembled.prompt)'
    ), 'the label is applied before the budget decided what to render'


def test_the_arm_can_administer_the_treatment_it_reads_a_variable_for() -> None:
    """The link whose absence made `semanticCarry` unmeasurable for six rounds.

    The option type, the env reader and the artifact projection all lived in `cortex-eval`, and the object
    that actually receives the option is built in `run-ablation.ts`. Without the spread below, a dispatch
    sent to label boundaries would render the control, record `sessionClock=on` (the arm's own echo) and
    publish an unchanged number -- a false negative that looks exactly like a real one.
    """
    bench = read(BENCH)
    assert "armOptions.sessionClock === 'on'" in bench, (
        'run-ablation.ts never forwards the switch to CortexMemory: the dispatch would record a treatment '
        'it did not administer'
    )
    assert '{ sessionClock: true }' in bench, (
        'the switch is read and the option is not passed, which is the same failure one line later'
    )


def test_the_workflow_forwards_the_variable_with_a_literal_fallback() -> None:
    """`vars.X || 'off'` rather than a bare `vars.X`, for the reason the weighting uses `'flat'`.

    A bare `vars.X` arrives as the empty string when the repository variable does not exist, and the arm's
    reader maps that to `off` as well -- so the run is right either way and the workflow cannot say whether
    the variable was absent or empty. The literal states the intended value in the file that would otherwise
    inherit it, which is the difference between a default and an accident.
    """
    forward = f"{VARIABLE}: ${{{{ vars.{VARIABLE} || 'off' }}}}"
    assert forward in read(WORKFLOW), (
        f'{WORKFLOW.name} does not forward {VARIABLE} as `{forward}`. Without it the mechanism is '
        'reachable from no dispatch at all.'
    )


def test_the_workflow_did_not_spend_a_dispatch_input_on_it() -> None:
    """The reason it is a repository variable: GitHub caps `workflow_dispatch` at 25 inputs."""
    workflow = read(WORKFLOW)
    block = re.search(r'\non:\n(.*?)\n\w', workflow, re.S)
    assert block is not None, 'the workflow has no `on:` block'
    inputs = re.findall(r'^      (\w+):$', block.group(1), re.M)
    assert 0 < len(inputs) < 25, (
        f'{WORKFLOW.name} declares {len(inputs)} dispatch inputs; GitHub refuses more than 25 and this '
        'repository keeps one in hand.'
    )
    assert 'session_clock' not in inputs, (
        'the clock was added as a dispatch input as well as a repository variable: two sources for one '
        'field, and the artifact cannot say which one won.'
    )


def test_the_dispatcher_writes_the_variable_before_it_dispatches() -> None:
    """Unconditionally, and before the POST.

    Before, because the workflow reads the variable when the job starts. Unconditionally, because the reset
    is the protection: an inherited `on` labels the boundaries of a run that asked for the control, and the
    artifact -- which records the switch -- would be accurate about the wrong run.
    """
    dispatch = read(DISPATCH)
    write = 'write_variable(SESSION_CLOCK_VARIABLE, session_clock)'
    assert write in dispatch, f'{DISPATCH.name} never writes {VARIABLE}.'
    assert dispatch.index(write) < dispatch.index(
        'actions/workflows/{WORKFLOW}/dispatches'
    ), 'the variable is written after the dispatch, so it describes the next run rather than this one'


def test_the_dispatcher_refuses_a_switch_the_arm_cannot_administer() -> None:
    """Executed rather than grepped, and `true` is in the list on purpose.

    A boolean is the obvious spelling of this switch and the one that would cost a dispatch: it must be a
    refusal, not a silently-rendered control published under the treatment's name.
    """
    module = load(DISPATCH, 'dispatch_cortex_memory_ab')
    for bad in ('true', 'ON', '1', 'yes', 'false'):
        with pytest.raises(SystemExit):
            module.session_clock_switch({VARIABLE: bad})
    assert module.session_clock_switch({}) == 'off'
    assert module.session_clock_switch({VARIABLE: '   '}) == 'off'
    assert module.session_clock_switch({VARIABLE: ' on '}) == 'on'
    assert module.session_clock_switch({VARIABLE: 'off'}) == 'off'


def test_the_departure_is_declared_only_when_the_clock_moves() -> None:
    """Read from the declaration block itself, not from the file.

    The same comparison appears in the line that prints the value, so a file-wide search passes on a
    declaration that has been made unconditional -- and an unconditional one makes every control run report
    a departure it did not make.
    """
    block = re.search(r'declared = sorted\(\s*\{.*?\n    \)\n', read(DISPATCH), re.S)
    assert block is not None, 'the dispatcher has no `declared = sorted({...})` block'
    entry = re.search(
        r'\*\(\(["\']sessionClock["\'],\) if session_clock != ["\']off["\'] else \(\)\)',
        block.group(0),
    )
    assert entry is not None, (
        'the departure declaration does not name `sessionClock` under the `!= off` condition, so an `on` '
        'dispatch is filed as a measurement of the configuration the project ships'
    )


def test_the_gate_holds_the_condition_at_the_value_the_shipped_arm_writes() -> None:
    """The value, not just the name: a wrong registered constant refuses every registered run."""
    module = load(DISPATCH, 'dispatch_cortex_memory_ab')
    gate = load(READOUT, 'readout_arm_run')
    shipped = module.session_clock_switch({})
    assert 'sessionClock' in gate.REGISTERED_CONDITIONS, (
        'the registration gate has no seat for `sessionClock`, so a declared `on` run is refused after the '
        'money is spent -- the `S14` failure in the other direction'
    )
    path, registered = gate.REGISTERED_CONDITIONS['sessionClock']
    assert path == 'sessionClock', (
        f'the condition is compared at {path!r}: a path that is not its own name compares a different field '
        'and reports agreement it never read'
    )
    assert registered == shipped, (
        f'the gate holds {registered!r} and the shipped arm writes {shipped!r}, so every run that leaves the '
        'clock alone departs from the registration'
    )


def test_the_arms_vocabulary_is_the_dispatchers_vocabulary() -> None:
    """Two copies of one two-valued grammar, held to each other by reading both."""
    module = load(DISPATCH, 'dispatch_cortex_memory_ab')
    arm = read(ARM)
    grammar = re.search(r'const SESSION_CLOCKS: readonly string\[\] = \[(.*?)\];', arm, re.S)
    assert grammar is not None, 'the arm has no `SESSION_CLOCKS` grammar'
    arm_names = sorted(re.findall(r"'(\w+)'", grammar.group(1)))
    assert arm_names == sorted(module.SESSION_CLOCKS), (
        f'the arm accepts {arm_names} and the dispatcher accepts {sorted(module.SESSION_CLOCKS)}.'
    )
    default = re.search(r"const DEFAULT_SESSION_CLOCK = '(\w+)'", arm)
    assert default is not None and default.group(1) == module.session_clock_switch({}), (
        'the arm default and the dispatcher default disagree, so an unset variable means two things '
        'depending on which side of the dispatch is asked'
    )


def test_the_artifact_records_the_switch_on_every_run() -> None:
    """Projected rather than conditional: `off` is a state a run can be dispatched to.

    Without an always-present field, an artifact that omitted it and one that recorded `off` would be the
    same bytes, and a reader comparing a labelled run against an archived control could not tell which of
    the two it was looking at.
    """
    arm = read(ARM)
    assert 'sessionClock: options.sessionClock ?? DEFAULT_SESSION_CLOCK' in arm, (
        'the artifact projection omits the switch when it is unset, so "ran the control" and "predates the '
        'field" are the same row'
    )
    report = read(ROOT / 'packages/cortex-eval/src/report.ts')
    assert 'sessionClock=${memoryArm.sessionClock ?? ' in report, (
        'the run line does not print the switch, so a reader comparing two runs has to open the JSON to '
        'learn which one labelled the boundaries'
    )


# The pairing, which is the link the round that shipped this file could not build.
#
# The five links above make the treatment *reachable*. They do not make it *attributable*: with
# `CORTEX_MEMORY_AB` unset the baseline is the reference pipeline, so a dispatch that turns the clock on
# measures the clock plus the whole cognitive layer, and the mechanism's own criterion (`§131 §3`, `C1`)
# reads a paired movement that such a run cannot produce. `pairing=clock` is what puts the same system on
# both sides, and the two tests below pin the two places it could be missing.
PAIRED = ROOT / '.github/workflows/semantic-carry.yml'
PAIR_DISPATCH = ROOT / 'tools/dispatch-semantic-carry.py'


def test_the_paired_workflow_derives_the_clock_from_the_pairing() -> None:
    """Derived, not read from a second variable, and the difference is what makes the pair a pair.

    `benchmark-cortex-memory.yml` forwards the clock from `vars.CORTEX_MEMORY_SESSION_CLOCK` because there
    the clock is a treatment layered on the registered pair and needs a channel of its own. Here the clock
    *is* the pairing, so a repository variable would let a dispatch send `pairing=clock` with the treatment
    off -- two sources for one field, and an artifact whose `clockPair` and `sessionClock` disagree.
    """
    workflow = read(PAIRED)
    forward = "CORTEX_MEMORY_SESSION_CLOCK: ${{ inputs.pairing == 'clock' && 'on' || 'off' }}"
    assert forward in workflow, (
        f'{PAIRED.name} does not derive {VARIABLE} from `pairing`. Without it a `clock` dispatch renders the '
        'control on both sides and its delta is zero while its config claims a treatment.'
    )
    assert f'{VARIABLE}: ${{{{ vars.' not in workflow, (
        'the paired workflow also reads a repository variable for the same switch: two sources for one '
        'field, and the artifact cannot say which one won'
    )


def test_the_pair_dispatcher_and_the_arm_agree_on_the_closed_set() -> None:
    """Two copies of one grammar, held to each other by reading both.

    The dispatcher refuses a value the arm would throw on, but only after the run is accepted and billed --
    so the check is a money gate, and a money gate whose vocabulary drifted from the arm's would pass a typo
    straight through to the arm.
    """
    module = load(PAIR_DISPATCH, 'dispatch_semantic_carry')
    source = read(ROOT / 'packages/cortex-eval/src/arm-pairing.ts')
    union = re.search(r"type ArmPairing = ([^;]+);", source)
    assert union is not None, 'arm-pairing.ts has no `ArmPairing` union'
    arm_names = sorted(re.findall(r"'(\w+)'", union.group(1)))
    assert arm_names == sorted(module.PAIRINGS), (
        f'the arm builds {arm_names} and the paired dispatcher accepts '
        f'{sorted(module.PAIRINGS)}: a dispatch of the missing one is billed and then refused by the arm.'
    )
    assert 'reference' in module.PAIRINGS, (
        'the registered pair is missing from the dispatcher vocabulary, so the control dispatch this '
        'instrument is read against cannot be sent'
    )
