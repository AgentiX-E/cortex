"""Tests for `tools/run-program.py`.

The point of this tool is narrow and worth stating so the tests stay honest:
three tool calls were lost to `Bad substitution`, all three because a program was
written *inside a shell command*. `check-shell-interpolation.py` detects the
pattern in files, which cannot help at the moment a command is typed. This tool
removes the precondition by making "program" and "shell string" disjoint.

So the tests below are about the two promises that matter:

  1. a program's text reaches the interpreter without the shell touching it, and
     the program still receives its own arguments;
  2. a program containing the hazard is refused at RUN time, with the guard's own
     message, instead of being executed and lost.
"""

from __future__ import annotations

import importlib.util
import io
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).resolve().parent.parent / 'run-program.py'


def _load():
    spec = importlib.util.spec_from_file_location('run_program', MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runner = _load()

# The hazard, assembled from character codes rather than written literally.
#
# This looks obtuse and is deliberate. Four tool calls were lost to `Bad
# substitution` while this file was being written: the offending text is inert
# inside a Python string, but not inside the shell command that delivers the
# edit, so the edit never arrived. Spelling it once, here, from codes keeps the
# exact bytes available to the tests without putting those bytes in a command
# line again. `DOLLAR + BRACE` is the sequence the shell reacts to.
DOLLAR = chr(36)
BRACE = chr(123)
HAZARD = DOLLAR + BRACE + 'h.join(ch)' + chr(125)


class TestTheHazardItself:
    """Pin the payload, so the tests above cannot silently stop testing it."""

    def test_the_hazard_is_what_the_guard_rejects(self) -> None:
        # If this ever fails, every "refuses" test above has been asserting about
        # a string that no longer contains a hazard -- a green suite measuring
        # nothing. The guard's own classifier is the oracle, not a literal here.
        guard = runner._load_guard()
        assert guard is not None
        assert guard.VALID_EXPANSION.fullmatch('h.join(ch)') is None
        assert runner._check_fragment_text('echo "' + HAZARD + '"\n', 'probe.sh') != []

    def test_the_hazard_is_not_written_literally_anywhere(self) -> None:
        # The file must not contain the raw sequence, because the raw sequence is
        # what breaks the delivery of an edit to this file. `DOLLAR + BRACE` is
        # two Python expressions, not the two characters.
        #
        # The assertion is on the DOLLAR-BRACE pair, not on `h.join`: prose may
        # name the identifier, and this file's docstrings do. Only the pair is
        # what the shell reacts to, so only the pair is what must stay absent.
        source = Path(__file__).read_text(encoding='utf-8')
        assert DOLLAR + BRACE not in source


class TestInterpreterSelection:
    """The extension decides the interpreter; nothing else does."""

    @pytest.mark.parametrize(
        ('extension', 'expected'),
        [
            ('.mjs', ['node']),
            ('.js', ['node']),
            ('.cjs', ['node']),
            ('.py', ['python3']),
            ('.sh', ['sh']),
            ('.bash', ['bash']),
        ],
    )
    def test_maps_extension_to_interpreter(self, extension: str, expected: list[str]) -> None:
        assert runner.INTERPRETERS[extension] == expected

    def test_typescript_uses_the_strip_types_flag(self) -> None:
        # Not `ts-node`: the node on PATH can strip types natively, and adding a
        # dependency here would make the escape hatch harder to use than the
        # mistake it exists to prevent.
        assert runner.INTERPRETERS['.ts'] == ['node', '--experimental-strip-types']


class TestRunsAProgramFromAFile:
    """The primary path: a file on disk, executed without shell involvement."""

    def test_runs_a_python_program(self, tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
        program = tmp_path / 'p.py'
        program.write_text("print('from-file')\n")
        assert runner.main(['prog', str(program)]) == 0
        assert 'from-file' in capfd.readouterr().out

    def test_passes_arguments_through(self, tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
        program = tmp_path / 'p.py'
        program.write_text('import sys\nprint("|".join(sys.argv[1:]))\n')
        assert runner.main(['prog', str(program), 'a', 'b']) == 0
        assert 'a|b' in capfd.readouterr().out

    def test_propagates_the_program_exit_code(self, tmp_path: Path) -> None:
        program = tmp_path / 'p.py'
        program.write_text('import sys\nsys.exit(7)\n')
        assert runner.main(['prog', str(program)]) == 7

    def test_missing_file_is_a_usage_error(self, tmp_path: Path) -> None:
        assert runner.main(['prog', str(tmp_path / 'absent.py')]) == 2

    def test_unknown_extension_is_a_usage_error(self, tmp_path: Path) -> None:
        program = tmp_path / 'p.zig'
        program.write_text('// nothing\n')
        assert runner.main(['prog', str(program)]) == 2

    def test_no_arguments_is_a_usage_error(self) -> None:
        assert runner.main(['prog']) == 2


class TestRefusesTheHazardAtRunTime:
    """The reason the tool exists: a hazardous program must not be executed."""

    def test_refuses_a_program_containing_the_collision(
        self, tmp_path: Path, capfd: pytest.CaptureFixture[str]
    ) -> None:
        program = tmp_path / 'probe.sh'
        # The exact text that produced `Bad substitution: h.join`.
        program.write_text('echo "' + HAZARD + '"\n')
        code = runner.main(['prog', str(program)])
        assert code == 1
        assert 'h.join' in capfd.readouterr().err

    def test_allows_the_same_text_when_single_quoted(self, tmp_path: Path) -> None:
        # Single quotes suppress expansion, so this spelling is legitimate and a
        # tool that rejected it would be wrong in the other direction.
        program = tmp_path / 'probe.sh'
        program.write_text("echo '" + HAZARD + "'\n")
        assert runner.main(['prog', str(program)]) == 0

    def test_a_javascript_program_with_template_literals_is_allowed(
        self, tmp_path: Path
    ) -> None:
        # The guard is about SHELL, not about the inner language. A `.mjs` file is
        # never expanded, so its template literals are fine and must not be
        # reported -- otherwise the tool would ban the very thing it recommends.
        program = tmp_path / 'p.mjs'
        program.write_text('const ch = ["a","b"];\nconsole.log(ch.join(""));\n')
        assert runner.main(['prog', str(program)]) == 0


class TestStdin:
    """`-` reads the program from a pipe, still never from a shell string."""

    def test_runs_a_program_from_stdin(self, monkeypatch: pytest.MonkeyPatch, capfd: pytest.CaptureFixture[str]) -> None:
        monkeypatch.setattr('sys.stdin', io.StringIO("print('from-stdin')\n"))
        assert runner.main(['prog', '--lang', 'py', '-']) == 0
        assert 'from-stdin' in capfd.readouterr().out

    def test_stdin_without_lang_is_a_usage_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr('sys.stdin', io.StringIO('print(1)\n'))
        assert runner.main(['prog', '-']) == 2

    def test_stdin_temp_file_is_removed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # The temp file holds the program text and must not outlive the run; a
        # leftover would be an unexplained artefact in the next audit.
        import tempfile

        probes: list[str] = []
        real_named = tempfile.NamedTemporaryFile

        def spy(*args, **kwargs):
            handle = real_named(*args, **kwargs)
            probes.append(handle.name)
            return handle

        monkeypatch.setattr(tempfile, 'NamedTemporaryFile', spy)
        monkeypatch.setattr('sys.stdin', io.StringIO('print(1)\n'))
        assert runner.main(['prog', '--lang', 'py', '-']) == 0
        assert probes
        assert not Path(probes[0]).exists()

    def test_refuses_a_hazardous_stdin_program(
        self, monkeypatch: pytest.MonkeyPatch, capfd: pytest.CaptureFixture[str]
    ) -> None:
        # A hazard piped in must be refused exactly like one in a file. The first
        # version of this tool checked only the file path, so stdin still reached
        # the shell and still raised `Bad substitution` -- the same lost
        # invocation, one indirection later. This test is what caught it, so the
        # assertion is on the refusal, not on the absence of an error message.
        #
        # The hazard is ASSEMBLED rather than written out. Spelling the dollar and
        # brace into this file's source is what lost four tool calls already: the
        # text is inert to pytest but not to the shell that carries the edit.
        hazard = 'echo "' + HAZARD + '"\n'
        monkeypatch.setattr('sys.stdin', io.StringIO(hazard))
        assert runner.main(['prog', '--lang', 'sh', '-']) == 1
        captured = capfd.readouterr()
        assert 'h.join' in captured.err

    def test_a_clean_stdin_program_still_runs(
        self, monkeypatch: pytest.MonkeyPatch, capfd: pytest.CaptureFixture[str]
    ) -> None:
        monkeypatch.setattr('sys.stdin', io.StringIO("print('clean-stdin')\n"))
        assert runner.main(['prog', '--lang', 'py', '-']) == 0
        assert 'clean-stdin' in capfd.readouterr().out
