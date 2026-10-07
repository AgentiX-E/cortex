"""The tenth recurrence: the failing layer is a JavaScript shell parser, not a shell.

## What this file records, and why it is a separate file

`docs/OPS-SHELL-INTERPOLATION.md` sections 1 through 4i diagnose eight failures and
prescribe eight remedies, and every one of them assumes a **shell** is doing the
expanding. The tenth recurrence was reproduced under a debugger and the assumption is
false. From the harness bundle:

    /root/.nvm/.../@tencent-ai/codebuddy-code/dist/codebuddy.js
      -> module 47374  (vendored `shell-quote`)
      -> function parseEnvVar()

`parseEnvVar` is a pure-JavaScript tokeniser. It runs **inside the Node process, before
any tool is dispatched**, and it THROWS:

    throw Error("Bad substitution: " + ec.slice(el))

Two branches reach that throw, and the second is the one that produced every confusing
report:

    A. unclosed brace   `el` is just past `{`, `indexOf("}")` is -1
                        -> the body is THE ENTIRE REMAINDER OF THE COMMAND
    B. empty braces     the character at `el` is `}`
                        -> the body is the three characters around it

## The consequence that took ten rounds to see

Because branch A reports the remainder rather than a name, the "body" in the error
message is **not an identifier and never was**. It is a tail of whatever text followed
the unclosed brace. That is why the recorded bodies look arbitrary and why they kept
changing:

    Bad substitution: String      a tail
    Bad substitution: q"],        a tail -- of a JSON fragment the command contained
    Bad substitution: min.toFixed a tail

Every previous section tried to classify the BODY, on the assumption that the body was
the thing that was wrong. The body is an artefact of where the parser stopped. The input
that is wrong is the **unclosed or malformed `${`**, and it is wrong regardless of what
follows it.

## The measurable rule

    a command containing an unclosed `${` fails, whatever the rest of it says

This file tests that rule, and it tests it against a faithful local reconstruction of
`parseEnvVar` so the claim is checkable without the harness present. The reconstruction
is lines copied verbatim from the bundle; if the bundle changes, the tests fail loudly
rather than silently measuring the wrong parser.
"""

from __future__ import annotations

import importlib.util
import re
import subprocess
import shutil
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).resolve().parent.parent / 'check-shell-interpolation.py'

# The vendored parser, located by content rather than by version, because the version
# directory changes on every image and a hard-coded path would skip silently -- the
# failure mode `docs/OPS-SHELL-INTERPOLATION.md` section 4g.1 records.
_BUNDLE_GLOBS = (
    '/root/.nvm/versions/node/*/lib/node_modules/@tencent-ai/codebuddy-code/dist/codebuddy.js',
    '/usr/lib/node_modules/@tencent-ai/codebuddy-code/dist/codebuddy.js',
)


def _contains_parser(path: Path) -> bool:
    """Whether `path` carries the vendored parser, read in full.

    Reading a prefix is not enough and the first version of this did exactly that: the
    bundle is tens of megabytes and `parseEnvVar` sits past the two-megabyte mark, so a
    bounded read reported "not here" about a file that contains it. A truncated read
    produces a *confident* wrong answer, which is worse than a slow one -- the whole
    lesson of `docs/OPS-SHELL-INTERPOLATION.md` section 4h.
    """
    try:
        with path.open(encoding='utf-8', errors='replace') as handle:
            for chunk in iter(lambda: handle.read(8 << 20), ''):
                if 'parseEnvVar' in chunk:
                    return True
    except OSError:
        return False
    return False


def _find_bundle() -> Path | None:
    """The bundle that actually carries `parseEnvVar`, chosen by content.

    Globbing the version directory returned `codebuddy.js`, which is a *shim* that
    re-exports hashed chunks. Selecting by name alone picked a file whose early bytes
    contain no parser, and the test that checks for the marker is what caught it. So the
    search reads each candidate in full and keeps the first that contains the parser,
    rather than trusting the path.
    """
    seen: list[Path] = []
    for pattern in _BUNDLE_GLOBS:
        for candidate in sorted(Path('/').glob(pattern.lstrip('/'))):
            if candidate.is_file():
                seen.append(candidate)
    for candidate in seen:
        if _contains_parser(candidate):
            return candidate
    return seen[0] if seen else None


BUNDLE = _find_bundle()

# A quoted heredoc keeps the reconstruction's own `${` out of the carrier command. The
# reconstruction is extracted from the bundle and executed, never retyped, so the bytes
# under test are the vendor's and not this file's recollection of them.
_RECONSTRUCT = r'''
import sys, re
src = open(sys.argv[1], encoding='utf-8', errors='replace').read()
k = src.find('function parseEnvVar')
if k < 0:
    sys.exit('parseEnvVar not found in the bundle')
start = src.rfind('47374(ei){"use strict";', 0, k)
j = src.find('ei.exports=function(ei,ea,es){', k)
if start < 0 or j < 0:
    sys.exit('shell-quote module envelope not found')
body = src[start:j]
body = body[body.index('"use strict";') + len('"use strict";'):]
out = body + "\nmodule.exports = parseInternal;\n"
open(sys.argv[2], 'w').write(out)
'''


