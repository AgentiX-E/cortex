"""The capability cell, and the claim a `0/6` makes about a system that answered 24 of 30.

## What this test exists for

Run `45096017960` printed the shipped arm's capability block as

    ABS   0/6 a6/6      IE   0/6 a4/6      KU   0/6 a5/6      MR   0/6 a4/6      TR   0/6 a5/6

beside its own row, which said `80.0% (24/30)`. The left half is `found/measured` -- retrieval -- and for a
self-answering system it is zero **by construction**: the product has no ranked-list endpoint, so `search` returns
`[]` and `found` cannot be anything else. Printing it states "found nothing" about an arm that answered 24 of the 30.

The recall columns of the table *above* that block already refuse this, in one line with its reason written
beside it (`score.answerer === 'self' ? '—' : pct(score.recallAtK)`). The capability block was added later and the
argument did not travel with it. So the property to pin is not "the cell looks right": it is that **the same rule
governs both places**, which is why the cell is now a function with a seam rather than six lines inside a printer
that needs a paid run to exercise.

## Why the assertions are strings and not numbers

The defect was a *rendering* claim, and the two halves are read at different times by different people: the recall
half is a pipeline property, the accuracy half is a result. A cell that collapses them (`6/6`) cannot be read at all,
which is why the retrieval-only and the read cases are asserted separately.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "report-render-smoke.mjs"


def cells() -> dict[str, str]:
    node = shutil.which("node")
    assert node is not None, "node is not on PATH"
    completed = subprocess.run(
        [node, str(FIXTURE)],
        cwd=REPO,
        env={"PATH": f"{Path(node).parent}:/usr/local/bin:/usr/bin:/bin", "HOME": str(Path.home())},
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout.strip().splitlines()[-1])


def test_a_self_answering_arm_prints_a_dash_where_its_recall_would_be() -> None:
    """The `0` was not a measurement. `— a6/6` says the reading was measured and the retrieval was not."""
    shown = cells()
    assert shown["selfAnswering"] == "— a6/6", shown


def test_a_retrieval_arm_keeps_both_halves() -> None:
    """The fix must not cost the ordinary row its retrieval count: `found` is real there."""
    shown = cells()
    assert shown["retrieval"] == "6/6 a5/6", shown


def test_an_unread_arm_prints_retrieval_alone() -> None:
    """`a0/0` would read as "answered nothing correctly", which is a different system from "was not read"."""
    shown = cells()
    assert shown["retrievalOnly"] == "2/6", shown


def test_a_family_the_arm_was_not_asked_about_is_a_dash() -> None:
    shown = cells()
    assert shown["missingFamily"] == "—", shown


def test_a_score_with_no_capability_breakdown_does_not_throw() -> None:
    """The table is written after the run; a cell that threw would lose the arms that did produce numbers."""
    shown = cells()
    assert shown["noCapability"] == "—", shown


def test_the_footer_names_the_reader_that_ran_and_not_a_constant() -> None:
    """The run whose table is graded said `reader/judge=none`; both were `deepseek-chat` in its own JSON."""
    shown = cells()
    assert "reader=deepseek-chat (chain-of-note/con, temp=0, one request)" in shown["readingFooter"], shown
    assert "judge=deepseek-chat (official per-type templates, temp=0)" in shown["readingFooter"], shown
    assert "none" not in shown["readingFooter"], shown
    # What the reading stage adds over a retrieval-only run of the same arms: the fields a reader must account for
    # before placing these numbers beside the retrieval table.
    assert "differs in reader, judge, judgePolicy" in shown["readingFooter"], shown


def test_the_footer_of_a_retrieval_only_stage_says_so() -> None:
    """The line still has to be true in the other direction, or it is only a correction rather than a rule."""
    shown = cells()
    assert "reader=none, judge=none" in shown["retrievalFooter"], shown
    assert "differs in nothing" in shown["retrievalFooter"], shown
