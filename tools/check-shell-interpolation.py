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

DOLLAR = chr(36)
OPEN_BRACE = chr(123)
CLOSE_BRACE = chr(125)

# Interpreters whose `-c` / `-e` argument is a program in another language. The list
# is written out rather than pattern-matched from `python|node|...` because a pattern
# that guessed wrong would silently stop recognising a payload, which is the failure
# this whole family of rules exists to prevent -- and a list that is too short is
# visible in review in a way that a regex is not.
#
# `python3.11` and friends are covered by the `[\d.]*` suffix. `sh -c` is included on
# purpose: `sh -c '...'` is a payload like any other, and the hazard there is worse,
# because the inner program is itself a shell that will expand `${...}` a second time.
_INTERPRETER = re.compile(
    r"\b(?:python[\d.]*|node|nodejs|deno|bun|perl|ruby|php|lua|sh|bash|zsh|dash|ksh)"
    r"\s+-[ce]\b"
)

# Interpreters whose payload language IS a shell, so a `${...}` inside the payload is
# the same parameter expansion the outer shell would have performed and is correct
# there. Everything else in `_INTERPRETER` is a language with its own interpolation,
# where a `${...}` is at best the wrong syntax and at worst a body the language will
# try to evaluate.
#
# This split is why the rule cannot be "reject `${...}` in payloads". `sh -c 'echo
# ${HOME}'` is correct and common, and a guard that fought it would be turned off --
# taking the rules that do work with it. The question is not "is there a payload", it
# is "whose language is the payload written in".
_SHELL_INTERPRETERS = frozenset({'sh', 'bash', 'zsh', 'dash', 'ksh'})

# The interpreter name as matched, for the message. Kept as a second capture-free match
# over the same prefix rather than a group swap, so `_INTERPRETER` stays the one place
# that decides what a payload is.
_INTERPRETER_NAME = re.compile(r"\b(python[\d.]*|nodejs|node|deno|bun|perl|ruby|php|lua|sh|bash|zsh|dash|ksh)\s+-[ce]\b")


def _line_of(text: str, offset: int) -> int:
    """1-based line number of `offset` in `text`."""
    return text.count('\n', 0, offset) + 1


def _violation(original: str, offset: int, origin: str, body: str, inside_payload: bool = False) -> str:
    """One report line, with the line number taken from the original fragment.

    The line number is computed against the text the reader has, because
    `_single_quoted_mask` and `_comment_spans` only ever flip mask bits — they never
    insert or delete a character, so offsets are stable across all of these views.
    That invariance is the reason the mask form was chosen over a stripped copy; if
    it ever stopped holding, the number would point at the wrong line, which is
    worse than printing no number at all.

    ## Why the message depends on where the sequence sits

    There are two ways a `${...}` in a live region hurts, and they call for different
    repairs. Reporting both as "not a shell parameter expansion" is what this
    function did, and the eighth failure showed the message can be false:

        ${String}   genuinely is not a valid expansion -> the shell ABORTS
        ${q}        IS a valid expansion -> the shell substitutes it SILENTLY

    `${q}` is the dangerous one and the old message described it backwards: it said
    the shell would consume something the shell does not recognise, when in fact the
    shell recognises it perfectly and replaces it with an empty string. A reader
    sent to look for a syntax error would find valid shell and conclude the guard was
    wrong. So a sequence inside an interpreter payload says what will actually
    happen to it instead.
    """
    line = _line_of(original, offset)
    if inside_payload:
        # The two example sequences are ASSEMBLED, not written. A literal `$` + `{q}`
        # in an f-string is evaluated by Python before it reaches the message, which
        # is the same collision this module exists to catch -- and it made this
        # function raise `NameError` on its first run. The bytes are needed in the
        # output and must not be live in the source, which is the whole reason
        # `tools/__tests__` builds its fixtures from `chr(36)`.
        short = DOLLAR + OPEN_BRACE + 'q' + CLOSE_BRACE
        upper = DOLLAR + OPEN_BRACE + 'HOME' + CLOSE_BRACE
        return (
            f"{origin}:{line}: `${{{body}}}` sits inside an interpreter payload that "
            f"the shell has not yet handed over. Whether or not the body is a valid "
            f"expansion, the shell resolves it first: an unrecognised body aborts the "
            f"command, and a recognised one -- `{short}`, `{upper}` -- is substituted "
            f"with its value, so the program receives text the author never wrote. "
            f"Pass the program on stdin with a quoted heredoc (`python3 "
            f"tools/probe.py --lang python - <<'PROBE'`) or write it to a file."
        )
    return (
        f"{origin}:{line}: "
        f"${{{body}}} is not a shell parameter expansion; "
        f"the inner language's interpolation would be consumed by the shell"
    )


