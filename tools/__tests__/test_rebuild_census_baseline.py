#!/usr/bin/env python3
"""The rebuild tool must not edit the record it is supposed to preserve.

## The defect this file is written against

`tools/rebuild-export-census-baseline.py` regenerates every group's `rationale` from its own `RATIONALE`
dictionary. The ledger's prose is not the generator's prose: steps 13.x append a sentence each time an
entry joins or leaves, and those sentences are the only statement of *why* the number is what it is.

On 2026-10-30 that cost a paragraph. §13.149 had hand-appended an explanation of the
`cortex-memory: asksForCount` retirement; a rebuild run to record two new entries deleted it, and the only
evidence is a length: 9,982 characters to 9,472. It was restored from a pre-run copy. Nothing warned,
nothing failed, and `--check` passed both before and after — because the tool's own output was consistent
with itself.

## The rule this file holds

Three cases, and only the third is a refusal:

1. **No existing ledger** — write the generator's text.
2. **The ledger starts with the generator's text** — write the ledger's, unchanged, so every hand-added
   sentence survives. This is the case that failed.
3. **The two disagree some other way** — refuse, naming the group. That means the generator's own text was
   edited, so the hand-added sentences may now be duplicated, superseded or contradicted, and a human has
   to merge them. A tool that guesses here is a tool that quietly picks one.

No `--force`. The escape hatch would be used on the first inconvenient Tuesday and the defect would be back
with a flag in front of it. The manual merge is: edit `RATIONALE`, run the tool, read the diff.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools" / "rebuild-export-census-baseline.py"


def load():
    """Import the tool by path: the file name has dashes, so it is not an importable module name."""
    spec = importlib.util.spec_from_file_location("rebuild_census", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


GENERATED = "Evaluation harness internals. This bucket holds the orphans the census cannot resolve."


def test_a_first_rebuild_writes_the_generators_text() -> None:
    """No ledger yet: there is no record to protect."""
    assert load().merge_rationale("eval-harness-surface", GENERATED, None) == GENERATED


def test_an_unchanged_rationale_is_written_unchanged() -> None:
    """The ordinary rebuild: nothing to preserve, nothing to lose."""
    assert load().merge_rationale("eval-harness-surface", GENERATED, GENERATED) == GENERATED


def test_a_hand_appended_sentence_survives_a_rebuild() -> None:
    """The case that failed. A step wrote a paragraph; the next rebuild must not be able to delete it."""
    recorded = GENERATED + " `cortex-memory: asksForCount` LEFT this ledger when a tool imported it (13.149)."
    merged = load().merge_rationale("eval-harness-surface", GENERATED, recorded)
    assert merged == recorded
    assert "13.149" in merged


def test_a_rewritten_generator_text_is_refused_rather_than_merged() -> None:
    """The generator says something new, so the recorded sentences may now contradict it.

    A tool cannot decide which of two accounts of the same group is current, and picking one silently is
    how the paragraph was lost in the first place. The refusal names the group so the operator knows which
    of five paragraphs to read.
    """
    module = load()
    recorded = "An older account of this group, written before the generator's text changed."
    with pytest.raises(module.RationaleConflict) as raised:
        module.merge_rationale("eval-harness-surface", GENERATED, recorded)
    message = str(raised.value)
    assert "eval-harness-surface" in message
    assert str(len(GENERATED)) in message and str(len(recorded)) in message


def test_the_refusal_is_a_distinct_error_and_not_a_bare_exception() -> None:
    """It is caught and reported by `main`, so it has to be catchable by name."""
    module = load()
    assert issubclass(module.RationaleConflict, Exception)
    assert module.RationaleConflict is not Exception


def test_the_ledger_is_built_through_the_merge() -> None:
    """A wiring assertion, because the failure mode is `main` regenerating directly and passing every test.

    The three cases above hold for any caller. What failed was that `main` did not call one: it wrote
    `RATIONALE[name]` straight into the document. The check is on the source, the way
    `test_push_blobs.py` checks the order of verify-then-publish -- the property is about a call site this
    test cannot reach without running a census over the whole repository.
    """
    import re

    source = SCRIPT.read_text(encoding="utf-8")
    body = source.split("def main()", 1)[1]
    assert re.search(r"merged\[name\]\s*=\s*merge_rationale\(", body), (
        "main() must build every group's rationale through merge_rationale"
    )
    assert re.search(r'"rationale":\s*merged\[name\]', body), (
        "the ledger entry must take the merged value, not the generator's"
    )
    assert not re.search(r'"rationale":\s*RATIONALE\[', body), (
        "main() still reads RATIONALE directly, which is the defect this file is written against"
    )
