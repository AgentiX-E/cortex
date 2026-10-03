"""Tests for `tools/check-shell-interpolation.py`.

The guard's own first draft is the reason this file exists in this shape: its
`VALID_EXPANSION` regex ended with an alternative that matched ANY text, so
`fullmatch` accepted `${String(t).padEnd(5)}` and the guard reported the exact
defect it was written to catch as clean. A guard is only worth wiring into CI if
something checks the guard, so every case below is a case the first draft got
wrong or could have got wrong.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).resolve().parent.parent / 'check-shell-interpolation.py'


def _load():
    spec = importlib.util.spec_from_file_location('check_shell_interpolation', MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


guard = _load()


class TestExpansionClassifier:
    """The classifier must accept every real expansion and reject everything else."""

    @pytest.mark.parametrize(
        'body',
        [
            'name',
            '#name',
            '!name',
            '1',
            '10',
            '@',
            '*',
            'name:-word',
            'name:=word',
            'name:?message',
            'name:+alternate',
            'name#pattern',
            'name##pattern',
            'name%pattern',
            'name%%pattern',
            'name/pat/rep',
            'name:1',
            'name:1:2',
            'name^',
            'name,',
        ],
    )
    def test_accepts_real_parameter_expansions(self, body: str) -> None:
        assert guard.VALID_EXPANSION.fullmatch(body) is not None

    @pytest.mark.parametrize(
        'body',
        [
            # The defect that motivated the guard.
            'String(t).padEnd(5)',
            # The same collision in other spellings.
            'JSON.stringify(row)',
            'rows.map(r => r.t)',
            'value.toFixed(2)',
            'items.length',
            'await fn()',
            # Near-misses on a valid name: a name must be followed by a real operator.
            'a-b',
            'a b',
            'name!',
            'name(',
            '',
        ],
    )
    def test_rejects_inner_language_interpolation(self, body: str) -> None:
        assert guard.VALID_EXPANSION.fullmatch(body) is None

    def test_the_wildcard_alternative_that_started_this(self) -> None:
        """Pin the exact shape of the first draft's bug.

        The draft's last alternative was `[\\^,]?[^}]*`, which matches any string
        at all. Reintroducing a trailing `[^}]*` with an optional prefix would
        restore it, so this asserts on the property rather than on the source:
        the classifier must depend on the leading name.
        """
        assert guard.VALID_EXPANSION.fullmatch('zzz(0)') is None
        assert guard.VALID_EXPANSION.fullmatch('zzz') is not None
        assert guard.VALID_EXPANSION.fullmatch('zzz jumbled (text)') is None


class TestScan:
    """`scan` finds the collisions in a shell fragment."""

    def test_catches_the_original_defect(self) -> None:
        fragment = 'npx vitest -e "\nconst r = `${String(t).padEnd(5)}`;\n"\n'
        violations = guard.scan(fragment, 'probe.sh')
        assert len(violations) == 1
        assert 'padEnd' in violations[0]

    def test_catches_several_on_different_lines(self) -> None:
        fragment = 'echo "${a.b}"\necho fine "${name}"\necho "${c(d)}"\n'
        violations = guard.scan(fragment, 'probe.sh')
        assert len(violations) == 2

    def test_accepts_a_fragment_that_only_uses_shell_expansions(self) -> None:
        fragment = 'echo "${HOME}" "${1}" "${name:-fallback}"\n'
        assert guard.scan(fragment, 'probe.sh') == []

    def test_single_quoted_regions_are_not_expanded(self) -> None:
        # Inside single quotes the shell passes the text through untouched, so an
        # inner language's `${...}` is legitimate there.
        fragment = "echo '${String(t).padEnd(5)}'\n"
        assert guard.scan(fragment, 'probe.sh') == []

    def test_comment_lines_are_skipped(self) -> None:
        fragment = '# echo "${String(t).padEnd(5)}"\necho ok\n'
        assert guard.scan(fragment, 'probe.sh') == []

    def test_quoted_heredoc_body_is_skipped(self) -> None:
        fragment = "cat <<'EOF'\n${String(t).padEnd(5)}\nEOF\necho done\n"
        assert guard.scan(fragment, 'probe.sh') == []

    def test_reports_the_line_number(self) -> None:
        fragment = 'echo ok\necho "${a.b}"\n'
        violations = guard.scan(fragment, 'probe.sh')
        assert violations[0].startswith('probe.sh:2:')


class TestDiscovery:
    """The scanners that feed `scan` find the right regions."""

    def test_reads_sh_fences_from_markdown(self, tmp_path: Path) -> None:
        doc = tmp_path / 'a.md'
        doc.write_text('text\n\n```sh\necho "${a.b}"\n```\n\n```text\nnot scanned\n```\n')
        found = guard._markdown_shell_blocks(doc)
        assert len(found) == 1
        assert 'a.b' in found[0][1]

    def test_ignores_non_shell_fences(self, tmp_path: Path) -> None:
        doc = tmp_path / 'a.md'
        doc.write_text('```ts\nconst x = `${f(1)}`;\n```\n')
        assert guard._markdown_shell_blocks(doc) == []

    def test_reads_docstrings_from_python(self, tmp_path: Path) -> None:
        src = tmp_path / 'a.py'
        src.write_text('"""Doc.\n\n    bash -c "echo ${a.b}"\n"""\n')
        found = guard._python_command_strings(src)
        assert len(found) == 1
        assert guard.scan(found[0][1], 'a.py') != []


class TestEndToEnd:
    """The entry point returns 1 on a violation and 0 on a clean tree."""

    def test_fails_on_a_tree_containing_the_defect(self, tmp_path: Path) -> None:
        (tmp_path / 'docs').mkdir()
        (tmp_path / 'tools').mkdir()
        (tmp_path / 'docs' / 'a.md').write_text('```sh\necho "${f(1)}"\n```\n')
        assert guard.main(['prog', str(tmp_path)]) == 1

    def test_passes_on_a_tree_that_is_clean(self, tmp_path: Path) -> None:
        (tmp_path / 'docs').mkdir()
        (tmp_path / 'tools').mkdir()
        (tmp_path / 'docs' / 'a.md').write_text('```sh\necho "${name}"\n```\n')
        assert guard.main(['prog', str(tmp_path)]) == 0
