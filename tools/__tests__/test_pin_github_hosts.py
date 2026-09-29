"""Tests for `tools/pin-github-hosts.py`.

This tool is the only working path to GitHub from this sandbox: the proxy admits
`api.github.com` and nothing else, so with a poisoned resolver every push, every
artifact fetch and every `git ls-remote` fails with a TLS error that looks like a
network outage. It had no tests and no CI coverage at all, which is how a defect
that makes it *silently stop working* went unnoticed.

The defect these tests were written for: the tool removed only lines carrying its
own `# doh-pin` marker, so any earlier pin written without the marker survived.
Two `A` records for one name is not a half-fix -- `getent` returns both and the
caller gets whichever it tries first, which produced intermittent
`gnutls_handshake() failed` on a host that resolved "fine".

The functions are imported rather than the CLI being driven, because the
behaviour under test is pure text transformation over a file path. The path is
injected so the tests never touch the real `/etc/hosts`; a test suite that edits
the sandbox's resolver is a test suite that can break the machine it runs on.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

TOOL = Path(__file__).resolve().parents[1] / "pin-github-hosts.py"


def _load():
    """Import the tool by path -- its filename is not a valid module name."""
    spec = importlib.util.spec_from_file_location("pin_github_hosts", TOOL)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["pin_github_hosts"] = module
    spec.loader.exec_module(module)
    return module


pin = _load()


BASE = """127.0.0.1\tlocalhost
::1\tlocalhost ip6-localhost ip6-loopback
172.24.0.1\tauth.proxy
"""


class TestStripPreviousPins:
    def test_removes_lines_carrying_the_marker(self):
        text = BASE + "20.205.243.168 api.github.com # doh-pin\n"
        assert pin.strip_previous_pins(text) == BASE

    def test_removes_an_unmarked_line_for_a_managed_host(self):
        # THE DEFECT. A pin written by hand, or by an earlier revision of this
        # tool before the marker existed. Leaving it in place makes the name
        # resolve to two addresses, and the caller's TLS session picks one.
        text = BASE + "140.82.112.6 api.github.com\n"
        assert pin.strip_previous_pins(text) == BASE

    def test_removes_both_marked_and_unmarked_lines_for_a_managed_host(self):
        # The real state of /etc/hosts when this was found: a stale hand-written
        # block AND the current marked block, four hosts each.
        text = (
            BASE
            + "140.82.112.6 api.github.com\n"
            + "140.82.112.3 github.com\n"
            + "20.205.243.168 api.github.com # doh-pin\n"
            + "20.205.243.166 github.com # doh-pin\n"
        )
        assert pin.strip_previous_pins(text) == BASE

    def test_keeps_unrelated_hosts(self):
        # The file belongs to the machine, not to this tool. A strip that removed
        # more than it wrote would take out `auth.proxy` and brick the sandbox.
        text = BASE + "1.2.3.4 example.com\n" + "20.205.243.168 api.github.com # doh-pin\n"
        assert pin.strip_previous_pins(text) == BASE + "1.2.3.4 example.com\n"

    def test_keeps_a_host_that_merely_shares_a_prefix(self):
        # `api.github.com.evil.example` is a different name. Matching on
        # substring rather than on the parsed name field would delete it, and a
        # deletion that is invisible in the diff is how a strip becomes a wipe.
        text = BASE + "1.2.3.4 api.github.com.evil.example\n"
        assert pin.strip_previous_pins(text) == text

    def test_keeps_a_managed_host_in_an_aliased_line(self):
        # `20.1.2.3 api.github.com alias` -- the name is still managed, so the
        # line goes. Kept in the suite because the parse must read the SECOND
        # field, and a fix that read the first would pass every test above.
        text = BASE + "20.205.243.168 api.github.com mirror-of-github # doh-pin\n"
        assert pin.strip_previous_pins(text) == BASE

    def test_is_idempotent(self):
        once = pin.strip_previous_pins(BASE + "140.82.112.6 api.github.com\n")
        assert pin.strip_previous_pins(once) == once

    def test_ignores_comments_without_touching_them(self):
        text = "# managed by pin-github-hosts.py\n" + BASE
        assert pin.strip_previous_pins(text) == text

    def test_preserves_a_trailing_newline_and_collapses_a_missing_one(self):
        # The file is rewritten wholesale, so a missing final newline would make
        # the next append land on the last line and corrupt it.
        assert pin.strip_previous_pins(BASE).endswith("\n")
        assert pin.strip_previous_pins(BASE.rstrip("\n")).endswith("\n")


class TestExistingPins:
    def test_reads_marked_pins_back(self):
        text = BASE + "20.205.243.168 api.github.com # doh-pin\n"
        assert pin.existing_pins(text) == {"api.github.com": ["20.205.243.168"]}

    def test_does_not_read_unmarked_lines_as_pins(self):
        # They are about to be stripped, so offering them as "previous" would
        # make `select` prefer an address the tool is deleting.
        text = BASE + "140.82.112.6 api.github.com\n"
        assert pin.existing_pins(text) == {}

    def test_collects_several_addresses_for_one_host(self):
        text = "20.205.243.168 api.github.com # doh-pin\n20.205.243.169 api.github.com # doh-pin\n"
        assert pin.existing_pins(text) == {"api.github.com": ["20.205.243.168", "20.205.243.169"]}

    def test_ignores_a_marked_line_with_no_name(self):
        # A truncated write. Reading it as a pin would produce a host named "".
        assert pin.existing_pins("20.205.243.168 # doh-pin\n") == {}

    def test_returns_empty_for_a_file_with_no_pins(self):
        assert pin.existing_pins(BASE) == {}


class TestResolutionShape:
    """The verification step, which is what failed to notice the defect."""

    def test_counts_every_non_comment_answer_for_a_name(self):
        # `getent hosts <name>` prints one line per answer. The old check asked
        # "is any address real?" and passed when ONE was; the property that
        # matters is "how many sources does this name have", so the counter has
        # to see all of them.
        output = "140.82.112.6  api.github.com\n20.205.243.168  api.github.com\n"
        assert pin.count_resolvers(output, "api.github.com") == 2

    def test_sees_one_source_when_there_is_one(self):
        assert pin.count_resolvers("20.205.243.168  api.github.com\n", "api.github.com") == 1

    def test_ignores_a_differently_named_line(self):
        output = "140.82.112.3  github.com\n20.205.243.168  api.github.com\n"
        assert pin.count_resolvers(output, "api.github.com") == 1

    def test_reports_zero_for_no_answer(self):
        assert pin.count_resolvers("", "api.github.com") == 0


class TestSyntheticDetection:
    def test_flags_the_rfc2544_range_the_hijack_used(self):
        # The measured address was 198.18.0.5. The whole /15 is reserved for
        # benchmarking and can never be a real GitHub address.
        assert pin.is_synthetic("198.18.0.5")
        assert pin.is_synthetic("198.19.255.254")

    def test_does_not_flag_a_real_address(self):
        assert not pin.is_synthetic("140.82.112.6")
        assert not pin.is_synthetic("20.205.243.168")

    def test_does_not_flag_the_boundary_just_outside_the_range(self):
        assert not pin.is_synthetic("198.17.255.255")
        assert not pin.is_synthetic("198.20.0.0")
