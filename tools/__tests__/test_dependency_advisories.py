#!/usr/bin/env python3
"""No resolved dependency may sit inside an advisory range this repository has fixed.

## The defect this file is written against

Six Dependabot alerts were open against `pnpm-lock.yaml` on 2026-11-01. Fixing them is a
lockfile edit, and a lockfile edit is the class of change nothing guards: `pnpm install`
re-resolves transitive versions whenever a range moves, `pnpm update <name>` re-resolves one
subtree, and a merge can take one side's resolution wholesale. Any of those can put
`js-yaml` back on 4.3.1 without touching a line of source, and no test in this repository
would have noticed -- the suite does not read the lockfile, and the code does not care which
patch of a development dependency it runs on.

The alerts themselves cannot be the guard: they live in GitHub's database, arrive days late,
and are not readable from a test. `tools/dependency-advisories.json` is the durable half --
the subset that applied to this lockfile, with the range verbatim from the advisory -- and
this file is the check that the lockfile never re-enters one.

## Why a range and not a floor

"At least the patched version" is the rule a human applies and it is wrong in a decidable
way: `source-map-js >= 1.0.0, < 1.2.2` says nothing about 0.9, and `brace-expansion
< 1.1.21` says nothing at all about 5.0.12, which is a different line entirely. A floor
would fail on a legitimate 0.9 pin and pass on a hypothetical 1.0.1 that the range
excludes. So the advisory range is stored as text and parsed, and the assertion is
membership.

## What is deliberately not checked

Whether the table is complete. A seventh advisory could be filed tomorrow and this file
would still be green, which is the honest limit of an offline check -- `pnpm audit` and
Dependabot answer that question, and both need the network. What this file guarantees is
that the six real fixes cannot silently regress.

## Why the parser refuses instead of guessing

The table is written by hand from an API response, so the failure mode to design against is
a range shape the parser half-understands: `>= 2.1.0-beta.7` is a prerelease bound,
`^1.2.3` is not a range this file handles, and a bare `1.2.3` is an exact pin. A parser that
treats an unknown operator as "probably fine" would report that a vulnerable version is
safe, which is worse than crashing. Each of those raises, and the test suite pins the
raising so a future contributor widening the parser has to do it on purpose.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
ADVISORIES = ROOT / "tools" / "dependency-advisories.json"
LOCKFILE = ROOT / "pnpm-lock.yaml"

# Operators the table may use. Anything else is a shape this file has not been taught, and
# the honest answer to an unknown shape is to stop rather than to call the version safe.
OPERATORS = (">=", "<=", "<", ">", "=")

_SEVERITIES = {"low", "moderate", "medium", "high", "critical"}
_GHSA = re.compile(r"^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$")


def _semver(text: str) -> tuple[tuple[int, int, int], tuple[tuple[int, object], ...]]:
    """Parse `X.Y.Z` or `X.Y.Z-pre`, with the prerelease as comparable identifiers.

    Build metadata (`+sha`) is refused rather than stripped: it never changes precedence, so
    silently dropping it would mean the parser had an opinion the caller did not ask for.
    """
    if "+" in text:
        raise ValueError(f"build metadata is not supported in an advisory range: {text!r}")
    core, _, pre = text.partition("-")
    parts = core.split(".")
    if len(parts) != 3 or not all(part.isdigit() for part in parts):
        raise ValueError(f"not a three-part version: {text!r}")
    identifiers: tuple[tuple[int, object], ...] = ()
    if pre:
        # A prerelease sorts BEFORE the release of the same core version, which is the one
        # rule from semver that matters here: `2.1.0-beta.7 < 2.1.0 < 2.1.9`.
        identifiers = tuple(
            (0, int(piece)) if piece.isdigit() else (1, piece) for piece in pre.split(".")
        )
    return (int(parts[0]), int(parts[1]), int(parts[2])), identifiers


def _compare(left: str, right: str) -> int:
    (lcore, lpre), (rcore, rpre) = _semver(left), _semver(right)
    if lcore != rcore:
        return -1 if lcore < rcore else 1
    if lpre == rpre:
        return 0
    if not lpre:
        return 1
    if not rpre:
        return -1
    return -1 if lpre < rpre else 1


def _range(spec: str) -> list[tuple[str, str]]:
    """Split `>= 2.1.0, < 4.1.11` into its comparators, refusing every other shape."""
    comparators: list[tuple[str, str]] = []
    for piece in spec.split(","):
        piece = piece.strip()
        if not piece:
            raise ValueError(f"empty comparator in {spec!r}")
        for operator in OPERATORS:
            if piece.startswith(operator):
                comparators.append((operator, piece[len(operator) :].strip()))
                break
        else:
            raise ValueError(f"unsupported operator in {piece!r}: expected one of {OPERATORS}")
    if not comparators:
        raise ValueError(f"no comparators in {spec!r}")
    return comparators


def contains(spec: str, version: str) -> bool:
    """Is `version` inside the advisory range `spec`?"""
    for operator, bound in _range(spec):
        order = _compare(version, bound)
        if operator == "<" and not order < 0:
            return False
        if operator == "<=" and not order <= 0:
            return False
        if operator == ">" and not order > 0:
            return False
        if operator == ">=" and not order >= 0:
            return False
        if operator == "=" and order != 0:
            return False
    return True


def resolved(lockfile_text: str) -> dict[str, set[str]]:
    """Every version the lockfile resolves, keyed by package name.

    Read from the `packages:` block rather than `snapshots:`, because snapshot keys carry the
    peer suffix -- `vitest@5.0.5(@types/node@22.20.1)(...)` -- and a parser that split on the
    first `@` after the name would answer "vitest resolves to 5.0.5(@types" on one line and
    the truth on another. The packages block is `name@version` and nothing else.
    """
    document = yaml.safe_load(lockfile_text)
    packages = document.get("packages") or {}
    found: dict[str, set[str]] = {}
    for key in packages:
        at = key.rfind("@")
        if at <= 0:
            raise ValueError(f"lockfile key has no version: {key!r}")
        name, version = key[:at], key[at + 1 :]
        found.setdefault(name, set()).add(version)
    return found


def load_advisories() -> list[dict]:
    return json.loads(ADVISORIES.read_text(encoding="utf-8"))["advisories"]


def violations(rows: list[dict], versions: dict[str, set[str]]) -> list[str]:
    """Every (row, resolved version) pair where the lockfile is inside the advisory."""
    found: list[str] = []
    for row in rows:
        present = versions.get(row["package"])
        if not present:
            found.append(
                f"{row['package']} is not in the lockfile at all; delete the {row['ghsa']} row "
                "with a message saying why the dependency went away"
            )
            continue
        for version in sorted(present):
            if contains(row["vulnerable"], version):
                found.append(
                    f"{row['package']} {version} is inside {row['ghsa']} ({row['severity']}): "
                    f"{row['vulnerable']} -- first patched {row['patched']}"
                )
    return found


class TestTheRangeParser:
    """The parser is the part that can quietly lie, so it is tested before it is trusted."""

    def test_a_bare_upper_bound_admits_everything_below_it(self) -> None:
        assert contains("< 1.1.21", "1.1.18")
        assert contains("< 1.1.21", "1.0.0")
        assert not contains("< 1.1.21", "1.1.21")
        assert not contains("< 1.1.21", "1.1.22")

    def test_a_two_sided_range_excludes_both_ends_correctly(self) -> None:
        # The 4.3.1 -> 4.3.2 fix, which is the row that had a lower bound worth respecting:
        # 3.5.0 is below `>= 4.0.0` and 5.5.0 is a different major line entirely.
        assert contains(">= 4.0.0, < 4.3.2", "4.3.1")
        assert not contains(">= 4.0.0, < 4.3.2", "4.3.2")
        assert not contains(">= 4.0.0, < 4.3.2", "3.5.0")
        assert not contains(">= 4.0.0, < 4.3.2", "5.5.0")

    def test_a_prerelease_bound_admits_the_release_it_precedes(self) -> None:
        # `>= 2.1.0-beta.7, < 4.1.12` is the @vitest/mocker row. 2.1.0 must be inside it: if
        # prerelease ordering were ignored, the bound would read as `>= 2.1.0` and 2.1.0-beta.9
        # -- which the advisory does cover -- would be reported safe.
        spec = ">= 2.1.0-beta.7, < 4.1.12"
        assert contains(spec, "2.1.0")
        assert contains(spec, "2.1.0-beta.7")
        assert contains(spec, "2.1.0-beta.9")
        assert not contains(spec, "2.1.0-beta.6")
        assert not contains(spec, "2.0.9")
        assert not contains(spec, "4.1.12")

    def test_a_caret_range_is_refused_rather_than_approximated(self) -> None:
        # `^1.2.3` means `>= 1.2.3, < 2.0.0`, and a parser that stripped the caret would read it
        # as `>= 1.2.3` -- reporting 2.5.0 as vulnerable when it is not, which is a false alarm,
        # and reporting nothing about 1.1.0, which is a false clearance. Both are worse than
        # stopping.
        with pytest.raises(ValueError, match="unsupported operator"):
            contains("^1.2.3", "1.2.4")

    def test_an_exact_pin_is_refused_too(self) -> None:
        # A bare version is a shape the table has never used. Accepting it as `=` would make a
        # typo ("4.1.11" with the `<` dropped) silently mean something much narrower than the
        # author intended, and the row would then clear every version it should catch.
        with pytest.raises(ValueError, match="unsupported operator"):
            contains("4.1.11", "4.1.11")

    def test_build_metadata_is_refused_rather_than_stripped(self) -> None:
        with pytest.raises(ValueError, match="build metadata"):
            _compare("1.0.0+sha", "1.0.0")


class TestTheLockfile:
    """The real resolutions, and the proof that this check can fail."""

    def test_no_resolved_version_sits_inside_an_advisory(self) -> None:
        rows = load_advisories()
        versions = resolved(LOCKFILE.read_text(encoding="utf-8"))
        assert violations(rows, versions) == []

    def test_the_recorded_count_is_the_row_count(self) -> None:
        # The count is not decoration: a row quietly dropped from the table would leave its
        # package unguarded while everything stayed green, and the file's own header would
        # still claim the old number. `open` is what the API said on the date in `readAt`, and
        # the literal below is deliberate friction -- it is 8 rather than 6 because two more
        # alerts surfaced when the graph was re-evaluated after the first six were closed, so a
        # future change to the table has to touch this line and say which wave it belongs to.
        record = json.loads(ADVISORIES.read_text(encoding="utf-8"))
        assert record["source"]["open"] == len(record["advisories"]) == 8
        assert "dependabot/alerts" in record["source"]["endpoint"]

    def test_the_one_override_is_the_one_row_that_needed_it(self) -> None:
        # `mechanism` is a field rather than a sentence, because the first version of this test
        # scanned `fixedBy` for the word "override" and matched the three rows that say "no
        # override" -- a substring search over prose, reading exactly the reassurance it was
        # supposed to police. The property asserted is that an override is an exception with a
        # reason and not a habit: if a second row acquires one, this line has to change too.
        rows = load_advisories()
        overrides = [row["package"] for row in rows if row["mechanism"] == "override"]
        assert overrides == ["minimatch"]
        assert {row["mechanism"] for row in rows} == {"in-range", "override"}

    def test_every_override_names_a_package_the_lockfile_still_resolves(self) -> None:
        # An override for a package nobody depends on any more is a pin that will silently stop
        # applying, so the row and the resolution are held together.
        versions = resolved(LOCKFILE.read_text(encoding="utf-8"))
        for row in load_advisories():
            if row["mechanism"] == "override":
                assert versions.get(row["package"]), row["package"]

    def test_a_version_below_the_patch_is_caught(self) -> None:
        # The check has to be able to fail, or it is a sentence about an intent. This is the
        # exact resolution the repository had before the upgrade.
        rows = [
            {
                "package": "js-yaml",
                "ghsa": "GHSA-2883-xcg3-v3hh",
                "severity": "high",
                "vulnerable": ">= 4.0.0, < 4.3.2",
                "patched": "4.3.2",
            }
        ]
        found = violations(rows, {"js-yaml": {"4.3.1"}})
        assert len(found) == 1
        assert "js-yaml 4.3.1" in found[0]
        assert "first patched 4.3.2" in found[0]

    def test_a_package_that_vanished_is_reported_rather_than_forgiven(self) -> None:
        # Removing a dependency is a legitimate fix and also a way to make a guard vacuous by
        # accident. The message names what to do, because the answer is a deleted row and a
        # sentence, not a silently smaller table.
        rows = [
            {
                "package": "some-removed-package",
                "ghsa": "GHSA-aaaa-bbbb-cccc",
                "severity": "medium",
                "vulnerable": "< 2.0.0",
                "patched": "2.0.0",
            }
        ]
        found = violations(rows, {"js-yaml": {"4.3.2"}})
        assert len(found) == 1
        assert "not in the lockfile at all" in found[0]

    def test_the_snapshot_peer_suffix_would_have_defeated_a_naive_parser(self) -> None:
        # A regression test for the parse itself: this is the shape `snapshots:` uses, and the
        # packages block must not be read the same way.
        text = LOCKFILE.read_text(encoding="utf-8")
        versions = resolved(text)
        assert "vitest" in versions
        for version in versions["vitest"]:
            assert re.fullmatch(r"\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?", version), version


class TestTheRecord:
    """The table is data a person wrote, so its own shape is asserted."""

    def test_every_row_names_a_real_advisory(self) -> None:
        for row in load_advisories():
            assert _GHSA.match(row["ghsa"]), row
            assert row["severity"] in _SEVERITIES, row
            assert row["cve"].startswith("CVE-"), row

    def test_every_row_carries_the_fix_that_retired_it(self) -> None:
        # `fixedBy` is what makes the table readable a year from now: without it the next
        # person has the range and no idea which upgrade satisfied it, and the temptation is
        # to re-derive it by downgrading.
        for row in load_advisories():
            assert row["fixedBy"].strip(), row

    def test_the_patched_version_is_outside_its_own_range(self) -> None:
        # A row whose `patched` is still inside `vulnerable` is internally inconsistent, and it
        # would send a reader to an upgrade that does not fix anything.
        for row in load_advisories():
            assert not contains(row["vulnerable"], row["patched"]), row

    def test_the_table_has_no_duplicate_rows(self) -> None:
        seen = [(row["package"], row["ghsa"]) for row in load_advisories()]
        assert len(seen) == len(set(seen))
