"""`run-identity.mjs`, checked on hand-built identity records.

The tool exists because of a measured dispatch failure (§13.153.10): a run was issued against a branch
seven commits behind the mechanism, so the arm failed to parse a value it does not implement. The arm's
refusal is what made that cheap. Nothing in the *artifact* would have caught it, and that is the whole
point of this file --

    a control artifact's config block is what a stale-code run of a treatment would also print.

So identity has to be established from the commit, before an artifact is read, and this suite is written
against the three ways such a check rots:

  - **a check that says pass when it cannot see.** An absent `head_sha` is the exact state of a run that
    has not started, and it is also the state of every record whose field was renamed. Reporting `MATCH`
    there turns the gate into decoration, so `UNKNOWN` is a verdict with its own exit code.
  - **a check that reds on everything.** Every docs commit lands after a dispatch that was correct at the
    time. A gate that cannot distinguish "the number-bearing code moved" from "a paragraph moved" is a
    gate that gets ignored, and an ignored gate is worse than none because it is still cited.
  - **a check that compares SHAs.** This repository is pushed through the Git Data API, which re-roots the
    same paths into a new tree object, so the local commit SHA and the remote commit SHA differ for
    byte-identical content (`push-via-api.py` verifies the content for exactly this reason). A SHA
    comparison would therefore report `MISMATCH` on every correct dispatch.

The last case is the one that decides the shape: identity here is **content**, and the verdict names the
paths that differ so a reader can see which side of the number-bearing line they fall on.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "run-identity.mjs"


def run_object(head_sha: str | None = "47ca9678bcc5c5254d2e1e3ee92e83919dd17b43") -> dict:
    body = {"id": 40984213349, "status": "completed", "conclusion": "success"}
    if head_sha is not None:
        body["headSha"] = head_sha
    return body


def record(
    expected: dict[str, str],
    actual: dict[str, str],
    *,
    head_sha: str | None = "47ca9678bcc5c5254d2e1e3ee92e83919dd17b43",
) -> dict:
    return {"run": run_object(head_sha), "expected": expected, "actual": actual}


def run_record(tmp_path: Path, body: dict, *, name: str = "identity.json") -> subprocess.CompletedProcess:
    path = tmp_path / name
    path.write_text(json.dumps(body), encoding="utf-8")
    return subprocess.run(
        ["node", str(TOOL), "--record", str(path)],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )


BASE = {  # every value is distinct, so a comparison that ignores values cannot pass by accident
    "packages/cortex-memory/src/prompt.ts": "aaaa1111",
    "packages/cortex-memory/src/memory.ts": "bbbb2222",
    ".github/workflows/benchmark-cortex-memory.yml": "cccc3333",
    "docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md": "dddd4444",
    "tools/window-wired.mjs": "eeee5555",
    "tools/__tests__/test_window_wired.py": "ffff6666",
}


def test_identical_content_is_a_match(tmp_path: Path) -> None:
    """The run executed this content. One verdict line, the exit code, and the commit it names."""
    completed = run_record(tmp_path, record(BASE, dict(BASE)))
    assert completed.returncode == 0, completed.stderr
    assert "verdict: MATCH" in completed.stdout
    assert "47ca967" in completed.stdout


def test_docs_that_landed_after_the_dispatch_do_not_red_the_gate(tmp_path: Path) -> None:
    """A paragraph cannot change a measured number, and a gate that reds on one is a gate nobody reads."""
    expected = dict(BASE, **{"docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md": "9999aaaa"})
    completed = run_record(tmp_path, record(expected, dict(BASE)))
    assert completed.returncode == 0, completed.stderr
    assert "verdict: CODE-SAME" in completed.stdout
    assert "docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md" in completed.stdout


def test_a_test_file_that_landed_after_the_dispatch_is_also_not_number_bearing(tmp_path: Path) -> None:
    """Tests gate a merge; they do not enter the run that produces the number."""
    expected = dict(BASE, **{"tools/__tests__/test_window_wired.py": "8888bbbb"})
    completed = run_record(tmp_path, record(expected, dict(BASE)))
    assert completed.returncode == 0, completed.stderr
    assert "verdict: CODE-SAME" in completed.stdout


def test_the_mechanisms_own_file_differing_is_a_mismatch(tmp_path: Path) -> None:
    """This is the §13.153.10 shape: the run's code does not contain the mechanism being priced."""
    expected = dict(BASE, **{"packages/cortex-memory/src/prompt.ts": "7777ffff"})
    completed = run_record(tmp_path, record(expected, dict(BASE)))
    assert completed.returncode == 1, completed.stdout
    assert "verdict: MISMATCH" in completed.stdout
    assert "packages/cortex-memory/src/prompt.ts" in completed.stdout