def _payload_language_violation(
    interpreter: str, offset: int, origin: str, original: str, body: str
) -> str:
    """Report a `${...}` that is wrong in the payload's language, not the shell's.

    The message has to name the payload language AND quote the sequence. The language,
    because "not a shell parameter expansion" would send the reader looking for a shell
    bug that does not exist -- the shell is doing exactly what it was asked. The body,
    because a report that does not show the offending text forces the reader to go find
    the line and guess which of several sequences was meant, and a diagnostic that
    costs a second lookup is one people learn to skim.
    """
    return (
        f"{origin}:{_line_of(original, offset)}: `${{{body}}}` sits inside a "
        f"`{interpreter}` payload. That language has no such construct, so either it "
        f"fails to parse or the text is taken literally; use the language's own "
        f"interpolation, or write the program to a file and run the file. See "
        f"tools/run-program.py."
    )


def scan_payload(text: str, origin: str, language: str = 'python') -> list[str]:
    """Check a program that is ALREADY known to be a `-c` payload.

    ## Why this is not `scan`

    `scan` answers "would the shell mangle this command line?". Its payload rules have
    to re-derive the payload from a command line, so they anchor on an `-c` token
    followed by a quoted argument.

    A `-c` payload handed to this function has no such token: the shim already split the
    command, and what arrives is the program text alone. Running `scan` over it reports
    clean -- and did, in the first probe of the shim, which is the only reason this
    function exists. The guard said `1 fragment(s) clean` about a payload that Python
    then refused to parse.

    The question here is therefore narrower and needs no anchoring: the text IS a
    program, so every `${...}` in it that is not a shell expansion has no business being
    there. The shell has already been taken out of the picture -- that is what makes it
    a payload rather than a command line -- so there is no "the shell would expand it"
    defence available, and the single-quoted exemption of `scan`'s second pass does not
    apply. `${...}` inside `python3 -c '...'` is the seventh recurrence exactly.

    ## The one exemption

    A payload the shim sees is a payload of *some* language, and `sh -c` is one of them.
    `sh -c 'echo ${HOME}'` is correct, so the shell interpreters stay exempt, for the
    same reason as in `scan`: the sequence is that language's own expansion. The
    `language` argument names the payload's language in the report; it defaults to
    `python` because the shim that calls this is the `python3` shim, and a default that
    guessed a language the payload is not written in would be a report that sends the
    reader somewhere useless.

    Comment offsets are still excluded, because a `#` line inside a Python payload
    cannot evaluate and a rule that reported a payload's own commentary would be
    silenced rather than satisfied.
    """
    if language in _SHELL_INTERPRETERS or origin in _SHELL_INTERPRETERS:
        return []

    mask = _single_quoted_mask(text)
    comment_offsets: set[int] = set()
    for start, end in _comment_spans(text):
        for k in range(start, end):
            mask[k] = False
            comment_offsets.add(k)

    scannable = ''.join(ch if keep else ' ' for ch, keep in zip(text, mask))
    violations: list[str] = []
    for m in re.finditer(r"\$\{([^}]*)\}", scannable):
        offset = m.start()
        if offset in comment_offsets:
            continue
        body = m.group(1)
        if _is_shell_expansion_for_a_payload(body):
            # A shell expansion in a Python payload is still not Python -- but it is not
            # this rule's business, and a rule that reported `${x}` in a payload would be
            # the "any occurrence" rule this module already deleted once.
            continue
        violations.append(_payload_language_violation(language, offset, origin, text, body))

    # An unterminated `${` in a payload is the same defect as in a command line, and the
    # shim sees it earlier than the harness tokeniser would -- the shim holds the payload
    # before it is ever handed to anything. Reporting it here is what turns the shim from
    # a reporter of this rule's existing shapes into a gate that also covers the shape
    # that produced the tenth recurrence.
    for offset, _ in _unterminated_expansions(text, scannable):
        violations.append(_unterminated_expansion_violation(offset, origin, text))

    return violations


