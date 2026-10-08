"""Tests for `tools/diagnose-bad-substitution.py`.

## What this file protects

Twelve recurrences of one class, and the twelve `Bad substitution` messages carry
bodies that look like identifiers (`String`, `bc`, `q"],`). Section 4j of
`docs/OPS-SHELL-INTERPOLATION.md` proved those bodies are **tails**, not
identifiers: the host tokeniser throws the rest of the token after an unclosed
`${`. So the message names where the parser stopped, never what was wrong.

Every previous round spent its time reading that name. The remedy that actually
removes the cost is to *stop reading it*: the message is decidable from the
command alone, and the diagnosis does not need a human or a model to work it out.
This file pins the mapping from a recorded message back to the shape that caused
it, so the answer is a lookup rather than an investigation.

## Why the fixtures are assembled and not written

`tools/check-shell-interpolation.py`'s own tests build the hazard from `chr(36)`
for a reason this file inherits: a fixture stored as a literal is reproduced
byte-for-byte into whatever carries the edit that writes it, so the test that
documents the hazard can itself be undeliverable. Every sequence below is
assembled at runtime.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'diagnose-bad-substitution.py'

DOLLAR = chr(36)
OPEN = chr(123)
CLOSE = chr(125)

# The seven characters that start the construct, assembled rather than typed.
OPENER = DOLLAR + OPEN


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(TOOL), *args],
        capture_output=True,
        text=True,
        timeout=60,
    )


def both(result: subprocess.CompletedProcess[str]) -> str:
    """stdout and stderr joined, for assertions about *what was said*.

    The two modes split their output on purpose: `--message` prints a report a
    human reads, `--command` prints violations the way the guard does -- on
    stderr, so it composes in a pipeline. A test that asserted against `stdout`
    alone therefore failed on a tool that was working, which is what these two
    assertions did on the first run. The assertions are about the diagnosis being
    present, not about which descriptor carried it, so they read both.
    """
    return result.stdout + result.stderr


class TestTheMessageIsDecodable:
    """A recorded `Bad substitution` maps back to the command that produced it."""

    def test_a_bare_tail_is_reported_as_an_unclosed_opener(self) -> None:
        """`String` is a tail, so the report must name the opener, not the word.

        This is the twelfth recurrence's exact message. A tool that repeated
        `String` back would be repeating the confusion twelve rounds were spent on.
        """
        r = run('--message', 'Failed to run function tools: Error: Bad substitution: String')
        assert r.returncode == 1, r.stdout + r.stderr
        assert OPENER in r.stdout, 'the report must name the unterminated opener'
        assert 'unterminated' in r.stdout.lower()

    def test_the_bc_tail_is_decoded_the_same_way(self) -> None:
        """`bc` -- from a template literal `${bc-1}` in a double-quoted argument."""
        r = run('--message', 'Bad substitution: bc')
        assert r.returncode == 1
        assert OPENER in r.stdout

    def test_a_json_tail_is_decoded(self) -> None:
        """`q"],` is a tail of a JSON fragment, and is not an identifier."""
        r = run('--message', 'Bad substitution: q"],')
        assert r.returncode == 1
        assert OPENER in r.stdout

    def test_the_empty_brace_branch_is_named_as_such(self) -> None:
        """`${}` is branch B, a different arm of the same function.

        The two branches are distinct defects and a report that merged them would
        send half its readers to the wrong repair: branch A is a missing closer,
        branch B is a present one with nothing between the braces.
        """
        r = run('--message', 'Bad substitution: ' + DOLLAR + OPEN + CLOSE)
        assert r.returncode == 1
        assert 'empty' in r.stdout.lower()


class TestTheCommandIsCheckedDirectly:
    """The tool answers about a command, without waiting for a failure."""

    def test_a_command_with_an_unclosed_opener_is_reported(self) -> None:
        command = 'echo "' + OPENER + 'x"'
        r = run('--command', command)
        assert r.returncode == 1
        assert OPENER in both(r)

    def test_a_clean_command_is_reported_clean(self) -> None:
        r = run('--command', 'echo hello')
        assert r.returncode == 0
        assert 'clean' in r.stdout.lower()

    def test_a_quoted_opener_is_literal_and_not_a_hazard(self) -> None:
        """A single-quoted sequence is an author writing the characters on purpose.

        The guard exempts it and so must this tool: a report that disagreed with
        the guard would send its reader to a violation the guard never raises.
        """
        command = "echo '" + OPENER + 'x}'
        r = run('--command', command)
        assert r.returncode == 0, r.stdout

    def test_a_shell_expansion_is_not_a_hazard(self) -> None:
        """`${HOME}` is valid shell and must stay clean in every mode."""
        command = 'echo "' + OPENER + 'HOME}"'
        r = run('--command', command)
        assert r.returncode == 0, r.stdout


class TestTheTwoModesAgree:
    """A message and the command that produced it get the same verdict."""

    def test_a_decoded_message_and_its_command_agree(self) -> None:
        """The two modes are two views of one defect, so they must not disagree.

        The failing shape is an UNCLOSED opener. A closed one (`+ CLOSE`) is a
        different defect -- an inner-language sequence sitting in live shell -- and
        conflating the two is the category error this whole document records.
        """
        unclosed = 'echo "' + OPENER + 'bc-1'
        by_command = run('--command', unclosed)
        by_message = run('--message', 'Bad substitution: bc-1')
        assert by_command.returncode == 1
        assert by_message.returncode == 1
        assert OPENER in both(by_command)
        assert OPENER in both(by_message)
