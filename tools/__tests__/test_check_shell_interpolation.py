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

    def test_from_command_checks_a_command_without_retyping_it(
        self, tmp_path: Path
    ) -> None:
        # The mode exists so an author who has just lost a call can ask whether the
        # line was safe without putting the line back on a command line. Same scan,
        # different provenance -- and the report says which, so a reader is not left
        # wondering why a file of prose was scanned as shell.
        cmd = tmp_path / 'lost-command.sh'
        cmd.write_text('python3 -c "x = ' + hazard('JSON.stringify(v)') + '"\n')
        assert guard.main(['prog', '--from-command', str(cmd)]) == 1

    def test_from_command_accepts_a_safe_command(self, tmp_path: Path) -> None:
        cmd = tmp_path / 'safe-command.sh'
        cmd.write_text("python3 -c 'print(1)'\n")
        assert guard.main(['prog', '--from-command', str(cmd)]) == 0

    def test_accepts_a_clean_fragment(self, tmp_path: Path) -> None:
        frag = tmp_path / 'probe.sh'
        frag.write_text('echo "' + hazard('HOME') + '" "' + hazard('1:-x') + '"\n')
        assert guard.main(['prog', '--fragment', str(frag)]) == 0


class TestInterpreterPayloads:
    """A `-c` / `-e` payload is inner-language source, and is scanned as such.

    This class exists because the guard was blind to two spellings that were both
    live in this session, and blind for two different reasons.

    **Blind spot 1: the payload was inside a single-quoted run, so it was erased.**
    `scan` blanks each single-quoted run from its opening quote to the next one,
    and in

        python3 -c 'PROG'

    the `-c` is *unquoted*, so the run starts and ends inside PROG and the whole
    payload is discarded. The guard reported the fragment clean while a human
    reading it would have hesitated.

    **Blind spot 2: the fragment was scanned one line at a time.** Quote state was
    recomputed for every line, so an unbalanced quote on one line silently inverted
    the region on the next. A payload spanning lines therefore escaped whenever its
    quoting only balanced across the whole command, which is the normal case for a
    heredoc-free multi-line program.

    The rule that closes both is one rule: resolve quoting over the fragment, and
    treat the text after a `-c` / `-e` as source for a different language.
    """

    def test_a_single_quoted_payload_is_not_a_SHELL_violation(self) -> None:
        # Verified against a real shell rather than reasoned about:
        #
        #     python3 -c 'print("${x}")'   ->  prints ${x}
        #
        # The shell expands nothing inside a single-quoted run, so the sequence
        # reaches the interpreter as typed. That settles the SHELL question, and this
        # is the shell rule, so it stays silent here.
        #
        # It does not settle the program question, and conflating the two is what the
        # seventh recurrence cost. The same fragment is reported by
        # `TestPayloadInterpolationIsStillInterpolation` -- not because the shell
        # would mangle it, but because the body is written as JavaScript
        # interpolation inside a Python program, where it is not a construct at all.
        # Two rules, two reasons, one sequence.
        fragment = "python3 -c 'const s = " + hazard('String(t).padEnd(5)') + "'\n"
        messages = guard.scan(fragment, 'probe.sh')
        assert len(messages) == 1
        assert 'payload' in messages[0]
        assert 'would be consumed by the shell' not in messages[0]

    def test_a_double_quoted_payload_is_a_violation(self) -> None:
        # The spelling that actually aborts the command: the shells expand `$`
        # constructs before the interpreter runs, find contents that are not a
        # parameter expansion, and stop. This is `Bad substitution: String`.
        fragment = 'python3 -c "const s = ' + hazard('String(t).padEnd(5)') + '"\n'
        violations = guard.scan(fragment, 'probe.sh')
        assert len(violations) == 1
        assert 'padEnd' in violations[0]

    def test_an_unquoted_payload_is_a_violation(self) -> None:
        fragment = 'node -e const s = ' + hazard('String(t)') + '\n'
        violations = guard.scan(fragment, 'probe.sh')
        assert len(violations) == 1
        assert 'String(t)' in violations[0]

    def test_the_live_payload_is_reported_exactly_once(self) -> None:
        # Both passes can see this one: the payload pass reads the original text, and
        # the ordinary pass reads the quote-resolved text where a double-quoted
        # payload is still live. Counting it twice would make every count-based
        # assertion in this file depend on which pass ran first.
        fragment = 'python3 -c "a = ' + hazard('a.b') + '" "b = ' + hazard('c(d)') + '"\n'
        assert len(guard.scan(fragment, 'probe.sh')) == 2

    def test_a_payload_spanning_lines_is_covered_by_one_quote_resolution(self) -> None:
        # Quote state used to be recomputed per line, so a payload opened on one line
        # closed on the next was evaluated as unquoted. Resolving over the fragment is
        # what makes the count one rather than zero or two -- here the single sequence
        # is reported once, by the program rule, for one reason.
        fragment = "python3 -c '\na = " + hazard('a.b') + "\n'\n"
        violations = guard.scan(fragment, 'probe.sh')
        assert len(violations) == 1
        assert 'payload' in violations[0]
        live = 'python3 -c "\na = ' + hazard('a.b') + '\n"\n'
        assert len(guard.scan(live, 'probe.sh')) == 1

    def test_the_line_number_of_a_payload_violation_is_its_own_line(self) -> None:
        fragment = 'echo start\npython3 -c "' + hazard('JSON.stringify(x)') + '"\n'
        violations = guard.scan(fragment, 'probe.sh')
        assert len(violations) == 1
        assert violations[0].startswith('probe.sh:2:')

    def test_a_shell_expansion_before_the_payload_is_still_found(self) -> None:
        # The payload rule must not swallow the shell text that precedes it.
        fragment = 'echo "' + hazard('a.b') + '"\npython3 -c \'print(1)\'\n'
        violations = guard.scan(fragment, 'probe.sh')
        assert len(violations) == 1
        assert 'a.b' in violations[0]

    def test_a_clean_payload_is_not_a_violation(self) -> None:
        fragment = "python3 -c 'print(1)'\nnode -e 'console.log(2)'\n"
        assert guard.scan(fragment, 'probe.sh') == []

    def test_a_genuine_shell_expansion_in_a_payload_position_is_accepted(self) -> None:
        # `${HOME}` is a real parameter expansion. It must not be rejected merely
        # for sitting where a `-c` payload would sit.
        fragment = 'echo "' + hazard('HOME') + '"\n'
        assert guard.scan(fragment, 'probe.sh') == []

    def test_a_comment_naming_an_interpreter_is_not_a_payload(self) -> None:
        # Comment suppression is inherited by the payload scan, because the two now
        # share a coordinate space. Without that, a comment explaining `python3 -c`
        # would turn the text after it into a payload and the guard would report
        # prose.
        fragment = '# run: python3 -c "a = ' + hazard('a.b') + '"\necho ok\n'
        assert guard.scan(fragment, 'probe.sh') == []

    def test_a_url_fragment_is_not_a_comment(self) -> None:
        # `#` only opens a comment at the start of a line or after whitespace.
        # Treating every `#` as a comment would suppress a real hazard instead.
        fragment = 'curl http://host/x#' + hazard('a.b') + '\n'
        assert len(guard.scan(fragment, 'probe.sh')) == 1


