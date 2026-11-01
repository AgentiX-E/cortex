"""`competitor-ledger.mjs`, checked on the real ledger and on six deliberate defects.

The tool answers one question -- may these two numbers be ordered? -- and the answer is a
six-tuple rather than a dataset. Every test here is a case where a plausible reading would get
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
  - **one answer per question, or eight?** Supermemory's ASMR reports 98.6 on LongMemEval-S by
    running eight prompt variants per question and counting the question correct if any of the
    eight is -- a rule whose ceiling is above 100% of what one answer can reach. Its own second
    configuration, twelve variants with a majority vote, reports 97.2. Every other number in this
    file is a single answer. The scoring rule is therefore a condition of comparability, and the
    tests below exist because a five-tuple would have placed those rows one field away from ours
    and called that near.
"""

from __future__ import annotations

import json
import re
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
        "scoring": "single",
        "kind": "self",
        "source": "a paper",
    }
    row.update(overrides)
    return row


def without(row: dict, field: str) -> dict:
    """The same entry with one field absent, which is how an undeclared condition looks."""
    copy = dict(row)
    copy.pop(field, None)
    return copy


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
        # One row per dataset, so the LongMemEval reading is selected rather than assumed to be
        # first: Zep's LoCoMo spread (30.9) is larger and would otherwise be the row this test
        # checked while claiming it was checking the one section 3 of the analysis quotes.
        zep = [
            row
            for row in data["spreads"]
            if row["system"] == "Zep / Graphiti" and row["dataset"] == "LongMemEval"
        ]
        assert zep, "Zep must appear in the spread block for LongMemEval"
        assert zep[0]["harnessCount"] >= 2
        assert zep[0]["spread"] >= 10, zep[0]

    def test_our_own_rows_are_excluded_from_the_spread_block(self) -> None:
        # Including them would compute a "spread" for a system measured once by one harness, which
        # is zero, and a zero in that column reads as "this system is stable across harnesses".
        r = run("--json")
        data = json.loads(r.stdout)
        assert not [row for row in data["spreads"] if row["system"].startswith("cortex")]


class TestTheSixTuple:
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


