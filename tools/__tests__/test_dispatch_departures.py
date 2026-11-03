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
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

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

        assert module.main(['--set', 'model=zhipu:glm-4.6']) == 0
        assert 'dispatch' in order, order
        assert order.index('dispatch') > order.index('variable-GET'), order
        out = capsys.readouterr().out
        assert 'declaring departures: ' in out
        assert "['model']" in out