class TestPayloadInterpolationIsStillInterpolation:
    """A `-c` / `-e` payload is another language's source, not shell text.

    `TestInterpreterPayloads` above covers the case where the *shell* expands the
    sequence and aborts. This class covers the case where the shell does not — the
    payload is single quoted — and the sequence is nevertheless wrong, because it is
    written as if it were shell text inside a language that has its own interpolation.

    That distinction is what the seventh recurrence turned on. The guard was asked
    "is this a valid parameter expansion", answered *no*, and — for a single-quoted
    payload — suppressed the report, because suppressing it is right for the shell.
    But the program being written was not shell: it was a Python program whose author
    meant to interpolate a value the way one does in JavaScript. The shell was never
    the failing party; the interpreter was.

    So the rule has to be stated about the *payload's* language, and it has to be
    careful in one direction the shell rule is not: `${HOME}` is a correct shell
    expansion, so it is legitimate inside `sh -c '...'` — a payload that really is
    shell — and must keep passing. Only a payload for a language with no such
    expansion (`python3 -c`, `ruby -e`, `perl -e`) makes the body's
    non-expansion-ness a defect. Banning `${...}` in payloads outright would reject
    correct programs, which is the overshoot that gets a guard deleted rather than
    obeyed.

    ## The JavaScript family, which this class used to get wrong

    This docstring named `node -e` as a language with no `${...}` construct. That is
    false: `` `${rows.length}` `` is a template literal and is JavaScript's own
    interpolation. The claim survived because no `node -e` payload in `tools/*.py` or
    `docs/*.md` used one, so the rule was never checked against a true negative -- and
    the workflow scan found two of them in `competitor-retrieval.yml` on its first run.

    The rule cannot be repaired by parsing harder. Deciding whether a `${...}` in a
    JavaScript payload is a template literal or a syntax error requires the payload's
    tokens, and this guard has no JavaScript parser; a heuristic would be a guess
    dressed as a verdict. So the rule is scoped to the languages whose premise holds,
    and the direction that actually breaks a command -- a LIVE payload, where the shell
    expands first -- is covered by the other rule, which is unaffected.
    """

    def test_catches_the_seventh_recurrence(self) -> None:
        # The literal body from the log, in the quoting that was actually used.
        fragment = "python3 -c 'const c = " + hazard('cut.toFixed(3)') + "'\n"
        violations = guard.scan(fragment, 'probe.sh')
        assert len(violations) == 1
        assert 'cut.toFixed(3)' in violations[0]

    @pytest.mark.parametrize(
        'interpreter', ['python3', 'python3.11', 'ruby', 'perl']
    )
    def test_catches_it_for_every_known_interpreter(self, interpreter: str) -> None:
        # The rule keys off the interpreter list, so a payload that Python rejects
        # must not slip through merely because it was addressed to ruby.
        #
        # Parametrised rather than looped: a loop reports one test name for six
        # checks, so a failure says "the rule is broken" instead of which interpreter
        # it is broken for. The list is written out rather than derived from
        # `_INTERPRETER` because a test that reads the implementation's own table
        # cannot notice the table losing an entry.
        #
        # `node`, `nodejs`, `deno` and `bun` are absent by decision, not by omission --
        # see the class docstring and `test_a_js_template_literal_...` below.
        fragment = f"{interpreter} -e 'x = {hazard('a.b')}'\n"
        assert len(guard.scan(fragment, 'probe.sh')) == 1

    def test_catches_it_with_the_interpreter_path_qualified(self) -> None:
        # `/usr/bin/python3 -c '...'` is how a real invocation is often written, and
        # the rule anchors on a word boundary so this has to work.
        fragment = "/usr/bin/python3 -c 'x = " + hazard('a.b') + "'\n"
        assert len(guard.scan(fragment, 'probe.sh')) == 1

    def test_a_real_expansion_in_a_shell_payload_is_accepted(self) -> None:
        # `sh -c 'echo ${HOME}'` is correct: the payload IS shell, so its expansion
        # is the same expansion the outer shell would have made. Reporting this
        # would be the overshoot that makes the guard fight its user.
        fragment = "sh -c 'echo " + hazard('HOME') + "'\n"
        assert guard.scan(fragment, 'probe.sh') == []

    def test_a_real_expansion_in_a_non_shell_payload_is_still_reported(self) -> None:
        # `python3 -c 'x = ${HOME}'` is a defect with the opposite shape from the
        # recurrence: the body happens to be a valid shell expansion, but Python has no
        # expansion at all, so this is not what the author meant. The inner language,
        # not the shell, decides here.
        #
        # This test used to be written with `node`, and the substitution is the honest
        # form of the JavaScript exemption: for Python the sentence the report prints --
        # "either it fails to parse or the text is taken literally" -- is true, and for
        # JavaScript it was false. A test that keeps node here would be asserting a
        # message about node that node contradicts.
        fragment = "python3 -c 'x = " + hazard('HOME') + "'\n"
        violations = guard.scan(fragment, 'probe.sh')
        assert len(violations) == 1
        assert 'HOME' in violations[0]

    def test_a_js_template_literal_in_a_single_quoted_payload_is_clean(self) -> None:
        # The two lines the workflow scan found in `competitor-retrieval.yml`, in their
        # own shape: a `node -e` program in SINGLE quotes, printing a template literal.
        # The shell cannot reach it, and `${rows.length}` is exactly JavaScript's syntax.
        # Reporting it was wrong twice -- once by saying the shell would expand it, once
        # by saying the language had no such construct.
        fragment = "node -e 'console.log(`n: " + hazard('rows.length') + "`)'\n"
        assert guard.scan(fragment, 'probe.sh') == []

    def test_a_js_template_literal_in_a_live_payload_is_still_a_violation(self) -> None:
        # The other half, and why the exemption is scoped to quoting rather than to the
        # language: double-quoted, the shell really does expand the sequence before node
        # is started, and that is the direction that kills the command.
        fragment = 'node -e "console.log(`n: ' + hazard('rows.length') + '`)"\n'
        violations = guard.scan(fragment, 'probe.sh')
        assert len(violations) == 1
        assert 'has not yet handed over' in violations[0]

    def test_a_shell_expansion_in_a_js_payload_is_not_the_language_rule(self) -> None:
        # `${HOME}` in a single-quoted node payload: the guard cannot decide this one.
        # Inside a template literal it is a reference to a JavaScript name; outside one
        # it is a syntax error; and telling which requires a JavaScript parser this tool
        # does not have. It is therefore not reported, and that is a deliberate trade of
        # a guess for silence -- the dangerous direction (a live payload) is the rule
        # above, and it still fires.
        fragment = "node -e 'x = " + hazard('HOME') + "'\n"
        assert guard.scan(fragment, 'probe.sh') == []

    def test_a_payload_spanning_lines_is_still_one_payload(self) -> None:
        fragment = "python3 -c '\nx = " + hazard('cut.toFixed(3)') + "\n'\n"
        assert len(guard.scan(fragment, 'probe.sh')) == 1

    def test_prose_that_documents_the_rule_is_not_a_violation(self) -> None:
        # The rule is explained in this file's own docstrings, and those are read by
        # `_python_command_strings`. A guard that flags its own documentation cannot
        # be kept accurate, and an inaccurate guard is one people stop reading.
        fragment = "# python3 -c 'x = " + hazard('a.b') + "'\n"
        assert guard.scan(fragment, 'probe.sh') == []

    def test_the_report_names_the_payload_language_not_just_the_sequence(self) -> None:
        # The reader has to know which decision to make. "not a shell parameter
        # expansion" sends them looking for a shell bug that does not exist; the
        # message must say the sequence sits in an interpreter payload.
        fragment = "python3 -c 'x = " + hazard('cut.toFixed(3)') + "'\n"
        message = guard.scan(fragment, 'probe.sh')[0]
        assert 'payload' in message


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

    def test_reads_a_command_string_from_python(self, tmp_path: Path) -> None:
        # A string literal whose first line is a COMMAND is a shell fragment and is
        # scanned. The first line must start with a word the shell would run; a
        # docstring's first line is a sentence and is excluded -- see the class below
        # for why that distinction was added.
        src = tmp_path / 'a.py'
        src.write_text('CMD = """bash -c "echo ' + hazard('a.b') + '"\n"""\n')
        found = guard._python_command_strings(src)
        assert len(found) == 1
        assert guard.scan(found[0][1], 'a.py') != []

    def test_does_not_read_a_prose_docstring_as_a_command(self, tmp_path: Path) -> None:
        # The extraction originally returned every `\"\"\"` block, which is every module
        # docstring. Adding `tools/exec-python.py` -- whose docstring EXPLAINS the rule
        # and therefore quotes the hazard -- produced four violations against the guard's
        # own documentation. A guard that reports its own prose gets turned off, and it
        # takes the checks that work with it. The failure is the same one
        # `scan_test_sources` records, in the other scanner.
        src = tmp_path / 'a.py'
        src.write_text(
            '"""Doc.\n\n'
            'The first version scanned this prose and reported\n'
            '    python3 -c "print(' + hazard('x:.3f') + ')"\n'
            'as a defect, which is the documentation rather than the defect.\n'
            '"""\n'
        )
        assert guard._python_command_strings(src) == []


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


