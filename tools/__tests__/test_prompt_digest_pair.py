"""The digest pair gate: `R0` is cheap, and that is the only reason it gets run before the accuracy.

## The failure this file is written against

`M1`'s registration (`PREREGISTRATION-CORTEX-MEMORY-ARM.md` §13.303) puts one check ahead of the number: all 500
`promptDigest` values must be identical between the two arms, or the accuracy comparison is between two packets
rather than between two readers. The cheap mistake is to read accuracy first — so the check has to be one command
whose answer is a table, and it has to fail loudly when it does not hold.

## Why the cases below are shaped like that

Every one of them is a way `R0` can be *true-looking*: a run that dropped the roster, a record that carries no
digest (an absent digest is not an identical one), a question that only one side has, a report whose roster was
reduced away. The tool's exit code is the gate, so each case asserts the code as well as the table.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "prompt-digest-pair.mjs"


def report(records: list[dict[str, Any]], reader: str | None = None) -> dict[str, Any]:
    document: dict[str, Any] = {"questions": records}
    if reader is not None:
        document["memoryArmConfig"] = {"reader": reader}
    return document


def record(question_id: str, digest: str | None, capability: str = "multi-session") -> dict[str, Any]:
    entry: dict[str, Any] = {"questionId": question_id, "capability": capability}
    if digest is not None:
        entry["promptDigest"] = digest
    return entry


def pair(tmp_path: Path, left: dict[str, Any], right: dict[str, Any]) -> tuple[int, dict[str, Any], str]:
    a = tmp_path / "a.json"
    b = tmp_path / "b.json"
    a.write_text(json.dumps(left))
    b.write_text(json.dumps(right))
    completed = subprocess.run(
        ["node", str(TOOL), "--a", str(a), "--b", str(b), "--json"], capture_output=True, text=True, timeout=120
    )
    parsed = json.loads(completed.stdout) if completed.stdout.strip() else {}
    return completed.returncode, parsed, completed.stderr


def test_five_hundred_identical_digests_pass() -> None:
    records = [record(f"q{index}", f"d{index}") for index in range(500)]
    import tempfile

    with tempfile.TemporaryDirectory() as directory:
        code, result, _ = pair(Path(directory), report(records, "deepseek:deepseek-flash"), report(records, "deepseek:deepseek-v4-pro"))
    assert code == 0
    assert result["holds"] is True
    assert result["compared"] == 500
    assert result["identical"] == 500
    # The pair describes itself: two different readers, one packet.
    assert result["a"]["reader"] == "deepseek:deepseek-flash"
    assert result["b"]["reader"] == "deepseek:deepseek-v4-pro"


def test_one_differing_digest_fails_and_names_the_capability() -> None:
    import tempfile

    left = [record("q0", "d0", "temporal"), record("q1", "d1", "temporal")]
    right = [record("q0", "d0", "temporal"), record("q1", "OTHER", "temporal")]
    with tempfile.TemporaryDirectory() as directory:
        code, result, _ = pair(Path(directory), report(left), report(right))
    assert code == 1
    assert result["holds"] is False
    assert result["differing"] == 1
    assert result["differingByCapability"] == {"temporal": 1}
    assert result["identical"] == 1


def test_an_absent_digest_is_not_an_identical_one() -> None:
    import tempfile

    left = [record("q0", "d0"), record("q1", "d1")]
    right = [record("q0", "d0"), record("q1", None)]
    with tempfile.TemporaryDirectory() as directory:
        code, result, _ = pair(Path(directory), report(left), report(right))
    assert code == 1
    assert result["b"]["unmeasured"] == ["q1"]
    assert result["compared"] == 1


def test_a_question_only_one_side_has_fails() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as directory:
        code, result, _ = pair(Path(directory), report([record("q0", "d0"), record("q9", "d9")]), report([record("q0", "d0")]))
    assert code == 1
    assert result["onlyInA"] == 1
    assert result["onlyInB"] == 0


def test_a_duplicated_question_id_fails_rather_than_being_counted() -> None:
    import tempfile

    left = [record("q0", "d0"), record("q0", "d0")]
    with tempfile.TemporaryDirectory() as directory:
        code, result, _ = pair(Path(directory), report(left), report([record("q0", "d0")]))
    assert code == 1
    assert result["a"]["duplicated"] == ["q0"]


def test_a_record_with_no_question_id_is_unmeasured() -> None:
    import tempfile

    left = [{"promptDigest": "d0"}, record("q1", "d1")]
    with tempfile.TemporaryDirectory() as directory:
        code, result, _ = pair(Path(directory), report(left), report(left))
    assert code == 1
    assert result["a"]["unmeasured"] == ["undefined"]


def test_the_roster_is_read_under_the_other_key_too() -> None:
    """One report calls it `questions`, the other may call it `records`; a gate that reads one key would compare
    nothing and say the digests match."""
    import tempfile

    left = {"records": [record("q0", "d0")]}
    right = {"questions": [record("q0", "d0")]}
    with tempfile.TemporaryDirectory() as directory:
        code, result, _ = pair(Path(directory), left, right)
    assert code == 0
    assert result["compared"] == 1


def test_a_reduced_report_is_a_usage_error_and_says_why() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as directory:
        a = Path(directory) / "a.json"
        b = Path(directory) / "b.json"
        a.write_text(json.dumps({"questions": [record("q0", "d0")]}))
        b.write_text(json.dumps({"evidenceReduction": {"dropped": True}}))
        completed = subprocess.run(
            ["node", str(TOOL), "--a", str(a), "--b", str(b)], capture_output=True, text=True, timeout=120
        )
    assert completed.returncode == 2
    assert "no per-question roster" in completed.stderr
    assert "reduced report" in completed.stderr


def test_unreadable_json_is_a_usage_error() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as directory:
        a = Path(directory) / "a.json"
        b = Path(directory) / "b.json"
        a.write_text("{not json")
        b.write_text(json.dumps(report([record("q0", "d0")])))
        completed = subprocess.run(
            ["node", str(TOOL), "--a", str(a), "--b", str(b)], capture_output=True, text=True, timeout=120
        )
    assert completed.returncode == 2
    assert completed.stderr.strip() != ""


def test_a_missing_argument_is_a_usage_error() -> None:
    completed = subprocess.run(["node", str(TOOL)], capture_output=True, text=True, timeout=120)
    assert completed.returncode == 2
    assert "usage:" in completed.stderr


def test_an_unknown_argument_is_refused() -> None:
    completed = subprocess.run(["node", str(TOOL), "--c", "x"], capture_output=True, text=True, timeout=120)
    assert completed.returncode == 2
    assert "unrecognised argument --c" in completed.stderr


def test_help_exits_zero() -> None:
    completed = subprocess.run(["node", str(TOOL), "--help"], capture_output=True, text=True, timeout=120)
    assert completed.returncode == 0
    assert "usage:" in completed.stdout


def test_the_table_reads_as_a_verdict_without_the_json() -> None:
    import tempfile

    records = [record("q0", "d0"), record("q1", "d1")]
    with tempfile.TemporaryDirectory() as directory:
        a = Path(directory) / "a.json"
        b = Path(directory) / "b.json"
        a.write_text(json.dumps(report(records, "deepseek:deepseek-flash")))
        b.write_text(json.dumps(report(records, "deepseek:deepseek-v4-pro")))
        passed = subprocess.run(
            ["node", str(TOOL), "--a", str(a), "--b", str(b)], capture_output=True, text=True, timeout=120
        )
        b.write_text(json.dumps(report([record("q0", "d0"), record("q1", "OTHER")])))
        failed = subprocess.run(
            ["node", str(TOOL), "--a", str(a), "--b", str(b)], capture_output=True, text=True, timeout=120
        )
    assert passed.returncode == 0
    assert "R0 holds" in passed.stdout
    assert "between two readers on one packet" in passed.stdout
    assert failed.returncode == 1
    assert "R0 FAILS" in failed.stdout
    assert "not a comparison between readers" in failed.stdout


def test_a_report_without_a_reader_field_says_unrecorded() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as directory:
        a = Path(directory) / "a.json"
        b = Path(directory) / "b.json"
        a.write_text(json.dumps(report([record("q0", "d0")])))
        b.write_text(json.dumps(report([record("q0", "d0")])))
        completed = subprocess.run(
            ["node", str(TOOL), "--a", str(a), "--b", str(b)], capture_output=True, text=True, timeout=120
        )
    assert completed.returncode == 0
    assert "(unrecorded)" in completed.stdout


def test_an_empty_roster_cannot_pass() -> None:
    """`0 of 0` matching is not `500 of 500` matching, and a gate that treated it as a pass would go green on a
    report whose roster was stripped."""
    import tempfile

    with tempfile.TemporaryDirectory() as directory:
        code, result, stderr = pair(Path(directory), {"questions": []}, {"questions": []})
    assert code == 2
    assert "no per-question roster" in stderr
    assert result == {}


def test_the_tool_is_wired_to_nodes_entry_guard_contract() -> None:
    """The module must not run its CLI on import: `index.mjs`-style importers pull tools in by path."""
    source = TOOL.read_text()
    assert "if (import.meta.url === `file://${process.argv[1]}`)" in source
    assert "export { compare, index, render, roster };" in source


def test_python_can_reach_the_exports() -> None:
    """The exports are the reason a Python tool can reuse the comparison instead of re-implementing it."""
    script = (
        "import {compare} from './tools/prompt-digest-pair.mjs';"
        "const r = compare({questions:[{questionId:'q',promptDigest:'d'}]},{records:[{questionId:'q',promptDigest:'d'}]});"
        "process.stdout.write(JSON.stringify({holds:r.holds,compared:r.compared}));"
    )
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", script], cwd=REPO, capture_output=True, text=True, timeout=120
    )
    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout) == {"holds": True, "compared": 1}


def test_the_usage_line_is_the_one_the_docstring_shows() -> None:
    source = TOOL.read_text()
    assert "node tools/prompt-digest-pair.mjs --a report-a.json --b report-b.json" in source
    assert sys.version_info.major == 3
