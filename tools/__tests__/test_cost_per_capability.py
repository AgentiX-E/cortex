"""Tests for `tools/cost-per-capability.mjs`, the CLI over the per-capability join.

The library's own tests live in `packages/cortex-eval/src/__tests__/cost-per-capability.test.ts`
and run under vitest with the package's coverage gate. These tests are about the **caller**: the
arguments it accepts, the two refusals it must not invent, and the one number it adds that the
library does not print (the reconstructed bill, which is how the apportionment is checked against
the artifact's own ledger).

  - **an unrecognised argument is not a default.** The dispatch path's parser refuses for the same
    reason: a typo that silently runs the intended thing is a typo nobody fixes.
  - **`--no-prices` is a reading, not a failure.** The token columns survive a price change and the
    money columns do not, so the flag has to keep working — and it must still name the expensive
    capability, because that verdict is graded on tokens.
  - **the library's refusal is quoted, not replaced.** A wrapper that prints its own sentence for
    every failure has thrown away the only part that says what to change.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools" / "cost-per-capability.mjs"

SHAPE = [
    ("ABS", 30, 23_099, 30),
    ("IE", 150, 22_981, 141),
    ("KU", 72, 23_084, 63),
    ("MR", 121, 48_311, 101),
    ("TR", 127, 47_841, 121),
]


def artifact(**overrides) -> dict:
    """A report carrying `42533236864`'s character and correctness shape."""
    questions, prompts, correct, masks = [], [], [], ["", "", "", ""]
    for capability, count, chars, hits in SHAPE:
        for index in range(count):
            questions.append({"capability": capability})
            prompts.append("x" * chars)
            ok = index < hits
            correct.append(ok)
            for repetition in range(4):
                masks[repetition] += "1" if ok else "0"
    report = {
        "runs": 4,
        "usageBySide": {
            "feature": {
                "calls": 2076,
                "unpricedCalls": 0,
                "promptTokens": 18_401_041,
                "completionTokens": 2_224_170,
                "cacheHitPromptTokens": 17_998_245,
            }
        },
        "questions": questions,
        "ablation": {
            "runs": 4,
            "featureCorrect": correct,
            "featureCorrectByRun": masks,
            "featurePromptTexts": prompts,
        },
    }
    report.update(overrides)
    return report


def run(tmp_path, report, *args):
    path = tmp_path / "report.json"
    path.write_text(json.dumps(report))
    return subprocess.run(
        ["node", str(TOOL), "--report", str(path), *args],
        capture_output=True,
        text=True,
        check=False,
        cwd=ROOT,
    )


def test_table_names_mr_as_the_most_expensive_per_correct_answer(tmp_path):
    completed = run(tmp_path, artifact())
    assert completed.returncode == 0, completed.stderr
    assert "most expensive per correct answer, on prompts: MR" in completed.stdout
    # TR shares MR's window and is therefore expensive too; IE, KU and ABS are not.
    assert "at or above 2x the cheapest: MR, TR" in completed.stdout


def test_prompt_ratio_is_the_measured_axis_and_money_ratio_is_flatter(tmp_path):
    completed = run(tmp_path, artifact())
    rows = {}
    for line in completed.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 11 and parts[0] in {"ABS", "IE", "KU", "MR", "TR"}:
            rows[parts[0]] = parts
    prompt = {name: float(cells[-1].rstrip("x")) for name, cells in rows.items()}
    money = {name: float(cells[-3].rstrip("x")) for name, cells in rows.items()}
    # The prompt column is a ratio of two measurements; the money column divides a completion half
    # that is apportioned by question-runs, so it is pulled toward the mean everywhere.
    assert prompt["MR"] == max(prompt.values())
    assert prompt["MR"] > 2
    assert prompt["ABS"] == 1.0
    for name in prompt:
        # A money ratio is the prompt ratio blended with the completion term, which is apportioned
        # by question-runs and is therefore 1.0 everywhere. It can never exceed the prompt ratio;
        # at two decimals the two tie on a row whose prompt ratio is already near 1.
        assert money[name] <= prompt[name] + 1e-9, name
    assert money["MR"] < prompt["MR"]
    assert money["MR"] == max(money.values())


def test_the_rows_reconstruct_the_artifact_bill(tmp_path):
    completed = run(tmp_path, artifact())
    assert "feature-side bill reconstructed from the rows: 11.078" in completed.stdout


def test_no_prices_keeps_the_token_columns_and_the_verdict(tmp_path):
    completed = run(tmp_path, artifact(), "--no-prices")
    assert completed.returncode == 0, completed.stderr
    assert "tok/correct" in completed.stdout
    assert "CNY/correct" not in completed.stdout
    assert "most expensive per correct answer, on prompts: MR" in completed.stdout
    assert "feature-side bill" not in completed.stdout


def test_json_round_trips_every_row(tmp_path):
    completed = run(tmp_path, artifact(), "--json")
    assert completed.returncode == 0, completed.stderr
    reading = json.loads(completed.stdout)
    assert [row["capability"] for row in reading["rows"]] == ["IE", "MR", "KU", "TR", "ABS"]
    assert reading["completionApportionment"] == "question-runs"
    assert reading["expensive"] == ["MR", "TR"]


def test_library_refusal_is_quoted_rather_than_replaced(tmp_path):
    report = artifact()
    report["ablation"].pop("featurePromptTexts")
    completed = run(tmp_path, report)
    assert completed.returncode == 2
    assert "no delivered prompt texts" in completed.stderr


def test_unrecognised_argument_is_refused(tmp_path):
    completed = run(tmp_path, artifact(), "--prcies")
    assert completed.returncode == 2
    assert "unrecognised argument --prcies" in completed.stderr


def test_missing_report_is_refused_before_reading(tmp_path):
    completed = subprocess.run(
        ["node", str(TOOL)],
        capture_output=True,
        text=True,
        check=False,
        cwd=ROOT,
    )
    assert completed.returncode == 2
    assert "--report <path> is required" in completed.stderr


def test_prices_file_is_read_when_given(tmp_path):
    prices = tmp_path / "prices.json"
    prices.write_text(
        json.dumps(
            {
                "cacheHitCnyPerMillion": 0.1,
                "cacheMissCnyPerMillion": 1,
                "outputCnyPerMillion": 1.5,
                "asOf": "2027-01-01",
                "model": "some-other-reader",
            }
        )
    )
    completed = run(tmp_path, artifact(), "--prices", str(prices))
    assert completed.returncode == 0, completed.stderr
    assert "some-other-reader at 2027-01-01" in completed.stdout
