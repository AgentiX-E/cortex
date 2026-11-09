"""Where the evidence budget actually binds: the depth curve, and the assumption it refutes.

The cost axis has 52% of headroom to Zep's 4,400 tokens and the obvious explanation was that the
budget cuts gold evidence the ranking had already found. That explanation is measurable from
`goldOverlap.goldRanks`, and it is wrong by a wide margin: 95.9% of gold turns are inside the
ranking's pool and 87.9% arrive at the reader. The binding constraint is **depth**: at K=20 the
ranking covers 51.5% of gold, so the budget cannot shrink without dropping answers, and shrinking it
anyway is what `A3`'s remaining 8% would buy.

These tests pin the arithmetic on hand-built ranks. The archived artifact is read by one smoke test,
because a curve that only works on the fixture is a curve nobody will trust on the next run.
"""

import json
import subprocess
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1] / "evidence-depth-curve.mjs"
CORPUS_DIR = Path("/workspace")


def _call(expr: str) -> object:
    script = (
        f"import {{ depthCurve, depthForCoverage, censusByCapability }} "
        f"from {json.dumps(TOOL.as_uri())};\n"
        f"process.stdout.write(JSON.stringify(({expr})));"
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


class TestDepthCurve:
    def test_depth_one_covers_only_rank_zero(self):
        # Three golds at ranks 0, 1 and 2: at depth 1 one of three is inside, at depth 3 all.
        payload = _call("depthCurve([0, 1, 2], [1, 3])")
        assert payload["total"] == 3
        assert payload["never"] == 0
        assert payload["coverage"] == {"1": 1 / 3, "3": 1}

    def test_a_rank_of_minus_one_is_never_covered_at_any_depth(self):
        # The ranking did not surface it, so no budget buys it. Counting it as coverage at a large
        # depth would let a widening experiment claim a recall it never had.
        payload = _call("depthCurve([0, -1], [1, 1000])")
        assert payload["never"] == 1
        assert payload["coverage"]["1000"] == 0.5

    def test_an_empty_census_has_no_coverage_rather_than_zero(self):
        # `null` and `0` are different statements: nothing was measured versus nothing was found.
        payload = _call("depthCurve([], [1])")
        assert payload["total"] == 0
        assert payload["coverage"]["1"] is None

    def test_duplicate_ranks_are_counted_once_per_gold(self):
        # Two golds inside the same turn is possible in an annotated set; the denominator is gold
        # turns, not distinct ranks, so both are covered at that depth.
        payload = _call("depthCurve([2, 2, 5], [3])")
        assert payload["coverage"]["3"] == 2 / 3


class TestDepthForCoverage:
    def test_returns_the_shallowest_depth_that_reaches_the_target(self):
        # Ranks 1, 2, 3, 4 of four golds: depth 2 covers 1/4, depth 3 covers 1/2, depth 4 covers 3/4.
        assert _call("depthForCoverage([1, 2, 3, 4], 0.5)") == 3
        assert _call("depthForCoverage([1, 2, 3, 4], 0.25)") == 2

    def test_an_unreachable_target_is_null_rather_than_the_pool_depth(self):
        # One gold is never surfaced, so 100% is unreachable however deep the pool goes. Returning
        # the pool size would report a depth that does not deliver the target.
        assert _call("depthForCoverage([0, -1], 1)") is None

    def test_a_reachable_target_equals_the_deepest_rank_not_the_pool(self):
        assert _call("depthForCoverage([0, 4, 9], 1)") == 10


class TestCensusByCapability:
    def test_carried_above_pool_is_reported_as_a_bypass_not_as_a_rate_above_one(self):
        # The multi-session route assembles whole sessions, so turns arrive that the ranking never
        # offered. `carried / pool` then exceeds 1 and reading it as a retention rate would report
        # 103% of something, which is the defect this field exists to refuse.
        records = [
            {
                "capability": "MR",
                "goldOverlap": {"total": 4, "carried": 4, "pool": 3, "goldRanks": [0, 1, 2, 5]},
            }
        ]
        payload = _call(f"censusByCapability({json.dumps(records)})")
        row = payload["MR"]
        assert row["kept"] is None
        assert row["bypassed"] == 1

    def test_a_clean_row_reports_recall_kept_and_end_to_end(self):
        records = [
            {
                "capability": "IE",
                "goldOverlap": {"total": 4, "carried": 2, "pool": 3, "goldRanks": [0, 1, -1, 5]},
            }
        ]
        row = _call(f"censusByCapability({json.dumps(records)})")["IE"]
        assert row["total"] == 4
        assert row["recall"] == 0.75
        assert row["kept"] == 2 / 3
        assert row["endToEnd"] == 0.5
        assert row["bypassed"] == 0

    def test_records_without_a_gold_account_are_excluded_rather_than_counted_as_zero(self):
        records = [
            {"capability": "IE", "goldOverlap": None},
            {"capability": "IE", "goldOverlap": {"total": 2, "carried": 2, "pool": 2, "goldRanks": [0, 1]}},
        ]
        row = _call(f"censusByCapability({json.dumps(records)})")["IE"]
        assert row["questions"] == 1
        assert row["total"] == 2


class TestArchivedArtifact:
    def test_the_reported_curve_matches_an_artifact_this_repository_archived(self):
        artifact = CORPUS_DIR / "art-42539923976" / "benchmark-cortex-memory-ablation-report.json"
        if not artifact.exists():
            import pytest

            pytest.skip("archived artifact is not present in this checkout")
        result = subprocess.run(
            ["node", str(TOOL), str(artifact)],
            capture_output=True,
            text=True,
            check=True,
        )
        # The finding the tool was written for: gold is almost entirely inside the pool, so the
        # budget is not what loses it, and shallow depths cover about half.
        assert "95.9%" in result.stdout or "96.0%" in result.stdout
        assert "ALL" in result.stdout
