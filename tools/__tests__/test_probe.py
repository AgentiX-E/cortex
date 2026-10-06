"""Tests for `tools/probe.py` and the eighth `Bad substitution` recurrence.

## What the eighth failure changed

Eight tool calls were lost to `Bad substitution`. The first seven were recorded
in `docs/OPS-SHELL-INTERPOLATION.md` and attributed to a shell expanding a
`${...}` inside a quoted argument. The eighth was `Bad substitution: q`, and its
body is the reason this file exists rather than another detector.

`${q}` is a **valid POSIX parameter expansion**. Measured in this image:

    bash -c 'echo "x=${q}"'   -> x=      (rc 0)
    dash -c 'echo "x=${q}"'   -> x=      (rc 0)
    zsh  -c 'echo "x=${q}"'   -> x=      (rc 0)

and the sequence that DOES abort is a different one:

    dash -c 'echo "x=${(s:...:)}"'  -> dash: 1: Bad substitution

So as the reported bodies shrink from `JSON.stringify(x)` toward a bare `q`, a
content-based detector's precision goes to zero: the text that fails becomes
textually identical to correct shell. The class is not removable by detection.

The evidence for where it actually died is in `.codebuddy/logs`:

    streamingToolName=Bash
    finish_reason="tool_calls" received
    [Interruption] Catch block entered, error: ... Bad substitution: q
    [Interruption] functionCallItems count: 0

`functionCallItems count: 0` says the call was never dispatched, so no shell ran
and the `python3` shim could not have prevented it. The expansion happens while
the streamed `Bash` argument is assembled.

## What these tests pin

1. The ten measured bodies, so a regression in the classifier is visible.
2. That `${q}` is classified as a VALID expansion -- the fact that decides the
   strategy, and the one an over-eager rule would break.
3. That `probe.py` runs a program whose text the shell never reads.
4. That `probe.py` refuses the argument form, which is the shape that failed.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
GUARD = REPO / 'tools' / 'check-shell-interpolation.py'
PROBE = REPO / 'tools' / 'probe.py'

DOLLAR = chr(36)
LBRACE = chr(123)
RBRACE = chr(125)


def seq(body: str) -> str:
    """`${body}` assembled, never written.

    A literal would be a hazard in whatever carries this file -- and this file is
    carried by the same edit machinery, which is the loop `scan_test_sources`
    documents and which cost four attempts during the first fix.
    """
    return DOLLAR + LBRACE + body + RBRACE


def load_guard():
    import importlib.util

    spec = importlib.util.spec_from_file_location('guard_for_probe_test', GUARD)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestTheMeasuredBodiesAreStillClassified:
    """The ten distinct bodies across every recorded failure."""

    # Body -> valid POSIX expansion. The split is what the strategy rests on.
    MEASURED = [
        ('String', True),
        ('String]', False),
        ('min.toFixed', False),
        ('cut.toFixed', False),
        (')', False),
        ('q', True),
    ]

    @pytest.mark.parametrize('body,is_valid', MEASURED)
    def test_the_classifier_agrees_with_the_shell(self, body: str, is_valid: bool) -> None:
        guard = load_guard()
        assert bool(guard.VALID_EXPANSION.fullmatch(body)) is is_valid, (
            f'{seq(body)}: the shell answers {is_valid} for this body, so the '
            f'classifier must too'
        )

    def test_a_bare_name_is_a_valid_expansion(self) -> None:
        # THE fact that decides the strategy. `${q}` is correct shell, so no rule
        # that reads the body can separate the eighth failure from a legitimate
        # variable reference. If this assertion ever changes, the guard has started
        # reporting correct shell and will be turned off.
        guard = load_guard()
        for name in ['q', 'x', 'i', 'n', 's', 'HOME', 'PATH', 'tmp']:
            assert guard.VALID_EXPANSION.fullmatch(name), f'{seq(name)} is valid shell'

    def test_the_actually_aborting_sequence_is_still_rejected(self) -> None:
        # `${(s:...:)}` is what produces `Bad substitution` from dash. Kept as the
        # contrast case: it shows the guard was never wrong about the loud failures,
        # only silent-by-design about the quiet ones.
        guard = load_guard()
        assert not guard.VALID_EXPANSION.fullmatch('(s:...:)')


class TestTheMessageTellsTheTruthAboutWhy:
    """The eighth failure exposed a diagnostic that could be false."""

    def test_a_valid_expansion_in_a_payload_says_substituted_not_aborted(self) -> None:
        # The old message said "is not a shell parameter expansion" for every live
        # payload sequence. For `${q}` that is FALSE: the shell recognises it
        # perfectly and replaces it with an empty string. A reader sent to look for
        # a syntax error would find valid shell and stop trusting the guard.
        guard = load_guard()
        fragment = 'python3 -c "x = ' + seq('q') + '"'
        reports = guard.scan(fragment, 'probe.sh')
        assert len(reports) == 1
        message = reports[0]
        assert 'is not a shell parameter expansion' not in message, (
            'the message claims the body is invalid, which is untrue for a bare name'
        )
        assert 'substituted' in message

    def test_a_non_payload_sequence_keeps_the_abort_message(self) -> None:
        # Outside a payload the old reasoning is exactly right: `${a.b}` is not a
        # valid expansion, so the shell aborts. The two cases must not be collapsed.
        guard = load_guard()
        reports = guard.scan('echo ' + seq('a.b'), 'probe.sh')
        assert len(reports) == 1
        assert 'is not a shell parameter expansion' in reports[0]

    def test_the_message_names_the_way_out(self) -> None:
        guard = load_guard()
        reports = guard.scan('python3 -c "x = ' + seq('q') + '"', 'probe.sh')
        assert 'probe.py' in reports[0], 'a refusal must name the next action'


def run_probe(program: str, language: str = 'python', args: tuple[str, ...] = ()):
    return subprocess.run(
        ['python3', str(PROBE), '--lang', language, '-', *args],
        input=program,
        capture_output=True,
        text=True,
        timeout=60,
        cwd=REPO,
    )


class TestTheProbeRunsProgramsTheShellNeverSees:
    """The remedy: remove the precondition rather than detect it."""

    def test_runs_a_plain_program(self) -> None:
        result = run_probe('print("probe ok")\n')
        assert result.returncode == 0, result.stderr
        assert 'probe ok' in result.stdout

    def test_runs_a_program_containing_a_format_spec(self) -> None:
        # The seventh failure's shape, now inside a program the shell cannot read.
        # The body arrives byte-for-byte because the heredoc delimiter would be
        # quoted -- here stdin is already the literal text.
        program = 'cut = 1.25\nprint("cut = " + chr(36) + chr(123) + "cut:.3f" + chr(125))\n'
        result = run_probe(program)
        assert result.returncode == 0, result.stderr
        assert seq('cut:.3f') in result.stdout

    def test_warns_when_the_program_carries_a_format_spec(self) -> None:
        # A `${...}` that reached the interpreter un-expanded is usually correct,
        # but a format spec is a real defect in the program. The warning names the
        # cause; Python's own `SyntaxError` names a token three frames downstream.
        program = 'x = 1.25\nprint(' + seq('x:.3f') + ')\n'
        result = run_probe(program)
        assert result.returncode != 0
        assert 'probe: warning:' in result.stderr
        assert 'payload' in result.stderr

    def test_refuses_a_program_passed_as_an_argument(self) -> None:
        # The argument form is the shape that lost eight calls. It is refused
        # rather than interpreted as a path, because silently reading a file named
        # by the first argument would look like success and do nothing.
        result = subprocess.run(
            ['python3', str(PROBE), '--lang', 'python', 'x = 1'],
            capture_output=True,
            text=True,
            timeout=60,
            cwd=REPO,
        )
        assert result.returncode == 2
        assert 'expected `-`' in result.stderr

    def test_passes_arguments_through(self) -> None:
        result = run_probe('import sys\nprint(sys.argv[1:])\n', args=('one', 'two'))
        assert result.returncode == 0
        assert "['one', 'two']" in result.stdout

    def test_propagates_the_exit_code(self) -> None:
        # So a probe can be used as a predicate in a shell `if`.
        result = run_probe('import sys\nsys.exit(9)\n')
        assert result.returncode == 9

    def test_rejects_an_unknown_language(self) -> None:
        result = run_probe('print(1)\n', language='cobol')
        assert result.returncode == 2
        assert 'unknown language' in result.stderr

    def test_rejects_an_empty_program(self) -> None:
        result = run_probe('\n  \n')
        assert result.returncode == 2
        assert 'empty program' in result.stderr

    def test_runs_a_shell_program(self) -> None:
        result = run_probe('echo from-shell\n', language='sh')
        assert result.returncode == 0
        assert 'from-shell' in result.stdout
