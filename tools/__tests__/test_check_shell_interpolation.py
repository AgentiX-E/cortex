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

# The hazard, assembled rather than written.
#
# Every test below needs a string the shell would mangle. Spelling it literally
# costs a tool call: the edit that writes this file is itself carried in a shell
# command, so a literal here kills the command before the file is written, and the
# fix cannot land. Building it from codes keeps the bytes out of the command line
# while leaving them available to the tests. `tools/check-shell-interpolation.py`
# enforces this on writers; `tools/run-program.py` shows the same technique.
DOLLAR = chr(36)
BRACE = chr(123)
CLOSE = chr(125)


def hazard(body: str) -> str:
    """A shell-hazardous interpolation for `body`, built from character codes."""
    return DOLLAR + BRACE + body + CLOSE


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


class TestQuotingIsModelledNotToggled:
    """Quoting and escaping must follow the shell's rule exactly.

    Every expectation below was taken from a real shell (`sh`) rather than
    reasoned about, because the boundary is easy to get wrong in both directions:

        echo \\${X}      -> prints ${X}    (backslash escapes the dollar)
        echo "\\${X}"    -> prints ${X}    (the escape works inside double quotes)
        echo ${X}        -> expands
        echo "${X}"      -> expands
        echo '${X}'      -> prints ${X}    (single quotes)

    The first draft of these tests asserted that `'it'\\''s ${X}'` expands. The
    shell says it does not -- the trailing quote opens a run that swallows the
    expansion -- so that assertion was deleted rather than satisfied. A test may
    only pin behaviour the tool it tests is actually required to match.
    """

    def test_backslash_escaped_dollar_is_not_an_expansion(self) -> None:
        # `\${...}` is a literal dollar sign; the shell does not expand it, so an
        # inner-language `${...}` there is safe and must not be reported.
        fragment = 'echo \\${String(t).padEnd(5)}\n'
        assert guard.scan(fragment, 'probe.sh') == []

    def test_escaped_dollar_inside_double_quotes_is_literal(self) -> None:
        fragment = 'echo "\\${String(t).padEnd(5)}"\n'
        assert guard.scan(fragment, 'probe.sh') == []

    def test_a_lone_backslash_still_escapes_its_neighbour(self) -> None:
        # `\\'` outside quotes is a literal quote, NOT an opening quote. The
        # scanner must not let it start a run, or the rest of the line is wrongly
        # treated as quoted.
        fragment = "echo \\' then ${a.b}\n"
        violations = guard.scan(fragment, 'probe.sh')
        assert len(violations) == 1
        assert '${a.b}' in violations[0]

    def test_unterminated_single_quote_quotes_the_rest_of_the_line(self) -> None:
        # With no closing quote the shell treats the remainder as quoted, so the
        # expansion below does not happen.
        fragment = "echo '${String(t).padEnd(5)}\n"
        assert guard.scan(fragment, 'probe.sh') == []

    def test_escaped_quote_between_two_quoted_runs_agrees_with_the_shell(self) -> None:
        # `'it'\\''s ${X}'`: quotes at index 1, 4, 7, 15. Runs are [1,4] and
        # [7,15], so `${X}` sits inside the second run and does NOT expand. This is
        # the case that looked like a toggle bug and is not one.
        fragment = "echo 'it'\\''s ${X}'\n"
        assert guard.scan(fragment, 'probe.sh') == []

    def test_expansion_after_a_closed_quote_is_still_found(self) -> None:
        fragment = "echo 'lit' \"${a.b}\"\n"
        violations = guard.scan(fragment, 'probe.sh')
        assert len(violations) == 1

    def test_a_real_quote_then_expansion_then_quote(self) -> None:
        # `'a' "b" ${c.d}` -- three separate regions, only the middle is quoted.
        fragment = "echo 'a' \"b\" ${c.d}\n"
        violations = guard.scan(fragment, 'probe.sh')
        assert len(violations) == 1
        assert '${c.d}' in violations[0]


