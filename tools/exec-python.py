#!/usr/bin/env python3
"""Run a Python program from a FILE or STDIN, so the shell never parses it.

## Why this exists

Seven tool calls were lost to `Bad substitution`. Every one took the same route: a
Python program was written inline in a shell command, the program contained a
`${...}` sequence, and the shell expanded it before Python was reached. Two of the
seven -- `${String(t).padEnd(5)}` and `${cut.toFixed(3)}` -- were template-literal
syntax from another language; the rest were this module's own test fixtures, written
into a command line that died before the file could be created.

The guard (`tools/check-shell-interpolation.py`) detects the pattern. This tool
removes the need for it. Both are useful, and they are useful in that order: a guard
tells you when you have made the mistake, a tool means there is no mistake to make.

    # the failing shape: the shell sees the program
    python3 -c "import math; print('${x:.3f}')"

    # the working shape: the shell sees a filename
    python3 tools/exec-python.py program.py

    # or no file at all, for a program that is still being drafted
    python3 tools/exec-python.py -            <<'PY'
    import math
    print('${x:.3f}')
    PY

## The one rule

The program text is never interpolated by the shell. `-` reads stdin, which the shell
has already expanded if the author wrote an unquoted heredoc -- which is why the
message above shows a quoted delimiter (`<<'PY'`). A quoted delimiter suppresses
expansion, so the body arrives byte-for-byte. The heredoc's own delimiter is the
thing that makes stdin safe, and it is the author's responsibility:

    <<'PY'   literal, correct
    <<PY     expanded, and the expansion is the bug

Because that distinction is easy to miss and impossible to see afterwards, this tool
checks the text it receives too. If the body carries a sequence the shell would have
mangled, saying so at this point names the real cause, whereas the `SyntaxError`
Python produces three frames later names a symptom.

## Scope

This runs Python. `tools/run-program.py` is the general form and dispatches on
extension or `--lang`; this is the Python-only path, kept separate because it is the
one the shim's message names and because a single-purpose tool is easier to trust.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

# The guard is imported rather than re-run as a subprocess: the check has to happen on
# exactly the text that is about to execute, and a subprocess would mean writing that
# text somewhere first. Writing it out is the act that loses the call.
from importlib.util import module_from_spec, spec_from_file_location  # noqa: E402

_spec = spec_from_file_location(
    'check_shell_interpolation',
    Path(__file__).parent / 'check-shell-interpolation.py',
)
assert _spec is not None and _spec.loader is not None
_guard = module_from_spec(_spec)
_spec.loader.exec_module(_guard)


def _read(source: str) -> tuple[str, str]:
    """The program text and a name for it, from a path or from stdin."""
    if source == '-':
        return sys.stdin.read(), '<stdin>'
    path = Path(source)
    if not path.exists():
        print(f'exec-python: no such file: {source}', file=sys.stderr)
        raise SystemExit(2)
    return path.read_text(encoding='utf-8'), str(path)


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ('-h', '--help'):
        print(__doc__.split('## The one rule')[0].strip(), file=sys.stderr)
        return 0 if len(argv) > 1 else 2

    source = argv[1]
    rest = argv[2:]
    text, name = _read(source)

    # A `${...}` that survived to here is one the shell did not expand -- which means
    # the author used single quotes or a quoted heredoc, correctly. That is the safe
    # shape, so this is not an error; but if the sequence is a format spec rather than
    # a shell expansion, the program itself is suspect and the run would fail with a
    # `SyntaxError` that points at the wrong thing. Reporting it here names the cause.
    #
    # It is a warning and not a refusal because a legitimate program may print the
    # literal text `${HOME}` and must still run. The guard is what refuses; this tool
    # is what runs things.
    for violation in _guard.scan_payload(text, name, 'python'):
        print(f'exec-python: warning: {violation}', file=sys.stderr)

    result = subprocess.run(
        [sys.executable, *(['-c', text] if source == '-' else [name]), *rest],
        check=False,
    )
    return result.returncode


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
