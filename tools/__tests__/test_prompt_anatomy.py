"""The prompt anatomy, which turns a registered *measurement* into a `0` by construction.

§13.140.5 registered three predictions the first instrumented artifact would settle, and the middle one was "the
prefix-cache share of the prompt is under 5%", written as if the answer were a property of the provider. It is a
property of the **layout**: `buildPrompt` assembles `EVIDENCE:\\n...\\n\\nQUESTION: <q>\\n\\n<instruction>`, so the
prompt stops being question-independent after ten characters. A prefix cache matches a prefix.

What this file pins, and why each one is load-bearing:

1. **The order.** The tool's headline number ("the invariant prefix is the evidence header") is only a property
   of the renderer if the renderer puts evidence first. The tool throws when it does not, so a future reordering
   cannot leave the report arguing from a layout that no longer exists.
2. **The instruction is small.** 315–571 characters across the six contracts, against a ~46,851-character prompt.
   That is the entire prize a reordering could win, and printing it is what makes "is reordering worth a run?" a
   priced question rather than an opinion.
3. **Every ask renders.** A grid cell with an empty instruction would be an ask whose instructions `buildPrompt`
   silently drops, which is the inert-configuration shape §13.141 is about.

The numbers are asserted as *ranges* rather than values: they are properties of prose that may be edited, and a
test that pinned 315 would fail on a wording change that changed nothing about the argument.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "prompt-anatomy.mjs"

CONTRACTS = {
    "extractive",
    "abstention",
    "temporal",
    "assistant",
    "knowledge-update",
    "abstention-evidence-blocks",
}


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["node", str(TOOL), *args],
        cwd=REPO,
        capture_output=True,
        text=True,
        check=False,
    )


def grid(*args: str) -> dict:
    result = run("--json", *args)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_every_contract_and_ask_renders_an_instruction() -> None:
    body = grid()
    rows = body["rows"]
    assert len(rows) == len(CONTRACTS) * 11
    for row in rows:
        assert row["instruction"] > 0, row
        # The empty-evidence prompt is the instruction, the question line and the placeholder. A cell
        # whose total is under its instruction would mean the shell was measured as negative.
        assert row["total"] > row["instruction"], row


def test_the_invariant_prefix_is_the_evidence_header_and_nothing_else() -> None:
    # Ten characters: `EVIDENCE:` and its newline. If the renderer ever moves the instruction to the
    # front, this number changes and the §13.140.5 prediction stops being "0 by construction".
    for row in grid()["rows"]:
        assert row["prefixToday"] == len("EVIDENCE:\n"), row


def test_the_instruction_is_under_two_percent_of_a_real_prompt() -> None:
    # 46,851 is the median rendered prompt of the roster run, and 2% of it is 937 characters -- nearly
    # twice the largest block in the grid. The bound is loose on purpose: it is there to catch an
    # instruction that grew by an order of magnitude, not to pin prose.
    observed = 46_851
    for row in grid()["rows"]:
        assert row["instruction"] < 0.02 * observed, row


def test_reordering_could_only_ever_win_the_instruction_block() -> None:
    # The comparison the registration needs: the same prompt, two orders, and the ceiling on what the
    # second one could save. It is stated as a ratio so a reader can see that the prize is small.
    for row in grid()["rows"]:
        assert row["prefixIfReordered"] == row["instruction"], row
        assert row["prefixIfReordered"] > row["prefixToday"], row


def test_the_report_names_the_ask_under_test_and_the_full_grid() -> None:
    result = run("--ask", "derive", "--contract", "temporal")
    assert result.returncode == 0, result.stderr
    text = result.stdout
    assert "The ask under test: `derive`" in text
    assert "The rest of the grid" in text
    # The header row, the six cells of the ask under test, the separator and the two prefix rows.
    assert text.count("| `temporal` |") >= 1


def test_an_unrecognised_argument_is_refused_rather_than_ignored() -> None:
    result = run("--ask", "enumerated", "--budget", "48000", "--nonsense")
    assert result.returncode != 0
    assert "unrecognised argument" in result.stderr
