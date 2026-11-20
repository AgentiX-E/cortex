"""The dispatch script's staleness gate, and the run that made it necessary.

The workflow dispatches against `master`. This checkout was pushing to `main`. Nothing errored:
`git push origin HEAD:main` succeeds, `gh workflow run` succeeds, and the run starts against
whatever `master` last pointed at. On 2026-10-29 that was `749946f7`, three commits before the
`derive` implementation the dispatch existed to test, and the only signal was a SHA printed in
the log -- which nobody has a reason to compare against anything.

That run was cancelled eight seconds in. The failure mode worth guarding against is the one that
completes: a benchmark that runs for two hours, produces 500 verdicts and a confident arithmetic
readout, and measures code that is not in the tree the author is reading.

The gate compares **trees** rather than SHAs, because `push-via-api.py` rebuilds each commit
through the Git Data API: the content arrives under a fresh object id, so a SHA comparison would
refuse every dispatch in the campaign's normal workflow.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / 'tools' / 'dispatch-cortex-memory-ab.py'


def _module():  # noqa: ANN202 - the dispatch script, imported by path
    spec = importlib.util.spec_from_file_location('dispatch_cortex_memory_ab', SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestStalenessRefusal:
    def test_identical_trees_pass(self) -> None:
        """The normal case: the branch the workflow reads carries this checkout's content."""
        module = _module()
        assert module.staleness_refusal('a' * 40, 'a' * 40) is None

    def test_a_different_tree_is_refused_and_both_trees_are_named(self) -> None:
        """A refusal that does not say which two trees differs is a refusal a reader cannot act on."""
        module = _module()
        refusal = module.staleness_refusal('749946f7' + 'a' * 32, '81d37e30' + 'b' * 32)

        assert refusal is not None
        assert refusal.startswith('refusing to dispatch:')
        assert '749946f7aaaa' in refusal
        assert '81d37e30bbbb' in refusal

    def test_the_refusal_names_the_branch_the_workflow_reads(self) -> None:
        """
        THE FIX IS "PUSH THIS BRANCH", SO THE MESSAGE HAS TO SAY WHICH ONE.

        "master is behind" is actionable; "the remote does not match" sends a reader to compare
        SHAs by hand, which is precisely the check that did not happen.
        """
        module = _module()
        refusal = module.staleness_refusal('a' * 40, 'b' * 40)

        assert refusal is not None
        assert 'master' in refusal
        assert 'main' in refusal

    def test_the_refusal_carries_an_exit(self) -> None:
        """A gate with no documented override gets worked around by editing the gate."""
        module = _module()
        refusal = module.staleness_refusal('a' * 40, 'b' * 40)

        assert refusal is not None
        assert '--allow-stale-tree' in refusal

    def test_a_directory_that_is_not_a_checkout_passes(self) -> None:
        """
        `None` is "cannot tell", not "stale".

        The script is importable from tests and from a bare copy of the repo, and neither has a
        HEAD tree to compare. Treating that as a mismatch would make the module unimportable
        outside a git checkout, which is the same absent-versus-zero confusion the artifact
        fields are read under.
        """
        module = _module()
        assert module.staleness_refusal('a' * 40, None) is None

    def test_local_tree_reads_this_checkout(self) -> None:
        """The gate is only a gate if it can see the local side; `None` everywhere would be inert."""
        module = _module()
        tree = module.local_tree()

        assert tree is None or re.fullmatch(r'[0-9a-f]{40}', tree), tree
        # This suite runs inside the repository, so the local side must be readable here.
        assert tree is not None


class TestTheOverrideTheRefusalNames:
    """`--allow-stale-tree` was named by the refusal and refused by the parser.

    `test_the_refusal_carries_an_exit` above asserts that the message mentions the flag, and it
    passed for as long as the flag was dead: `main` read it out of `sys.argv`, decided not to raise,
    and then handed the same argv to `parse_argv`, which answers *"unrecognised argument
    '--allow-stale-tree'; this script takes --set KEY=VALUE"*. The escape hatch was the one argument
    the parser would not take, so the documented override produced a refusal about a typo.

    The defect is the same class as `S18`'s three: a sentence in one place promising behaviour that
    the code beside it does not have. The repair is in `split_finance`, which is the function that
    separates flags from `--set` values, and the assertion is that the flag survives to `main`.
    """

    def test_the_switch_is_consumed_rather_than_handed_to_the_set_parser(self) -> None:
        module = _module()
        rest, finance = module.split_finance(['--no-budget', '--allow-stale-tree', '--set', 'a=b'])
        assert rest == ['--set', 'a=b'], rest
        assert finance['flags']['--allow-stale-tree'] is True

    def test_a_stale_tree_proceeds_when_the_flag_is_given(self, monkeypatch, capsys) -> None:
        module = _module()
        monkeypatch.setattr(module, 'remote_head', lambda: 'a' * 40)
        monkeypatch.setattr(module, 'local_tree', lambda: 'c' * 40)
        monkeypatch.setattr(module, 'write_variable', lambda name, value: value)
        monkeypatch.setattr(
            module,
            'req',
            lambda method, path, payload=None, allow_empty=False: (
                {'workflow_runs': []} if '/runs' in path else {'tree': {'sha': 'c' * 40}}
            ),
        )
        # The real refusal would fire on the tree mismatch, so this call proves the flag reached it.
        assert module.main(['--no-budget', '--allow-stale-tree', '--set', 'capability=MR']) == 0
        assert 'dispatched' in capsys.readouterr().out

    def test_the_flag_is_still_refused_when_it_is_not_given(self, monkeypatch) -> None:
        module = _module()
        import pytest

        monkeypatch.setattr(module, 'remote_head', lambda: 'a' * 40)
        monkeypatch.setattr(module, 'local_tree', lambda: 'c' * 40)
        monkeypatch.setattr(module, 'write_variable', lambda name, value: value)
        monkeypatch.setattr(
            module,
            'req',
            lambda method, path, payload=None, allow_empty=False: (
                {'workflow_runs': []} if '/runs' in path else {'tree': {'sha': 'c' * 40}}
            ),
        )
        # The commits read answers a tree that is not this checkout's, which is what the gate looks at.
        monkeypatch.setattr(
            module,
            'req',
            lambda method, path, payload=None, allow_empty=False: (
                {'workflow_runs': []} if '/runs' in path else {'tree': {'sha': 'a' * 40}}
            ),
        )
        with pytest.raises(SystemExit) as raised:
            module.main(['--no-budget', '--set', 'capability=MR'])
        assert 'refusing to dispatch' in str(raised.value)
