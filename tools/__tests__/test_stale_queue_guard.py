"""A round must not name a retracted mechanism as its queue head.

The real-document case is the point: for fifteen rounds the tracking report named
`resolution: raw` as the pending queue head even though RETRACTIONS.md §1 had closed
the C7 family on 2026-11-19. These tests pin that a queue head cannot name a
key the retraction ledger has already closed, unless the sentence acknowledges
the closure.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
GUARD = REPO / "tools" / "stale-queue-guard.mjs"


def run(report: Path, retractions: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "node", str(GUARD),
            "--report", str(report),
            "--retractions", str(retractions),
            "--check",
        ],
        cwd=REPO,
        capture_output=True,
        text=True,
    )


def write(tmp: Path, name: str, text: str) -> Path:
    path = tmp / name
    path.write_text(text, encoding="utf-8")
    return path


RETRACTIONS_WITH_KEY = """# Retractions

## 1. resolution layering (C7)

<!-- retracted: resolution -->

Closed on 2026-11-19 per the consequence table.
"""

RETRACTIONS_NO_MARKER = """# Retractions

## 1. resolution layering (C7)

Closed on 2026-11-19, but no machine-readable marker was written.
"""


def report_with(head_sentence: str, older: str = "") -> str:
    parts = []
    if older:
        parts.append(older)  # historical sections come first
    parts += [
        "### 231.1 direction",  # a round starts at `.1`; older sections come before it
        "### 231.5 six questions",  # the queue head lives in a non-final sub-section
        "5. **SOTA remaining path** " + head_sentence,
        "6. self-review: all gates green.",
        "### 231.6 verdict",  # a later sub-section must not hide the head from the guard
    ]
    return "\n".join(parts) + "\n"


def test_stale_queue_head_is_rejected(tmp_path: Path) -> None:
    """A queue head naming a retracted key must fail with the key in the message."""
    report = write(
        tmp_path, "stale.md",
        report_with("queue head `resolution: raw` ¥3.57/1.5h is pending."),
    )
    retractions = write(tmp_path, "r.md", RETRACTIONS_WITH_KEY)
    result = run(report, retractions)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "resolution" in (result.stdout + result.stderr).lower(), result.stdout + result.stderr


def test_acknowledged_closure_passes(tmp_path: Path) -> None:
    """Citing a retracted key is fine when the sentence says it is already closed."""
    report = write(
        tmp_path, "ack.md",
        report_with(
            "queue head `resolution: raw` is already closed (retracted, see §1); "
            "the pending item is a new registration."
        ),
    )
    retractions = write(tmp_path, "r.md", RETRACTIONS_WITH_KEY)
    result = run(report, retractions)
    assert result.returncode == 0, result.stdout + result.stderr


def test_quoted_stale_head_is_a_citation_not_a_plan(tmp_path: Path) -> None:
    """An audit describing the stale head quotes it; a quotation is not a queue head."""
    report = write(
        tmp_path, "audit.md",
        report_with(
            'the report wrote it as "queue head `resolution: raw` ¥3.57/1.5h (pending)" — now removed.'
        ),
    )
    retractions = write(tmp_path, "r.md", RETRACTIONS_WITH_KEY)
    result = run(report, retractions)
    assert result.returncode == 0, result.stdout + result.stderr


def test_unretracted_queue_head_passes(tmp_path: Path) -> None:
    """A key absent from the retraction ledger is a legitimate queue head."""
    report = write(
        tmp_path, "fresh.md",
        report_with("queue head `new-mechanism` ¥1/1h is pending."),
    )
    retractions = write(tmp_path, "r.md", RETRACTIONS_WITH_KEY)
    result = run(report, retractions)
    assert result.returncode == 0, result.stdout + result.stderr


def test_historical_sections_are_not_checked(tmp_path: Path) -> None:
    """Only the latest round's queue head is a plan; older rounds are history."""
    report = write(
        tmp_path, "history.md",
        report_with(
            "queue head `new-mechanism` is pending.",
            older=(
                "### 220.5 six questions\n"
                "5. **SOTA remaining path** queue head `resolution: raw` was pending then.\n"
            ),
        ),
    )
    retractions = write(tmp_path, "r.md", RETRACTIONS_WITH_KEY)
    result = run(report, retractions)
    assert result.returncode == 0, result.stdout + result.stderr


def test_missing_retraction_markers_fails_closed(tmp_path: Path) -> None:
    """A retraction ledger with no markers cannot be trusted; do not silently pass."""
    report = write(tmp_path, "any.md", report_with("queue head `new-mechanism` is pending."))
    retractions = write(tmp_path, "r.md", RETRACTIONS_NO_MARKER)
    result = run(report, retractions)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "marker" in (result.stdout + result.stderr).lower(), result.stdout + result.stderr


def test_real_documents_do_not_name_a_retracted_queue_head() -> None:
    """The actual tracking report must not repeat the fifteen-round stale head.

    This is the regression case: it fails on the unmodified documents (§231 still
    names `resolution: raw` as the queue head) and passes once §232 corrects it.
    """
    result = subprocess.run(
        ["node", str(GUARD), "--check"],
        cwd=REPO,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
