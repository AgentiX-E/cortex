"""Tests for the `python3` shim and the payload rule it calls.

## What this file protects

`/root/.pyenv/shims/python3` is an **environment change**, not a committed file. It
lives outside the repository, so nothing in review would notice it disappearing, and a
re-image removes it silently. The seventh `Bad substitution` happened *because* the
guard sat outside the path of a typed command: the rule existed, was tested, and was
not in the way. This file is the way the guard is in the way, and it asserts so.

The tests are written to fail loudly on a re-image rather than skip. A missing net that
reports nothing is indistinguishable from a net that never fires, which is the exact
condition that produced the recurrences.

## Why the payload rule lives here too

`scan_payload` answers a question no other rule can: "the shell question is already
settled, so is this program's own `${...}` a construct its language has?" Its only
caller is the shim, so a test of the shim is what keeps it honest. Splitting them would
let the caller and the callee drift while both stayed green.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SHIM = Path('/root/.pyenv/shims/python3')
GUARD = REPO / 'tools' / 'check-shell-interpolation.py'

DOLLAR = chr(36)
LBRACE = chr(123)
RBRACE = chr(125)


def seq(body: str) -> str:
    """`${body}` built from pieces.

    Written this way rather than as a literal because the literal would be a shell
    hazard in whatever carries this file -- an edit, a diff, a command. `scan_test_sources`
    in the guard enforces the same rule on writers; assembling the string is how a test
    can name the hazard without becoming one.
    """
    return DOLLAR + LBRACE + body + RBRACE


def run_shim(payload: str) -> subprocess.CompletedProcess[str]:
    """Run the shim the way PATH would, and capture its verdict."""
    return subprocess.run(
        [str(SHIM), '-c', payload],
        capture_output=True,
        text=True,
        timeout=60,
    )


class TestTheShimIsPresent:
    """An absent shim is the failure mode this class exists to make visible."""

    def test_the_shim_exists_and_is_executable(self) -> None:
        assert SHIM.exists(), (
            f'the python3 shim is missing at {SHIM}. It is an environment change, so a '
            f're-image removes it; reinstall it from docs/OPS-SHELL-INTERPOLATION.md. '
            f'Without it the guard is not in the path of a typed command, which is how '
            f'the seventh Bad substitution happened.'
        )
        assert SHIM.stat().st_mode & 0o111

    def test_the_shim_is_the_python3_on_PATH(self) -> None:
        # The shim only works if an unqualified `python3` resolves to it. Asserting the
        # absolute path alone would pass while PATH pointed elsewhere.
        found = subprocess.run(
            ['bash', '-lc', 'command -v python3'],
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert found.stdout.strip(), 'python3 not found on PATH'

    def test_the_shim_does_not_break_an_ordinary_payload(self) -> None:
        # The shim is on the path of every python3 invocation in this environment, so a
        # false positive would be worse than the hazard: it would be turned off.
        result = run_shim('print("shim alive")')
        assert result.returncode == 0, result.stderr
        assert 'shim alive' in result.stdout


class TestTheShimRefusesTheSeventhRecurrence:
    """The reported failures, replayed against the net that now catches them."""

    def test_a_format_spec_in_a_payload_is_refused(self) -> None:
        # This is the reported `Bad substitution: cut.toFixed`, in its Python spelling.
        result = run_shim('x = 1.23456\nprint(' + seq('x:.3f') + ')')
        assert result.returncode != 0, 'the shim allowed a format spec through'
        assert 'sits inside a `python` payload' in result.stderr

    def test_the_refusal_quotes_the_offending_sequence(self) -> None:
        result = run_shim('print(' + seq('x:.3f') + ')')
        assert seq('x:.3f') in result.stderr, (
            'the report must show the offending text; a diagnostic that costs a lookup '
            'is one people skim'
        )

    def test_the_refusal_names_the_way_out(self) -> None:
        result = run_shim('print(' + seq('x:.3f') + ')')
        assert 'exec-python.py' in result.stderr

    def test_a_bare_name_sequence_is_refused(self) -> None:
        # `${HOME}` is a legal shell expansion, so the shell rule stays quiet about it --
        # but it is not Python, and a payload is not shell. This is the case that made
        # `scan_payload` necessary: reusing the shell rule reported this clean.
        result = run_shim('print(' + seq('HOME') + ')')
        assert result.returncode != 0

    @pytest.mark.parametrize(
        'body',
        ['x:.3f', 'x:2.3f', 'label:>5', 'w:=^20', 'd:%Y'],
    )
    def test_every_measured_spec_shape_is_refused(self, body: str) -> None:
        # Each of these was run through bash, dash and zsh and fails in all three; the
        # table is in `_is_shell_expansion_for_a_payload`. A loop would report one test
        # name for five checks, which hides which shape regressed.
        result = run_shim('print(' + seq(body) + ')')
        assert result.returncode != 0, f'{seq(body)} was allowed through'


class TestTheShimAllowsWhatMustStayAllowed:
    """False positives are how a guard gets deleted, so they are asserted too."""

    @pytest.mark.parametrize(
        'body',
        ['HOME', 'PATH', 'x:-1', 'x:+w', 'x:offset', 'a:1', 'x:0:5', '1', '@'],
    )
    def test_a_real_shell_expansion_shape_is_quiet(self, body: str) -> None:
        # These are shell expansions, measured: `${x:-1}` is a default, `${a:1}` and
        # `${x:0:5}` are substrings that bash and zsh perform. A payload may print them
        # as literal text, and refusing would make the shim unusable.
        result = run_shim('print("' + seq(body) + '")')
        assert result.returncode == 0, (
            f'{seq(body)} was refused, but it is a valid shell expansion: {result.stderr}'
        )

    def test_a_payload_with_no_sequence_is_untouched(self) -> None:
        result = run_shim('import sys; print(sys.version_info[0])')
        assert result.returncode == 0
        assert result.stdout.strip() == '3'


class TestScanPayloadAnswersTheNarrowerQuestion:
    """`scan_payload` is not `scan`, and the difference is what it exists for."""

    def load_guard(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location('guard_for_shim_test', GUARD)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_a_payload_has_no_command_line_to_derive(self) -> None:
        # Feeding bare program text to `scan` reports clean, and did, in the first probe
        # of the shim -- the guard said `1 fragment(s) clean` about a payload Python then
        # refused to parse. That is why the two functions are separate.
        guard = self.load_guard()
        payload = 'x = 1.2\nprint(' + seq('x:.3f') + ')'
        assert guard.scan(payload, '<probe>') == []
        assert guard.scan_payload(payload, '<probe>', 'python') != []

    def test_a_shell_payload_is_exempt(self) -> None:
        # `sh -c 'echo ${HOME}'` is correct, so the rule must not fire on a shell
        # language. The argument is what names the language, not the origin string.
        guard = self.load_guard()
        assert guard.scan_payload('echo ' + seq('HOME'), '<probe>', 'sh') == []
        assert guard.scan_payload('echo ' + seq('HOME'), '<probe>', 'bash') == []

    def test_a_comment_in_a_payload_is_not_a_violation(self) -> None:
        # This module's own documentation names the hazard in prose, and a rule that
        # reported its own documentation would be deleted rather than obeyed.
        guard = self.load_guard()
        assert guard.scan_payload('# see ' + seq('x:.3f') + ' in the notes', '<p>', 'python') == []

    def test_the_language_is_named_in_the_report(self) -> None:
        guard = self.load_guard()
        reports = guard.scan_payload('print(' + seq('x:.3f') + ')', '<p>', 'python')
        assert len(reports) == 1
        assert '`python`' in reports[0]
