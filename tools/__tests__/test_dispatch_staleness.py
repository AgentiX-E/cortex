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
