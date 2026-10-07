#!/usr/bin/env python3
"""Append a section to a Markdown document supplied as DATA, never as a command line.

## Why this exists

Eleven recurrences of `Bad substitution` had one thing in common, and it was not the
sequence. It was the **carrier**: the text being written, and the command doing the
writing, were the same command line. A host-process tokeniser reads that line before any
tool runs, so a document that *documents* an unclosed expansion *contains* one, and the
command that would have written it dies.

    docs  ->  shell command  ->  file        the hazard kills its own carrier
    docs  ->  this tool      ->  file        no shell is involved

The fix is not a cleverer escape. It is that documentation stops travelling by command
line. `write_doc` reads the section from a file or stdin and appends it verbatim, so the
hazard CANNOT be spelled into a command, because no command is built.

## Why appending and not editing

A rewriter would have to read, transform and write, which puts a second copy of the
document in memory and makes a partial failure lose content. Appending only ever adds,
so the failure mode is "nothing happened" rather than "the document is shorter now".

## Usage

    printf '%s' "$SECTION" | python3 tools/write-doc.py --append docs/X.md

`--section-file FILE` reads from a file instead of stdin. `--dry-run` reports what would
change without writing. The tool refuses to append a section that is already present,
which is what makes a retry after a failed run safe rather than duplicating.

## What this tool deliberately does NOT do

It does not sanitise, escape or inspect the document text. A tool that rewrote the
author's text would be a second rule about content, and the content is exactly what must
survive byte-for-byte. The safety here comes from the CARRIER, not from the content.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def _identity_line(section: str) -> str:
    """Return the line that identifies a section, skipping structural separators.

    ## Why this is not "the first non-empty line"

    It was, and the first real use of the tool refused a section that was not present.
    The section opened with a `---` thematic break, which every other section in these
    documents also opens with, so the "already present" test matched immediately and the
    write was skipped.

    That failure is the quiet kind: the tool reported success and the document did not
    change. A duplicate check that cannot tell a separator from a heading is not a
    duplicate check; it is a coin flip that always lands on "skip".

    A heading is what identifies a section, and this repository's documents open every
    one with one. If a section has no heading the marker is empty, and the tool appends --
    which is the safe direction, because appending twice is recoverable and silently
    dropping a section is not.
    """
    for line in section.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if set(stripped) <= {'-', '=', '*', '_', ' '}:
            continue
        return stripped
    return ''


def read_section(section_file: str | None) -> str:
    """Read the section from a file, or from stdin when no file is named."""
    if section_file is None:
        return sys.stdin.read()
    return Path(section_file).read_text(encoding='utf-8')


def append_section(path: Path, section: str, dry_run: bool) -> int:
    """Append `section`, refusing when it is already the document's tail.

    The idempotence check is on the section's first non-empty line, and it is a
    guard against a retried run rather than a general duplicate detector. Detecting
    duplicates in general would need a definition of "the same section" that the
    tool has no basis to invent; the first line of a section is a heading in this
    repository's convention, and that is a property of the document, not a guess.
    """
    existing = path.read_text(encoding='utf-8') if path.exists() else ''
    marker = _identity_line(section)
    if marker and marker in existing:
        print(f'{path}: section already present ({marker[:60]}); nothing to do')
        return 0
    if dry_run:
        print(f'{path}: would append {len(section.splitlines())} lines')
        return 0
    path.write_text(existing.rstrip('\n') + '\n' + section, encoding='utf-8')
    print(f'{path}: appended {len(section.splitlines())} lines')
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--append', required=True, metavar='MARKDOWN', type=Path)
    parser.add_argument('--section-file', default=None, metavar='FILE')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv[1:])
    return append_section(args.append, read_section(args.section_file), args.dry_run)


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