def test_the_workflow_file_is_number_bearing(tmp_path: Path) -> None:
    """The workflow decides which arm runs with which options, so it is configuration, not documentation."""
    expected = dict(BASE, **{".github/workflows/benchmark-cortex-memory.yml": "6666eeee"})
    completed = run_record(tmp_path, record(expected, dict(BASE)))
    assert completed.returncode == 1, completed.stdout
    assert "verdict: MISMATCH" in completed.stdout


def test_a_missing_head_sha_is_refused_rather_than_passed(tmp_path: Path) -> None:
    """No commit named means the run cannot be identified, which is not the same as being identifiable."""
    completed = run_record(tmp_path, record(BASE, dict(BASE), head_sha=None))
    assert completed.returncode == 2, completed.stdout
    assert "verdict: UNKNOWN" in completed.stdout
    assert "verdict: MATCH" not in completed.stdout


def test_an_empty_expected_map_is_refused(tmp_path: Path) -> None:
    """An empty map would report every path as extra, which is a large diff and no diagnosis."""
    completed = run_record(tmp_path, record({}, dict(BASE)))
    assert completed.returncode == 2, completed.stdout
    assert "verdict: UNKNOWN" in completed.stdout


def test_an_empty_actual_map_is_refused(tmp_path: Path) -> None:
    """The run's tree could not be read. Reading that as "everything is missing" is not a verdict."""
    completed = run_record(tmp_path, record(dict(BASE), {}))
    assert completed.returncode == 2, completed.stdout
    assert "verdict: UNKNOWN" in completed.stdout


def test_a_path_present_only_in_the_run_is_named_as_extra(tmp_path: Path) -> None:
    """Content the checkout does not have is still content the run executed, and it is named."""
    actual = dict(BASE, **{"packages/cortex-core/src/extra.ts": "1234abcd"})
    completed = run_record(tmp_path, record(BASE, actual))
    assert completed.returncode == 1, completed.stdout
    assert "verdict: MISMATCH" in completed.stdout
    assert "packages/cortex-core/src/extra.ts" in completed.stdout


def test_a_path_present_only_in_the_checkout_is_named_as_missing(tmp_path: Path) -> None:
    """A file added after the dispatch is the ordinary case, and it still has to be named."""
    expected = dict(BASE, **{"packages/cortex-memory/src/new.ts": "abcd1234"})
    completed = run_record(tmp_path, record(expected, dict(BASE)))
    assert completed.returncode == 1, completed.stdout
    assert "packages/cortex-memory/src/new.ts" in completed.stdout


def test_a_truncated_tree_listing_is_refused(tmp_path: Path) -> None:
    """The API truncates above 100k entries. A partial listing compared as complete is a false MATCH."""
    body = record(BASE, {"truncated": True, "tree": [{"path": path, "type": "blob", "sha": sha} for path, sha in BASE.items()]})
    completed = run_record(tmp_path, body)
    assert completed.returncode == 2, completed.stdout
    assert "verdict: UNKNOWN" in completed.stdout