def _is_shell_expansion_for_a_payload(body: str) -> bool:
    """Whether `body` is a shell expansion that a payload could legitimately mean.

    ## Why the payload rule cannot reuse `VALID_EXPANSION`

    It did, and it reported clean on the exact payload the shim was written for.
    `VALID_EXPANSION` accepts `${cut:.3f}`, because the shell's `${name:offset}` form
    takes arbitrary text after the colon and `cut:.3f` lexically fits: `cut` is a name,
    `:` introduces the operator, `.3f` is the word. Every character is legal.

    Lexically correct, empirically broken. Measured against three shells:

        body          bash                     dash                  zsh
        ${cut:.3f}    syntax error: operand     Bad substitution      bad math expression
        ${label:>5}   syntax error: operand     Bad substitution      bad math expression
        ${d:%Y}       syntax error: operand     Bad substitution      bad math expression
        ${a:1}        yz                        Bad substitution      yz
        ${x:0:5}      abcde                     Bad substitution      abcde

    The first three fail in EVERY shell, and the failure modes are the ones this module
    exists for -- `Bad substitution` verbatim in dash. They are Python format specs
    (`f'{cut:.3f}'`, `f'{label:>5}'`, `strftime('%Y')`) that lost their `f` or their
    quotes; no shell can evaluate them and no shell variable is named that way.

    The last two are different: a substring operation that bash and zsh perform and only
    dash rejects. Reporting those would flag `"${x:offset}"` -- correct, common shell --
    and a rule that fights correct shell gets deleted.

    ## The discriminator, and why it is syntactic after all

    The two groups differ in what the operand IS. A substring or default takes an
    ARITHMETIC expression. A format spec takes a mini-language, and a mini-language
    always carries an indicator no arithmetic expression contains:

        body        bash verdict                       indicator
        ${x:offset}  yz                               alphabetic operand
        ${a:1}       yz                               pure digits
        ${x:-1}      default value                    sign
        ${cut:.3f}   syntax error: operand            `.`   before a letter
        ${v:0.3f}    invalid arithmetic operator      `.`   after digits
        ${v:2.3f}    invalid arithmetic operator      `.`   after digits
        ${label:>5}  syntax error: operand            `>`
        ${d:%Y}      syntax error: operand            `%`

    Note `${v:0.3f}` and `${v:2.3f}`: measured, and they fail in bash AND dash even
    though the operand starts with a digit. A decimal point inside the operand is never
    arithmetic there -- it is a precision. That is why the test is not "does the first
    character look numeric" but "does the operand contain a point or a spec indicator".

    The three failures in the table are the ones that matter, because each is the
    seventh recurrence wearing a different spec: `f'{cut:.3f}'`, `f'{v:2.3f}'`. They are
    Python format specs that lost their `f`, and no shell evaluates them.
    """
    head = _NAME_HEAD.match(body)
    if head is None:
        # No name, so no shell parameter: `${:.3f}` is a format spec with the field name
        # dropped, which is a different but equally real mistake.
        return not _SPEC_INDICATOR.search(body)
    after = body[head.end():]
    if not after.startswith(':'):
        # `${name}` `${name#pat}` `${name/pat/rep}` -- the shell's own operators, all of
        # which are meaningful and none of which this rule has an opinion about.
        return True
    return not _SPEC_INDICATOR.search(after[1:])


# What marks an operand as a format mini-language rather than arithmetic.
#
#   `.`  a precision or a width -- never valid inside shell arithmetic
#   `%`  a strftime/printf type code
#   `<` `>` `^` `=`  an alignment or fill character
#
# `@` is deliberately ABSENT even though `${@}` is a parameter expansion: the rule is
# applied to text after a `:`, and a comma/space-separated spec is handled by the
# operators below rather than by a catch-all. `-` and `+` are absent because they begin
# arithmetic (`${x:-1}`, `${x:+w}`). `#` is absent because `${x:#}` is a base prefix in
# arithmetic. `!` is absent because `${!x}` is an indirect reference.
_SPEC_INDICATOR = re.compile(r"[.%,<>^=]")

# The head of a bare word: what a shell parameter name looks like. Required so that a
# string with a colon and a suffix -- `http://x`, `key:value` -- is not swept up.
_NAME_HEAD = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*")