class TestArraySubscripts:
    """`${a[@]}` is valid shell, and the classifier used to refuse it.

    The grammar required a bare name plus an optional operator, so a subscript had no
    route through it. Nothing in `tools/*.py` or `docs/*.md` used one, which is why the
    gap survived until the workflow scan widened the corpus and this guard's own
    `benchmark-cortex-memory.yml` audit step was reported as a violation of itself.

    The distinction matters for the guard's credibility rather than for its coverage: a
    rule that refuses correct shell teaches its reader to skip the report, and the next
    report is the one that aborts a job at 03:00.
    """

    @pytest.mark.parametrize(
        'body',
        [
            'extra[@]',
            'argv[*]',
            'a[0]',
            'a[i+1]',
            'a[@]:-fallback',
            'a[0]##*/',
        ],
    )
    def test_accepts_a_subscript(self, body: str) -> None:
        assert guard.VALID_EXPANSION.fullmatch(body) is not None

    def test_a_subscript_is_clean_in_a_live_region(self) -> None:
        assert guard.scan('python3 tools/x.py "' + hazard('extra[@]') + '"\n', 'p.sh') == []

    def test_widening_the_grammar_did_not_reopen_the_first_draft(self) -> None:
        # The hole this file was written for: an alternative that matched anything. A
        # subscript is `[` first, so it must still be a name first, and a call is not.
        assert guard.VALID_EXPANSION.fullmatch('String(t).padEnd(5)') is None
        assert guard.VALID_EXPANSION.fullmatch('[0]') is None


