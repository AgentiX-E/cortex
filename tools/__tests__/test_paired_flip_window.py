#!/usr/bin/env python3
"""A sharded artifact's statistics are recomputed, and its windows are never pooled silently.

## Two defects this file is written against, and they were found one round apart

The first is arithmetic. `runAblation` writes `ablation.pValue`, `mcnemarPValue`, `delta`,
`effectSize` and both sides' metrics from the whole population. A sharded dispatch has no whole
population inside any one job, so the merge (`--merge-evidence`) drops all thirty-three of those
fields and says so in `notRecomputed`. That is correct -- a merge cannot compute a statistic over
data it has not seen -- and it left the campaign's only sharded instrument with **no test at all**:
`tools/paired-flip.mjs` read the masks, printed the gaps and the durable populations, and never asked
whether the asymmetry could be a coin flip. Two rows a reader orders by eye (`20` against `9` is
`p = 0.043`; `9` against `2` is `p = 0.065`) were therefore the same evidence.

The second is population. `CORTEX_WINDOWS = 2` asks each corpus twice so that a mechanism which moved
the second ask is readable beside a first ask that did not (`two-window.ts`). A pooled reading adds
the two together, so a delta that came entirely from the absorbing window and a delta that came from
neither are the same number. The reading therefore splits by window by default and refuses a window
it cannot find, because a filter that silently summarises nothing prints as a null result.

## What is asserted

1. the exact p-value is printed per repetition and equals two tails of `Binomial(b + c, 1/2)`;
2. a two-window artifact is split, and the split's counts add up to the pooled reading;
3. `--window N` narrows the whole reading, and the narrowed population is the window's own;
4. a window outside the artifact's range is refused with the range named, and `--window` on a
   single-window artifact is refused rather than ignored.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
import re
from math import comb
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools" / "paired-flip.mjs"


def _artifact(
    baseline: list[str], feature: list[str], ids: list[str], windows: int | None = None
) -> dict:
    """The smallest artifact `casesFrom` accepts: two masks and the questions they index."""
    report = {
        "ablation": {"baselineCorrectByRun": baseline, "featureCorrectByRun": feature},
        "questions": [
            {"questionId": name, "capability": "MR", "groundTruth": "3", "answer": "2"}
            for name in ids
        ],
    }
    if windows is not None:
        report["population"] = {"windows": windows, "corpora": len(ids) // windows, "marker": "#w"}
    return report


def _run(report: dict, *args: str) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "report.json"
        path.write_text(json.dumps(report), encoding="utf-8")
        return subprocess.run(
            ["node", str(TOOL), "--artifact", str(path), *args],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            check=False,
        )


def _counts(baseline: str, feature: str, index: list[int]) -> tuple[int, int]:
    """The discordant counts of one repetition, read off the masks rather than counted by hand."""
    only_baseline = sum(1 for i in index if baseline[i] == "1" and feature[i] == "0")
    only_feature = sum(1 for i in index if feature[i] == "1" and baseline[i] == "0")
    return only_baseline, only_feature


def _printed_p_values(stdout: str) -> list[float]:
    """Every p-value the tool printed, in order, from the bracketed per-repetition lists."""
    found: list[float] = []
    for group in re.findall(r"\[([0-9eE.,+\- ]+)\]", stdout):
        for part in group.split(","):
            part = part.strip()
            if part:
                found.append(float(part))
    return found


def _assert_printed(test: unittest.TestCase, printed: list[float], b: int, c: int) -> None:
    """The exact p is one of the numbers printed, to the four decimals the tool rounds to.

    Compared numerically rather than as a string: `0.03125` prints as `0.0313` from
    `Number.toFixed` and as `0.0312` from Python's `format`, and a test that pins the rounding
    convention is a test of `toFixed`.
    """
    expected = _exact(b, c)
    test.assertTrue(
        any(abs(value - expected) < 6e-5 for value in printed),
        f"no printed p-value matched {expected:.6f} (printed: {printed})",
    )


def _exact(b: int, c: int) -> float:
    """Two tails of `Binomial(b + c, 1/2)` at `min(b, c)`, computed the long way on purpose."""
    n = b + c
    if n == 0:
        return 1.0
    return min(1.0, 2 * sum(comb(n, i) for i in range(min(b, c) + 1)) / 2**n)


class PairedFlipReadsTheStatistics(unittest.TestCase):
    def test_the_p_value_is_printed_and_matches_the_exact_test(self) -> None:
        baseline, feature = "11111100", "00000000"
        report = _artifact([baseline], [feature], [f"q{i}" for i in range(8)])
        result = _run(report)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("exact p", result.stdout)
        only_baseline, only_feature = _counts(baseline, feature, list(range(8)))
        self.assertEqual((only_baseline, only_feature), (6, 0))
        _assert_printed(self, _printed_p_values(result.stdout), only_baseline, only_feature)

    def test_a_single_repetition_artifact_still_gets_a_test(self) -> None:
        baseline, feature = "1110", "0000"
        report = _artifact([baseline], [feature], ["a", "b", "c", "d"])
        result = _run(report)
        self.assertEqual(result.returncode, 0, result.stderr)
        only_baseline, only_feature = _counts(baseline, feature, [0, 1, 2, 3])
        _assert_printed(self, _printed_p_values(result.stdout), only_baseline, only_feature)

    def test_a_repetition_that_clears_the_bar_and_one_that_does_not_is_flagged(self) -> None:
        # The baseline wins six and loses none in repetition 0; in repetition 1 it wins three and
        # loses three, which is a coin flip.
        report = _artifact(
            ["111111" + "000", "111000" + "111"],
            ["000000" + "000", "000111" + "000"],
            [f"q{i}" for i in range(9)],
        )
        result = _run(report)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("NOT below 0.05 in every repetition", result.stdout)


class PairedFlipSplitsWindows(unittest.TestCase):
    def _two_window(self) -> dict:
        # Window 1 carries three baseline-only questions, window 2 carries one feature-only one.
        ids = ["a#w1", "b#w1", "c#w1", "d#w1", "a#w2", "b#w2", "c#w2", "d#w2"]
        # Three baseline-only questions in window 1, one feature-only question in window 2. The
        # pooled reading is three against one; neither window sees that number.
        baseline = ["1101" + "0000"]
        feature = ["0000" + "1000"]
        return _artifact(baseline, feature, ids, windows=2)

    def test_the_split_is_printed_and_adds_up_to_the_pooled_reading(self) -> None:
        result = _run(self._two_window())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("per window", result.stdout)
        self.assertIn("2 windows per corpus", result.stdout)
        report = self._two_window()
        baseline = report["ablation"]["baselineCorrectByRun"][0]
        feature = report["ablation"]["featureCorrectByRun"][0]
        printed = _printed_p_values(result.stdout)
        pooled = _counts(baseline, feature, list(range(8)))
        self.assertEqual(pooled, (3, 1))
        _assert_printed(self, printed, *pooled)
        first = _counts(baseline, feature, [0, 1, 2, 3])
        second = _counts(baseline, feature, [4, 5, 6, 7])
        self.assertEqual((first, second), ((3, 0), (0, 1)))
        _assert_printed(self, printed, *first)
        _assert_printed(self, printed, *second)

    def test_a_window_selection_reads_only_that_window(self) -> None:
        result = _run(self._two_window(), "--window", "1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("reading window 1 only", result.stdout)
        self.assertNotIn("per window", result.stdout)
        # Window 1 is four questions, not eight.
        self.assertRegex(result.stdout, r"MR\s+4\s")

    def test_a_window_outside_the_range_is_refused_with_the_range_named(self) -> None:
        result = _run(self._two_window(), "--window", "3")
        self.assertEqual(result.returncode, 2)
        self.assertIn("1..2", result.stderr)

    def test_a_window_flag_on_a_single_window_artifact_is_refused(self) -> None:
        report = _artifact(["1100"], ["0000"], ["a", "b", "c", "d"])
        result = _run(report, "--window", "1")
        self.assertEqual(result.returncode, 2)
        self.assertIn("one window per corpus", result.stderr)

    def test_ids_that_do_not_carry_the_marker_are_refused_rather_than_summarised(self) -> None:
        # `population.windows` says two, the ids say nothing: the filter would keep nothing, and a
        # summary of nothing prints as a null result.
        ids = ["a", "b", "c", "d"]
        report = _artifact(["1100"], ["0000"], ids, windows=2)
        result = _run(report, "--window", "1")
        self.assertEqual(result.returncode, 3)
        self.assertIn("empty population", result.stderr)


if __name__ == "__main__":
    unittest.main()