def _comment_spans(text: str) -> list[tuple[int, int]]:
    """Spans of full-line comments, which cannot execute.

    A `#` only opens a comment where the shell would treat it as one: at the start
    of a line, or after whitespace. `echo a#b` prints `a#b`, and `curl http://x#f`
    is a URL fragment, so treating every `#` as a comment would suppress real
    hazards — the direction that costs a silent pass.
    """
    spans: list[tuple[int, int]] = []
    for start, end in _line_spans(text):
        stripped = text[start:end].lstrip()
        if stripped.startswith('#'):
            spans.append((start, end))
    return spans


def _line_spans(text: str) -> list[tuple[int, int]]:
    """Half-open `[start, end)` for each line, newline excluded."""
    spans: list[tuple[int, int]] = []
    start = 0
    for i, ch in enumerate(text):
        if ch == '\n':
            spans.append((start, i))
            start = i + 1
    spans.append((start, len(text)))
    return spans


def _interpolations(text: str, start: int, end: int) -> list[tuple[int, str]]:
    """`(offset, body)` for each `${...}` wholly inside `[start, end)`."""
    found: list[tuple[int, str]] = []
    for m in re.finditer(r"\$\{([^}]*)\}", text):
        if m.start() < start or m.end() > end:
            continue
        found.append((m.start(), m.group(1)))
    return found


def _payload_spans(text: str, mask: list[bool]) -> list[tuple[int, int, str]]:
    """Regions that are an interpreter's `-c` / `-e` program, plus its language.

    Read against the *original* `text` and the quote mask, never against the blanked
    copy: the blanked copy has the payload replaced by spaces by the time this runs,
    so a search over it would find the `-c` and then an empty argument. That is the
    bug the first version of this function had, and it is why the mask exists.

    `mask` is consulted only to find the payload's own opener. A quote inside the
    payload belongs to the inner language and must not confuse the scan for the
    closing delimiter, which is why the search is `str.find` over `text` rather than
    a masked walk: `python3 -c 'print("hi")'` closes at the `'` after `)`, and the
    `"` pair in between is the payload's business.

    The interpreter name is returned with the span because the two callers need
    opposite things from it. Whether a payload is safe depends on whose language it
    is written in: a shell payload's `${...}` is a real expansion, a JavaScript or
    Python payload's is not a construct those languages have. Returning only the
    coordinates would force one of the callers to re-match the name, which is how two
    readers of one fact end up disagreeing about it.
    """
    spans: list[tuple[int, int, str]] = []
    n = len(text)
    for m in _INTERPRETER_NAME.finditer(text):
        interpreter = m.group(1)
        i = m.end()
        while i < n and text[i] in ' \t':
            i += 1
        if i >= n:
            continue
        opener = text[i]
        if opener in ('"', "'"):
            closer = text.find(opener, i + 1)
            # An unterminated payload runs to the end of the fragment, which is what
            # the shell does too: the quote is still open when the command ends.
            spans.append((i + 1, n if closer == -1 else closer, interpreter))
        else:
            end = i
            while end < n and text[end] not in ' \t\n':
                end += 1
            spans.append((i, end, interpreter))
    return spans

# Characters after which we are inside unquoted shell text: the start of a
# command string, an unquoted `"`, or a `"` that opened previously.
DOUBLE_QUOTE = '"'
SINGLE_QUOTE = "'"


def _single_quoted_mask(text: str) -> list[bool]:
    """Whether each character is live shell text (`True`) or suppressed (`False`).

    Blank out the regions where the shell does not perform an expansion.

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

    ## Why this returns a mask and not a string

    A per-character quote TOGGLE also reproduces all five lines, which is why the
    original version survived review — including the escaped-quote case
    `'it'\\''s ${X}'`, where a toggle and the shell agree that `${X}` is quoted
    (the trailing `'` opens a run that swallows the expansion). Modelling the run
    is still the better form: it states the shell's rule once instead of encoding
    an accumulator whose correctness depends on the input being well-formed.

    It has to be a mask rather than a blanked copy because a second reader needs the
    same coordinates. `_payload_spans` asks "is this region an interpreter's `-c`
    program?", and it must answer about the *original* fragment while the scan runs
    over the quoted-resolved one. Two functions producing two independently-indexed
    views of one string is how a rule ends up checking an offset in the wrong text —
    the class of defect `docs/AUDIT-CODE-VS-DOCS.md` records. One pass, one set of
    coordinates, both readers.

    `_strip_single_quoted` is kept as the string-returning facade over this, because
    every existing caller and test wants the blanked copy.
    """
    out: list[bool] = [True] * len(text)
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == '\\' and i + 1 < n:
            # Outside single quotes a backslash escapes the next character. When
            # that character is `$` the shell does not expand, so the pair is
            # blanked; otherwise the pair is copied and no state changes.
            if text[i + 1] == DOLLAR:
                out[i] = False
                out[i + 1] = False
            i += 2
            continue
        if ch == SINGLE_QUOTE:
            # Consume the whole quoted run, up to and including the closing quote.
            # If the run is unterminated the rest of the line is quoted, which is
            # what the shell would do too.
            j = text.find(SINGLE_QUOTE, i + 1)
            end = n if j == -1 else j + 1
            for k in range(i, end):
                out[k] = False
            i = end
            continue
        i += 1
    return out


