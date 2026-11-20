"""Tests for `tools/reader-cost-census.mjs`, the split of a run's spend into delivered and undelivered.

The tool answers constraint ⑰'s question -- *of the tokens this run spent, which part bought something the
reader used?* -- and it is worth reading only if four ways of being wrong are closed:

  - **dividing delivery by the wrong population.** `questions[]` holds the LAST pass's output and `llmUsage`
    holds every pass, so dividing characters by `runs` would spread one pass's text over four passes' tokens
    and understate the gap by the repetition count. The fixture below has two passes, so the wrong divisor
    produces a visibly different number.
  - **an undelivered share outside `[0, 1]`.** A run whose delivered text is longer than its completion count
    is an artifact whose sides disagree, not a run that saved tokens. The share is clamped, and a test that
    let it go negative would let the artifact publish a credit nobody earned.
  - **an absent side read as a zero.** A baseline that never reported usage is "not measured"; the feature's
    characters reused for it would be "measured as equal".
  - **a population that is empty and passes.** `0 of 0` reads as perfect delivery. The tool refuses an
    artifact with no computable feature side, and `--check` must fail on it.

The fixture is small enough to check by hand: one side of two calls over two passes, three questions of ten
characters each, and a completion count chosen so the arithmetic lands on round numbers.
"""

from __future__ import annotations

import json
import pathlib
import subprocess

REPO = pathlib.Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "reader-cost-census.mjs"

# 3.5 characters per token is the tool's own constant; the fixture is built so every expected number is exact
# at that value rather than rounded into agreement.
CHARS_PER_TOKEN = 3.5


def question(chars: int) -> dict:
    return {
        "questionId": f"q{chars}",
        "capability": "MR",
        "rawOutput": "x" * chars,
    }


def artifact(**fields) -> dict:
    """A two-pass artifact whose feature side billed 700 completion tokens over two calls."""
    base = {
        "dataset": "longmemeval-s",
        "questionCount": 3,
        "runs": 2,
        "questions": [question(10), question(10), question(10)],
        "usageBySide": {
            "feature": {
                "calls": 2,
                "unpricedCalls": 0,
                "promptTokens": 2_000,
                "completionTokens": 700,
                "cacheHitPromptTokens": 1_500,
                "answerChars": 30,
            },
            "baseline": {
                "calls": 4,
                "unpricedCalls": 0,
                "promptTokens": 400,
                "completionTokens": 40,
                "cacheHitPromptTokens": 200,
                "answerChars": 12,
            },
        },
    }
    base.update(fields)
    return base


def write(tmp_path: pathlib.Path, payload: dict, name: str = "artifact.json") -> pathlib.Path:
    path = tmp_path / name
    path.write_text(json.dumps(payload))
    return path


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", str(TOOL), *args],
        capture_output=True,
        text=True,
        cwd=REPO,
    )


def census_of(tmp_path: pathlib.Path, payload: dict) -> dict:
    out = tmp_path / "census.json"
    result = run(str(write(tmp_path, payload)), "--out", str(out))
    assert result.returncode == 0, result.stderr
    return json.loads(out.read_text())


class TestTheReading:
    def test_divides_delivered_text_by_questions_not_by_passes(self, tmp_path: pathlib.Path) -> None:
        # 30 characters over 3 questions is 10 per question. Over 2 passes it would be 15, and that divisor
        # is the defect this assertion exists to keep out: `rawOutputs[index]` is overwritten by each pass,
        # so the artifact holds one output per question while the bill covers both passes.
        reading = census_of(tmp_path, artifact())
        assert reading["feature"]["deliveredCharsPerCall"] == 10.0
        assert reading["delivered"]["counted"] == 3

    def test_prices_the_undelivered_part_against_the_billed_completion(self, tmp_path: pathlib.Path) -> None:
        # 700 completion tokens over 2 calls is 350 per call; 10 characters is 2.86 tokens at 3.5 chars/token,
        # so 347.14 are billed and not delivered -- 99.18%.
        reading = census_of(tmp_path, artifact())
        feature = reading["feature"]
        assert feature["completionTokensPerCall"] == 350.0
        assert feature["deliveredTokensPerCall"] == round(10 / CHARS_PER_TOKEN, 2)
        assert feature["undeliveredTokensPerCall"] == round(350 - 10 / CHARS_PER_TOKEN, 2)
        assert feature["undeliveredShare"] > 0.99

    def test_reports_the_cache_share_that_decides_whether_prompt_ordering_matters(
        self, tmp_path: pathlib.Path
    ) -> None:
        # 1,500 of 2,000 prompt tokens from the prefix cache. This is the quantity that prices a prompt
        # reordering, and it is a subset of the prompt rather than an addition to it.
        reading = census_of(tmp_path, artifact())
        assert reading["feature"]["cacheHitShare"] == 0.75
        assert reading["baseline"]["cacheHitShare"] == 0.5

    def test_prints_the_assumption_the_estimate_rests_on(self, tmp_path: pathlib.Path) -> None:
        # A precise-looking ratio computed from an unstated constant is worse than a coarse one that names
        # its own error, so the constant travels with the reading rather than staying in the source.
        reading = census_of(tmp_path, artifact())
        assert reading["charsPerToken"] == CHARS_PER_TOKEN
        rendered = run(str(write(tmp_path, artifact(), "again.json"))).stdout
        assert "3.5 chars/token" in rendered


