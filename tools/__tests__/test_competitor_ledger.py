"""`competitor-ledger.mjs`, checked on the real ledger and on five deliberate defects.

The tool answers one question -- may these two numbers be ordered? -- and the answer is a
five-tuple rather than a dataset. Every test here is a case where a plausible reading would get
that wrong:

  - **one dataset is not one comparison.** Two entries that share `LongMemEval-S` and nothing else
    are not comparable, and a ledger that lets them sit in one sorted table is the artifact this
    file exists to prevent.
  - **a spread is only a harness effect when the harness changed.** Mem0 at 93.4 and 94.4 is one
    author's two releases; Zep at 90.2 and 71.2 is two harnesses. Quoting the first as evidence
    that "the harness barely matters" is the error, and the tool has to label which is which.
  - **"the nearest comparable group" is usually several.** Picking one by map order makes the
    reported distance a property of the file's key ordering.
  - **an invalid ledger must not print tables.** A check that runs after the table has been printed
    is decoration; a reader who sees the table has already read it.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "competitor-ledger.mjs"
LEDGER = REPO / "tools" / "competitor-ledger.json"


def run(*args: str) -> "subprocess.CompletedProcess[str]":
    return subprocess.run(
        ["node", str(TOOL), *args], capture_output=True, text=True, check=False
    )


def entry(**overrides: object) -> dict:
    row = {
        "system": "someone",
        "score": 70.0,
        "dataset": "LongMemEval",
        "variant": "S",
        "answerModel": "gpt-x",
        "judge": "gpt-y",
        "harness": "their-harness",
        "kind": "self",
        "source": "a paper",
    }
    row.update(overrides)
    return row


def write_ledger(tmp_path: Path, entries: list[dict]) -> Path:
    path = tmp_path / "ledger.json"
    path.write_text(json.dumps({"entries": entries}), encoding="utf-8")
    return path


class TestTheRealLedger:
    def test_the_committed_ledger_passes_its_own_check(self) -> None:
        r = run("--check")
        assert r.returncode == 0, r.stdout + r.stderr
        assert "every group agrees with itself" in r.stdout

    def test_every_entry_carries_a_source(self) -> None:
        # The property, not the count: a table of numbers with no provenance is the thing the
        # check exists to refuse, and asserting the count would not notice a silent substitution.
        ledger = json.loads(LEDGER.read_text(encoding="utf-8"))
        for row in ledger["entries"]:
            assert row["source"].strip(), row
            assert row["harness"].strip(), row

    def test_zep_travels_across_at_least_two_harnesses(self) -> None:
        # A registered finding, pinned so that deleting the awkward reading cannot make the
        # ledger agree with itself more comfortably. Zep is on record at 90.2, 79.8 and 71.2.
        r = run("--json")
        data = json.loads(r.stdout)
        zep = [row for row in data["spreads"] if row["system"] == "Zep"]
        assert zep, "Zep must appear in the spread block"
        assert zep[0]["harnessCount"] >= 2
        assert zep[0]["spread"] >= 10, zep[0]

    def test_our_own_rows_are_excluded_from_the_spread_block(self) -> None:
        # Including them would compute a "spread" for a system measured once by one harness, which
        # is zero, and a zero in that column reads as "this system is stable across harnesses".
        r = run("--json")
        data = json.loads(r.stdout)
        assert not [row for row in data["spreads"] if row["system"].startswith("cortex")]


class TestTheFiveTuple:
    def test_a_judge_difference_is_not_absorbed_into_one_group(self, tmp_path: Path) -> None:
        # The stronger form of "judge is part of the tuple": the ledger does not quietly split them
        # into two quietly-sorted tables -- it refuses, because one harness name covering two
        # judges means the harness field is claiming a condition that does not exist.
        path = write_ledger(
            tmp_path,
            [entry(system="a", judge="prose"), entry(system="b", judge="citation")],
        )
        # On stderr, because stdout is where a table goes and a problem must not be mistaken for
        # one: `--check` reports to stdout and everything else refuses on stderr.
        r = run("--json", "--ledger", str(path))
        assert r.returncode == 1
        assert "disagree about judge" in r.stderr

    def test_an_answer_model_difference_is_not_absorbed_into_one_group(
        self, tmp_path: Path
    ) -> None:
        path = write_ledger(
            tmp_path, [entry(system="a", answerModel="gpt-4"), entry(system="b", answerModel="gpt-5")]
        )
        r = run("--json", "--ledger", str(path))
        assert r.returncode == 1
        assert "disagree about answerModel" in r.stderr

    def test_entries_that_agree_on_all_five_are_one_group(self, tmp_path: Path) -> None:
        path = write_ledger(tmp_path, [entry(system="a"), entry(system="b", score=80.0)])
        groups = json.loads(run("--json", "--ledger", str(path)).stdout)["groups"]
        assert len(groups) == 1
        (members,) = groups.values()
        assert [row["system"] for row in members] == ["b", "a"], "the group must be sorted by score"


class TestTheRefusals:
    def test_a_missing_source_is_refused(self, tmp_path: Path) -> None:
        path = write_ledger(tmp_path, [entry(source="")])
        r = run("--check", "--ledger", str(path))
        assert r.returncode == 1
        assert "missing source" in r.stdout

    def test_a_score_outside_the_percentage_range_is_refused(self, tmp_path: Path) -> None:
        # 830 is a fraction that had its decimal point dropped; 0.83 is the same mistake in the
        # other direction and this check cannot catch it, since it is a legal percentage. Stating
        # which direction is covered is the point -- a check believed to cover both is worse than
        # one that says what it covers.
        path = write_ledger(tmp_path, [entry(score=830)])
        r = run("--check", "--ledger", str(path))
        assert r.returncode == 1
        assert "outside 0-100" in r.stdout

    def test_an_unrecognised_provenance_is_refused(self, tmp_path: Path) -> None:
        path = write_ledger(tmp_path, [entry(kind="hearsay")])
        r = run("--check", "--ledger", str(path))
        assert r.returncode == 1
        assert "kind" in r.stdout

    def test_a_harness_whose_members_disagree_about_the_answer_model_is_refused(
        self, tmp_path: Path
    ) -> None:
        # The defect found in this repository's own first draft: three rows of one published table
        # carried the table's own model while a fourth carried another, and sorting them together
        # would have ordered numbers produced under two conditions.
        path = write_ledger(
            tmp_path,
            [
                entry(system="a", answerModel="claude"),
                entry(system="b", answerModel="gpt-4"),
            ],
        )
        r = run("--check", "--ledger", str(path))
        assert r.returncode == 1
        assert "disagree about answerModel" in r.stdout

    def test_a_single_system_calling_itself_a_harness_is_refused(self, tmp_path: Path) -> None:
        # One system run by its own authors is a self-report with a better name; the label is
        # earned by the systems it covers.
        path = write_ledger(tmp_path, [entry(kind="harness")])
        r = run("--check", "--ledger", str(path))
        assert r.returncode == 1
        assert "ran one system" in r.stdout

    def test_every_problem_is_reported_in_one_run(self, tmp_path: Path) -> None:
        path = write_ledger(
            tmp_path, [entry(source=""), entry(score=830), entry(kind="hearsay")]
        )
        r = run("--check", "--ledger", str(path))
        assert r.returncode == 1
        assert "3 problem(s)" in r.stdout

    def test_an_invalid_ledger_does_not_print_a_table(self, tmp_path: Path) -> None:
        # The order matters: a reader who has seen the table has already read it, so the refusal
        # has to come before the rendering rather than after it.
        path = write_ledger(tmp_path, [entry(source="")])
        r = run("--ledger", str(path))
        assert r.returncode == 1
        assert r.stdout == ""
        assert "refusing to print tables" in r.stderr


class TestTheSpread:
    def test_a_version_difference_is_not_labelled_a_harness_effect(self, tmp_path: Path) -> None:
        path = write_ledger(
            tmp_path,
            [
                entry(system="mem0", score=93.4, harness="mem0-v3"),
                entry(system="mem0", score=94.4, harness="mem0-v3"),
            ],
        )
        r = run("--ledger", str(path))
        assert r.returncode == 0, r.stderr
        assert "version difference, not a harness effect" in r.stdout
        # And the word the tool must not use here.
        assert "across 1 harnesses" not in r.stdout

    def test_two_harnesses_are_labelled_across_harnesses(self, tmp_path: Path) -> None:
        path = write_ledger(
            tmp_path,
            [
                entry(system="zep", score=90.2, harness="zep"),
                entry(system="zep", score=71.2, harness="supermemory"),
            ],
        )
        r = run("--ledger", str(path))
        assert "across 2 harnesses" in r.stdout

    def test_harness_differences_sort_above_version_drift(self, tmp_path: Path) -> None:
        # A 1.8-point harness effect must not appear below a 9-point release difference, because a
        # reader takes the first row as the largest finding -- and because the two rows answer
        # different questions. The sizes are deliberately inverted against the ranking: sorting by
        # magnitude alone would put `drifty` first, so this test fails on that implementation.
        path = write_ledger(
            tmp_path,
            [
                entry(system="drifty", score=84.4, harness="one"),
                entry(system="drifty", score=93.4, harness="one"),
                entry(system="travelled", score=71.2, harness="two"),
                entry(system="travelled", score=73.0, harness="three"),
            ],
        )
        r = run("--ledger", str(path))
        assert r.returncode == 0, r.stderr
        # Only the spread block, because both names appear in the group tables above it and the
        # question is the order of the spread rows.
        block = r.stdout[r.stdout.index("How far") :]
        assert block.index("travelled") < block.index("drifty")


class TestTheGap:
    def test_a_score_inside_a_group_is_ranked_against_it(self, tmp_path: Path) -> None:
        ours = entry(system="ours", kind="ours", score=75.0)
        path = write_ledger(tmp_path, [entry(system="a", score=90.0), entry(system="b", score=70.0)])
        # The gap search uses this repository's fixed five-tuple, so the fixture has to carry it.
        mine = entry(
            system="ours",
            kind="ours",
            score=75.0,
            answerModel="DeepSeek",
            judge="cortex-judge",
            harness="cortex-ablation-40989420944",
        )
        path = write_ledger(
            tmp_path,
            [
                entry(system="a", score=90.0, answerModel="DeepSeek", judge="cortex-judge", harness="cortex-ablation-40989420944"),
                entry(system="b", score=70.0, answerModel="DeepSeek", judge="cortex-judge", harness="cortex-ablation-40989420944"),
            ],
        )
        assert mine["score"] == 75.0 and ours["score"] == 75.0
        r = run("--gap", "75", "--ledger", str(path))
        assert r.returncode == 0, r.stderr
        assert "rank 2 of 2" in r.stdout

    def test_a_score_with_no_group_reports_every_tied_nearest(self, tmp_path: Path) -> None:
        # Two groups both share dataset and variant and nothing else, so both are equally near and
        # both must be named. Naming one would make the distance a property of key ordering.
        path = write_ledger(
            tmp_path,
            [
                entry(system="a", harness="aaa", answerModel="m1", judge="j1"),
                entry(system="b", harness="bbb", answerModel="m2", judge="j2"),
            ],
        )
        r = run("--gap", "83", "--ledger", str(path))
        assert r.returncode == 0, r.stderr
        assert "2 group(s) are equally near" in r.stdout
        body = r.stdout[r.stdout.index("equally near") :]
        assert "aaa" in body and "bbb" in body

    def test_no_rank_is_reported_across_differing_conditions(self, tmp_path: Path) -> None:
        # The sentence this refuses to print is "83 would be second": the rank would be a fact
        # about the harnesses and would be read as a fact about the systems.
        path = write_ledger(tmp_path, [entry(system="a", harness="theirs")])
        r = run("--gap", "83", "--ledger", str(path))
        assert "rank 1 of" not in r.stdout and "rank 2 of" not in r.stdout
        assert "no comparable group" in r.stdout
        assert "differs" in r.stdout or "differing" in r.stdout or "theirs" in r.stdout

    def test_a_group_that_differs_only_in_judge_cannot_provide_a_rank(self, tmp_path: Path) -> None:
        # The five-tuple's fourth field, tested where it decides something: a group whose answer
        # model, dataset and harness all match ours but whose JUDGE differs is not a table our
        # number belongs in. Without this, dropping `judge` from the key would go unnoticed, since
        # every other check groups by harness rather than by the tuple.
        path = write_ledger(
            tmp_path,
            [
                entry(
                    system="a",
                    score=90.0,
                    answerModel="DeepSeek",
                    judge="their-judge",
                    harness="cortex-ablation-40989420944",
                )
            ],
        )
        r = run("--gap", "75", "--ledger", str(path))
        assert r.returncode == 0, r.stderr
        assert "no comparable group" in r.stdout
        assert "judge" in r.stdout

    def test_a_group_that_differs_only_in_harness_cannot_provide_a_rank(
        self, tmp_path: Path
    ) -> None:
        # The fifth field, for the same reason: two harnesses with the same answer model and judge
        # still differ in what they retrieve, so a rank across them is a fact about the pipelines.
        path = write_ledger(
            tmp_path,
            [
                entry(
                    system="a",
                    score=90.0,
                    answerModel="DeepSeek",
                    judge="cortex-judge",
                    harness="their-harness",
                )
            ],
        )
        r = run("--gap", "75", "--ledger", str(path))
        assert "no comparable group" in r.stdout
        assert "harness" in r.stdout

    def test_a_non_numeric_gap_is_refused(self, tmp_path: Path) -> None:
        path = write_ledger(tmp_path, [entry()])
        r = run("--gap", "high", "--ledger", str(path))
        assert r.returncode == 2
        assert "needs a number" in r.stderr


if __name__ == "__main__":  # pragma: no cover
    sys.exit(subprocess.call([sys.executable, "-m", "pytest", __file__, "-q"]))