class TestFragmentMode:
    """`--fragment` checks one shell fragment, which is where failures happen.

    The second recurrence was `Bad substitution: lines[l-1].trim`, raised by a
    command typed straight into the shell. The tree scan could not see it: nothing
    on disk contained the text. This mode closes that gap, so a command can be
    validated before it is ever run.
    """

    def test_rejects_the_second_recurrence_unquoted(self, tmp_path: Path) -> None:
        frag = tmp_path / 'probe.sh'
        # The illegal spelling: an unquoted inner-language interpolation.
        frag.write_text('echo "' + hazard('lines[l-1].trim') + '"\n')
        assert guard.main(['prog', '--fragment', str(frag)]) == 1

    def test_accepts_the_second_recurrence_when_single_quoted(self, tmp_path: Path) -> None:
        frag = tmp_path / 'probe.sh'
        # Single quotes protect it, so this spelling is legal.
        frag.write_text("echo '" + hazard('lines[l-1].trim') + "'\n")
        assert guard.main(['prog', '--fragment', str(frag)]) == 0

    def test_reads_stdin(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import io

        monkeypatch.setattr('sys.stdin', io.StringIO('echo "' + hazard('a.b') + '"\n'))
        assert guard.main(['prog', '--fragment', '-']) == 1

    def test_accepts_a_clean_fragment(self, tmp_path: Path) -> None:
        frag = tmp_path / 'probe.sh'
        frag.write_text('echo "' + hazard('HOME') + '" "' + hazard('1:-x') + '"\n')
        assert guard.main(['prog', '--fragment', str(frag)]) == 0


class TestDiscovery:
    """The scanners that feed `scan` find the right regions."""

    def test_reads_sh_fences_from_markdown(self, tmp_path: Path) -> None:
        doc = tmp_path / 'a.md'
        doc.write_text(
            'text\n\n```sh\necho "' + hazard('a.b') + '"\n```\n\n```text\nnot scanned\n```\n'
        )
        found = guard._markdown_shell_blocks(doc)
        assert len(found) == 1
        assert 'a.b' in found[0][1]

    def test_ignores_non_shell_fences(self, tmp_path: Path) -> None:
        doc = tmp_path / 'a.md'
        doc.write_text('```ts\nconst x = `' + hazard('f(1)') + '`;\n```\n')
        assert guard._markdown_shell_blocks(doc) == []

    def test_reads_docstrings_from_python(self, tmp_path: Path) -> None:
        src = tmp_path / 'a.py'
        src.write_text('"""Doc.\n\n    bash -c "echo ' + hazard('a.b') + '"\n"""\n')
        found = guard._python_command_strings(src)
        assert len(found) == 1
        assert guard.scan(found[0][1], 'a.py') != []


class TestStoredHazardRule:
    """A hazard stored in a writer-literal breaks the edit that would fix it.

    This is the rule that actually ended the recurrence, so it is tested as
    carefully as the classifier. Its scope is the subtle part: it must catch a
    literal that gets copied to a file, and must NOT catch prose that merely names
    the hazard -- the guard's own docstrings do that, and a rule that forbids
    naming the hazard cannot be documented.
    """

    def test_flags_a_hazard_written_to_a_file(self, tmp_path: Path) -> None:
        src = tmp_path / 'tools'
        src.mkdir()
        (src / 'a.py').write_text(f"f.write_text('echo \"{hazard('h.join')}\"')\n")
        found = guard.scan_test_sources(tmp_path)
        assert len(found) == 1
        assert 'a.py:1' in found[0]

    def test_allows_the_same_hazard_built_from_codes(self, tmp_path: Path) -> None:
        # The recommended form: the bytes never appear in the command line.
        src = tmp_path / 'tools'
        src.mkdir()
        (src / 'a.py').write_text("f.write_text('echo ' + DOLLAR + BRACE + 'h.join' + CLOSE)\n")
        assert guard.scan_test_sources(tmp_path) == []

    def test_allows_prose_that_names_the_hazard(self, tmp_path: Path) -> None:
        # The rule must not fire on a comment or a docstring. The guard's own
        # module documentation names the hazard repeatedly; if this failed, the
        # only way to obey the rule would be to stop explaining it.
        src = tmp_path / 'tools'
        src.mkdir()
        (src / 'a.py').write_text(f"# see the {hazard('h.join')} example\ndef f():\n    pass\n")
        assert guard.scan_test_sources(tmp_path) == []

    def test_ignores_pycache(self, tmp_path: Path) -> None:
        cache = tmp_path / 'tools' / '__pycache__'
        cache.mkdir(parents=True)
        (cache / 'a.py').write_text(f"f.write_text('{hazard('h.join')}')\n")
        assert guard.scan_test_sources(tmp_path) == []


class TestEndToEnd:
    """The entry point returns 1 on a violation and 0 on a clean tree."""

    def test_fails_on_a_tree_containing_the_defect(self, tmp_path: Path) -> None:
        (tmp_path / 'docs').mkdir()
        (tmp_path / 'tools').mkdir()
        (tmp_path / 'docs' / 'a.md').write_text(
            '```sh\necho "' + hazard('f(1)') + '"\n```\n'
        )
        assert guard.main(['prog', str(tmp_path)]) == 1

    def test_passes_on_a_tree_that_is_clean(self, tmp_path: Path) -> None:
        (tmp_path / 'docs').mkdir()
        (tmp_path / 'tools').mkdir()
        (tmp_path / 'docs' / 'a.md').write_text(
            '```sh\necho "' + hazard('name') + '"\n```\n'
        )
        assert guard.main(['prog', str(tmp_path)]) == 0
