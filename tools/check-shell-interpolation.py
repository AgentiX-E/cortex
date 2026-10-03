#!/usr/bin/env python3
"""Fail when an inner language's `${...}` sits inside unquoted shell quoting.

## Why this exists

`docs/OPS-SHELL-INTERPOLATION.md` records a tool call that never ran:

    Failed to run function tools: Error: Bad substitution: String

The command embedded a TypeScript template literal -- `${String(t).padEnd(5)}` --
inside a double-quoted shell argument. The shell expands `$` constructs before the
inner program sees them, found the contents were not a valid parameter expansion,
and aborted.

That direction is loud. The dangerous direction is the quiet one: `${X}` silently
becomes `""` and the command succeeds with a number computed from mangled input.
A plausible number from a broken probe costs far more than an error message, so
the pattern is checked rather than remembered.

## What counts as a violation

A `${...}` sequence inside a **double-quoted or unquoted** region, where the
contents are not a valid POSIX shell parameter expansion. Valid forms are:

    ${name}  ${name:-word}  ${name:=word}  ${name:?word}  ${name:+word}
    ${name#pat}  ${name##pat}  ${name%pat}  ${name%%pat}
    ${name/pat/rep}  ${name:offset}  ${name:offset:len}
    ${#name}  ${!name}  ${name^}  ${name,}  ${@}  ${*}

Anything else -- `${JSON.stringify(x)}`, `${String(t).padEnd(5)}` -- is a
violation. Single-quoted regions and heredocs with a **quoted** delimiter are
skipped, because no expansion happens there.

## Scope

This scans shell **fragments recorded in this repository** -- the command strings
inside `tools/*.py` and the fenced ```sh blocks in `docs/*.md`. It is a guard on
what we author, not a linter for arbitrary shell a user might type.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# A valid POSIX parameter expansion body. Anchored so the whole `${...}` contents
# must match; anything else is the collision this module exists to catch.
#
# EVERY alternative must begin with a parameter NAME. The first draft of this
# regex ended with `[\^,]?[^}]*`, an alternative that matched any text at all --
# so `fullmatch` accepted `${String(t).padEnd(5)}` and the guard reported the
# exact defect it was written to catch as clean. `[^}]*` after an optional single
# character is a wildcard wearing a modifier's clothes; the file's own test
# (`tools/__tests__/test_check_shell_interpolation.py`) is what surfaced it.
#
# The anchor is therefore structural rather than a matter of care: a name is
# required, and only the operator that follows it is optional.
_NAME = r"(?:\#?[A-Za-z_][A-Za-z0-9_]*|!?[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*])"
_PATTERN = (
    _NAME
    + r"""
    (?:
        [:-=+?][^}]*                    # ${name:-word} ${name:offset:len}
      | \#\#?[^}]*                      # ${name##pat} ${name#pat}
      | %%?[^}]*                        # ${name%%pat} ${name%pat}
      | /[^}]*                          # ${name/pat/rep}
      | [\^,][^}]*                      # ${name^} ${name,}
    )?
    """
)
VALID_EXPANSION = re.compile(_PATTERN, re.VERBOSE)

# Characters after which we are inside unquoted shell text: the start of a
# command string, an unquoted `"`, or a `"` that opened previously.
DOUBLE_QUOTE = '"'
SINGLE_QUOTE = "'"


def _strip_single_quoted(text: str) -> str:
    """Blank out single-quoted regions, where no expansion happens."""
    out: list[str] = []
    in_single = False
    for ch in text:
        if ch == SINGLE_QUOTE:
            in_single = not in_single
            out.append(' ')
            continue
        out.append(' ' if in_single else ch)
    return ''.join(out)


def _strip_quoted_heredocs(text: str) -> list[str]:
    """Drop bodies of heredocs whose delimiter is quoted.

    A quoted delimiter (`<<'EOF'`) suppresses all expansion inside the body, so
    the body may contain any `${...}` legitimately. An unquoted delimiter does
    expand, so its body is kept for scanning.
    """
    # Mark regions belonging to quoted heredocs so they can be skipped.
    lines = text.split('\n')
    kept: list[str] = []
    skip_until: str | None = None
    opener = re.compile(r"<<-?\s*'([A-Za-z_][A-Za-z0-9_]*)'|<<-?\s*\"([A-Za-z_][A-Za-z0-9_]*)\"")

    for line in lines:
        if skip_until is not None:
            if line.strip() == skip_until:
                skip_until = None
            kept.append('')
            continue
        m = opener.search(line)
        if m and '<<' in line.split(m.group(0))[0] + m.group(0):
            skip_until = m.group(1) or m.group(2)
            kept.append('')
            continue

        # The `<<` must not be part of a shift or a redirection of another form;
        # a simple guard is that the opener appears outside quotes.
        kept.append(line)
    return kept


def scan(fragment: str, origin: str) -> list[str]:
    """Return human-readable violations of the interpolation rule."""
    violations: list[str] = []
    lines = _strip_quoted_heredocs(fragment)
    for lineno, raw in enumerate(lines, start=1):
        # Skip full-line comments; they cannot be executed.
        stripped = raw.strip()
        if stripped.startswith('#'):
            continue
        # Single quotes suppress expansion entirely.
        scannable = _strip_single_quoted(raw)
        for m in re.finditer(r"\$\{([^}]*)\}", scannable):
            body = m.group(1)
            if VALID_EXPANSION.fullmatch(body):
                continue
            violations.append(
                f"{origin}:{lineno}: ${{{body}}} is not a shell parameter expansion; "
                f"the inner language's interpolation would be consumed by the shell"
            )
    return violations


def _python_command_strings(path: Path) -> list[tuple[str, str]]:
    """Extract long string literals from a Python file, as (origin, text)."""
    text = path.read_text(encoding='utf-8')
    results: list[tuple[str, str]] = []
    for m in re.finditer(r'(?:"""|\'\'\')(.*?)(?:"""|\'\'\')', text, re.DOTALL):
        results.append((str(path), m.group(1)))
    return results


def _markdown_shell_blocks(path: Path) -> list[tuple[str, str]]:
    """Extract fenced ```sh / ```bash blocks from a Markdown file."""
    text = path.read_text(encoding='utf-8')
    results: list[tuple[str, str]] = []
    for m in re.finditer(r'```(?:sh|bash|shell)\n(.*?)```', text, re.DOTALL):
        results.append((str(path), m.group(1)))
    return results


def main(argv: list[str]) -> int:
    root = Path(argv[1]) if len(argv) > 1 else Path('.')
    fragments: list[tuple[str, str]] = []

    for path in sorted((root / 'tools').glob('*.py')):
        if path.name == Path(__file__).name:
            continue
        fragments.extend(_python_command_strings(path))
    for path in sorted((root / 'docs').glob('*.md')):
        fragments.extend(_markdown_shell_blocks(path))

    violations: list[str] = []
    for origin, text in fragments:
        violations.extend(scan(text, origin))

    if violations:
        print(f"{len(violations)} shell-interpolation violation(s):", file=sys.stderr)
        for v in violations:
            print(f"  {v}", file=sys.stderr)
        print(
            "\nSee docs/OPS-SHELL-INTERPOLATION.md. Write the program to a file and "
            "run the file, or quote the here-doc delimiter.",
            file=sys.stderr,
        )
        return 1

    print(f"shell-interpolation guard: {len(fragments)} fragment(s) clean")
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