def _strip_single_quoted(text: str) -> str:
    """`_single_quoted_mask`, rendered as the blanked copy callers already expect."""
    mask = _single_quoted_mask(text)
    return ''.join(ch if keep else ' ' for ch, keep in zip(text, mask))


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
    """Return human-readable violations of the interpolation rule.

    ## Why quoting is resolved over the fragment and not over each line

    The first version of this function called `_strip_single_quoted` once per line,
    so it recomputed quote state at every newline. A shell does not: quoting is
    resolved across the whole command, so a quote opened on one line and closed on
    the next leaves the text between them — the common shape of an interpreter
    payload — inside a region the per-line version evaluated as unquoted. That is
    the second blind spot `TestInterpreterPayloads` records.

    Resolving once and mapping offsets back to line numbers is the only form that
    agrees with the shell here, because the thing being modelled is a property of
    the command rather than of its lines.
    """
    violations: list[str] = []
    stripped_heredocs = '\n'.join(_strip_quoted_heredocs(fragment))
    mask = _single_quoted_mask(stripped_heredocs)

    # A comment line cannot execute, so nothing on it can be a hazard. The
    # suppression is inherited by the payload scan as well, because the two now
    # share a coordinate space: a `#` comment that happens to contain `python3 -c`
    # must not turn the text after it into a payload.
    #
    # Comments and single-quoted runs both clear the mask, and the payload rule below
    # needs them apart: a commented sequence is nothing, a quoted one is a program.
    # Keeping the comment spans in their own set is what makes that possible, rather
    # than trying to re-derive the distinction from the mask alone.
    comment_offsets: set[int] = set()
    for start, end in _comment_spans(stripped_heredocs):
        for k in range(start, end):
            mask[k] = False
            comment_offsets.add(k)

    scannable = ''.join(ch if keep else ' ' for ch, keep in zip(stripped_heredocs, mask))

    # A payload's `${...}` is source for another language. Two cases, and they get
    # opposite verdicts, which is the whole reason this pass exists:
    #
    #   * the payload is single-quoted, so the shell passes it through untouched.
    #     The sequence is the inner language's own and is LEGAL there;
    #   * the payload is live shell text, so the shell expands it before the
    #     interpreter is ever reached. That is the hazard, and the ordinary scan
    #     cannot see it when the character sequence is not a valid expansion --
    #     which is exactly the case that aborts the command.
    #
    # So the payload scan is silent on the first and loud on the second. Reading
    # the mask the other way round turns both into the wrong answer at once, which
    # is how the first draft of this loop behaved.
    payloads = _payload_spans(stripped_heredocs, mask)

    # Offsets the *shell* rule actually reported inside a payload -- not every offset
    # inside a payload span. The distinction is the whole bug: a set built from the
    # spans alone would contain a single-quoted payload's sequence too, and the
    # language rule below would then skip exactly the case it exists to report while
    # reporting only the ones the shell rule already handled. Building it from the
    # reports is what keeps the two rules' responsibilities disjoint.
    reported_as_shell_hazard: set[int] = set()

    for start, end, interpreter in payloads:
        for offset, body in _interpolations(stripped_heredocs, start, end):
            if not mask[offset]:
                # Suppressed by the shell, which is only the end of the story when the
                # payload is shell too. Anything else is decided below, by
                # `_payload_language_violation`, because the shell answers a different
                # question: it says what IT will do, and the defect is what the
                # interpreter will do with text that is not its syntax.
                continue
            reported_as_shell_hazard.add(offset)
            # `inside_payload=True` because this offset sits in a live payload, where
            # the verdict does NOT depend on whether the body is a valid expansion --
            # the eighth failure (`${q}`) is valid and still fatal, by substitution
            # rather than by abort. The old message asserted the invalid-expansion
            # reason unconditionally, which was false for exactly the sequence that
            # prompted the eighth investigation.
            violations.append(
                _violation(stripped_heredocs, offset, origin, body, inside_payload=True)
            )

    # The payload's own language, which the shell rule above cannot speak for. A
    # `${...}` here is not shell text at all: it is what the author wrote INTO a
    # program. When the program's language has no such construct the sequence is
    # wrong regardless of quoting, and the seventh recurrence is exactly this -- a
    # Python program written as though interpolation were a shell feature.
    for start, end, interpreter in payloads:
        if interpreter in _SHELL_INTERPRETERS:
            continue
        for offset, body in _interpolations(stripped_heredocs, start, end):
            if offset in comment_offsets:
                # A comment. This file documents the hazard in prose, and a rule that
                # reported its own documentation would be deleted rather than obeyed.
                #
                # Note the test is against the comment set and NOT against the mask:
                # a single-quoted payload also clears the mask, and that is the case
                # this rule exists to report.
                continue
            if offset in reported_as_shell_hazard:
                # Already reported as a shell hazard. One sequence is one defect, and
                # naming both reasons would make the reader think there were two.
                continue
            violations.append(
                _payload_language_violation(
                    interpreter, offset, origin, stripped_heredocs, body
                )
            )

    # The ordinary scan runs over the quote-resolved text, so it sees only live
    # shell. A live payload interpolation is already reported above, and
    # `reported_as_shell_hazard` is what keeps one hazard from being counted twice --
    # a duplicate makes the guard look more thorough while telling the reader nothing
    # new, and it makes every count-based assertion in the test file ambiguous.
    for m in re.finditer(r"\$\{([^}]*)\}", scannable):
        if m.start() in reported_as_shell_hazard:
            continue
        body = m.group(1)
        if VALID_EXPANSION.fullmatch(body):
            continue
        violations.append(_violation(stripped_heredocs, m.start(), origin, body))

    # An unterminated `${`. This runs LAST, and it answers a question the match-based
    # loop above structurally cannot: a regex whose pattern ends in `\}` never matches
    # the input where the `}` is absent. A missing match is invisible to a scanner built
    # out of matches, which is exactly why eight earlier fixes -- every one of which
    # edited the body classifier and left this pattern alone -- could not catch the tenth
    # recurrence that came through this gap.
    #
    # Appended alongside the others rather than instead of them: a fragment can carry both
    # a closed expansion that is wrong and an unclosed one, and suppressing either would
    # make the reported count depend on which pass happened to run first.
    for offset, _ in _unterminated_expansions(stripped_heredocs, scannable):
        violations.append(_unterminated_expansion_violation(offset, origin, stripped_heredocs))

    return violations


