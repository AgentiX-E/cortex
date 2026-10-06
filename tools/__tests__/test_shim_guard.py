"""Tests for the `python3` shim and the payload rule it calls.

## What this file protects

`/root/.pyenv/shims/python3` is an **environment change**, not a committed file. It
lives outside the repository, so nothing in review would notice it disappearing, and a
re-image removes it silently. The seventh `Bad substitution` happened *because* the
guard sat outside the path of a typed command: the rule existed, was tested, and was
not in the way. This file is the way the guard is in the way, and it asserts so.

The tests are written to fail loudly on a re-image rather than skip. A missing net that
reports nothing is indistinguishable from a net that never fires, which is the exact
condition that produced the recurrences.

## Why the payload rule lives here too

`scan_payload` answers a question no other rule can: "the shell question is already
settled, so is this program's own `${...}` a construct its language has?" Its only
caller is the shim, so a test of the shim is what keeps it honest. Splitting them would
let the caller and the callee drift while both stayed green.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
GUARD = REPO / 'tools' / 'check-shell-interpolation.py'

# The shim's documented home (docs/OPS-SHELL-INTERPOLATION.md 4g).
SHIM_HOME = Path('/root/.pyenv/shims/python3')

# Where `python3` actually resolves on this host. The shim is an ENVIRONMENT change and
# is not committed, so on a CI runner it legitimately does not exist -- the runner has no
# `.pyenv` at all. See `shim_on_path` for why the tests split on this rather than
# hardcoding `SHIM_HOME` everywhere.
SHIM = SHIM_HOME


def run_shim(payload: str) -> subprocess.CompletedProcess[str]:
    """Run a payload through the shim at its documented home.

    ## Why this is the absolute path and not `command -v python3`

    The first fix for the CI failure replaced this with a PATH lookup, and the lookup was
    itself wrong -- measured, not assumed. In this image:

        interactive login shell:   command -v python3 -> /root/.pyenv/shims/python3
        non-interactive `bash -lc' command -v python3 -> /root/.pyenv/versions/3.11.1/bin/python3

    A subprocess gets the second. `~/.bashrc` re-runs pyenv's `rehash` on the non-interactive
    path, which drops the shim shim from `PATH`, so the lookup resolves to the REAL
    interpreter and two of these tests silently exercised nothing. They still passed, because
    a real interpreter also exits non-zero on `print(${x:.3f})` -- with a `SyntaxError`
    instead of the shim's refusal. A green test asserting the wrong producer is the failure
    this whole file exists to warn about.

    So the shim is invoked where `4g` documents it. "Is the shim installed here" is then a
    single explicit question (`shim_is_installed`) that gates the classes, rather than a
    side effect of how a shell happens to initialise.
    """
    return subprocess.run(
        [str(SHIM_HOME), '-c', payload],
        capture_output=True,
        text=True,
        timeout=60,
    )


DOLLAR = chr(36)
LBRACE = chr(123)
RBRACE = chr(125)


def seq(body: str) -> str:
    """`${body}` built from pieces.

    Written this way rather than as a literal because the literal would be a shell
    hazard in whatever carries this file -- an edit, a diff, a command. `scan_test_sources`
    in the guard enforces the same rule on writers; assembling the string is how a test
    can name the hazard without becoming one.
    """
    return DOLLAR + LBRACE + body + RBRACE


def shim_is_installed() -> bool:
    """Whether this host has the shim at its documented home, executable.

    ## Why every step is guarded

    `Path.exists()` and `Path.stat()` both raise `PermissionError`, not `False`, when an
    ANCESTOR directory is unreadable. On a GitHub runner `/root` exists but the runner
    process cannot traverse it, so this predicate raised at COLLECTION time and took the
    whole file down with `Interrupted: 1 error during collection` -- including the rule
    tests that do not need the shim at all.

    A gate is not allowed to fail; it is only allowed to say no. Returning `False` here
    means "this host does not have the shim", which is exactly true and is what the
    `skipif` reason already states. Letting the check raise would make an environment
    difference indistinguishable from a broken test file, which is the whole class of
    defect this file exists to catch.

    `PermissionError` is caught alongside `OSError` (its parent) so a future filesystem
    quirk lands in the same place rather than reopening this.
    """
    try:
        if not SHIM_HOME.exists():
            return False
        return bool(SHIM_HOME.stat().st_mode & 0o111)
    except OSError:
        return False


# The reason strings are the point of using skipif rather than a bare boolean: the log
# records WHY the class did not run, so a green suite on a CI runner cannot be mistaken
# for evidence that the guidance in 4g is in place.
SHIM_INSTALLED = pytest.mark.skipif(
    not shim_is_installed(),
    reason=(
        f'the python3 shim is not installed at {SHIM_HOME}; it is an environment change '
        f'and not a committed file, so this host is not the development image. The rule '
        f'tests below still cover check-shell-interpolation.py, which IS committed.'
    ),
)


@SHIM_INSTALLED
class TestTheShimIsPresent:
    """An absent shim is the failure mode this class exists to make visible."""

    def test_the_shim_exists_and_is_executable(self) -> None:
        assert SHIM.exists(), (
            f'the python3 shim is missing at {SHIM}. It is an environment change, so a '
            f're-image removes it; reinstall it from docs/OPS-SHELL-INTERPOLATION.md. '
            f'Without it the guard is not in the path of a typed command, which is how '
            f'the seventh Bad substitution happened.'
        )
        assert SHIM.stat().st_mode & 0o111

    def test_the_shim_intercepts_a_payload_that_must_be_refused(self) -> None:
        """The load-bearing property: reached, the shim refuses.

        Called at its documented path rather than through `command -v`, because — see
        `test_the_shim_is_bypassed_when_the_path_is_ordered_the_other_way` — the PATH
        lookup is not reliable here and a test that depended on it would be measuring
        PATH rather than the shim.

        ## Two wrong versions, and why each was wrong

        **Version 1** asserted the shims directory appears on `PATH`. True, and not
        sufficient: listing a directory does not make it win the lookup.

        **Version 2** asserted `sys.executable` is the shim. It failed, informatively: the
        shim is a bash script that `exec`s the real interpreter after checking the payload,
        so a successful intercept *necessarily* leaves `sys.executable` on the real binary.
        The test was asserting the absence of the behaviour it wanted.

        **This version** asserts what the shim IS for — a refusal — at the one address that
        reaches it unconditionally.
        """
        result = subprocess.run(
            [str(SHIM_HOME), '-c', 'print(' + seq('x:.3f') + ')'],
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert result.returncode != 0
        # The refusal must be the SHIM's, not Python's: a real interpreter also exits
        # non-zero on this text, with a SyntaxError. Asserting only the exit code would
        # pass whether or not the guard was consulted.
        assert 'sits inside a `python` payload' in result.stderr, (
            f'the payload was refused by the interpreter rather than by the guard: '
            f'{result.stderr}'
        )

    def test_the_shim_is_bypassed_when_the_path_is_ordered_the_other_way(self) -> None:
        """The measured bypass, asserted so it cannot be forgotten.

        ## What is true here, and it is not what §4g originally claimed

        §4g says the shim "is the first `python3` on `PATH`". Measured from a subprocess,
        that is **false**: `PATH` begins with `/root/.pyenv/versions/3.11.1/bin`, ahead of
        `/root/.pyenv/shims`, in both `bash -c` and `bash -lc`. An unqualified `python3`
        in a subprocess therefore reaches the real interpreter and the guard is never
        consulted.

        The interactive shell resolves to the shim, which is why this went unnoticed: the
        author's own `command -v python3` answered with the shim, and every test that
        asserted the shim's verdict called its absolute path, so the lookup never had to
        win for the suite to pass.

        ## Why this asserts the bypass instead of failing on it

        Asserting `Path(resolved) == SHIM_HOME` here would fail on a correct host and pass
        only where PATH happens to be ordered one way. That is the third consistency class
        in `cortex-docs`: a test measuring the machine's install state. The bypass is a
        fact about this environment; pinning the FACT is what makes the next recurrence
        cheap to diagnose, and `4g.1` records it for whoever fixes the ordering.

        The direction that matters is asserted, not assumed: whichever way this host
        resolves `python3`, the assertion below states which behaviour is expected from
        that resolution.
        """
        resolved = subprocess.run(
            ['bash', '-c', 'command -v python3'],
            capture_output=True,
            text=True,
            timeout=60,
        ).stdout.strip()
        assert resolved, 'python3 is not on PATH at all, which is a different problem'

        if Path(resolved) == SHIM_HOME:
            # Reached: then a refusable payload must be refused BY THE SHIM.
            result = subprocess.run(
                ['bash', '-c', 'python3 -c ' + repr('print(' + seq('x:.3f') + ')')],
                capture_output=True,
                text=True,
                timeout=60,
            )
            assert 'sits inside a `python` payload' in result.stderr, (
                f'python3 resolved to the shim but the payload was refused by the '
                f'interpreter: {result.stderr}'
            )
        else:
            # Bypassed: then the guard is not consulted, and the refusal must NOT be the
            # shim's. Asserting this half too keeps the test from passing vacuously when
            # the resolution changes -- it would otherwise go green by falling through.
            result = subprocess.run(
                ['bash', '-c', 'python3 -c ' + repr('print(' + seq('x:.3f') + ')')],
                capture_output=True,
                text=True,
                timeout=60,
            )
            assert 'sits inside a `python` payload' not in result.stderr, (
                f'python3 resolved to {resolved}, not the shim, yet the guard spoke -- '
                f'which means something else on PATH is forwarding to it'
            )

    def test_the_login_shell_bypass_is_recorded(self) -> None:
        """The bypass is a measured environment gap, and it is written down.

        Asserting the RECORD rather than the behaviour: the behaviour is wrong and will
        stay wrong until the `PATH` ordering is fixed, and a test that pinned the wrong
        behaviour would lock it in. What is checkable now is that nobody has to
        rediscover it — `4g.1` names it, and this class's docstrings name it.
        """
        text = (REPO / 'docs' / 'OPS-SHELL-INTERPOLATION.md').read_text()
        assert '4g.1' in text, (
            'the PATH-ordering bypass must be written down as 4g.1; it is the difference '
            'between a guard that is consulted and one that is only believed in'
        )

    def test_the_shim_does_not_break_an_ordinary_payload(self) -> None:
        # The shim is on the path of every python3 invocation in this environment, so a
        # false positive would be worse than the hazard: it would be turned off.
        result = run_shim('print("shim alive")')
        assert result.returncode == 0, result.stderr
        assert 'shim alive' in result.stdout


@SHIM_INSTALLED
class TestTheShimRefusesTheSeventhRecurrence:
    """The reported failures, replayed against the net that now catches them."""

    def test_a_format_spec_in_a_payload_is_refused(self) -> None:
        # This is the reported `Bad substitution: cut.toFixed`, in its Python spelling.
        result = run_shim('x = 1.23456\nprint(' + seq('x:.3f') + ')')
        assert result.returncode != 0, 'the shim allowed a format spec through'
        assert 'sits inside a `python` payload' in result.stderr

    def test_the_refusal_quotes_the_offending_sequence(self) -> None:
        result = run_shim('print(' + seq('x:.3f') + ')')
        assert seq('x:.3f') in result.stderr, (
            'the report must show the offending text; a diagnostic that costs a lookup '
            'is one people skim'
        )

    def test_the_refusal_names_the_way_out(self) -> None:
        result = run_shim('print(' + seq('x:.3f') + ')')
        assert 'exec-python.py' in result.stderr

    def test_a_bare_name_sequence_is_refused(self) -> None:
        # `${HOME}` is a legal shell expansion, so the shell rule stays quiet about it --
        # but it is not Python, and a payload is not shell. This is the case that made
        # `scan_payload` necessary: reusing the shell rule reported this clean.
        result = run_shim('print(' + seq('HOME') + ')')
        assert result.returncode != 0

    @pytest.mark.parametrize(
        'body',
        ['x:.3f', 'x:2.3f', 'label:>5', 'w:=^20', 'd:%Y'],
    )
    def test_every_measured_spec_shape_is_refused(self, body: str) -> None:
        # Each of these was run through bash, dash and zsh and fails in all three; the
        # table is in `_is_shell_expansion_for_a_payload`. A loop would report one test
        # name for five checks, which hides which shape regressed.
        result = run_shim('print(' + seq(body) + ')')
        assert result.returncode != 0, f'{seq(body)} was allowed through'


@SHIM_INSTALLED
class TestTheShimAllowsWhatMustStayAllowed:
    """False positives are how a guard gets deleted, so they are asserted too."""

    @pytest.mark.parametrize(
        'body',
        ['HOME', 'PATH', 'x:-1', 'x:+w', 'x:offset', 'a:1', 'x:0:5', '1', '@'],
    )
    def test_a_real_shell_expansion_shape_is_quiet(self, body: str) -> None:
        # These are shell expansions, measured: `${x:-1}` is a default, `${a:1}` and
        # `${x:0:5}` are substrings that bash and zsh perform. A payload may print them
        # as literal text, and refusing would make the shim unusable.
        result = run_shim('print("' + seq(body) + '")')
        assert result.returncode == 0, (
            f'{seq(body)} was refused, but it is a valid shell expansion: {result.stderr}'
        )

    def test_a_payload_with_no_sequence_is_untouched(self) -> None:
        result = run_shim('import sys; print(sys.version_info[0])')
        assert result.returncode == 0
        assert result.stdout.strip() == '3'


class TestScanPayloadAnswersTheNarrowerQuestion:
    """`scan_payload` is not `scan`, and the difference is what it exists for."""

    def load_guard(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location('guard_for_shim_test', GUARD)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_a_payload_has_no_command_line_to_derive(self) -> None:
        # Feeding bare program text to `scan` reports clean, and did, in the first probe
        # of the shim -- the guard said `1 fragment(s) clean` about a payload Python then
        # refused to parse. That is why the two functions are separate.
        guard = self.load_guard()
        payload = 'x = 1.2\nprint(' + seq('x:.3f') + ')'
        assert guard.scan(payload, '<probe>') == []
        assert guard.scan_payload(payload, '<probe>', 'python') != []

    def test_a_shell_payload_is_exempt(self) -> None:
        # `sh -c 'echo ${HOME}'` is correct, so the rule must not fire on a shell
        # language. The argument is what names the language, not the origin string.
        guard = self.load_guard()
        assert guard.scan_payload('echo ' + seq('HOME'), '<probe>', 'sh') == []
        assert guard.scan_payload('echo ' + seq('HOME'), '<probe>', 'bash') == []

    def test_a_comment_in_a_payload_is_not_a_violation(self) -> None:
        # This module's own documentation names the hazard in prose, and a rule that
        # reported its own documentation would be deleted rather than obeyed.
        guard = self.load_guard()
        assert guard.scan_payload('# see ' + seq('x:.3f') + ' in the notes', '<p>', 'python') == []

    def test_the_language_is_named_in_the_report(self) -> None:
        guard = self.load_guard()
        reports = guard.scan_payload('print(' + seq('x:.3f') + ')', '<p>', 'python')
        assert len(reports) == 1
        assert '`python`' in reports[0]


class TestTheRuleIsCoveredWithoutTheShim:
    """The same verdicts, reached through the guard's CLI instead of the shim.

    ## Why this class exists

    The shim is deliberately not committed, so the three classes above do not run on a CI
    runner. That is correct for the *presence* claim, and it would be a serious loss for
    the *rule* claim: "the format spec is refused" and "the nine legal shapes stay quiet"
    are properties of `check-shell-interpolation.py`, which IS committed, and CI is the
    only place they are exercised on a clean checkout.

    Gating them behind the shim would have meant the rule's entire coverage ran on exactly
    one machine -- the one where a regression is least likely to be noticed, because the
    author is watching. So every verdict the shim classes assert is asserted here too,
    against the committed entry point the shim invokes:

        shim:  guard --c-payload <program> <language>
        here:  guard --c-payload <program> <language>

    The shim adds nothing but the `-c` detection that routes to this call. `test_the_shim_
    calls_the_same_entry_point` pins that, so the two cannot drift into testing different
    things while both reading green.
    """

    def run_cli(self, payload: str, language: str = 'python') -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ['python3', str(GUARD), '--c-payload', payload, language],
            capture_output=True,
            text=True,
            timeout=60,
        )

    def test_a_format_spec_in_a_payload_is_refused(self) -> None:
        # The reported `Bad substitution: cut.toFixed`, in its Python spelling.
        result = self.run_cli('x = 1.23456\nprint(' + seq('x:.3f') + ')')
        assert result.returncode == 1, f'the guard allowed a format spec: {result.stdout}'
        assert 'sits inside a `python` payload' in result.stderr

    def test_the_refusal_quotes_the_offending_sequence(self) -> None:
        result = self.run_cli('print(' + seq('x:.3f') + ')')
        assert seq('x:.3f') in result.stderr

    def test_the_refusal_names_the_way_out(self) -> None:
        # Measured: the `--c-payload` arm points at tools/run-program.py, which is the
        # generic "write the program to a file" route. The SHIM's own message points at
        # tools/exec-python.py, because a `python3 -c` payload is already Python. Two
        # entry points, two remedies; asserting the wrong one here would have been a test
        # written from assumption.
        result = self.run_cli('print(' + seq('x:.3f') + ')')
        assert 'run-program.py' in result.stderr

    def test_a_bare_name_sequence_is_clean_at_this_layer(self) -> None:
        # ## The two layers answer different questions, and this is where they part
        #
        # `TestTheShimRefusesTheSeventhRecurrence` asserts the shim REFUSES `${HOME}` in a
        # payload, and that is right: a payload is not shell, so a shell variable is not
        # what the author meant. This class asserts `--c-payload` calls it CLEAN, and that
        # is also right, because this arm answers a narrower question -- *can the inner
        # language parse this?* -- and `${HOME}` is not a Python construct, so nothing in
        # Python's grammar is being shadowed.
        #
        # Writing both as `returncode == 1` would have made one of them a lie. The split is
        # the design: the guard detects a construct the INNER language has (and therefore
        # expected to own), while the shim adds the knowledge that the text arrived through
        # a shell in the first place. That extra knowledge is what `-c` supplies and a
        # `--c-payload` invocation does not.
        result = self.run_cli('print(' + seq('HOME') + ')')
        assert result.returncode == 0, result.stderr
        # And it is reported as clean rather than silently ignored, so the log says the
        # payload was looked at.
        assert 'clean' in result.stdout

    @pytest.mark.parametrize('body', ['x:.3f', 'x:2.3f', 'label:>5', 'w:=^20', 'd:%Y'])
    def test_every_measured_spec_shape_is_refused(self, body: str) -> None:
        result = self.run_cli('print(' + seq(body) + ')')
        assert result.returncode == 1, f'{seq(body)} was allowed through'

    @pytest.mark.parametrize(
        'body',
        ['HOME', 'PATH', 'x:-1', 'x:+w', 'x:offset', 'a:1', 'x:0:5', '1', '@'],
    )
    def test_a_real_shell_expansion_shape_is_quiet(self, body: str) -> None:
        # The false-positive side, asserted where CI can see it: a rule that refuses these
        # gets turned off, and it takes the checks that work with it.
        result = self.run_cli('print("' + seq(body) + '")')
        assert result.returncode == 0, (
            f'{seq(body)} was refused, but it is a valid shell expansion: {result.stderr}'
        )

    def test_a_payload_with_no_sequence_is_untouched(self) -> None:
        result = self.run_cli('import sys; print(sys.version_info[0])')
        assert result.returncode == 0

    def test_the_shim_calls_the_same_entry_point(self) -> None:
        # The shim routes `python3 -c` with a `${` to this exact flag. If the flag name or
        # the arity changed, the shim would call it with the wrong shape and every shim
        # test above would still pass while the shim itself was broken.
        source = (GUARD).read_text()
        assert "'--c-payload'" in source
        shim_reference = REPO / 'docs' / 'OPS-SHELL-INTERPOLATION.md'
        text = shim_reference.read_text()
        assert '--c-payload' in text, (
            'the documented shim wiring must name the entry point it calls, or the two '
            'halves of this guard drift'
        )
