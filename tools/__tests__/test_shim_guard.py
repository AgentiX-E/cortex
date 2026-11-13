"""Tests for the `python3` shim and the payload rule it calls.

## What this file protects

`/root/.pyenv/shims/python3` is an **environment change**: the file that has to sit at
that address lives outside the repository. The seventh `Bad substitution` happened
*because* the guard sat outside the path of a typed command -- the rule existed, was
tested, and was not in the way. This file is the way the guard is in the way, and it
asserts so.

## What changed when the gate itself was measured on a fresh image

The shim's *source* now lives in `tools/python3-shim.py`, because a hand-written file at
an address outside the repository is removed by whatever replaces the image, and the
repository could not tell. On a re-imaged host the check below found **3 failed / `pnpm
check` red**, and the reason it gave was wrong: `shim_is_installed()` asked "is there an
executable file at the home", and pyenv's own dispatcher -- which a stock pyenv image
puts at exactly that path -- answers yes. Every intercept test then ran against a shim
that does not intercept.

So the predicate is now a three-state **identity** (`absent` / `guard` / `foreign`) owned
by the installer module, and the skip reason names which stranger is at the address. The
distinction matters in one direction only, and it is the direction a gate is allowed to
move in: a host that cannot host the net is *skipped with a diagnosis*, and the rule
tests below -- which cover `check-shell-interpolation.py`, the committed half -- run
everywhere regardless.

## Why the payload rule lives here too

`scan_payload` answers a question no other rule can: "the shell question is already
settled, so is this program's own `${...}` a construct its language has?" Its only
caller is the shim, so a test of the shim is what keeps it honest. Splitting them would
let the caller and the callee drift while both stayed green.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
GUARD = REPO / 'tools' / 'check-shell-interpolation.py'
INSTALLER = REPO / 'tools' / 'python3-shim.py'


def _load_installer():
    """The installer module, so the marker and the identity rule have one owner.

    Imported rather than restated for the reason the payload rule lives beside its
    caller: a second copy of the marker string is a gate that can be made to believe a
    stranger is its own instrument, which is the defect this whole file is about.
    """
    spec = importlib.util.spec_from_file_location('cortex_python3_shim', INSTALLER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


installer = _load_installer()

# The shim's documented home (docs/OPS-SHELL-INTERPOLATION.md 4g). Read from the
# installer, so `--home` and the tests cannot disagree about where the net is.
SHIM_HOME = installer.default_home()

# Where `python3` actually resolves on this host. The shim is an ENVIRONMENT change, so
# on a CI runner it legitimately does not exist -- the runner has no `.pyenv` at all.
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


def shim_identity() -> str:
    """What is at the shim's home on this host: `absent`, `guard`, or `foreign`.

    ## Why a boolean was not enough, measured

    This function used to ask "is there an executable file at the home" and return a
    bool. On a stock pyenv image that question has a **yes** answer that is not the
    answer anyone wanted: pyenv writes its own 168-byte dispatcher to precisely this
    path. The suite then ran three intercept tests against a dispatcher, failed, and the
    failure read like a code defect -- `Bad substitution` shaped exactly like the one the
    shim exists to prevent, arriving through the gate that was supposed to prevent it.

    Three states let the skip reason say **which** stranger occupies the address, which
    is the difference between an environment difference and a broken test file.

    Never raises. `Path.exists()` and `Path.stat()` raise `PermissionError` when an
    ANCESTOR is unreadable, and on a GitHub runner `/root` exists but is not traversable
    -- that raise once happened at COLLECTION time and took the whole file down,
    including the rule tests that do not need the shim at all.
    """
    return installer.identity(SHIM_HOME)


SHIM_STATE = shim_identity()


# The reason strings are the point of using skipif rather than a bare boolean: the log
# records WHY the class did not run, so a green suite on a CI runner cannot be mistaken
# for evidence that the guidance in 4g is in place. Each state gets its own sentence,
# because "the net is not here", "our net is here but cannot run" and "something else is
# at the net's address" are three different facts about the host.
SHIM_DIAGNOSIS = {
    'foreign': (
        'a file is at the home that this repository did not write -- on a stock pyenv '
        'image it is pyenv\'s own dispatcher, which answers "is there an executable here" '
        'and does not intercept anything'
    ),
    'inert': (
        'this repository\'s shim is at the home but is not executable, which is an install '
        'whose mode was lost rather than an install that never happened'
    ),
    'absent': 'the shim is not installed, and a re-image removes it',
}

SHIM_INSTALLED = pytest.mark.skipif(
    SHIM_STATE != 'guard',
    reason=(
        f'nothing of this repository\'s is runnable at {SHIM_HOME} (state: `{SHIM_STATE}`): '
        f'{SHIM_DIAGNOSIS.get(SHIM_STATE, "unknown state")}. '
        'Install it with `python3 tools/python3-shim.py --install`. The rule tests below '
        'still cover check-shell-interpolation.py, which IS committed, and '
        '`TestTheInstallerIsTheShimsSource` exercises the generated shim from a temporary '
        'path on every host.'
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


class TestTheInstallerIsTheShimsSource:
    """`tools/python3-shim.py` owns the file, the marker and the identity rule.

    ## Why these tests are not gated on the shim being installed

    The classes above skip when the host cannot host the net, and that is right for the
    claim "the net is up here". It would be wrong for the claim "the net works", because
    then the mechanism's only coverage would live on exactly one machine -- the one where
    a regression is least likely to be noticed, since the author is watching. So every
    test below writes the generated source to a temporary path and runs **that**, which
    is the same bytes `--install` writes and needs no privileges anywhere.
    """

    def generated(self) -> str:
        return installer._bash_source('/bin/echo', str(GUARD))

    def test_the_generated_source_carries_the_marker(self) -> None:
        # The marker is the ONLY thing separating our shim from pyenv's dispatcher at the
        # same path, so its presence in the output is the identity mechanism's precondition.
        assert installer.MARKER in self.generated()

    def test_the_generated_source_calls_the_documented_flag(self) -> None:
        # A shim that calls the guard with a different flag is a shim that prints a usage
        # error into stderr and lets the hazard through -- and every refusal test would
        # still pass if the flag were renamed in both places.
        assert '--c-payload' in self.generated()

    def test_the_generated_source_names_the_way_out(self) -> None:
        assert 'exec-python.py' in self.generated()

    def test_the_generated_source_opens_no_interpolation_of_its_own(self) -> None:
        # The shim sits in the path of every `python3 -c`, so an unquoted opener in it
        # would make the net a hazard. `--print` output is fed to the committed guard,
        # which is the same rule it enforces on the repository's own sources.
        spec = importlib.util.spec_from_file_location('guard_for_installer_test', GUARD)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        assert module.scan(self.generated(), '<python3-shim>') == [], (
            'the shim itself contains a construct the guard refuses'
        )

    def test_the_installed_shim_and_the_generated_source_agree(self) -> None:
        # Two ways to obtain the same bytes. If `--install` and `--print` ever diverge, the
        # docs would describe a shim nobody is running.
        if SHIM_STATE != 'guard':
            pytest.skip(f'nothing to compare against: {SHIM_HOME} is `{SHIM_STATE}`')
        installed = SHIM.read_text()
        for fingerprint in (installer.MARKER, '--c-payload', 'exec-python.py', 'locate_guard'):
            assert fingerprint in installed

    def test_identity_reports_absent_for_a_path_that_does_not_exist(self, tmp_path) -> None:
        assert installer.identity(tmp_path / 'nope') == 'absent'

    def test_identity_reports_foreign_for_another_programs_file(self, tmp_path) -> None:
        # The measured case: pyenv's dispatcher is 168 bytes, executable, and lives at
        # exactly the shim's address. A boolean predicate said yes to it.
        foreign = tmp_path / 'python3'
        foreign.write_text('#!/usr/bin/env bash\nexec /usr/bin/python3 "$@"\n')
        foreign.chmod(0o755)
        assert installer.identity(foreign) == 'foreign'

    def test_identity_reports_guard_for_our_own_source(self, tmp_path) -> None:
        mine = tmp_path / 'python3'
        mine.write_text(self.generated())
        mine.chmod(0o755)
        assert installer.identity(mine) == 'guard'

    def test_identity_separates_our_source_without_its_mode_from_a_stranger(self, tmp_path) -> None:
        # `chmod` is not preserved by every archive or image layer, so a copy of OUR shim
        # can arrive without the executable bit. Both states stop the net from working and
        # only one of them is fixed by reinstalling -- a diagnosis that merges them sends
        # the operator to the wrong command.
        mine = tmp_path / 'python3'
        mine.write_text(self.generated())
        mine.chmod(0o644)
        assert installer.identity(mine) == 'inert'
        stranger = tmp_path / 'other' / 'python3'
        stranger.parent.mkdir()
        stranger.write_text('#!/usr/bin/env bash\nexit 0\n')
        assert installer.identity(stranger) == 'absent', (
            'a non-executable file that is not ours is not a shim in any state'
        )

    def test_check_is_non_zero_for_a_foreign_file(self, tmp_path) -> None:
        # `--check` is what a human or a CI step runs to ask "is the net up". A zero exit
        # for a stranger at the address would be the gate reporting the opposite of what
        # it measured.
        foreign = tmp_path / 'python3'
        foreign.write_text('#!/usr/bin/env bash\nexit 0\n')
        foreign.chmod(0o755)
        result = subprocess.run(
            ['python3', str(INSTALLER), '--check', '--home', str(foreign)],
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert result.returncode == 1
        assert '--install' in result.stderr

    def test_install_then_uninstall_round_trips(self, tmp_path) -> None:
        home = tmp_path / 'shims' / 'python3'
        interpreter = installer.resolve_real_python(home)
        if interpreter is None:
            pytest.skip('no interpreter on PATH outside the shim home to exec')
        assert installer.install(home, interpreter, GUARD) == 0
        assert installer.identity(home) == 'guard'
        assert home.stat().st_mode & 0o111
        assert installer.uninstall(home) == 0
        assert installer.identity(home) == 'absent'

    def test_install_displaces_rather_than_deletes(self, tmp_path) -> None:
        # The defect this closes is that the first install overwrote pyenv's dispatcher
        # with no copy taken, so `--uninstall` could not put the host back.
        home = tmp_path / 'python3'
        dispatcher = '#!/usr/bin/env bash\n# pyenv dispatcher, 168 bytes in the wild\n'
        home.write_text(dispatcher)
        home.chmod(0o755)
        interpreter = installer.resolve_real_python(home) or '/usr/bin/python3'
        assert installer.install(home, interpreter, GUARD) == 0
        backup = home.with_suffix(home.suffix + installer.BACKUP_SUFFIX)
        assert backup.read_text() == dispatcher
        assert installer.uninstall(home) == 0
        assert home.read_text() == dispatcher, 'uninstall did not restore the displaced file'

    def test_install_is_idempotent_and_keeps_the_first_backup(self, tmp_path) -> None:
        # A second `--install` must not overwrite the only copy of the displaced file with
        # a copy of ourselves, which would make the host unrecoverable.
        home = tmp_path / 'python3'
        home.write_text('#!/usr/bin/env bash\n# original\n')
        home.chmod(0o755)
        interpreter = installer.resolve_real_python(home) or '/usr/bin/python3'
        installer.install(home, interpreter, GUARD)
        installer.install(home, interpreter, GUARD)
        backup = home.with_suffix(home.suffix + installer.BACKUP_SUFFIX)
        assert backup.read_text() == '#!/usr/bin/env bash\n# original\n'

    def test_install_refuses_when_the_shim_would_exec_itself(self, tmp_path) -> None:
        # `resolve_real_python` excludes the shim home by resolved path, not by name. With
        # no `python3` anywhere else, installing would create an infinite exec loop, so it
        # is refused rather than written.
        empty = tmp_path / 'emptybin'
        empty.mkdir()
        result = subprocess.run(
            [sys.executable, str(INSTALLER), '--install', '--home', str(tmp_path / 'python3')],
            capture_output=True,
            text=True,
            timeout=60,
            env={'PATH': str(empty)},
        )
        assert result.returncode == 1
        assert 'exec itself' in result.stderr

    def test_a_generated_shim_written_anywhere_refuses_the_hazard(self, tmp_path) -> None:
        """The behaviour claim, asserted where CI can see it.

        This is the same refusal `TestTheShimRefusesTheSeventhRecurrence` asserts, reached
        without installing anything: the generated source is written to a temporary path
        and run there. If the shim's logic regresses, this test goes red on every host
        rather than only on the development image.
        """
        interpreter = installer.resolve_real_python(tmp_path)
        if interpreter is None:
            pytest.skip('no interpreter on PATH outside the shim home to exec')
        scratch = tmp_path / 'python3'
        scratch.write_text(installer._bash_source(interpreter, str(GUARD)))
        scratch.chmod(0o755)

        hazard = 'print(' + seq('x:.3f') + ')'
        refused = subprocess.run([str(scratch), '-c', hazard], capture_output=True, text=True)
        assert refused.returncode != 0, 'the generated shim allowed the hazard through'
        assert 'sits inside a `python` payload' in refused.stderr, (
            'the payload was refused by the interpreter rather than by the guard: '
            f'{refused.stderr}'
        )
        assert 'exec-python.py' in refused.stderr

        clean = subprocess.run(
            [str(scratch), '-c', 'print(6 * 7)'], capture_output=True, text=True
        )
        assert clean.returncode == 0, clean.stderr
        assert clean.stdout.strip() == '42'

    def test_a_generated_shim_passes_arguments_through_untouched(self, tmp_path) -> None:
        # `exec "$REAL_PYTHON" "$@"` is the whole contract for every invocation that is
        # not a hazardous `-c`. A shim that dropped or reordered an argument would break
        # `python3 -m pytest`, which is how this repository's own gate runs.
        interpreter = installer.resolve_real_python(tmp_path)
        if interpreter is None:
            pytest.skip('no interpreter on PATH outside the shim home to exec')
        scratch = tmp_path / 'python3'
        scratch.write_text(installer._bash_source(interpreter, str(GUARD)))
        scratch.chmod(0o755)
        result = subprocess.run(
            [str(scratch), '-c', 'import sys; print("|".join(sys.argv[1:]))', 'a b', 'c'],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == 'a b|c'

    def test_the_self_test_passes(self, tmp_path) -> None:
        # The installer ships a `--self-test` so an operator can answer "did the install
        # work" in one command. A self-test that cannot fail is not a test, so this asserts
        # it against a real hazard inside the installer itself.
        result = subprocess.run(
            ['python3', str(INSTALLER), '--self-test', '--home', str(tmp_path / 'python3')],
            capture_output=True,
            text=True,
            timeout=120,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        assert 'self-test: ok' in result.stdout