class TestTheRefusals:
    def test_refuses_an_artifact_with_no_feature_side(self, tmp_path: pathlib.Path) -> None:
        # `0 of 0` would read as perfect delivery. An artifact that never split its spend cannot answer the
        # question at all, and `--check` is what makes that a failing gate rather than a blank line.
        path = write(tmp_path, artifact(usageBySide={"baseline": artifact()["usageBySide"]["baseline"]}))
        result = run(str(path), "--check")
        assert result.returncode == 1
        assert "NOT COMPUTABLE" in result.stdout

    def test_refuses_a_side_whose_counts_are_not_numbers(self, tmp_path: pathlib.Path) -> None:
        # A proxy that rewrote the block is not a run that spent nothing, which is the rule `usage.ts` states
        # one layer down for an absent `usage` block.
        broken = artifact()
        broken["usageBySide"]["feature"]["completionTokens"] = "n/a"
        result = run(str(write(tmp_path, broken)), "--check")
        assert result.returncode == 1
        assert "NOT COMPUTABLE" in result.stdout

    def test_leaves_the_baseline_delivery_unknown_rather_than_borrowing_the_features(
        self, tmp_path: pathlib.Path
    ) -> None:
        # The artifact keeps the feature's raw outputs and not the baseline's. Reporting the feature's
        # characters for the baseline would state a delivery nobody measured.
        reading = census_of(tmp_path, artifact())
        assert reading["baseline"]["calls"] == 4
        assert reading["baseline"]["deliveredCharsPerCall"] is None
        assert reading["baseline"]["undeliveredShare"] is None

    def test_clamps_a_delivered_text_longer_than_the_completion_it_was_billed_for(
        self, tmp_path: pathlib.Path
    ) -> None:
        # 2,000 characters per question against 350 completion tokens per call: the artifact's two sides
        # disagree, and a negative share would print as a credit. The clamp keeps the number in `[0, 1]`
        # without hiding the disagreement, which is visible in the two inputs.
        payload = artifact()
        payload["questions"] = [question(2_000), question(2_000), question(2_000)]
        reading = census_of(tmp_path, payload)
        assert reading["feature"]["undeliveredTokensPerCall"] == 0.0
        assert reading["feature"]["undeliveredShare"] == 0.0


class TestTheQuestionsItCounts:
    def test_counts_a_question_with_no_raw_output_as_missing_rather_than_as_zero_characters(
        self, tmp_path: pathlib.Path
    ) -> None:
        # A null output is a question whose answer was not captured, which is different from a question whose
        # answer was empty. A zero would pull the per-question divisor up by one and understate delivery.
        payload = artifact()
        payload["questions"] = [question(10), {"questionId": "qnull", "rawOutput": None}]
        reading = census_of(tmp_path, payload)
        assert reading["delivered"]["counted"] == 1
        assert reading["delivered"]["missing"] == 1
        assert reading["feature"]["deliveredCharsPerCall"] == 10.0

    def test_treats_an_absent_pass_count_as_one_rather_than_refusing_the_artifact(
        self, tmp_path: pathlib.Path
    ) -> None:
        # `runs` is a top-level field that older artifacts may not carry. The reading it feeds -- the divisor
        # for delivered text -- no longer depends on it, so a missing count cannot change any number here;
        # the field is still reported so a reader can see which artifact they are holding.
        payload = artifact()
        payload.pop("runs")
        reading = census_of(tmp_path, payload)
        assert reading["runs"] == 1
        # 30 characters over 3 questions, unchanged by the missing field: the divisor is the question count.
        assert reading["feature"]["deliveredCharsPerCall"] == 10.0