def test_a_raw_tree_listing_is_read_the_same_as_a_blob_map(tmp_path: Path) -> None:
    """Both shapes reach the tool: the API's listing, and the map a `git ls-tree` produces."""
    listing = {
        "truncated": False,
        "tree": [{"path": path, "type": "blob", "sha": sha} for path, sha in BASE.items()]
        + [{"path": "packages", "type": "tree", "sha": "0000000"}],
    }
    completed = run_record(tmp_path, record(listing, dict(BASE)))
    assert completed.returncode == 0, completed.stdout
    assert "verdict: MATCH" in completed.stdout


def test_a_subdirectory_is_a_tree_not_a_blob(tmp_path: Path) -> None:
    """Every directory would otherwise count as a path the other side is missing."""
    listing = {
        "truncated": False,
        "tree": [{"path": path, "type": "blob", "sha": sha} for path, sha in BASE.items()]
        + [{"path": "packages/cortex-memory/src", "type": "tree", "sha": "0000000"}],
    }
    completed = run_record(tmp_path, record(BASE, listing))
    assert completed.returncode == 0, completed.stdout
    assert "verdict: MATCH" in completed.stdout


def test_the_verdict_names_what_it_could_not_see(tmp_path: Path) -> None:
    """`UNKNOWN` covers two states, and the reason line distinguishes them for the operator."""
    completed = run_record(tmp_path, record(BASE, dict(BASE), head_sha=None))
    assert "reason:" in completed.stdout
    assert "head" in completed.stdout.lower()


def test_a_malformed_record_is_refused_rather_than_traced(tmp_path: Path) -> None:
    """A missing `expected` key is a caller error, and the operator needs one sentence, not a stack."""
    completed = run_record(tmp_path, {"run": run_object(), "actual": dict(BASE)})
    assert completed.returncode == 2, completed.stdout
    assert "verdict: UNKNOWN" in completed.stdout
    assert "Traceback" not in completed.stderr
    assert "at Object.<anonymous>" not in completed.stderr


def test_the_help_lists_the_three_verdicts(tmp_path: Path) -> None:
    """The exit codes are the interface a script reads, so they are documented where the tool is run."""
    completed = subprocess.run(
        ["node", str(TOOL), "--help"], cwd=REPO, capture_output=True, text=True, timeout=60, check=False
    )
    assert completed.returncode == 0, completed.stdout
    for verdict in ("MATCH", "CODE-SAME", "MISMATCH", "UNKNOWN"):
        assert verdict in completed.stdout


def test_no_identifier_here_collides_with_a_recorded_orphan() -> None:
    """A name is enough to retire an orphan, because the census matches whole words and parses no imports.

    `cortex-storage` exports `Refusal`, and the error class in this tool was called the same thing. The
    census counts a whole-word occurrence in any non-test repository file as a caller, so the file you are
    reading retired `cortex-storage: Refusal` from the report without importing anything: 394 recorded
    orphans became 393, and `export-census-gate.test.ts` failed on the missing one.

    The guard is on the code shape rather than on the raw text. A docblock that explains the collision has
    to be able to name the symbol it is warning about, and the census blanks comments for the same reason.
    """
    baseline = json.loads((REPO / "tools" / "export-census-baseline.json").read_text(encoding="utf-8"))
    names = {entry.split(": ", 1)[1] for entry in baseline["knownOrphans"] if ": " in entry}

    code_lines = []
    for line in TOOL.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith(("*", "//", "/*", "*/")):
            continue
        code_lines.append(re.sub(r"//.*$", "", line))
    code = "\n".join(code_lines)

    collisions = sorted(
        name
        for name in names
        if re.search(rf"(?<![A-Za-z0-9_$]){re.escape(name)}(?![A-Za-z0-9_$])", code)
    )
    assert collisions == [], f"these names are recorded orphans and appear as code in this tool: {collisions}"