def _unterminated_expansion_violation(offset: int, origin: str, original: str) -> str:
    """Report a `${` that is never closed.

    ## Why this rule exists, and why it is not the rule the other eight sections wrote

    The tenth recurrence was reproduced against the parser that actually raises the
    error. It is **not** a shell. It is a vendored JavaScript tokeniser
    (`shell-quote`'s `parseEnvVar`, bundled into the harness) that runs inside the Node
    process before any tool is dispatched. Its two failing branches are:

        A. unclosed brace   the body it reports is THE ENTIRE REMAINDER OF THE COMMAND
        B. empty braces     the body it reports is the three characters around the `}`

    Branch A is the one that produced every confusing report, and it explains the thing
    eight sections could not: **the reported body is not an identifier and never was.**
    It is a tail of whatever followed the unclosed `${`. That is why the bodies look
    arbitrary (`String`, `q"],`, `min.toFixed`) and why they kept changing while the
    underlying mistake stayed the same. `q"],` is a JSON fragment from my own command.

    So the input that is wrong is the unclosed `${` itself, and it is wrong regardless of
    what follows it. Earlier sections tried to classify the body, which is an artefact of
    where the parser stopped -- a category error, and the reason the class recurred.

    ## Why detection is the right strategy HERE, after 4h said it was not

    Section 4h concluded that a content-based detector cannot win, because as the bodies
    shrank toward a bare name the failing text became textually identical to correct
    shell. That argument is sound about a **closed** expansion: `${q}` is valid POSIX and
    no rule can distinguish the version that hurts from the version that does not.

    An **unterminated** expansion is a different question. There is no correct command
    containing a bare `${` with no closer -- the shell itself rejects it, and so does the
    tokeniser. So a rule against it has no true-positive/false-positive trade to make.
    That is the whole difference, and it is why 4h's prohibition does not apply here.
    """
    return (
        f"{origin}:{_line_of(original, offset)}: an unterminated `{DOLLAR}{OPEN_BRACE}` "
        f"has no matching `{CLOSE_BRACE}`. The harness tokenises the command with a "
        f"JavaScript shell parser before dispatching it, and an unclosed expansion makes "
        f"that parser throw `Bad substitution` with the REST OF THE COMMAND as the "
        f"reported body -- so the name in the error message is an artefact of where "
        f"parsing stopped, not the thing that is wrong. Close the brace, or escape the "
        f"sequence as `{DOLLAR}{OPEN_BRACE}{CLOSE_BRACE}` when it is a literal, or move "
        f"the program to stdin with a quoted heredoc."
    )


