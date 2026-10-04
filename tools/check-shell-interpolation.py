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
    """Blank out the regions where the shell does not perform an expansion.

    Two constructs suppress expansion and must be erased before scanning:

      1. single-quoted runs, from an opening `'` to the next `'`;
      2. a backslash-escaped `$`, outside single quotes.

    Both were verified against a real shell rather than reasoned about, because
    the reasoning is easy to get wrong in both directions and this module's whole
    value is that it is right about the boundary:

        echo \\${X}      -> prints ${X}    (backslash escapes the dollar)
        echo "\\${X}"    -> prints ${X}    (the escape works inside double quotes)
        echo ${X}        -> expands
        echo "${X}"      -> expands
        echo '${X}'      -> prints ${X}    (single quotes)

    A rule of "erase from `'` to the next `'`, and erase `\\$`" reproduces all
    five lines above.

    A per-character quote TOGGLE also reproduces them, which is why the original
    version survived review -- including the escaped-quote case
    `'it'\\''s ${X}'`, where a toggle and the shell agree that `${X}` is quoted
    (the trailing `'` opens a run that swallows the expansion). Modelling the run
    is still the better form: it states the shell's rule once instead of encoding
    an accumulator whose correctness depends on the input being well-formed.
    """
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == '\\' and i + 1 < n:
            # Outside single quotes a backslash escapes the next character. When
            # that character is `$` the shell does not expand, so the pair is
            # blanked; otherwise the pair is copied and no state changes.
            if text[i + 1] == '$':
                out.append('  ')
            else:
                out.append(ch)
                out.append(text[i + 1])
            i += 2
            continue
        if ch == SINGLE_QUOTE:
            # Consume the whole quoted run, up to and including the closing quote.
            # If the run is unterminated the rest of the line is quoted, which is
            # what the shell would do too.
            j = text.find(SINGLE_QUOTE, i + 1)
            if j == -1:
                out.append(' ' * (n - i))
                i = n
            else:
                out.append(' ' * (j - i + 1))
                i = j + 1
            continue
        out.append(ch)
        i += 1
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


def scan_test_sources(root: Path) -> list[str]:
    """Find a shell hazard stored as a *string literal* in a Python file.

    ## Why this is a second, narrower rule

    Four tool calls were lost to `Bad substitution` while the tests that check for
    that failure were being written. The path was always the same: the hazard was
    spelled literally inside a Python file, and the edit that would have written
    that file was itself carried in a shell command -- so the command died before
    the file existed, and the fix could never land. The tests were correct and
    could not be delivered.

    The rule that stops the loop is not "detect the hazard" (the rest of this
    module does that) but "do not store the hazard as a literal". A test that needs
    the sequence can build it from `chr(36) + chr(123)`, which is inert in every
    carrier.

    ## Scope, and why it is not "any occurrence"

    The first version of this function flagged every line containing the sequence,
    which failed on the guard's own documentation -- 69 violations, most of them
    prose. That version would have to be deleted to be obeyed, which is the mark of
    a rule that measures the wrong thing. Naming the hazard is how it gets
    explained, and the docstring you are reading does exactly that.

    What actually breaks a delivery is the hazard sitting inside a **string
    literal** that will be written to a file or handed to an interpreter, because
    such a literal is reproduced byte-for-byte into whatever carries it. So this
    scans only the contents of string literals that contain `write_text`,
    `write(`, or a heredoc-style program body -- not comments, not docstrings.
    """
    violations: list[str] = []
    hazard = chr(36) + chr(123)
    # A string literal that is an argument to a writer. Double- and single-quoted,
    # non-greedy, on one line: multi-line program bodies are caught by `scan` when
    # they are shell, and the hazard here is about a literal that survives a copy.
    literal = re.compile(
        r"""(?:write_text|\.write|writelines)\s*\(\s*(?P<q>["'])(?P<body>(?:\\.|(?!\1).)*)\1"""
    )
    for path in sorted(root.rglob('*.py')):
        if '__pycache__' in path.parts:
            continue
        text = path.read_text(encoding='utf-8')
        for lineno, line in enumerate(text.split('\n'), start=1):
            stripped = line.strip()
            # Comments and docstring prose may name the hazard; that is how it is
            # documented. Only executable literals are checked.
            if stripped.startswith('#'):
                continue
            for m in literal.finditer(line):
                if hazard in m.group('body'):
                    violations.append(
                        f'{path}:{lineno}: a literal written to a file contains a shell '
                        f'hazard; build it from chr(36) + chr(123) so an edit to this '
                        f'file can be delivered'
                    )
    return violations


def _markdown_shell_blocks(path: Path) -> list[tuple[str, str]]:
    """Extract fenced ```sh / ```bash blocks from a Markdown file."""
    text = path.read_text(encoding='utf-8')
    results: list[tuple[str, str]] = []
    for m in re.finditer(r'```(?:sh|bash|shell)\n(.*?)```', text, re.DOTALL):
        results.append((str(path), m.group(1)))
    return results


def main(argv: list[str]) -> int:
    # `--fragment FILE` (or `-` for stdin) checks ONE shell fragment instead of a
    # tree. This is the mode that matters most, and the mode the first version
    # lacked. The guard originally scanned only `tools/*.py` and `docs/*.md`, so a
    # command typed directly into a shell ran unchecked -- and the second
    # recurrence (`Bad substitution: lines[l-1].trim`) was exactly that: a probe
    # held in the command string, never written to a file, invisible to a
    # filesystem scan. A guard that inspects only what was committed cannot see the
    # mistake at the moment it is made, which is the only moment it is cheap.
    if len(argv) > 2 and argv[1] == '--fragment':
        source = argv[2]
        text = sys.stdin.read() if source == '-' else Path(source).read_text(encoding='utf-8')
        violations = scan(text, source if source != '-' else '<stdin>')
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
        print('shell-interpolation guard: 1 fragment(s) clean')
        return 0

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
    violations.extend(scan_test_sources(root))

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