class TestWorkflowRunBlocks:
    """The only shell in this repository that runs unattended, scanned at last.

    `§13.161`'s eleventh recurrence was a `run:` block that interpolated a dispatch input
    straight into bash. The guard's scope said "shell fragments recorded in this
    repository" and read `tools/*.py` and `docs/*.md` -- so the recurrence happened in the
    one place the guard had never looked. These tests pin both halves of the repair: the
    scope, and the line numbers that make a report usable.
    """

    def _workflow(self, tmp_path: Path, body: str) -> Path:
        workflows = tmp_path / '.github' / 'workflows'
        workflows.mkdir(parents=True)
        path = workflows / 'bench.yml'
        path.write_text(body)
        return path

    def test_a_block_scalar_body_is_extracted(self, tmp_path: Path) -> None:
        path = self._workflow(
            tmp_path,
            'jobs:\n  a:\n    steps:\n      - name: x\n        run: |\n          echo hi\n',
        )
        masked, blocks, _ = guard._workflow_run_blocks(path)
        assert blocks == 1
        assert 'echo hi' in masked

    def test_a_one_line_scalar_is_extracted(self, tmp_path: Path) -> None:
        path = self._workflow(
            tmp_path,
            'jobs:\n  a:\n    steps:\n      - name: x\n        run: pnpm build\n',
        )
        masked, blocks, _ = guard._workflow_run_blocks(path)
        assert blocks == 1
        assert 'pnpm build' in masked
        assert 'name: x' not in masked

    def test_the_mask_preserves_the_file_coordinates(self, tmp_path: Path) -> None:
        # The property every report depends on: masking must not change the length of
        # any line, or `path:line` would name a place the reader cannot find.
        body = 'jobs:\n  a:\n    steps:\n      - run: |\n          echo hi\n'
        path = self._workflow(tmp_path, body)
        masked, _, _ = guard._workflow_run_blocks(path)
        assert [len(x) for x in masked.split('\n')] == [len(x) for x in body.split('\n')]
        assert masked.count('\n') == body.count('\n')

    def test_a_violation_is_reported_at_its_own_line(self, tmp_path: Path) -> None:
        path = self._workflow(
            tmp_path,
            'jobs:\n  a:\n    steps:\n      - name: x\n        run: |\n'
            '          ok=1\n          echo "' + hazard('f(1)') + '"\n',
        )
        masked, _, _ = guard._workflow_run_blocks(path)
        violations = guard.scan(masked, str(path))
        assert len(violations) == 1
        assert violations[0].startswith(f'{path}:7:')

    def test_a_github_expression_is_not_shell_text(self, tmp_path: Path) -> None:
        # `${{ ... }}` is resolved by the runner before bash starts. Without the mask
        # `${` would match inside `${{`, and every workflow using the syntax would be
        # reported -- which is how a guard becomes something people disable.
        path = self._workflow(
            tmp_path,
            'jobs:\n  a:\n    steps:\n      - run: |\n'
            '          mkdir -p "${{ github.workspace }}/data"\n'
            '          echo "${{ github.event.inputs.arm }}"\n',
        )
        masked, _, _ = guard._workflow_run_blocks(path)
        assert guard.scan(masked, str(path)) == []

    def test_an_input_handed_to_bash_through_env_is_clean(self, tmp_path: Path) -> None:
        # The shape §13.161's repair produced, and the one the guard should reward.
        path = self._workflow(
            tmp_path,
            'jobs:\n  a:\n    steps:\n      - run: |\n'
            '          if [ "$ARM" = "window" ]; then echo yes; fi\n'
            '        env:\n          ARM: ${{ github.event.inputs.arm }}\n',
        )
        masked, _, _ = guard._workflow_run_blocks(path)
        assert guard.scan(masked, str(path)) == []

    def test_a_step_after_the_block_is_not_swallowed(self, tmp_path: Path) -> None:
        # The bound is indentation, and the failure it prevents is the other direction:
        # a body that runs to the end of the file would scan comments and `env:` values
        # as shell and report hazards that no shell will ever see.
        path = self._workflow(
            tmp_path,
            'jobs:\n  a:\n    steps:\n      - run: |\n          echo hi\n'
            '        env:\n          X: "' + hazard('prose(x)') + '"\n',
        )
        masked, _, _ = guard._workflow_run_blocks(path)
        assert guard.scan(masked, str(path)) == []

    def test_the_entry_point_reads_a_workflow(self, tmp_path: Path) -> None:
        (tmp_path / 'tools').mkdir()
        (tmp_path / 'docs').mkdir()
        self._workflow(
            tmp_path,
            'jobs:\n  a:\n    steps:\n      - run: |\n          echo "' + hazard('f(1)') + '"\n',
        )
        assert guard.main(['prog', str(tmp_path)]) == 1

    def test_the_entry_point_passes_a_clean_workflow(self, tmp_path: Path) -> None:
        (tmp_path / 'tools').mkdir()
        (tmp_path / 'docs').mkdir()
        self._workflow(
            tmp_path,
            'jobs:\n  a:\n    steps:\n      - run: |\n          echo "' + hazard('name') + '"\n',
        )
        assert guard.main(['prog', str(tmp_path)]) == 0


