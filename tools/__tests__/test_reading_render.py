"""The two tools that print an acceptance reading must print the same number.

`tools/acceptance-check.mjs` renders the matrix a person reads; `tools/docs-crosscheck.mjs` renders the
value a document is allowed to carry in a `<!-- reading:X -->` marker. They were two copies of one rule
until `C1` arrived with a mean for a value: the checker wrote `12105` and the cross-check wrote
`12104.99`, so whichever document a reader opened, the other one looked wrong — and the disagreement was
about the formatter, not about the measurement.

The tests below hold the two renders to one rule for every row this checkout can read, and they say
which rule: a `count` is a whole number. There is no fractional prompt token, and a mean quoted to two
decimals claims a precision the division does not have (24,209,976 / 2,000 is 12,104.988, which is
12,105 to any number of digits that means anything).

Every test skips rather than fails when the prerequisites are absent — no `node`, no built `dist`, no
sibling `cortex-docs` checkout — because a missing prerequisite is not a disagreement, and a test that
cannot tell the two apart gets deleted the first time CI is red for an unrelated reason.
"""

from __future__ import annotations

import json
import pathlib
import shutil
import subprocess

import pytest

REPO = pathlib.Path(__file__).resolve().parents[2]
DIST = REPO / "packages" / "cortex-eval" / "dist" / "acceptance.js"
CHECKER = REPO / "tools" / "acceptance-check.mjs"
CROSSCHECK = REPO / "tools" / "docs-crosscheck.mjs"


def _node() -> str:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed")
    if not DIST.exists():
        pytest.skip("packages/cortex-eval/dist is not built")
    return node


@pytest.fixture(scope="module")
def matrix() -> list[dict]:
    out = subprocess.run(
        [_node(), str(CHECKER), "--json"],
        capture_output=True, text=True, cwd=REPO, check=True,
    )
    return json.loads(out.stdout)


@pytest.fixture(scope="module")
def markers() -> dict[str, str]:
    """`id -> the text after the marker`, as the cross-check itself renders it."""
    out = subprocess.run(
        [_node(), str(CROSSCHECK), "--list"],
        capture_output=True, text=True, cwd=REPO, check=True,
    )
    rendered: dict[str, str] = {}
    for line in out.stdout.splitlines()[1:]:
        if not line.strip():
            continue
        # `id  value  status  <!-- reading:id -->value`
        _, _, _, tail = line.split(maxsplit=3)
        marker, _, shown = tail.partition("-->")
        rendered[marker.split(":")[1].strip()] = shown
    return rendered


class TestTheTwoRendersAgree:
    def test_every_row_the_checker_prints_is_in_the_cross_check(self, matrix, markers):
        # One list, two printers: a row missing from either is a row a document cannot cite.
        assert {row["id"] for row in matrix} == set(markers)

    def test_a_count_is_printed_as_a_whole_number_in_both(self, matrix, markers):
        counts = [row for row in matrix if row["unit"] == "count" and row["current"] is not None]
        assert counts, "no countable row has a value in this checkout, so the rule is untested"
        for row in counts:
            shown = markers[row["id"]]
            assert shown == f"{round(row['current']):d}", (
                f"{row['id']} renders as {shown!r} in the cross-check; a count is a whole number"
            )

    def test_the_cost_row_is_the_case_that_exposed_the_two_rules(self, matrix, markers):
        # `C1` is the row that arrived with a mean, and it is the only count whose value is not an
        # integer, so it is the only row that could have caught this by reporting a difference.
        cost = next(row for row in matrix if row["id"] == "C1")
        if cost["current"] is None:
            pytest.skip("the cost evidence file is not in this checkout")
        assert cost["current"] != round(cost["current"]), "the cost reading became an integer; retest"
        # The number itself is **not** pinned here, and this line is the reason: a literal in a test
        # is the same defect `C1` was written to remove from the documents -- a figure typed by hand
        # that agrees with the artifact only until the artifact is regenerated. It was `12105` while
        # the reading came from `42310779222` and `12137` once the evidence file was regenerated from
        # `42355323615`, and the only thing the change proved was that a test can go red for a reason
        # that is not a defect. What the rule needs pinned is the *relationship*: the marker equals
        # the rounded value, whatever the evidence file holds.
        assert f"{round(cost['current']):d}" == markers["C1"]

    def test_a_ratio_still_keeps_one_decimal_in_both(self, matrix, markers):
        # The rule being unified is about counts. A ratio rendered as an integer would round 83.45% to
        # 83% and lose the 0.45 that the whole S1 discussion turns on.
        ratios = [row for row in matrix if row["unit"] == "ratio" and row["current"] is not None]
        assert ratios
        for row in ratios:
            assert markers[row["id"]].endswith("%")
            assert len(markers[row["id"]].split(".")[-1]) == 2  # "83.5%": one decimal, one percent sign


