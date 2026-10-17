"""The dispatch script's input overrides, and why they cannot be silent.

`tools/dispatch-cortex-memory-ab.py` carries a literal `INPUTS` table, one dispatch per
campaign section edited into it. That was workable while every dispatch changed the
constant it needed, and it stops being workable the moment two dispatches differ by one
input: editing the table for the second one loses the record of what the first one sent.

`--set KEY=VALUE` is the override, and the property that matters is that a **typo fails
loudly**. A silently-ignored override would dispatch the previous configuration and report
the new one in its commit message, which is §13.34.6's defect class -- a check that is not
a check -- applied to the thing that decides what an experiment is.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / 'tools' / 'dispatch-cortex-memory-ab.py'


def _module():  # noqa: ANN202 - the dispatch script, imported by path
    spec = importlib.util.spec_from_file_location('dispatch_cortex_memory_ab', SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestOverrides:
    def test_no_override_returns_the_table_unchanged(self) -> None:
        module = _module()
        assert module.apply_overrides(module.INPUTS, []) == module.INPUTS

    def test_an_override_replaces_exactly_one_value(self) -> None:
        module = _module()
        before = dict(module.INPUTS)
        after = module.apply_overrides(module.INPUTS, ['cortex_memory_relevance=none'])
        assert after['cortex_memory_relevance'] == 'none'
        assert {k: v for k, v in after.items() if k != 'cortex_memory_relevance'} == {
            k: v for k, v in before.items() if k != 'cortex_memory_relevance'
        }

    def test_an_override_does_not_mutate_the_table(self) -> None:
        """The table is module state, and a dispatch that edited it would edit the next one.

        Two dispatches in one process is not hypothetical: the campaign dispatches from a
        script that is re-imported between sections, and a mutated table would make the
        second dispatch's "held" values depend on the first's.
        """
        module = _module()
        before = dict(module.INPUTS)
        module.apply_overrides(module.INPUTS, ['cortex_memory_ask=computed'])
        assert module.INPUTS == before

    def test_an_empty_value_is_an_override_to_empty(self) -> None:
        # `cortex_memory_relevance=` is a meaningful value -- the workflow reads empty as
        # the shipped arrival-order prefix -- so it must not be mistaken for a missing value.
        module = _module()
        after = module.apply_overrides(module.INPUTS, ['cortex_memory_relevance='])
        assert after['cortex_memory_relevance'] == ''

    def test_a_value_containing_an_equals_sign_keeps_it(self) -> None:
        module = _module()
        after = module.apply_overrides(module.INPUTS, ['cortex_memory_prompt_contract=a=b'])
        assert after['cortex_memory_prompt_contract'] == 'a=b'


class TestTheRefusals:
    """Every way an override can be wrong, refused with a message that names it."""

    def test_an_unknown_key_is_refused(self) -> None:
        module = _module()
        with pytest.raises(SystemExit, match='cortex_memory_releavnce'):
            module.apply_overrides(module.INPUTS, ['cortex_memory_releavnce=none'])

    def test_the_refusal_lists_the_keys_that_exist(self) -> None:
        # A refusal that does not say what would have worked leaves the reader to read the
        # script, which is where the typo came from.
        module = _module()
        with pytest.raises(SystemExit, match='cortex_memory_relevance'):
            module.apply_overrides(module.INPUTS, ['cortex_memory_relevance_signal=none'])

    def test_a_missing_equals_is_refused(self) -> None:
        module = _module()
        with pytest.raises(SystemExit, match='KEY=VALUE'):
            module.apply_overrides(module.INPUTS, ['cortex_memory_relevance'])

    def test_two_overrides_for_one_key_are_refused(self) -> None:
        """The last-wins rule would make the argument order decide the experiment."""
        module = _module()
        with pytest.raises(SystemExit, match='twice'):
            module.apply_overrides(
                module.INPUTS,
                ['cortex_memory_relevance=none', 'cortex_memory_relevance=retrieval'],
            )

    def test_the_table_holds_every_key_the_workflow_declares(self) -> None:
        """The other direction: an override cannot name a key the workflow does not take.

        Read from the workflow rather than from a copy, so a key renamed on one side and not
        the other fails here instead of at dispatch -- where GitHub answers with a 422 whose
        message names nothing useful.
        """
        import re

        module = _module()
        workflow = (REPO / '.github' / 'workflows' / 'benchmark-cortex-memory.yml').read_text(
            encoding='utf-8'
        )
        block = workflow.split('workflow_dispatch:', 1)[1].split('jobs:', 1)[0]
        declared = set(re.findall(r'^ {6}([a-z_]+):$', block, re.MULTILINE))
        assert declared, 'no inputs parsed from the workflow'
        declared.add('cortex_memory')  # sent as `1`, and read by the bench entry point
        unknown = sorted(set(module.INPUTS) - declared)
        assert not unknown, f'INPUTS carries keys the workflow does not declare: {unknown}'
