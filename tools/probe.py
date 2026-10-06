#!/usr/bin/env python3
"""Run a probe whose text would be mangled if the shell saw it.

## The eight failures this closes, and the layer they actually died in

Eight tool calls were lost to `Bad substitution`. The first seven were recorded in
`docs/OPS-SHELL-INTERPOLATION.md` and attributed to a shell expanding a `${...}`
inside a quoted argument. The eighth was `Bad substitution: q`, and finding its
layer required evidence rather than reasoning. From `.codebuddy/logs`:

    [ModelProvider] ... streamingToolName=Bash
    [ModelProvider] finish_reason="tool_calls" received
    [Interruption] Catch block entered, error: Failed to run function tools:
                   Error: Bad substitution: q
    [Interruption] functionCallItems count: 0

`functionCallItems count: 0` is the decisive line. The failing call was **never
dispatched to a tool**: it died while the streamed `Bash` argument was being
assembled. No shell ran, which is why the `python3` shim in this repository did not
prevent it -- and why `pythonShimPath=false` appears in the very same log line as
the sandbox dispatch. The expansion happens in the harness's own argument path.

The body inventory across all ten distinct failures says the same thing:

    String  String]  String'  "   min.toFixed  min.toFixed]  cut.toFixed  cut.toFixed]  q  q]

Two facts follow, and together they settle the strategy question.

1. **The trailing `]` and `'` variants show a body-scan that stops at a delimiter.**
   The reporter prints the prefix it had accumulated, which is what a parameter
   expansion parser does when it reaches a character its grammar does not accept.
2. **`q` is the end of the road for detection.** `${q}` is a valid POSIX parameter
   expansion in every shell in this image: measured, `bash`, `dash` and `zsh` all
   expand it to the empty string without complaint. Only `${(s:...:)}` and its
   relatives produce `Bad substitution`, and `q` is not one of those.

So as the bodies shrink from `JSON.stringify(x)` toward a bare `q`, a detector's
precision goes to zero: the text that fails is indistinguishable from correct shell.
**Detection is the wrong strategy and always was.** The precondition is a program
written inside a shell argument; this tool removes the precondition.

## What it does differently from `run-program.py`

`run-program.py` runs a program *from a file*. That is the right answer when the
program already exists. This tool is for the case that actually loses calls: a probe
that does not exist yet and is being improvised, where writing it as a file is the
step the author is trying to avoid.

The hazard is in the argument text. So the program arrives on **standard input**,
and the only thing in the command is a path and a quoted heredoc delimiter:

    python3 tools/probe.py --lang python -            <<'PROBE'
    for q in (0.25, 0.5, 0.9):
        print(f'{q:.3f}')
    PROBE

`<<'PROBE'` is **quoted**, so the shell performs no expansion on the body. The
`${...}` in the program is delivered byte-for-byte to the interpreter instead of
being read by the shell (or by the harness's argument path) first.

## Why the delimiter is not optional

    <<'PROBE'   the body is literal -- correct
    <<PROBE     the body is expanded -- this IS the bug

The two differ by two characters and the second is what the default muscle memory
produces, so this tool checks what it received and says so. A `SyntaxError` from the
interpreter names a token three frames downstream; a message here names the cause.

## Scope, and what is deliberately absent

It runs a program and passes remaining arguments through. It does not read a file
path as the program (use `run-program.py`), and it does not write anything to disk --
a probe that persists is a probe the author has decided to keep, and that decision
belongs to `--keep`.

Exit code is the program's, so a probe can be used as a predicate.
"""

from __future__ import annotations

import subprocess
import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# The guard is imported, not spawned. It has to judge exactly the bytes about to
# execute, and handing them to a subprocess would mean writing them somewhere first.
_spec = spec_from_file_location(
    'check_shell_interpolation',
    Path(__file__).parent / 'check-shell-interpolation.py',
)
assert _spec is not None and _spec.loader is not None
_guard = module_from_spec(_spec)
_spec.loader.exec_module(_guard)

# Language selection is by explicit flag and nothing else. A probe on stdin has no
# extension to infer from, and `run-program.py` already owns inference for real files;
# guessing here would give one question two answers that can disagree.
LANGUAGES: dict[str, list[str]] = {
    'python': [sys.executable, '-'],
    'python3': [sys.executable, '-'],
    'js': ['node', '--input-type=module'],
    'mjs': ['node', '--input-type=module'],
    'node': ['node', '--input-type=module'],
    'sh': ['sh', '-s'],
    'bash': ['bash', '-s'],
}

USAGE = """Run a probe whose text the shell must not read.

  python3 tools/probe.py --lang LANG - [args...] <<'DELIM'
  <program>
  DELIM

The heredoc delimiter MUST be quoted. `<<PROBE` expands the body and is the
failure this tool exists to avoid; `<<'PROBE'` does not.

Languages: python, js, mjs, node, sh, bash.
"""


def _read_program() -> str:
    """The program text, from stdin only.

    stdin rather than argv on purpose. A program passed as an argument re-enters
    the argument path that produced the eight failures; stdin does not, because a
    quoted heredoc is expanded by nobody.
    """
    return sys.stdin.read()


def _expanded_body_symptom(text: str, language: str) -> str | None:
    """A message if the text looks like a HERE-DOC body the shell expanded.

    ## Why this check cannot be omitted

    The difference between the right and wrong delimiter is two characters, and the
    wrong one is the default. This is the only point in the pipeline where the
    author can still be told which they used, because the symptom is a program that
    parses but does not do what it says -- or does not parse at all, for a reason
    that points at the language rather than at the heredoc.

    ## What it does not claim

    It cannot always tell. A program whose `${...}` was expanded to empty may be
    perfectly valid in its language (`print("")`), and this returns `None` for it.
    The check is a warning on the evidence present, not a proof of correct quoting.
    """
    reports = _guard.scan_payload(text, '<stdin probe>', language)
    if not reports:
        return None
    return (
        reports[0]
        + '\n  If that sequence was meant literally, the heredoc delimiter is '
        'unquoted:\n    <<PROBE expands the body; <<\'PROBE\' does not.'
    )


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ('-h', '--help'):
        print(USAGE, file=sys.stderr)
        return 0 if len(argv) > 1 else 2

    language = 'python'
    rest = argv[1:]
    if rest[0] == '--lang':
        if len(rest) < 2:
            print('--lang needs a value', file=sys.stderr)
            return 2
        language = rest[1]
        rest = rest[2:]

    if language not in LANGUAGES:
        print(
            f"unknown language {language!r}; known: {', '.join(sorted(LANGUAGES))}",
            file=sys.stderr,
        )
        return 2

    # The program MUST come from stdin. An argument here would be the hazard itself,
    # so it is rejected rather than treated as a path: silently reading a file named
    # by the first argument would make `probe.py --lang python 'x = 1'` look like it
    # worked and then do nothing.
    if rest and rest[0] != '-':
        print(USAGE, file=sys.stderr)
        print(
            f'\nrefused: expected `-` (read the program from stdin), got {rest[0]!r}. '
            f'A program passed as an argument re-enters the path that produced the '
            f'eight Bad substitution failures.',
            file=sys.stderr,
        )
        return 2
    args = rest[1:] if rest else []

    text = _read_program()
    if not text.strip():
        print('probe: empty program', file=sys.stderr)
        return 2

    symptom = _expanded_body_symptom(text, language)
    if symptom is not None:
        print(f'probe: warning: {symptom}', file=sys.stderr)

    result = subprocess.run([*LANGUAGES[language], *args], input=text, text=True, check=False)
    return result.returncode


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
