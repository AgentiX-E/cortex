"""The dispatcher declares its own departures, so the gate has a producer.

`§13.220.5` installed a step that reads the artifact against the registration and fails on a
departure nobody named. `41560510937` was its first live catch, and it caught exactly the shape the
step was built for: a 60-question glm smoke whose artifact said `reader.model: "deepseek-chat"
(registered) -> "glm-4.6" (ran)`, whose gate reported *"the run is an experiment that has not said
so"*, and which exited 1 -- after producing a complete, correct, unthrottled measurement (237 of 237
requests clean, zero refusals).

The gate was right and useless: the declaration it compares against was a repository variable that
a human had to remember to set. A check whose input is a human's memory is the defect `§13.220`
wrote the check to remove, one level up. So the dispatcher -- the only process that knows which
inputs it moved -- writes the variable itself, before dispatching, always.

## Why every call here passes `--no-budget`

These tests are about which variable is written and in what order. The spend gate added in
`test_dispatch_spend.py` prices the dispatch before any of that and refuses a full pass at the
default ceiling, so a call that left it on would be asserting the gate rather than the order --
and would start failing the first time the baseline's price moved. Passing `--no-budget` states
which question each test is asking; the gate is measured in its own file, against its own two
configurations.
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


class TestTheDepartureList:
    def test_the_registered_configuration_declares_nothing(self) -> None:
        # The control, and the one that matters most: a registered dispatch must clear whatever the
        # last experiment left behind, or that experiment's declaration would excuse a run that
        # never made it.
        module = _module()
        assert module.departures(dict(module.INPUTS)) == []

    def test_a_moved_input_is_named_by_its_dispatch_name(self) -> None:
        # `model`, not `reader.model`: `--departs` resolves against the dispatch table, and the
        # artifact path is what the gate prints, not what it accepts. Naming the path would make
        # the declaration resolve to nothing, which is `§13.192.7.3` applied to the declaration.
        module = _module()
        inputs = dict(module.INPUTS, model='zhipu:glm-4.6')
        assert module.departures(inputs) == ['model']

    def test_an_input_set_to_its_registered_value_is_not_a_departure(self) -> None:
        # `--set limit=500` on a table that already says 500 moves nothing, and declaring it would
        # describe an intention rather than what ran.
        module = _module()
        inputs = dict(module.INPUTS)
        assert module.departures(inputs) == []
        inputs['limit'] = module.INPUTS['limit']
        assert module.departures(inputs) == []

    def test_several_moves_are_sorted_so_the_variable_is_stable(self) -> None:
        module = _module()
        inputs = dict(module.INPUTS, limit='60', model='zhipu:glm-4.6')
        assert module.departures(inputs) == ['limit', 'model']


class TestWritingTheVariable:
    def _recording(self, module, variables: list[dict]) -> list[tuple]:
        calls: list[tuple] = []

        def fake_req(method: str, path: str, payload=None, allow_empty: bool = False):  # noqa: ANN001, ANN202
            # `allow_empty` is recorded, not swallowed. It used to be a parameter this fake
            # accepted and dropped, which made every write path look identical to the test while
            # the PATCH branch was sending `allow_empty=False` to an endpoint that answers 204
            # with no body -- and the re-dispatch of §13.234 died on precisely that, after writing
            # the variable, leaving a declaration for a run that was never sent.
            calls.append((method, path, payload, allow_empty))
            if method == 'GET':
                return {'variables': variables}
            return None

        module.req = fake_req
        return calls

    def test_an_existing_variable_is_updated_rather_than_duplicated(self) -> None:
        module = _module()
        calls = self._recording(
            module, [{'name': 'CORTEX_MEMORY_WORKERS', 'value': '1'},
                     {'name': module.DECLARED_DEPARTURES_VARIABLE, 'value': 'limit'}]
        )
        module.declare_departures(['model'])
        writes = [call for call in calls if call[0] != 'GET']
        assert len(writes) == 1
        assert writes[0][0] == 'PATCH'
        assert writes[0][1].endswith(module.DECLARED_DEPARTURES_VARIABLE)
        assert writes[0][2]['value'] == 'model'
        # GitHub answers this endpoint 204 with no body, and `req` parses JSON: without the flag
        # the write succeeds and the process still exits, which is the worst of both.
        assert writes[0][3] is True

    def test_a_missing_variable_is_created(self) -> None:
        # The two branches are not symmetric in consequence: PATCHing a name that does not exist
        # is a 404 that `req` turns into a process exit, and that would be a dispatch that never
        # happened for a reason unrelated to the run.
        module = _module()
        calls = self._recording(module, [{'name': 'CORTEX_MEMORY_WORKERS', 'value': '1'}])
        module.declare_departures(['model'])
        writes = [call for call in calls if call[0] != 'GET']
        assert [call[0] for call in writes] == ['POST']
        assert writes[0][1].endswith('/actions/variables')
        assert writes[0][2]['value'] == 'model'
        # A create answers 201 with a body, so the flag is not needed here -- and asserting it is
        # absent keeps the two branches from silently acquiring the same call shape.
        assert writes[0][3] is False

    def test_an_empty_list_deletes_rather_than_writing_an_empty_value(self) -> None:
        # Found by calling the API once instead of trusting the fake: GitHub answers
        # `422 Variable value cannot be empty`, so a write here would crash the dispatcher on the
        # commonest dispatch there is -- a registered one. Absence is also the precise meaning,
        # because `vars.X` interpolates to the empty string when the variable does not exist.
        module = _module()
        calls = self._recording(module, [{'name': module.DECLARED_DEPARTURES_VARIABLE, 'value': 'model'}])
        module.declare_departures([])
        writes = [call for call in calls if call[0] != 'GET']
        assert [call[0] for call in writes] == ['DELETE']
        # 204 with no body, the same shape as the update branch and the same failure if unread.
        assert writes[0][3] is True
        assert writes[0][1].endswith(module.DECLARED_DEPARTURES_VARIABLE)

    def test_an_empty_list_with_no_variable_writes_nothing(self) -> None:
        # A registered dispatch on a clean repository has nothing to say and nothing to undo. A
        # DELETE against a name that is not there is a 404, i.e. a dispatch that never happened.
        module = _module()
        calls = self._recording(module, [{'name': 'CORTEX_MEMORY_WORKERS', 'value': '1'}])
        module.declare_departures([])
        assert [call for call in calls if call[0] != 'GET'] == []

    def test_the_value_is_comma_joined_without_spaces(self) -> None:
        # The reading side splits on `,` and strips, so spaces would survive; they would also make
        # two dispatches that declare the same thing produce different variable values, which
        # makes a diff of the variable unreadable for the one thing it is for.
        module = _module()
        self._recording(module, [])
        assert module.declare_departures(['limit', 'model']) == 'limit,model'


class TestTheOrderOfOperations:
    def test_the_variable_is_written_before_the_dispatch_that_reads_it(self, monkeypatch, capsys) -> None:  # noqa: ANN001
        # The whole point of the round, and the assertion is about ORDER: the workflow reads the
        # variable when the job starts, so a write after the dispatch would describe the next run.
        # `41560510937` is what "written by nobody" costs -- a complete measurement refused for
        # bookkeeping.
        module = _module()
        order: list[str] = []

        def fake_req(method: str, path: str, payload=None, allow_empty: bool = False):  # noqa: ANN001, ANN202
            if 'variables' in path:
                order.append(f'variable-{method}')
                return {'variables': []} if method == 'GET' else None
            if path.endswith('/dispatches'):
                order.append('dispatch')
                return None
            return {'tree': {'sha': 'b' * 40}}

        monkeypatch.setattr(module, 'req', fake_req)
        monkeypatch.setattr(module, 'remote_head', lambda: 'a' * 40)
        monkeypatch.setattr(module, 'local_tree', lambda: 'b' * 40)
        monkeypatch.setattr(module, 'staleness_refusal', lambda *_: None)

        assert module.main(['--no-budget', '--set', 'model=zhipu:glm-4.6']) == 0
        assert 'dispatch' in order, order
        assert order.index('dispatch') > order.index('variable-GET'), order
        out = capsys.readouterr().out
        assert 'declaring departures: ' in out
        assert "['model']" in out


class TestTheOracleSwitch:
    """The evidence-source variable, which is a repository variable rather than an input.

    It cannot be a workflow input: `benchmark-cortex-memory.yml` sits at 24 of GitHub's 25
    `workflow_dispatch` inputs and `test_dispatch_inputs.py` refuses a workflow that reaches the
    limit, so the switch lives where `CORTEX_DECLARED_DEPARTURES` already lives -- written by the
    dispatcher through the API, read by the job from `vars`. The tests below are about the two
    properties that makes load-bearing: the value is never inherited, and a typo is never read as
    the corpus.
    """

    def test_absent_means_the_shipped_corpus(self) -> None:
        module = _module()
        assert module.oracle_switch({}) == '0'

    def test_the_empty_string_means_the_shipped_corpus(self) -> None:
        # What an unset repository variable interpolates to in the workflow's `|| '0'`.
        module = _module()
        assert module.oracle_switch({module.ORACLE_VARIABLE: ''}) == '0'

    def test_zero_and_one_are_the_two_states(self) -> None:
        module = _module()
        assert module.oracle_switch({module.ORACLE_VARIABLE: '0'}) == '0'
        assert module.oracle_switch({module.ORACLE_VARIABLE: '1'}) == '1'

    def test_a_typo_is_refused_instead_of_read_as_off(self) -> None:
        module = _module()
        with pytest.raises(SystemExit) as refusal:
            module.oracle_switch({module.ORACLE_VARIABLE: 'oracle'})
        assert module.ORACLE_VARIABLE in str(refusal.value)

    def test_the_variable_is_written_on_every_dispatch(self, monkeypatch, capsys) -> None:  # noqa: ANN001
        # The property that stops a `1` from outliving the run that asked for it: the dispatcher
        # writes `0` even when nobody asked for anything, so a dispatch made outside this script is
        # the only way to inherit the previous experiment's mode.
        module = _module()
        written: list[tuple[str, str]] = []
        monkeypatch.setattr(module, 'req', lambda *a, **k: {'tree': {'sha': 'b' * 40}})
        monkeypatch.setattr(module, 'remote_head', lambda: 'a' * 40)
        monkeypatch.setattr(module, 'local_tree', lambda: 'b' * 40)
        monkeypatch.setattr(module, 'staleness_refusal', lambda *_: None)
        monkeypatch.setattr(
            module,
            'write_variable',
            lambda name, value: written.append((name, value)) or value,
        )
        monkeypatch.delenv(module.ORACLE_VARIABLE, raising=False)

        assert module.main(['--no-budget', '--set', 'model=zhipu:glm-4.6']) == 0
        assert (module.ORACLE_VARIABLE, '0') in written, written
        assert f'{module.ORACLE_VARIABLE} = 0' in capsys.readouterr().out

    def test_the_condition_is_declared_as_a_departure(self, monkeypatch) -> None:  # noqa: ANN001
        # The artifact will say `evidenceSource: gold-sessions`; a declaration that did not name it
        # would leave the gate's reader with a departure nobody asked for.
        module = _module()
        declared: list[list[str]] = []
        monkeypatch.setattr(module, 'req', lambda *a, **k: {'tree': {'sha': 'b' * 40}})
        monkeypatch.setattr(module, 'remote_head', lambda: 'a' * 40)
        monkeypatch.setattr(module, 'local_tree', lambda: 'b' * 40)
        monkeypatch.setattr(module, 'staleness_refusal', lambda *_: None)
        monkeypatch.setattr(module, 'write_variable', lambda name, value: value)
        monkeypatch.setattr(module, 'declare_departures', lambda names: declared.append(names))
        monkeypatch.setenv(module.ORACLE_VARIABLE, '1')

        assert module.main(['--no-budget']) == 0
        # The artifact's field, not the repository variable's name: a declaration that names
        # no field is refused by the gate (`42500412709`), so the record has to point at
        # something a reader can look up in the artifact.
        assert declared and declared[0] == ['evidenceSource'], declared


class TestTheReplyRepairSwitch:
    """The reply-contract repair's variable, on the same two properties as the evidence source.

    It cannot be a workflow input (the 24-of-25 ceiling), so it is written by the dispatcher and read by
    the job from `vars`. What has to hold is that it is never inherited and that a typo is refused here
    rather than three hours into a run -- `readReplyRepair` in `cortex-eval` would refuse it too, but a
    refused dispatch costs a second while a refused run costs the whole queue behind it.
    """

    def test_absent_means_the_registered_control(self) -> None:
        module = _module()
        assert module.reply_repair_switch({}) == 'off'
        assert module.reply_repair_switch({module.REPLY_REPAIR_VARIABLE: ''}) == 'off'

    def test_every_value_the_product_implements_round_trips(self) -> None:
        # The list is the arm's, not a second copy: `REPLY_REPAIRS` is what the error message offers and
        # what `readReplyRepair` accepts, and a value in one and not the other is a dispatch that dies late.
        module = _module()
        for name in module.REPLY_REPAIRS:
            assert module.reply_repair_switch({module.REPLY_REPAIR_VARIABLE: name}) == name

    def test_case_and_padding_are_normalised(self) -> None:
        # The repository variable is typed by a human in a settings page, and `Both` is not a different
        # treatment from `both`.
        module = _module()
        assert module.reply_repair_switch({module.REPLY_REPAIR_VARIABLE: ' Both '}) == 'both'

    def test_a_typo_is_refused_instead_of_read_as_off(self) -> None:
        module = _module()
        with pytest.raises(SystemExit) as refusal:
            module.reply_repair_switch({module.REPLY_REPAIR_VARIABLE: 'commit'})
        assert module.REPLY_REPAIR_VARIABLE in str(refusal.value)

    def test_the_variable_is_written_on_every_dispatch(self, monkeypatch, capsys) -> None:  # noqa: ANN001
        # The property that stops a `both` from outliving the run that asked for it.
        module = _module()
        written: list[tuple[str, str]] = []
        monkeypatch.setattr(module, 'req', lambda *a, **k: {'tree': {'sha': 'b' * 40}})
        monkeypatch.setattr(module, 'remote_head', lambda: 'a' * 40)
        monkeypatch.setattr(module, 'local_tree', lambda: 'b' * 40)
        monkeypatch.setattr(module, 'staleness_refusal', lambda *_: None)
        monkeypatch.setattr(
            module,
            'write_variable',
            lambda name, value: written.append((name, value)) or value,
        )
        monkeypatch.delenv(module.ORACLE_VARIABLE, raising=False)
        monkeypatch.delenv(module.REPLY_REPAIR_VARIABLE, raising=False)

        assert module.main(['--no-budget', '--set', 'model=zhipu:glm-4.6']) == 0
        assert (module.REPLY_REPAIR_VARIABLE, 'off') in written, written
        assert f'{module.REPLY_REPAIR_VARIABLE} = off' in capsys.readouterr().out

    def test_the_treatment_is_declared_and_the_control_is_not(self, monkeypatch) -> None:  # noqa: ANN001
        # The artifact's field name, and only when the treatment is on: `off` is the registered value, so a
        # declaration there would name a field the run did not move -- which the gate reports as an
        # intention rather than a departure.
        module = _module()
        declared: list[list[str]] = []
        monkeypatch.setattr(module, 'req', lambda *a, **k: {'tree': {'sha': 'b' * 40}})
        monkeypatch.setattr(module, 'remote_head', lambda: 'a' * 40)
        monkeypatch.setattr(module, 'local_tree', lambda: 'b' * 40)
        monkeypatch.setattr(module, 'staleness_refusal', lambda *_: None)
        monkeypatch.setattr(module, 'write_variable', lambda name, value: value)
        monkeypatch.setattr(module, 'declare_departures', lambda names: declared.append(names))
        monkeypatch.delenv(module.ORACLE_VARIABLE, raising=False)

        monkeypatch.setenv(module.REPLY_REPAIR_VARIABLE, 'both')
        assert module.main(['--no-budget']) == 0
        assert declared[0] == ['replyRepair'], declared

        monkeypatch.setenv(module.REPLY_REPAIR_VARIABLE, 'off')
        assert module.main(['--no-budget']) == 0
        assert declared[1] == [], declared