def _unterminated_expansions(text: str, scannable: str) -> list[tuple[int, str]]:
    """`(offset, text)` for each `${` in a live region that is never closed.

    ## Why this is a scan of its own rather than a clause in the existing loop

    The existing loop matches `\\$\\{([^}]*)\\}` -- a pattern that, by construction,
    **cannot see an unterminated expansion**, because the closing brace is part of the
    match. Every one of the eight earlier fixes left that pattern alone, and the pattern
    is why they could not catch the tenth: the defect is precisely the case the regex
    does not match. A missing match is invisible to a scanner built from matches.

    ## Quoting

    The search runs over the quote-resolved text, like every other pass, so a `${` inside
    single quotes or after a `\\$` is exempt -- those are exactly the ways an author
    writes the sequence on purpose. Only a brace that is live to the shell and live to
    the tokeniser counts.
    """
    found: list[tuple[int, str]] = []
    opener = DOLLAR + OPEN_BRACE
    for m in re.finditer(re.escape(opener), scannable):
        offset = m.start()
        # A matching closer anywhere after this point makes it a closed expansion, which
        # is the existing rule's business and not this one's -- except when the closer is
        # itself suppressed, in which case the brace really is unterminated.
        if CLOSE_BRACE in scannable[m.end():]:
            continue
        # `_line_of` and the report read the ORIGINAL fragment, never the blanked copy, so
        # the offset must be validated against the text the reader will open.
        if text[offset:offset + len(opener)] != opener:
            continue
        found.append((offset, text[offset:]))
    return found


def _python_command_strings(path: Path) -> list[tuple[str, str]]:
    """Extract long string literals from a Python file, as (origin, text).

    ## Why a length check is not enough, and what replaces it

    The first version of this returned every `\"\"\"...\"\"\"` block, and that includes
    every module docstring. A docstring is prose -- it explains the hazard, names it,
    shows it -- so scanning it as a command reports the documentation rather than a
    defect. Adding `tools/exec-python.py` with its explanatory docstring produced four
    violations against the guard's own description of the rule, which is the same
    failure `scan_test_sources` already recorded once and for the same reason.

    The discriminator is not length or position but SHAPE. A shell program's first
    non-blank line begins with something the shell would execute: a command word, an
    assignment, a variable, a pipe. A docstring's first line is a sentence. English
    prose starts with a capitalised subject and runs on until a period; a command has no
    spaces-and-articles spine.

    The test applied is the narrow one: the first line must be short (commands are
    one-liners or the first line of a script) and must not read as a sentence. Being
    conservative here is correct in the direction that matters -- an unrecognised
    command string means one fewer fragment checked, while an over-eager match means the
    guard reports its own prose and gets turned off, taking every real check with it.
    """
    text = path.read_text(encoding='utf-8')
    results: list[tuple[str, str]] = []
    for m in re.finditer(r'(?:"""|\'\'\')(.*?)(?:"""|\'\'\')', text, re.DOTALL):
        body = m.group(1)
        if _looks_like_a_command_string(body):
            results.append((str(path), body))
    return results