class TestTheScoringRule:
    """The sixth field, and the reason it is not optional.

    A bench number is a number of *something*. "98.6" under best-of-eight and "98.6" under one
    answer per question differ by the entire headroom of the second, so the rule that turned
    predictions into a score is a condition of comparability in exactly the sense the answer model
    is. It is required with no default: a default would silently read an undeclared pass@k as a
    single answer, which is the one direction of error that inflates somebody else's row.
    """

    def test_a_missing_scoring_rule_is_refused(self, tmp_path: Path) -> None:
        path = write_ledger(tmp_path, [without(entry(), "scoring")])
        r = run("--check", "--ledger", str(path))
        assert r.returncode == 1
        assert "missing scoring" in r.stdout

    def test_an_unrecognised_scoring_rule_is_refused(self, tmp_path: Path) -> None:
        path = write_ledger(tmp_path, [entry(scoring="best-of-lots")])
        r = run("--check", "--ledger", str(path))
        assert r.returncode == 1
        assert "scoring" in r.stdout
        # The refusal has to name the permitted set, or the author's only move is to guess.
        assert "single" in r.stdout

    def test_the_rule_is_part_of_the_group_key(self, tmp_path: Path) -> None:
        # Everything else identical: same dataset, variant, model, judge and harness. Under a
        # five-tuple these are one group and their difference is presented as a system
        # difference; under a six-tuple they are two readings of two different questions.
        path = write_ledger(
            tmp_path,
            [
                entry(system="eight-shots", score=98.6, scoring="pass@k"),
                entry(system="one-shot", score=80.0, scoring="single"),
            ],
        )
        groups = json.loads(run("--json", "--ledger", str(path)).stdout)["groups"]
        assert len(groups) == 2

    def test_a_harness_reporting_two_rules_prints_two_tables_not_one(
        self, tmp_path: Path
    ) -> None:
        # The refusal is the wrong instrument here. A harness that prints a single-answer column
        # and an any-of-k column for every system it ran is the most honest table in the
        # literature. What must not happen is the merge: one score-sorted block whose first row
        # came from one rule and whose second came from the other. So the check accepts the input
        # and the rendering separates it -- asserted on the print, because that is where the harm
        # was.
        path = write_ledger(
            tmp_path,
            [
                entry(system="eight-shots", score=98.6, scoring="pass@k"),
                entry(system="one-shot", score=80.0, scoring="single"),
            ],
        )
        r = run("--ledger", str(path))
        assert r.returncode == 0, r.stderr
        assert "scoring pass@k" in r.stdout
        assert "scoring single" in r.stdout
        # Two headers, and the higher number only ever appears under the rule it was produced by.
        assert r.stdout.count("harness their-harness") == 2
        pass_block = r.stdout.split("scoring pass@k", 1)[1].split("scoring single", 1)[0]
        assert "eight-shots" in pass_block and "one-shot" not in pass_block

    def test_a_scoring_difference_is_named_when_our_score_is_placed(self, tmp_path: Path) -> None:
        # The sentence this field exists to make true. With `--gap` pointed at a group that differs
        # only in the scoring rule, the tool must name that field rather than report a distance.
        path = write_ledger(
            tmp_path,
            [
                entry(
                    system="theirs",
                    score=98.6,
                    scoring="pass@k",
                    answerModel="DeepSeek",
                    judge="cortex-judge",
                    harness="cortex-ablation-40989420944",
                )
            ],
        )
        r = run("--ledger", str(path), "--gap", "83.0")
        assert r.returncode == 0, r.stderr
        tail = r.stdout.split("83 has no comparable group", 1)
        assert len(tail) == 2, "the score must not be placed in the group"
        assert re.search(r"rank \d+ of \d+", tail[1]) is None
        # The field that differs is named, and it is the only one: every other condition of
        # comparability is identical in this fixture, which is what makes the row dangerous.
        assert "same 1 field(s): scoring" in tail[1], tail[1]

    def test_readings_under_two_rules_are_not_given_one_spread(self, tmp_path: Path) -> None:
        # A system read at 98.6 (pass@8) and 97.2 (majority of 12) has not "travelled 1.4 points".
        # Both are its own numbers and neither is a repeat of the other.
        path = write_ledger(
            tmp_path,
            [
                entry(system="asmr", score=98.6, scoring="pass@k", harness="asmr-setup"),
                entry(system="asmr", score=97.2, scoring="majority", harness="asmr-forest"),
            ],
        )
        data = json.loads(run("--json", "--ledger", str(path)).stdout)
        assert data["spreads"] == [], data["spreads"]

    def test_the_committed_ledger_declares_a_rule_on_every_row_and_uses_more_than_one(
        self,
    ) -> None:
        # Two properties at once. Declaring one is the guard against an undeclared pass@k sneaking
        # in later; using more than one is the evidence that the field is doing work rather than
        # being a constant that happens to be present.
        ledger = json.loads(LEDGER.read_text(encoding="utf-8"))
        rules = {row["scoring"] for row in ledger["entries"]}
        assert rules >= {"single", "pass@k"}, rules
        assert len(rules) > 1

    def test_our_own_row_is_a_single_answer(self) -> None:
        # The rule our numbers are produced under, pinned, because `--gap` compares only within a
        # scoring rule and a change here would silently re-point every gap in the file.
        ledger = json.loads(LEDGER.read_text(encoding="utf-8"))
        ours = [row for row in ledger["entries"] if row["kind"] == "ours"]
        assert ours
        assert {row["scoring"] for row in ours} == {"single"}


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

    def test_a_score_with_no_group_counts_every_tied_nearest(self, tmp_path: Path) -> None:
        # Two groups share dataset and variant and nothing else, so both are equally near. The
        # count must be both, not one: reporting one of them would make the distance a property of
        # key ordering. Their names are not printed because both are near for the same reason, and
        # that reason is printed once instead.
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
        assert "same 3 field(s): answerModel, harness, judge" in r.stdout

    def test_ties_with_different_causes_are_listed_by_name(self, tmp_path: Path) -> None:
        # The counterweight to the condensation above. Two groups can tie at the same agreement
        # count while differing in different fields, and then the shared signature is a lie: no
        # single sentence describes why neither is comparable, so the list has to be printed.
        path = write_ledger(
            tmp_path,
            [
                # Differs in answerModel, judge, harness.
                entry(system="a", harness="aaa", answerModel="m1", judge="j1"),
                # Differs in scoring, judge, harness -- and matches our answer model.
                entry(
                    system="b",
                    harness="bbb",
                    answerModel="DeepSeek",
                    judge="j2",
                    scoring="pass@k",
                ),
            ],
        )
        r = run("--gap", "83", "--ledger", str(path))
        assert r.returncode == 0, r.stderr
        assert "2 group(s) are equally near" in r.stdout
        body = r.stdout[r.stdout.index("equally near") :]
        assert "aaa" in body and "bbb" in body, body
        assert "every one differs in the same" not in body

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
