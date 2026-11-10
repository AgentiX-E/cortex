"""Tests for `tools/capability-ledger.py`, the arithmetic behind acceptance rows `S2`-`S5`.

Those four rows read `evidence/longmemeval/summary.json`, which is four independent dispatches of a
configuration that no longer ships. Re-hanging them on the arm's own artifact is not a matter of
pointing at a different file: `ablation.featureByCapability` carries `min / avg / max` across
repetitions, only `avg` is the repetition mean, and on the artifact this tool was written against
`min` and `max` read **three to four questions apart on the same population**. The tests below pin the
four things a plausible implementation gets wrong:

  - **the interval is on the wrong side of the mean.** Clopper-Pearson solves one equation at each end
    and both use `alpha/2`, not `alpha/2` and `1 - alpha/2`. The wrong target does not crash and does
    not produce a degenerate interval -- it produces an interval that does not contain the estimate,
    which is how this implementation shipped its first version. `test_lower_bound_is_below_the_estimate`
    is that bug.
  - **a repetition mean is not an integer count.** `MR` passes 99, 101, 104 and 102 of 121 and the mean
    is 101.5. An interval defined on integers has to be evaluated at the mean without rounding it,
    otherwise the four counts it came from are not bracketed by the interval that quotes them.
  - **a floor of zero.** `resolution` is `2.8016 * sqrt(p(1-p)/n)`, which returns exactly 0 at p = 1 --
    and `ABS` reads 30 of 30. Printing `0.00` says "this population resolves any difference", when the
    exact interval on 30 of 30 is `[88.43, 100]`. `None` is the reading; zero is a claim.
  - **provenance.** `--write` without `--run` must not produce a file: an evidence file that cannot
    name the artifact it came from is the failure `S1` already spent three rounds on.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from importlib import import_module

ledger_tool = import_module("capability-ledger")

REPO = pathlib.Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "capability-ledger.py"


def mask(ones: int, total: int) -> str:
    """A repetition mask with `ones` passes, in order. Which questions pass is irrelevant to a total."""
    return "1" * ones + "0" * (total - ones)


def report(
    capabilities: dict[str, list[int]],
    *,
    runs: int = 4,
    extra_runs: int = 0,
    sizes: dict[str, int] | None = None,
) -> dict:
    """An artifact shaped like the real one, with `capabilities` mapping a name to its per-run passes.

    `capabilities['MR'] = [99, 101, 104, 102]` and 121 questions is the published reading of
    `42355323615`, so the arithmetic in the docstring above is checkable against this fixture. `sizes`
    exists because the real denominators differ per capability -- 150 / 121 / 72 / 127 / 30 -- and a
    fixture that gives all five 121 questions cannot produce the 30-of-30 ceiling the abs row reads.
    """
    questions: list[dict] = []
    rows: list[list[int]] = [[] for _ in range(runs)]
    for name, per_run in capabilities.items():
        assert len(per_run) == runs
        total = (sizes or {}).get(name, 121)
        assert per_run[-1] <= total
        for index in range(total):
            questions.append({"questionId": f"{name}-{index}", "capability": name})
        for r in range(runs):
            rows[r].extend(1 if i < per_run[r] else 0 for i in range(total))
    feature = ["".join("1" if value else "0" for value in row) for row in rows]
    for _ in range(extra_runs):
        feature.append(feature[0])
    return {
        "questions": questions,
        "ablation": {"featureCorrectByRun": feature, "baselineCorrectByRun": feature},
    }


# ---- Clopper-Pearson against values a reader can look up ---------------------------------------


@pytest.mark.parametrize(
    "k,n,expected",
    [
        (5, 10, (0.187086, 0.812914)),
        (0, 10, (0.0, 0.308497)),
        (10, 10, (0.691502, 1.0)),
        (29, 30, (0.827830, 0.999156)),
        (1, 29, (0.000872, 0.177644)),
        (50, 100, (0.398321, 0.601679)),
    ],
)
def test_exact_interval_matches_the_table(k: int, n: int, expected: tuple[float, float]) -> None:
    lower, upper = ledger_tool.clopper_pearson(k, n)
    assert lower == pytest.approx(expected[0], abs=1e-5)
    assert upper == pytest.approx(expected[1], abs=1e-5)


def test_lower_bound_is_below_the_estimate() -> None:
    """The bug that shipped: the lower bound solved `P(X >= k) = 1 - alpha/2` and landed above the mean."""
    for n in (10, 30, 72, 121, 127):
        for k in range(0, n + 1):
            lower, upper = ledger_tool.clopper_pearson(k, n)
            estimate = k / n
            assert lower <= estimate + 1e-9, f"k={k} n={n}: lower {lower} above {estimate}"
            assert upper >= estimate - 1e-9, f"k={k} n={n}: upper {upper} below {estimate}"


def test_interval_narrows_as_the_denominator_grows() -> None:
    widths = []
    for n in (30, 72, 121, 127, 500):
        lower, upper = ledger_tool.clopper_pearson(0.84 * n, n)
        widths.append(upper - lower)
    assert widths == sorted(widths, reverse=True)


def test_repetition_mean_is_bracketed_without_rounding() -> None:
    """101.5 of 121 is evaluated at 101.5, not rounded to 101 or 102.

    The interval is defined on an integer count, so the continuous extension floors the count and reads
    the same tail mass. What must hold is that the mean is **inside** the interval quoted for it, and
    that the interval it gets is the one for the count below it rather than for the count above -- a
    choice, made here and asserted here so it cannot change silently.
    """
    mean_lower, mean_upper = ledger_tool.clopper_pearson(101.5, 121)
    assert mean_lower <= 101.5 / 121 <= mean_upper
    below = ledger_tool.clopper_pearson(101, 121)
    assert (mean_lower, mean_upper) == (below[0], below[1])
    above = ledger_tool.clopper_pearson(102, 121)
    assert mean_lower < mean_upper < above[1] + 1


def test_degenerate_inputs_are_refused() -> None:
    with pytest.raises(ValueError):
        ledger_tool.clopper_pearson(5, 0)
    with pytest.raises(ValueError):
        ledger_tool.clopper_pearson(-1, 10)
    with pytest.raises(ValueError):
        ledger_tool.clopper_pearson(11, 10)


# ---- the resolution floor -----------------------------------------------------------------------


def test_resolution_floor_is_the_published_arithmetic() -> None:
    """2.8016 * sqrt(0.839 * 0.161 / 121) = 9.36 points, the number that cancels a three-question mechanism."""
    assert ledger_tool.resolution_points(101.5 / 121, 121) == pytest.approx(9.36, abs=0.01)


def test_resolution_floor_is_none_at_a_ceiling() -> None:
    assert ledger_tool.resolution_points(1.0, 30) is None
    assert ledger_tool.resolution_points(0.0, 30) is None
    assert ledger_tool.resolution_points(0.5, 30) is not None


def test_resolution_floor_scales_as_the_inverse_root() -> None:
    """Four times the questions halves the floor. That is what makes the repetition count irrelevant: it
    divides the within-question variance, and `p(1-p)/n` is the between-question one."""
    wide = ledger_tool.resolution_points(0.84, 100)
    narrow = ledger_tool.resolution_points(0.84, 400)
    assert wide == pytest.approx(2 * narrow, rel=1e-9)


# ---- the masks the arithmetic reads -------------------------------------------------------------


def test_category_grouping_reproduces_the_published_reading() -> None:
    rows = ledger_tool.category_rows(report({"MR": [99, 101, 104, 102]}))
    assert rows["MR"]["denominator"] == 121
    assert rows["MR"]["perRun"] == [99, 101, 104, 102]
    assert rows["MR"]["mean"] == pytest.approx(101.5 / 121)
    assert rows["MR"]["perRunMax"] - rows["MR"]["perRunMin"] == pytest.approx(5 / 121)


def test_masks_that_do_not_index_the_questions_are_refused() -> None:
    broken = report({"MR": [99, 101, 104, 102]})
    broken["ablation"]["featureCorrectByRun"][0] = broken["ablation"]["featureCorrectByRun"][0][:-1]
    with pytest.raises(ValueError, match="covers 120 questions"):
        ledger_tool.masks_of(broken)


def test_a_mask_that_is_not_binary_is_refused() -> None:
    broken = report({"MR": [99, 101, 104, 102]})
    row = broken["ablation"]["featureCorrectByRun"][0]
    broken["ablation"]["featureCorrectByRun"][0] = "2" + row[1:]
    with pytest.raises(ValueError, match="not a pass/fail mask"):
        ledger_tool.masks_of(broken)


def test_a_missing_ablation_block_is_refused() -> None:
    with pytest.raises(ValueError, match="no ablation block"):
        ledger_tool.masks_of({"questions": [{"capability": "MR"}]})
    with pytest.raises(ValueError, match="featureCorrectByRun"):
        ledger_tool.masks_of({"questions": [{"capability": "MR"}], "ablation": {}})
    with pytest.raises(ValueError, match="no questions"):
        ledger_tool.masks_of({"questions": [], "ablation": {"featureCorrectByRun": ["0"]}})


def test_a_question_without_a_capability_is_refused() -> None:
    broken = report({"MR": [99, 101, 104, 102]})
    broken["questions"][7].pop("capability")
    with pytest.raises(ValueError, match="no capability"):
        ledger_tool.category_rows(broken)


def test_baseline_masks_of_a_different_width_are_refused() -> None:
    broken = report({"MR": [99, 101, 104, 102]}, extra_runs=0)
    broken["ablation"]["baselineCorrectByRun"] = broken["ablation"]["baselineCorrectByRun"][:2]
    with pytest.raises(ValueError, match="baseline has 2"):
        ledger_tool.masks_of(broken)


# ---- the file -----------------------------------------------------------------------------------


def test_the_file_names_its_run_and_its_denominators() -> None:
    built = ledger_tool.ledger(report({"MR": [99, 101, 104, 102]}), "42355323615")
    assert built["run"] == "42355323615"
    assert built["accuracySource"] == "repetition-mean"
    assert built["runs"] == 4
    assert built["categories"]["MR"]["denominator"] == 121
    assert built["pooled"]["denominator"] == 121
    assert built["pooled"]["mean"] == pytest.approx(101.5 / 121)
    assert "150 / 121 / 72 / 127 / 30" in built["grouping"]


def test_a_ledger_without_a_run_is_refused() -> None:
    with pytest.raises(ValueError, match="without the run id"):
        ledger_tool.ledger(report({"MR": [99, 101, 104, 102]}), "")


def test_capabilities_are_emitted_in_the_artifact_order() -> None:
    built = ledger_tool.ledger(
        report(
            {
                "ABS": [30, 30, 30, 30],
                "TR": [120, 122, 125, 121],
                "IE": [140, 144, 142, 142],
                "MR": [99, 101, 104, 102],
                "KU": [62, 65, 63, 65],
            },
            sizes={"ABS": 30, "TR": 127, "IE": 150, "KU": 72},
        ),
        "42355323615",
    )
    assert list(built["categories"]) == ["IE", "MR", "KU", "TR", "ABS"]


def test_render_prints_a_dash_for_a_ceiling_rather_than_zero() -> None:
    built = ledger_tool.ledger(report({"ABS": [30, 30, 30, 30]}, sizes={"ABS": 30}), "x")
    text = ledger_tool.render(built, False)
    line = next(entry for entry in text.splitlines() if entry.startswith("ABS"))
    assert "100.00%" in line
    assert line.rstrip().endswith("-")


# ---- the command line ---------------------------------------------------------------------------


def write(tmp_path: pathlib.Path, data: dict) -> pathlib.Path:
    path = tmp_path / "report.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(TOOL), *args], capture_output=True, text=True, check=False
    )


def test_write_requires_a_run_and_writes_nothing_without_one(tmp_path: pathlib.Path) -> None:
    artifact = write(tmp_path, report({"MR": [99, 101, 104, 102]}))
    target = tmp_path / "categories.json"
    result = run(str(artifact), "--write", str(target))
    assert result.returncode == 2
    assert "requires --run" in result.stderr
    assert not target.exists()


def test_write_produces_a_file_that_names_the_run(tmp_path: pathlib.Path) -> None:
    artifact = write(tmp_path, report({"MR": [99, 101, 104, 102]}))
    target = tmp_path / "categories.json"
    result = run(str(artifact), "--run", "42355323615", "--write", str(target))
    assert result.returncode == 0, result.stderr
    written = json.loads(target.read_text(encoding="utf-8"))
    assert written["run"] == "42355323615"
    assert written["categories"]["MR"]["passes"] == pytest.approx(101.5)


def test_the_table_and_the_file_agree(tmp_path: pathlib.Path) -> None:
    artifact = write(tmp_path, report({"MR": [99, 101, 104, 102]}))
    table = run(str(artifact), "--run", "42355323615")
    dumped = run(str(artifact), "--run", "42355323615", "--json")
    assert table.returncode == 0 and dumped.returncode == 0
    assert "83.88%" in table.stdout
    assert json.loads(dumped.stdout)["categories"]["MR"]["mean"] == pytest.approx(101.5 / 121)


def test_an_unreadable_artifact_exits_two(tmp_path: pathlib.Path) -> None:
    result = run(str(tmp_path / "absent.json"))
    assert result.returncode == 2
    assert "cannot read" in result.stderr


def test_a_malformed_artifact_exits_two_with_the_reason(tmp_path: pathlib.Path) -> None:
    artifact = write(tmp_path, {"questions": [{"capability": "MR"}]})
    result = run(str(artifact), "--run", "1")
    assert result.returncode == 2
    assert "no ablation block" in result.stderr
