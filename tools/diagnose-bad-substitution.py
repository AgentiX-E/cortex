#!/usr/bin/env python3
"""Decode a `Bad substitution: X` message back to the shape that produced it.

## Why this exists

`docs/OPS-SHELL-INTERPOLATION.md` records twelve recurrences of one class. Every
round was spent reading the reported body -- `String`, `bc`, `q"],`, `min.toFixed`
-- and every round concluded something different about it, because a tail of a
command carries no information about what went wrong.

Section 4j located the producer: a vendored `shell-quote` tokeniser inside the
host Node process, whose `parseEnvVar` throws the rest of the token after an
unclosed `{`. The twelfth recurrence is the bill for not having acted on that
finding: the message was still being read as if it named a defect.

**The message is decidable.** An unclosed opener is the only input that reaches
that branch, so the tail in the message is a symptom and the diagnosis is fixed.
This tool performs the mapping so it costs a lookup instead of an investigation,
and so its answer does not depend on how much attention the reader has left.

## The two branches, which are different defects

Located in the bundle and measured against it (see 4j):

    branch A   no `}` anywhere after the `{`   -> the body is the rest of the token
    branch B   `}` immediately after the `{`   -> the body is the three characters

A report that merged them would send half its readers to the wrong repair: A is a
missing closer, B is a present closer with nothing inside it. Both are refused,
and they are refused for different reasons.

## Why `--command` does not re-derive the tokeniser

`scan_payload` and `_unterminated_expansions` in `tools/check-shell-interpolation.py`
already model this, and a second implementation would drift from the first while
both stayed green -- the failure mode `docs/AUDIT-CODE-VS-DOCS.md` records. The
`--command` mode therefore *imports* the guard and calls it, so the verdict here
is the guard's verdict by construction rather than by agreement.

## Usage

    python3 tools/diagnose-bad-substitution.py --message 'Bad substitution: String'
    python3 tools/diagnose-bad-substitution.py --command 'echo "...${x"'

Exit status is 0 for a clean verdict and 1 for a decoded (or present) hazard, so
the tool composes with a shell pipeline the same way the guard does.
"""

from __future__ import annotations

import argparse
import importlib.util
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
GUARD = REPO / 'tools' / 'check-shell-interpolation.py'

DOLLAR = chr(36)
OPEN_BRACE = chr(123)
CLOSE_BRACE = chr(125)
OPENER = DOLLAR + OPEN_BRACE

# The message's shape, as the host prints it. Anchored on the prefix so a log line
# that merely CONTAINS the words is not mistaken for one that is the error.
_MESSAGE = re.compile(r"Bad substitution:\s*(?P<body>.*)$", re.DOTALL)

# How the host tokeniser's branch A is described, and why the wording is not a
# restatement of the message. The reader already has the message; what they do not
# have is the knowledge that its body is a tail. Saying so is the whole product.
_BRANCH_A = (
    "branch A of the host tokeniser: there is no closing brace after the opener, "
    "so the parser consumed the rest of the token and reported that tail. The "
    "reported text is a SYMPTOM -- where parsing stopped -- and not the defect. "
    "The defect is the unterminated opener itself."
)

_BRANCH_B = (
    "branch B of the host tokeniser: the brace pair is closed but empty. A "
    "present-but-empty expansion is a different defect from a missing closer, and "
    "the repair is different: something was meant to be between the braces."
)


def _load_guard():
    """Import the guard by path, so this tool's verdict is the guard's by construction.

    Importing rather than re-implementing is deliberate. Two scanners for one
    hazard is how a rule and its explanation end up describing different things,
    and the second one is always the one that stops being maintained.
    """
    spec = importlib.util.spec_from_file_location('cortex_shell_guard', GUARD)
    if spec is None or spec.loader is None:  # pragma: no cover - a broken checkout
        sys.exit(f'cannot load the guard at {GUARD}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _decode_message(message: str) -> tuple[int, str] | None:
    """`(exit_status, report)` for a recorded `Bad substitution`, or None if absent.

    Returning None for "this is not a `Bad substitution` message" is the honest
    answer and it is reported as such rather than as a clean verdict: a tool that
    said "clean" about a message it could not parse would be the silent pass this
    entire document is about.
    """
    m = _MESSAGE.search(message)
    if m is None:
        return None
    body = m.group('body').strip()
    empty_brace = DOLLAR + OPEN_BRACE + CLOSE_BRACE
    if body == empty_brace:
        brace = 'the empty brace pair'
        detail = _BRANCH_B
    else:
        brace = f'the opener `{OPENER}`'
        detail = _BRANCH_A
    return (
        1,
        f'decoded: this message reports {detail}\n'
        f'  the command carried {brace} without a matching `{CLOSE_BRACE}`.\n'
        f'  repair: close the brace, or -- when the sequence is a literal an inner\n'
        f'          language interpolates -- write the program to a file and run the\n'
        f'          file, or pass it on stdin with a QUOTED heredoc delimiter.\n'
        f'  see: docs/OPS-SHELL-INTERPOLATION.md 4j',
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog='diagnose-bad-substitution.py',
        description='Decode a `Bad substitution` message, or check a command for the shape.',
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--message', help='a recorded error line containing `Bad substitution: X`')
    group.add_argument('--command', help='a shell command to check for the shape directly')
    args = parser.parse_args(argv[1:])

    if args.message is not None:
        decoded = _decode_message(args.message)
        if decoded is None:
            print(
                'not a `Bad substitution` message, so there is nothing to decode. '
                'Pass --command to check a command directly.',
                file=sys.stderr,
            )
            return 2
        status, report = decoded
        print(report)
        return status

    guard = _load_guard()
    violations = guard.scan(args.command, '<--command>')
    if not violations:
        print('clean: no unclosed or empty opener the host tokeniser would refuse')
        return 0
    print(f'{len(violations)} hazard(s) in the command:', file=sys.stderr)
    for v in violations:
        print(f'  {v}', file=sys.stderr)
    return 1


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