# A word that English prose uses and a command line does not. Deliberately the common
# articles and copulas, and deliberately checked in the plural: see `_looks_like_a_
# command_string` for why one match is not evidence.
_PROSE_MARKERS = re.compile(r"\b(?:the|a|an|is|are|that|which|when|this|it|its|and|or)\b")

# A word the shell would run, followed by the rest of a command line. Anchored at the
# start so a sentence that happens to contain `git` mid-clause is not swept up.
_COMMAND_HEAD = re.compile(
    r"^\s*(?:sudo\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)*"
    r"(?:pnpm|npm|npx|yarn|node|python3?|pytest|git|gh|curl|cat|printf|echo|bash|sh|zsh|"
    r"make|docker|cargo|go|touch|mkdir|rm|cp|mv|sed|awk|grep|rg|find|jq|tee|sort|uniq|"
    r"head|tail|wc|xargs|env|export|cd|set|lefthook|husky)\b"
)

# How many prose words a line must carry before it reads as a sentence. TWO, not one.
#
# One was the first threshold and it rejected `bash -c "echo ${a.b}"`, a real command:
# the `a` inside the sequence matches the article `a`. A hazard body is full of short
# identifiers -- `a`, `b`, `it`, `n` -- so a single match is noise rather than evidence.
# A sentence uses several of these words; a command line uses none by accident. Two is
# the smallest threshold that separates the two on the real corpus, and it is stated as
# a count so that the next person can move it with the reason in view.
_PROSE_WORD_THRESHOLD = 2


def _looks_like_a_command_string(body: str) -> bool:
    """Whether a string literal is a shell program rather than prose about one."""
    first = next((line for line in body.split('\n') if line.strip()), '')
    head = _COMMAND_HEAD.match(first) if first else None
    if head is None:
        return False
    # Prose detection runs over the words AFTER the command name, never over the whole
    # line: the arguments are exactly where a hazard lives, so scanning them for English
    # vocabulary confuses the thing being read with the thing being said about it.
    tail = first[head.end():]
    if len(_PROSE_MARKERS.findall(tail)) >= _PROSE_WORD_THRESHOLD:
        return False
    return True


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
    #
    # `--from-command FILE` is the third mode, and it exists because the first two
    # share a defect of their own: using either of them requires putting the
    # suspect fragment back into a shell command line, which is the very act that
    # fails. An author who has just lost a call to `Bad substitution` cannot easily
    # ask "was this line safe?" by retyping it. This mode takes the command from a
    # file the author already has -- a script, a log, a diff -- so the question can
    # be asked without re-committing the mistake. The scan is identical; only the
    # provenance changes, and the report says so.
    #
    # `--c-payload TEXT` is the fourth, and it is the only mode whose argument is the
    # fragment ITSELF rather than a path to it. That inversion is deliberate: it is
    # called by the `python3` shim, which already holds the payload in a shell
    # variable and must not write it anywhere to ask about it -- writing it out would
    # reproduce the very expansion the shim is there to refuse. `--c-payload` is
    # treated as one fragment, never as a filename, so a payload whose text happens
    # to name an existing file is still scanned as text.
    #
    # The three fragment modes differ only in where the text came from and what the
    # report says, so they share one branch. Two branches would be two chances for
    # the rules to drift apart.
    #
    # `--c-payload` is the one mode that does NOT call `scan`. Its argument is a program
    # whose shell has already been resolved by whoever split the command line, so the
    # question "would the shell mangle this?" has no referent -- and answering it anyway
    # is how the first version of the shim reported `1 fragment(s) clean` about a payload
    # Python then refused to parse.
    if len(argv) > 2 and argv[1] == '--c-payload':
        language = argv[3] if len(argv) > 3 else 'python'
        violations = scan_payload(argv[2], '<c-payload>', language)
        if violations:
            print(f"{len(violations)} shell-interpolation violation(s):", file=sys.stderr)
            for v in violations:
                print(f"  {v}", file=sys.stderr)
            return 1
        print('shell-interpolation guard: 1 payload(s) clean')
        return 0

    if len(argv) > 2 and argv[1] in ('--fragment', '--from-command'):
        source = argv[2]
        text = sys.stdin.read() if source == '-' else Path(source).read_text(encoding='utf-8')
        origin = source if source != '-' else '<stdin>'
        if argv[1] == '--from-command':
            origin = f'{source} (as a command)'
        violations = scan(text, origin)
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
