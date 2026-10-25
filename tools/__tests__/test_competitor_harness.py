"""The competition harness on a real-shaped corpus, and the one property that separates the two gold paths.

## Why this file exists

`tools/competitor-harness.mjs` has two datasets. On the synthetic one the gold is *derived* — "the context
turns that state the expected answer" — which is true by construction for a generated corpus and false for a
real one. On the LongMemEval path the gold is *annotated*: `answer_session_ids`, resolved by the loader into
`Question.goldTurns`.

Those two are not interchangeable, and the difference is invisible in a score. It is visible in one field: a
question whose answer text does not appear verbatim in any turn is **unmeasurable** under derivation and
**measurable** under annotation. The fixture in `fixtures/longmemeval-sample.json` contains exactly such a
question (`ie-001`, whose answer is a locker combination discussed nowhere in the sessions), so the first test
below fails the moment the real path starts deriving its gold.

That is the whole argument for running a tool against a fixture rather than only against the corpus: the
corpus cannot tell you which branch you are on.

## Why subprocess and not an import

The tool is a script with top-level `await` and `process.exit`; its contract is what it prints. Testing the
printed table tests the thing a reader reads.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "competitor-harness.mjs"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "longmemeval-sample.json"


def run(*args: str) -> dict:
    """Run the harness with `--json` and return the parsed payload."""
    completed = subprocess.run(
        ["node", str(TOOL), "--json", *args],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(
            f"harness exited {completed.returncode}\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
        )
    return json.loads(completed.stdout)


def by_provider(scores: list[dict]) -> dict[str, dict]:
    return {score["provider"]: score for score in scores}


def test_real_path_uses_annotated_gold() -> None:
    """A question whose answer appears in no turn is still measurable, which only annotation can do."""
    payload = run("--data", str(FIXTURE), "--questions", "4")
    scores = payload["scores"]
    assert scores, "no provider rows"
    for score in scores:
        assert score["unmeasurable"] == 0, (
            f"{score['provider']} marked {score['unmeasurable']} question(s) unmeasurable; "
            "the real path must read goldTurns from answer_session_ids rather than deriving "
            "the gold from the answer text"
        )
        assert score["measured"] == 4


def test_real_path_names_the_dataset_and_its_provenance() -> None:
    payload = run("--data", str(FIXTURE), "--questions", "4")
    assert payload["config"]["dataset"] == "longmemeval/s/4"
    assert payload["config"]["reader"] == "none (retrieval only)"


def test_every_capability_in_the_file_is_represented() -> None:
    """The sampler rounds across capabilities, so a four-row file cannot sample into one capability."""
    payload = run("--data", str(FIXTURE), "--questions", "4")
    scores = by_provider(payload["scores"])
    cortex = scores["cortex-session"]
    assert set(cortex["byCapability"]) == {"IE", "MR", "TR", "KU"}


def test_subset_is_reproducible_from_the_file_and_the_count_alone() -> None:
    """Two runs must agree, or no later comparison against these numbers means anything."""
    first = run("--data", str(FIXTURE), "--questions", "4")
    second = run("--data", str(FIXTURE), "--questions", "4")
    assert first["scores"] == second["scores"]


def test_the_synthetic_path_is_untouched() -> None:
    """The default invocation still generates its corpus, so the archived synthetic readings stay comparable."""
    payload = run("--people", "2")
    assert payload["config"]["dataset"].startswith("synthetic/")
    # The synthetic generator emits no `goldTurns`, so some questions are legitimately unmeasurable there.
    assert by_provider(payload["scores"])["cortex-session"]["unmeasurable"] > 0


def test_the_adapter_declares_a_model_free_build() -> None:
    payload = run("--data", str(FIXTURE), "--questions", "4")
    scores = by_provider(payload["scores"])
    assert scores["cortex-session"]["build"] == "none"
    assert scores["lexical-reference"]["build"] == "none"


def test_both_granularity_arms_are_on_the_table() -> None:
    """A granularity claim that is not measured beside the shipped rule on one corpus is a preference."""
    payload = run("--data", str(FIXTURE), "--questions", "4")
    names = {score["provider"] for score in payload["scores"]}
    assert "cortex/whole-8t" in names, names
    assert any(name.startswith("cortex/trim-") for name in names), names


def test_a_tiny_token_budget_actually_bounds_the_context() -> None:
    """`--budget-tokens` has to reach the plan: a budget that does not bound anything is a recorded no-op."""
    payload = run("--data", str(FIXTURE), "--questions", "4", "--budget-tokens", "120")
    priced = next(s for s in payload["scores"] if s["provider"].startswith("cortex/trim-"))
    assert priced["meanContextChars"] <= 120 * 4, priced["meanContextChars"]
    # And a tiny budget must still return something: an empty context answers every question from nothing.
    assert priced["empty"] == 0


def test_the_cost_column_is_reported_for_every_provider() -> None:
    """The only axis on which a vendor figure can be set beside ours."""
    payload = run("--data", str(FIXTURE), "--questions", "4")
    for score in payload["scores"]:
        assert isinstance(score["meanContextChars"], (int, float))
        assert score["meanContextChars"] >= 0


def test_an_unknown_reader_mode_is_rejected() -> None:
    """A mode the reader does not implement must fail, not fall back to the control.

    A silent fallback would produce a run whose artifact names `dispatch` and whose prompts were `con` -- the
    recorded-configuration defect this repository has already been audited for twice.
    """
    completed = subprocess.run(
        ["node", str(TOOL), "--read", "--reader", "bogus"],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    assert completed.returncode != 0
    assert "must be 'con', 'dispatch' or 'dispatch2'" in completed.stderr


def test_json_survives_a_pipe_whose_reader_is_slow() -> None:
    """A payload over the pipe buffer must come out whole.

    `process.exit` does not wait for stdout to drain, so the tool truncated its own JSON whenever the payload
    exceeded the kernel pipe buffer and the reader was not already draining it. Measured before the fix: a
    73,480-byte payload arrived as exactly 65,536 bytes — the pipe buffer, not a coincidence — and every
    downstream reader saw a document that stopped mid-string rather than an error.

    Two details make this a test rather than a hope. The payload has to exceed 64 KiB, or the whole thing fits in
    the buffer and the exit is harmless. And the reader has to be **slow**, because a reader that drains
    immediately keeps the buffer empty and the race goes the other way — which is why the bug survived until a
    tool started piping this output, and why the earlier version of this test passed on the broken code.
    """
    command = f"node {TOOL} --json --people 20 | (sleep 0.5; cat)"
    completed = subprocess.run(
        ["sh", "-c", command],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    assert len(completed.stdout) > 65536, (
        f"output was {len(completed.stdout)} bytes; a payload inside the pipe buffer cannot detect the truncation"
    )
    # `json.loads` is the assertion: a truncated document raises here rather than being read as a smaller run.
    payload = json.loads(completed.stdout)
    assert len(payload["scores"]) > 0


def test_the_floor_stays_at_zero() -> None:
    """A comparison whose bottom row is not zero is measuring arithmetic."""
    payload = run("--data", str(FIXTURE), "--questions", "4")
    floor = by_provider(payload["scores"])["null-floor"]
    assert floor["recallAtK"] == 0
    assert floor["recallAllAtK"] == 0
    assert floor["mrr"] == 0


def test_a_malformed_corpus_is_rejected_rather_than_scored(tmp_path: Path) -> None:
    """A JSON object where an array was expected must fail loudly, not produce an empty table."""
    broken = tmp_path / "broken.json"
    broken.write_text('{"not": "an array"}', encoding="utf-8")
    completed = subprocess.run(
        ["node", str(TOOL), "--json", "--data", str(broken)],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    assert completed.returncode != 0
    assert "JSON array" in completed.stderr


if __name__ == "__main__":
    sys.exit(subprocess.call(["pytest", "-q", __file__]))