class TestTheJsonDocumentSurvivesThePipe:
    def test_the_checker_writes_its_json_with_an_exit_code_rather_than_process_exit(self):
        # A write to a pipe is asynchronous in node, so `process.exit(0)` can terminate while the
        # `--json` document is still in flight: the exit code is right and the output is truncated
        # mid-string, which a consumer reports as malformed JSON rather than as a check that failed.
        # This was intermittent -- the document usually flushed in time -- and it surfaced here as an
        # occasional `Unterminated string` while every gate was passing.
        text = CHECKER.read_text()
        assert "process.exitCode = " in text
        # Comment lines are stripped first: the file explains this rule in prose, and a test that
        # forbade the string outright would forbid the explanation of why it is forbidden.
        code = "\n".join(
            line for line in text.splitlines() if not line.strip().startswith("//")
        )
        assert "process.exit(" not in code, (
            "an explicit exit can truncate a piped JSON document; set `process.exitCode` and let the "
            "process end when stdout drains"
        )

    def test_a_piped_document_parses(self):
        out = subprocess.run(
            [_node(), str(CHECKER), "--json"],
            capture_output=True, text=True, cwd=REPO,
        )
        assert out.returncode == 0, out.stderr[-400:]
        # Parsed rather than counted: the defect was a truncated string, which only a parse sees.
        assert len(json.loads(out.stdout)) > 0


class TestTheConfigurationAttestation:
    """A single-repository checkout must skip the registry check rather than fail it.

    This repository's CI checks out one repository, so every `cortex-docs/...` path is absent there and the
    five rows that read one print `unrun` for exactly that reason. The first version of the registry check
    treated an absent file as a defect, which made the check red on every push in CI and green only in a
    developer checkout with both repositories — a gate whose verdict depends on which machine ran it, which
    is the shape `AUDIT-B7-DEAD-SWITCH.md` records twice.

    The distinction the check has to keep is *absent* against *present and naming another configuration*:
    only the second is a defect, and the test below pins both sides so the skip cannot widen into a pass.
    """

    def test_an_absent_evidence_file_is_skipped_and_named(self, tmp_path: pathlib.Path) -> None:
        out = subprocess.run(
            [_node(), str(CHECKER), "--root", str(tmp_path)],
            capture_output=True,
            text=True,
            cwd=REPO,
        )
        assert out.returncode == 0, out.stdout + out.stderr
        assert "not in this checkout" in out.stdout
        assert "cortex-docs/evidence/longmemeval/frontier.json" in out.stdout
        assert "describe a configuration that is not registered" not in out.stdout

    def test_a_present_file_naming_another_configuration_fails(self, tmp_path: pathlib.Path) -> None:
        # The other direction, and the one that matters: a file that *is* here and names a configuration the
        # baseline does not is a defect even though every number in it is well formed. §13.336 is the case.
        evidence = tmp_path / "cortex-docs" / "evidence" / "longmemeval"
        evidence.mkdir(parents=True)
        (evidence / "frontier.json").write_text(json.dumps({"shipping": {"configurationFingerprint": "sha256:" + "0" * 64}}))
        (evidence / "categories.json").write_text(json.dumps({"configurationFingerprint": "sha256:" + "0" * 64}))
        out = subprocess.run(
            [_node(), str(CHECKER), "--root", str(tmp_path)],
            capture_output=True,
            text=True,
            cwd=REPO,
        )
        assert out.returncode == 1, out.stdout + out.stderr
        assert "describe a configuration that is not registered" in out.stdout