class TestExpressionInjection:
    """A GitHub expression inside a `run:` block is substituted BEFORE bash parses it.

    This is `§13.161`'s eleventh recurrence as a rule. The shell rules in this file cannot see it: by
    the time bash runs the block, the value is not a variable, it is source. Quoting does not repair
    it either — `--limit "${{ inputs.limit }}"` breaks on a value containing a double quote — which is
    why the rule has no quoted/unquoted distinction and why the repair is always `env:`.

    The first run of this rule over this repository found fourteen sites across two workflows, all of
    them a dispatch input or a model name handed to a command as script text.
    """

    def _workflow(self, tmp_path: Path, body: str) -> Path:
        workflows = tmp_path / '.github' / 'workflows'
        workflows.mkdir(parents=True)
        path = workflows / 'bench.yml'
        path.write_text(body)
        return path

    def _violations(self, tmp_path: Path, body: str) -> list[str]:
        path = self._workflow(tmp_path, body)
        masked, _, expressions = guard._workflow_run_blocks(path)
        found = guard.scan(masked, str(path))
        return found + guard._expression_injection_violations(expressions, str(path))

    def test_a_dispatch_input_in_a_run_block_is_reported(self, tmp_path: Path) -> None:
        found = self._violations(
            tmp_path,
            'jobs:\n  a:\n    steps:\n      - run: |\n'
            '          node harness.mjs --limit "${{ inputs.limit }}"\n',
        )
        assert len(found) == 1
        assert 'inputs.' in found[0]
        assert 'BEFORE bash parses' in found[0]

    def test_quoting_is_not_repair(self, tmp_path: Path) -> None:
        # The double quotes are the shape a reader reaches for, and they are exactly the shape that
        # fails: a value containing `"` closes the quote and continues the command.
        found = self._violations(
            tmp_path,
            'jobs:\n  a:\n    steps:\n      - run: |\n'
            '          x="${{ github.event.inputs.arm }}"\n',
        )
        assert len(found) == 1

    def test_the_env_handoff_is_clean(self, tmp_path: Path) -> None:
        # The repair, and the shape `207e19d` produced in the one workflow that had already been fixed.
        found = self._violations(
            tmp_path,
            'jobs:\n  a:\n    env:\n      LIMIT: ${{ inputs.limit }}\n    steps:\n      - run: |\n'
            '          node harness.mjs --limit "$LIMIT"\n',
        )
        assert found == []

    def test_a_runner_provided_value_is_not_an_input(self, tmp_path: Path) -> None:
        # `github.workspace` and `github.run_id` are generated by the runner. Flagging them would
        # refuse valid workflows, which is the twelfth recurrence's failure in the other direction.
        found = self._violations(
            tmp_path,
            'jobs:\n  a:\n    steps:\n      - run: |\n'
            '          mkdir -p "${{ github.workspace }}/data"\n'
            '          echo "${{ github.run_id }}"\n',
        )
        assert found == []

    def test_a_pull_request_title_is_an_input(self, tmp_path: Path) -> None:
        # The classic, and the reason the list is not just dispatch inputs: a branch name or a PR
        # title reaches the same substitution with no operator involved at all.
        found = self._violations(
            tmp_path,
            'jobs:\n  a:\n    steps:\n      - run: |\n'
            '          echo "${{ github.event.pull_request.title }}"\n',
        )
        assert len(found) == 1
        assert 'pull_request' in found[0]

    def test_the_shell_rules_do_not_also_report_the_same_expression(self, tmp_path: Path) -> None:
        # One sequence is one defect. The shell view blanks the expression, so the shell rules see a
        # hole rather than an invalid expansion — without that, every workflow using the syntax would
        # be reported twice for one construct.
        found = self._violations(
            tmp_path,
            'jobs:\n  a:\n    steps:\n      - run: |\n'
            '          echo "${{ inputs.cards }}"\n',
        )
        assert len(found) == 1

    def test_the_entry_point_fails_on_an_injected_input(self, tmp_path: Path) -> None:
        (tmp_path / 'tools').mkdir()
        (tmp_path / 'docs').mkdir()
        self._workflow(
            tmp_path,
            'jobs:\n  a:\n    steps:\n      - run: |\n          echo "${{ inputs.cards }}"\n',
        )
        assert guard.main(['prog', str(tmp_path)]) == 1
