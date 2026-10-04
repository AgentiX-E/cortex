#!/usr/bin/env python3
"""Run a program from a file, never from a shell string.

## Why this exists

Three separate tool calls have now aborted with `Bad substitution`:

    Bad substitution: String            (a TS template literal in a quoted arg)
    Bad substitution: lines[l-1].trim   (the same, in a probe)
    Bad substitution: h.join            (the same, in a probe)

Each time the cause was identical and each time it was recorded rather than
removed. `tools/check-shell-interpolation.py` detects the pattern, and it works
-- but it scans **files**, so it cannot see a command string at the moment it is
written, which is the only moment that matters. A guard that cannot run at the
point of failure is documentation.

The precondition for all three failures is the same: a program was written
*inside a shell command*. The fix is to remove the precondition, not to keep
detecting its consequences.

## What this does

Reads a program from a file (or stdin) and executes it with the interpreter
selected by the file's extension, passing any remaining arguments through. The
shell never sees the program text, so no shell interpolation inside it can be
expanded by the shell. The program is also a file on disk, which means the
existing guard scans it and the failure becomes a lint error before it becomes a
lost invocation.

## Usage

    python3 tools/run-program.py /tmp/probe.mjs arg1 arg2
    python3 tools/run-program.py -              # program on stdin
    echo 'console.log(1)' | python3 tools/run-program.py --lang js -

Interpreters: `.mjs`/`.js` -> node, `.ts` -> node --experimental-strip-types,
`.py` -> python3, `.sh` -> sh. Unknown extension with `--lang` uses that.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

# Extension -> argv prefix. An entry here is a promise that the interpreter can
# run a file of that kind without the shell being involved in any way.
INTERPRETERS: dict[str, list[str]] = {
    '.mjs': ['node'],
    '.js': ['node'],
    '.cjs': ['node'],
    '.ts': ['node', '--experimental-strip-types'],
    '.py': ['python3'],
    '.sh': ['sh'],
    '.bash': ['bash'],
}


def _usage() -> str:
    return (
        'usage: run-program.py [--lang EXT] <file|-> [args...]\n'
        f'known extensions: {", ".join(sorted(INTERPRETERS))}'
    )


def _load_guard():
    """Load the interpolation guard as a module.

    The rule is defined once, in `check-shell-interpolation.py`. This tool calls
    that implementation rather than restating it, so the two cannot drift into
    disagreeing about what is safe -- which is the failure mode a duplicated
    checker always eventually has.
    """
    import importlib.util

    guard_path = Path(__file__).parent / 'check-shell-interpolation.py'
    spec = importlib.util.spec_from_file_location('check_shell_interpolation', guard_path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _render(violations: list[str]) -> str:
    return '\n'.join(violations) + '\n'


def _check_fragment_text(text: str, origin: str) -> list[str]:
    """Return the guard's violations for a program's text, or [] if clean."""
    guard = _load_guard()
    if guard is None:
        # No guard available: run the program rather than block on a missing
        # file. The guard is a safety net, not a hard dependency.
        return []
    return guard.scan(text, origin)


def _guard_path(path: str) -> str | None:
    """Return a message if the file at `path` violates the rule, else None."""
    guard = _load_guard()
    if guard is None:
        return None
    text = Path(path).read_text(encoding='utf-8')
    violations = guard.scan(text, path)
    return _render(violations) if violations else None


def main(argv: list[str]) -> int:
    args = argv[1:]
    lang: str | None = None

    # `--lang` exists for stdin, which has no extension to dispatch on. It is not
    # a way to bypass the file rule: the program still arrives as text from a
    # file or a pipe, never as a shell command line.
    if args and args[0] == '--lang':
        if len(args) < 2:
            print(_usage(), file=sys.stderr)
            return 2
        lang = args[1] if args[1].startswith('.') else f'.{args[1]}'
        args = args[2:]

    if not args:
        print(_usage(), file=sys.stderr)
        return 2

    source = args[0]
    passthrough = args[1:]

    if source == '-':
        text = sys.stdin.read()
        if lang is None:
            print('run-program: reading from stdin requires --lang', file=sys.stderr)
            return 2
        # Check BEFORE writing the temp file, so the stdin path is covered by the
        # same rule as the file path. Leaving this out was a real hole: a hazard
        # piped in still reached the shell and still raised `Bad substitution`,
        # which is the failure the tool exists to prevent. A test caught it.
        violations = _check_fragment_text(text, '<stdin>')
        if violations:
            sys.stderr.write(_render(violations))
            return 1
        # A temp file rather than `-`: some interpreters treat `-` as "read the
        # REPL's stdin", which would consume the passthrough arguments. Writing
        # the bytes to a file also means the shell still never sees them.
        import tempfile

        with tempfile.NamedTemporaryFile('w', suffix=lang, delete=False) as handle:
            handle.write(text)
            temp_path = Path(handle.name)
        program_args = [temp_path]
    else:
        temp_path = None
        program_path = Path(source)
        if not program_path.is_file():
            print(f'run-program: no such file: {program_path}', file=sys.stderr)
            return 2
        # Refuse to run a program that the interpolation guard rejects. This is
        # the one place the guard's rule can be enforced at RUN time rather than
        # at commit time, so it is enforced here.
        message = _guard_path(str(program_path))
        if message:
            # The program is on disk, so this is a lint failure rather than a
            # lost invocation -- which is the entire point of the file rule.
            sys.stderr.write(message)
            return 1
        program_args = [program_path]

    extension = lang or ''.join(Path(source).suffixes[-1:])
    interpreter = INTERPRETERS.get(extension)
    if interpreter is None:
        print(
            f'run-program: no interpreter for extension {extension!r}; pass --lang',
            file=sys.stderr,
        )
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
        return 2

    try:
        return subprocess.run(
            [*interpreter, *program_args, *passthrough],
        ).returncode
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
