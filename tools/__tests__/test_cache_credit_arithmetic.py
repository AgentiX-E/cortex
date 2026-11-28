"""Tests for `tools/cache-credit-arithmetic.mjs`, the prompt text behind the cache credit.

The tool prints two expectations: `position` over every prompt, and `content` over every prompt
**after the first** (there is no earlier prompt for the first one to share content with). A report
with a single question therefore has an empty `content` population, and a mean over an empty array
is not a measurement -- it is `NaN`. The two ways that leaks are a `NaN%` cell in the Markdown and a
silent `null` in JSON that reads like a refusal nobody wrote. Both must read as unavailable.
"""

from __future__ import annotations

import json
import pathlib
import subprocess

REPO = pathlib.Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "cache-credit-arithmetic.mjs"


def report(questions: list[dict]) -> dict:
    return {
        "questionCount": len(questions),
        "runs": 1,
        "questions": questions,
        "usageBySide": {
            "feature": {
                "calls": 1,
                "promptTokens": 1_000,
                "completionTokens": 100,
                "cacheHitPromptTokens": 500,
            }
        },
    }


def one_question() -> dict:
    return report(
        [{"questionId": "q1", "turns": [{"text": "a single delivered prompt"}]}]
    )


def two_questions() -> dict:
    return report(
        [
            {"questionId": "q1", "turns": [{"text": "the first delivered prompt"}]},
            {"questionId": "q2", "turns": [{"text": "the first delivered prompt, extended"}]},
        ]
    )


def write(tmp_path: pathlib.Path, payload: dict, name: str = "report.json") -> pathlib.Path:
    path = tmp_path / name
    path.write_text(json.dumps(payload))
    return path


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["node", str(TOOL), *args], capture_output=True, text=True, cwd=REPO)


class TestTheEmptyContentPopulation:
    def test_single_question_never_prints_nan(self, tmp_path: pathlib.Path) -> None:
        result = run("--report", str(write(tmp_path, one_question())))
        assert result.returncode == 0, result.stderr
        assert "NaN" not in result.stdout

    def test_single_question_marks_the_content_mean_unavailable(self, tmp_path: pathlib.Path) -> None:
        result = run("--report", str(write(tmp_path, one_question())), "--json")
        assert result.returncode == 0, result.stderr
        reading = json.loads(result.stdout)
        assert reading["content"]["mean"] is None
        assert reading["position"]["mean"] is not None

    def test_two_questions_still_prices_the_content_mean(self, tmp_path: pathlib.Path) -> None:
        # The guard must not fire on the normal case: one earlier prompt makes the population a one.
        result = run("--report", str(write(tmp_path, two_questions())), "--json")
        assert result.returncode == 0, result.stderr
        reading = json.loads(result.stdout)
        assert isinstance(reading["content"]["mean"], (int, float))