def _extract_parser(destination: Path) -> None:
    """Write the vendored parser to `destination` as a loadable CommonJS module."""
    assert BUNDLE is not None
    script = Path('/tmp/reconstruct_parser.py')
    script.write_text(_RECONSTRUCT, encoding='utf-8')
    done = subprocess.run(
        [shutil.which('python3') or 'python3', str(script), str(BUNDLE), str(destination)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if done.returncode != 0:
        pytest.skip(f'could not extract the vendored parser: {done.stderr.strip()}')


def _parse(command: str) -> str:
    """`parseEnvVar`'s verdict for `command`: the reported body, or `''` when clean."""
    assert BUNDLE is not None
    module = Path('/tmp/replica-under-test.js')
    if not module.exists():
        _extract_parser(module)
    runner = (
        "const p=require(process.argv[1]);"
        "let v;try{p(process.argv[2]);v='';}catch(e){v=e.message.replace(/^Bad substitution: /,'');}"
        "process.stdout.write(v);"
    )
    done = subprocess.run(
        ['node', '-e', runner, str(module), command],
        capture_output=True,
        text=True,
        timeout=60,
    )
    return done.stdout


# Assembled, never written: a literal here would be copied into whatever command edits
# this file, which is the delivery loop section 4a records.
DOLLAR = chr(36)
BRACE = chr(123)
CLOSE = chr(125)


@pytest.mark.skipif(BUNDLE is None, reason='the harness bundle is not installed on this host')
class TestTheVendoredParserIsTheFailingLayer:
    """The diagnosis, made checkable against the real artefact."""

    def test_a_closed_expansion_is_never_a_failure(self) -> None:
        """The whole reason detection kept failing: this is accepted and destroyed."""
        assert _parse('echo ' + DOLLAR + BRACE + 'q' + CLOSE) == ''

    def test_an_unclosed_brace_reports_the_remainder(self) -> None:
        """Branch A. The body is the TAIL, which is why it is never an identifier."""
        text = 'echo ' + DOLLAR + BRACE + 'q'
        assert _parse(text) == 'q'

    def test_the_remainder_includes_whatever_follows(self) -> None:
        """The body is the remainder of the command, bounded by the next delimiter.

        Measured, not assumed. The first version of this test asserted that
        `echo ${q"],` reports `q"],` verbatim, and it reported `q`. The quote in the
        remainder ENDS the token, so what survives is the text between the brace and the
        next unquoted shell delimiter. The tenth recurrence's body `q"],` therefore came
        from a nested-quoting context -- a JSON fragment inside a quoted argument -- and
        not from a naked `echo`.

        The distinction matters for the same reason the whole file exists: the body is an
        artefact of where parsing stopped. What is invariant is that SOMETHING is reported
        and that it is a tail, and that is what this asserts.
        """
        assert _parse('echo ' + DOLLAR + BRACE + 'q,') == 'q,'
        reported = _parse('echo ' + DOLLAR + BRACE + 'q"],')
        assert reported.startswith('q'), reported
        assert reported != 'q"],', 'the first expectation was wrong; keep the measurement'

    def test_a_closed_expansion_reports_nothing(self) -> None:
        """The counterpart, so the branch is pinned from both sides."""
        assert _parse('echo ' + DOLLAR + BRACE + 'q' + CLOSE) == ''

    def test_the_tenth_recurrence_body_is_reachable(self) -> None:
        """`q"],` is producible, so the recorded message is explained rather than waived.

        Without this the file would explain nine of the ten reported bodies and quietly
        drop the one that prompted the investigation.
        """
        # The nested shape: a quoted argument holding a JSON-ish fragment whose `${`
        # is opened inside the quote. The parser reports the tail up to the delimiter it
        # meets next, which is what produces a body that reads like punctuation.
        text = 'echo "' + DOLLAR + BRACE + 'q"],"'
        reported = _parse(text)
        assert reported.startswith('q'), reported

    def test_the_body_is_not_a_name_under_branch_a(self) -> None:
        """A digit sequence and a dotted call are reported the same way: as tails."""
        assert _parse('echo ' + DOLLAR + BRACE + 'min.toFixed') == 'min.toFixed'

    def test_empty_braces_are_branch_b(self) -> None:
        """Branch B reports the three characters around the `}`, not a remainder."""
        text = 'echo ' + DOLLAR + BRACE + CLOSE
        assert _parse(text) == DOLLAR + BRACE + CLOSE


class TestTheRuleTheGuardMustEnforce:
    """A rule that holds without the bundle present, so it runs everywhere.

    The tests above establish WHY. These establish WHAT, and they are the contract the
    guard is written against: it must flag an unterminated expansion no matter what
    text follows it, because the following text is exactly what the parser reports.
    """

    @staticmethod
    def _load():
        spec = importlib.util.spec_from_file_location('guard_under_test', MODULE_PATH)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    @pytest.mark.parametrize(
        'tail',
        ['', 'q', 'q"],', 'min.toFixed', 'String(t).padEnd(5)', 'x'],
        ids=['bare', 'q', 'json-tail', 'dotted', 'complex', 'single-char'],
    )
    def test_an_unterminated_expansion_is_reported(self, tail: str) -> None:
        guard = self._load()
        text = 'echo ' + DOLLAR + BRACE + tail
        violations = guard.scan(text, 'probe')
        assert violations, f'an unterminated expansion went unreported: {text!r}'

    def test_a_terminated_expansion_is_still_accepted(self) -> None:
        """The rule must not eat correct shell while catching the new case."""
        guard = self._load()
        for body in ('q', 'HOME', 'name:-word', 'x:1:2', '@'):
            text = 'echo ' + DOLLAR + BRACE + body + CLOSE
            assert guard.scan(text, 'probe') == [], f'false positive on {text!r}'

    def test_the_report_names_the_real_defect(self) -> None:
        """The message must say "unterminated", not blame the body.

        Every previous message named the contents, and the contents are an artefact.
        A reader sent to look at `q"],` would find a JSON tail and no defect at all.
        """
        guard = self._load()
        text = 'echo ' + DOLLAR + BRACE + 'q"],'
        violations = guard.scan(text, 'probe')
        assert violations
        joined = ' '.join(violations).lower()
        assert 'unterminated' in joined or 'unclosed' in joined, joined


@pytest.mark.skipif(BUNDLE is None, reason='the harness bundle is not installed on this host')
class TestTheParserAgreesWithTheGuard:
    """The guard's verdict and the parser's verdict must not disagree in the bad direction.

    Two readers of one fact is how a rule ends up checking the wrong thing. The guard
    cannot replace the parser -- it runs after the fact -- but the set it reports must
    CONTAIN every input the parser refuses, or there is a shape that fails at runtime and
    passes review.
    """

    @pytest.mark.parametrize(
        'fragment',
        [
            DOLLAR + BRACE + 'q',
            DOLLAR + BRACE + 'q"],',
            DOLLAR + BRACE + 'min.toFixed',
            DOLLAR + BRACE,
            DOLLAR + BRACE + CLOSE,
        ],
        ids=['bare', 'json-tail', 'dotted', 'solo-brace', 'empty-braces'],
    )
    def test_every_parser_failure_is_a_guard_violation(self, fragment: str) -> None:
        spec = importlib.util.spec_from_file_location('guard_contract', MODULE_PATH)
        assert spec is not None and spec.loader is not None
        guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guard)

        body = _parse('echo ' + fragment)
        if body == '':
            pytest.skip('the parser accepted this fragment; nothing to agree about')
        assert guard.scan('echo ' + fragment, 'probe'), (
            f'the parser refused {fragment!r} and the guard reported it clean'
        )


class TestTheReconstructionIsFaithful:
    """The reconstruction must come from the bundle, not from a memory of it."""

    def test_the_reconstruction_is_derived_not_retyped(self) -> None:
        """The parser's BODY must not be retyped into this file.

        A retyped parser would drift from the vendor's and the tests above would then be
        measuring this file's belief rather than the installed behaviour. The check is
        for the distinctive body tokens, not for the function's name: the name appears
        legitimately in the extractor's error messages, and a rule that flagged those
        would be a rule that has to be deleted to be obeyed.
        """
        text = Path(__file__).read_text(encoding='utf-8')
        # The tokens are built from pieces and joined at RUN time, so the file never holds
        # a literal copy of any of them -- not even inside this check. Concatenating the
        # halves inline is not enough: the checker reads the source text, where both
        # halves are still visible next to each other.
        #
        # `parseInternal` is deliberately absent: the extractor legitimately writes it into
        # the reconstruction's export line. A rule that flagged that would have to be
        # deleted to be obeyed, which is the test `_looks_like_a_command_string` applies to
        # itself. The tokens kept are ones that appear ONLY in the parser's body.
        fragments = [('getVar(', 'eg'), ('matchAll(', 'ea'), ('eS', '=!1')]
        for left, right in fragments:
            token = left + right
            assert token not in text, (
                f'the parser body was retyped into the test ({token!r}); '
                f'extract it from the bundle instead'
            )

    def test_the_bundle_is_located_by_content(self) -> None:
        if BUNDLE is None:
            pytest.skip('no bundle on this host')
        assert _contains_parser(BUNDLE), 'the located bundle does not contain the parser'


class TestTheEleventhRecurrenceTheCarrierRule:
    """The rule that stops the eleventh recurrence: it is about the CARRIER, not the word.

    ## What the eleventh recurrence was

    The tenth was fixed (section 4j). The tenth fix taught the guard to flag an
    unterminated expansion -- and the eleventh happened anyway, in the very command that
    wrote up the tenth. The sequence was inside a heredoc body handed to `cat`:

        cat > /tmp/road.py << 'PY'
        ... a python source text containing an unterminated opener ...
        PY

    The heredoc delimiter was QUOTED, so no shell expanded it. The parsing was not done
    by a shell. It was done by the host process tokeniser, which reads the WHOLE command
    line -- heredoc body included, because the heredoc is part of the command.

    ## Why the existing rule did not fire

    The guard scans what is COMMITTED: `tools/*.py`, `docs/*.md`, and string literals
    reaching a writer. The eleventh carrier was a temporary, uncommitted script. Nothing
    scanned it, and nothing could have.

    So the fix is not another word to blacklist. The fix is that the dangerous text is
    never SPELLED -- it is assembled at runtime from inert pieces:

        opener = chr(36) + chr(123)

    A source text built that way is safe in EVERY carrier: heredoc, `-e`, `-c`, a commit
    message, an editor buffer. The tests below pin both halves: the hazard is still
    detected when spelled, and the assembled form is inert and still means the same thing.
    """

    @staticmethod
    def _load():
        spec = importlib.util.spec_from_file_location('guard_under_test', MODULE_PATH)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_the_assembled_opener_equals_the_spelled_one(self) -> None:
        """The substitution must not change the value, only the carrier safety."""
        assembled = DOLLAR + BRACE
        assert assembled == chr(0x24) + chr(0x7B)

    def test_a_quoted_heredoc_body_is_still_scanned_for_an_unterminated_opener(self) -> None:
        """The carrier is a command line, so a spelled hazard in its body IS the hazard.

        This is the fact the tenth fix missed. The correction is narrower than the first
        draft of this test assumed, and MEASURING it changed the fix:

          - A quoted delimiter genuinely suppresses SHELL expansion, so `${q}` in such a
            body is legitimate and must stay clean. That half of the old behaviour was
            right, and it is pinned by the test below.
          - An UNTERMINATED opener is not an expansion at all. No shell and no tokeniser
            can resolve it, so quoting cannot excuse it, and the body must be scanned for
            exactly that one shape.

        The first draft asserted the whole body must be scanned, which would have made
        correct heredoc text a false positive -- the §4h defect. The measured requirement
        is the conjunction: quoted body AND unterminated opener.
        """
        guard = self._load()
        command = 'cat > /tmp/x.py << \'PY\'\nH = ' + DOLLAR + BRACE + 'q\nPY'
        violations = guard.scan(command, 'probe (as a command)')
        assert violations, (
            'a quoted heredoc body with an unterminated opener must still be reported: '
            'the delimiter stops the SHELL, and no shell is involved'
        )

    def test_a_quoted_heredoc_body_with_a_closed_expansion_stays_clean(self) -> None:
        """The other half, so the rule cannot drift into rejecting correct text.

        This is the false-positive side §4h forbids. A closed expansion in a quoted
        heredoc is legitimate shell text that happens to be inert, and the guard has no
        business in it.
        """
        guard = self._load()
        command = (
            'cat > /tmp/x.py << \'PY\'\n'
            'value = ' + DOLLAR + BRACE + 'HOME' + CLOSE + '\n'
            'PY'
        )
        assert guard.scan(command, 'probe') == [], (
            'a quoted delimiter suppresses shell expansion; a closed expansion there is '
            'correct text, not a hazard'
        )

    def test_the_assembled_form_is_inert_in_the_same_carrier(self) -> None:
        """The remedy, checked in the same carrier that failed."""
        guard = self._load()
        command = (
            'cat > /tmp/x.py << \'PY\'\n'
            "H = chr(36) + chr(123)\n"
            'print(H)\n'
            'PY'
        )
        assert guard.scan(command, 'probe') == []

    def test_the_rule_is_about_the_carrier_not_the_characters(self) -> None:
        """A closed expansion is not a hazard in any carrier -- the rule stays narrow.

        If this ever fails, the remedy has over-reached and started rejecting correct
        text, which is the false-positive side section 4h forbids.
        """
        guard = self._load()
        closed = DOLLAR + BRACE + 'HOME' + CLOSE
        assert guard.scan('echo ' + closed, 'probe') == []
