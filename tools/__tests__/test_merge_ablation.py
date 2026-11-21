"""Folding a split dispatch back into one population, and the three defects that look like success.

`semantic-carry.yml` answers `S12`'s 500 corpora in `shards` jobs because one Node process uses one
core and run `43609290786` showed the wall clock does not move with the worker count. That makes the
merge a reading instrument rather than plumbing: sixteen artifacts are not a population, and the
three ways to produce a plausible number from them are all silent.

  - **Different layers.** A shard that ran with the carry off, or with three repetitions, is a
    different experiment. Its questions belong to a population nobody dispatched, and averaging it in
    moves the delta toward a configuration that was never registered.
  - **A missing shard.** Fifteen of sixteen is not a smaller population. The questions the sixteenth
    would have answered are absent from every count while the denominator stays whole.
  - **Overlapping shards.** Two jobs given one index weight their questions twice, and a duplicated
    download does the same thing with no human error at all.

So the tests below are mostly refusals. The successful merge is pinned too -- order, concatenation,
disjointness, and a `questionCount` that is the sum rather than the mean -- because a refusal suite
with no green path can pass while refusing everything.
"""

import json
import pathlib
import subprocess

import pytest

TOOL = pathlib.Path(__file__).resolve().parents[1] / "merge-ablation.mjs"

CONFIG = {
    "reviewPass": "supersede",
    "semanticCarry": True,
    "carryPair": True,
    "reader": {"model": "deepseek-chat"},
    "judge": {"model": "deepseek-chat"},
}
SHAPE = {"windows": 2, "repetitions": 4, "sides": 2}
FINGERPRINT = "sha256:" + "a" * 64


def artifact(index, shards, prefixes, runs=2, config=None, cascade=None):
    """One shard's report, shaped like the arm's own artifact and no larger than a test needs."""
    ids = [f"{prefix}#w{window}" for prefix in prefixes for window in (1, 2)]
    baseline_runs = ["1" * len(ids) for _ in range(runs)]
    feature_runs = ["1" * len(ids) for _ in range(runs)]
    if cascade is not None:
        baseline_runs, feature_runs = cascade(ids, runs)
    return {
        "dataset": "longmemeval",
        "questionCount": len(ids),
        "runs": runs,
        "passShape": SHAPE,
        "datasetFingerprint": FINGERPRINT,
        "memoryArmConfig": dict(CONFIG if config is None else config),
        "featureConfig": {"semanticCarry": True},
        "population": {
            "windows": 2,
            "corpora": len(prefixes),
            "marker": "#w",
            "shard": {"index": index, "shards": shards},
        },
        "ablation": {
            "baselineCorrectByRun": baseline_runs,
            "featureCorrectByRun": feature_runs,
        },
        "questions": [{"questionId": question_id, "capability": "KU"} for question_id in ids],
        "semanticCarry": {
            "absorbed": 1,
            "dropped": 0,
            "matched": 2,
            "served": 2,
            "withheld": 0,
            "stored": {"semantic": 1},
        },
        "supersession": {"attempted": 10, "replaced": 1, "refused": 9},
    }


def write(directory, document, name="benchmark-cortex-memory-ablation-report.json"):
    target = pathlib.Path(directory) / name
    target.write_text(json.dumps(document), encoding="utf-8")
    return target


def cli(*args):
    return subprocess.run(["node", str(TOOL), *args], capture_output=True, text=True)


def merged(tmp_path, shards, documents, out=None):
    for position, document in enumerate(documents):
        subdirectory = pathlib.Path(tmp_path) / f"artifact-{position}"
        subdirectory.mkdir()
        write(subdirectory, document)
    destination = pathlib.Path(out or (pathlib.Path(tmp_path) / "merged.json"))
    return cli("--dir", str(tmp_path), "--shards", str(shards), "--out", str(destination)), destination


class TestTheMerge:
    def test_two_shards_become_one_population_in_index_order(self, tmp_path):
        # Deliberately written in reverse so the order has to come from `population.shard.index`
        # rather than from the directory listing -- the upload step assigns those names, and a merge
        # that trusted them would be trusting the thing under test.
        result, out = merged(
            tmp_path,
            2,
            [artifact(1, 2, ["c2", "c3"]), artifact(0, 2, ["c0", "c1"])],
        )
        assert result.returncode == 0, result.stderr
        document = json.loads(out.read_text())
        assert [row["questionId"] for row in document["questions"]] == [
            "c0#w1",
            "c0#w2",
            "c1#w1",
            "c1#w2",
            "c2#w1",
            "c2#w2",
            "c3#w1",
            "c3#w2",
        ]
        assert document["questionCount"] == 8
        assert document["population"]["corpora"] == 4
        # The censuses are counts, so they add. A merged `matched` of 2 would be shard 0's reading
        # presented as the dispatch's.
        assert document["semanticCarry"]["matched"] == 4
        assert document["semanticCarry"]["stored"]["semantic"] == 2
        assert document["supersession"]["attempted"] == 20

    def test_every_repetition_is_concatenated_and_still_aligned(self, tmp_path):
        # The vectors are what the reading script pairs on, so their length has to equal the roster
        # for every repetition -- a merge that concatenated shard-major instead of run-major would
        # produce bitstrings of the right length and the wrong alignment.
        result, out = merged(
            tmp_path,
            3,
            [artifact(0, 3, ["a"]), artifact(1, 3, ["b"]), artifact(2, 3, ["c"])],
        )
        assert result.returncode == 0, result.stderr
        document = json.loads(out.read_text())
        assert document["runs"] == 2
        for side in ("baselineCorrectByRun", "featureCorrectByRun"):
            vectors = document["ablation"][side]
            assert len(vectors) == 2
            assert all(len(bits) == 6 for bits in vectors)

    def test_the_delta_is_read_off_the_vectors_and_not_averaged(self, tmp_path):
        # Unequal shards on purpose. The left one is 2 corpora with one question wrong (-0.25) and
        # the right one is 4 corpora with one question wrong (-0.125); the mean of the two per-shard
        # deltas is -0.1875 and the difference over the merged questions is -2/12 = -0.1667. Averaging
        # per-shard deltas is the defect this asserts against, and equal shards could not show it.
        def cascade(ids, runs):
            baseline = ["1" * len(ids) for _ in range(runs)]
            feature = ["1" * len(ids) for _ in range(runs)]
            return baseline, feature

        left = artifact(0, 2, ["a", "b"], cascade=cascade)
        left["ablation"]["featureCorrectByRun"] = ["1011", "1011"]
        right = artifact(1, 2, ["c", "d", "e", "f"])
        right["ablation"]["featureCorrectByRun"] = ["11101111", "11101111"]
        result, out = merged(tmp_path, 2, [left, right])
        assert result.returncode == 0, result.stderr
        readings = json.loads(out.read_text())["merged"]["readings"]
        assert readings["baselineMeanAccuracy"] == pytest.approx(1.0)
        assert readings["featureMeanAccuracy"] == pytest.approx(10 / 12)
        assert readings["deltaMeanAccuracy"] == pytest.approx(-2 / 12)
        assert readings["deltaMeanAccuracy"] != pytest.approx(-0.1875)

    def test_a_per_job_census_inside_the_config_block_is_not_a_layer_difference(self, tmp_path):
        # The defect run 43622841638's merge job hit, in the shape it hit it: `memoryArmConfig`
        # carries `admission`, which the arm folds the per-run admission census into. Two shards of
        # one dispatch differ there for the only reason they should -- `candidates` 10020 against
        # 9428, because they read different corpora -- and every configured field is identical.
        # Comparing the block whole refuses every real sharded dispatch, which is worse than a
        # missing check: it makes the merge unusable on the population it was built for.
        left = artifact(0, 2, ["a"])
        right = artifact(1, 2, ["b"])
        left["memoryArmConfig"] = dict(CONFIG, admission={"candidates": 9428, "admitted": 9428})
        right["memoryArmConfig"] = dict(CONFIG, admission={"candidates": 10020, "admitted": 10020})
        result, out = merged(tmp_path, 2, [left, right])
        assert result.returncode == 0, result.stderr
        document = json.loads(out.read_text())
        assert document["questionCount"] == 4
        assert "memoryArmConfig.admission" in document["merged"]["notRecomputed"]

    def test_a_configuration_field_inside_that_block_is_still_a_layer_difference(self, tmp_path):
        # The other direction, and the one that matters more: excluding the census must not turn the
        # block into something nobody compares. `reviewPass` is configuration, and two passes are two
        # experiments.
        left = artifact(0, 2, ["a"])
        right = artifact(1, 2, ["b"])
        left["memoryArmConfig"] = dict(CONFIG, admission={"candidates": 1})
        right["memoryArmConfig"] = dict(CONFIG, admission={"candidates": 1}, reviewPass="bare")
        result, out = merged(tmp_path, 2, [left, right])
        assert result.returncode == 1
        assert "memoryArmConfig" in result.stderr

    def test_unequal_shards_sum_their_corpora_instead_of_multiplying_one(self, tmp_path):
        # 78 corpora over 16 shards is fourteen jobs with 5 and two with 4. A merge that multiplied
        # the first part by the count would report 80 -- a population 2.6 % larger than the dispatch,
        # and the error is invisible in a document whose own `parts` list shows the sizes.
        result, out = merged(
            tmp_path,
            3,
            [artifact(0, 3, ["a", "b"]), artifact(1, 3, ["c", "d"]), artifact(2, 3, ["e"])],
        )
        assert result.returncode == 0, result.stderr
        document = json.loads(out.read_text())
        assert document["population"]["corpora"] == 5
        assert [part["corpora"] for part in document["merged"]["parts"]] == [2, 2, 1]

    def test_the_turn_window_census_is_summed_like_every_other_census(self, tmp_path):
        # This test exists because the key was missing from the fold for a full round and nothing
        # noticed. The census reaches the artifact through four tested hops and then this tool
        # rebuilt the document without it, so `turn_window_analysis.py` would have read "no census"
        # off the merged file -- the same bytes as a run that never counted -- and `P1` would have
        # gone back to being unreadable at the last hop. A refusal suite that exercises only
        # `semanticCarry` passes while a key is absent from the list, which is exactly what happened.
        left = artifact(0, 2, ["a"])
        right = artifact(1, 2, ["b"])
        for document in (left, right):
            document["turnWindow"] = {
                "cut": 3,
                "marked": 0,
                "whole": 2,
                "questions": 2,
                "unreported": 0,
            }
        result, out = merged(tmp_path, 2, [left, right])
        assert result.returncode == 0, result.stderr
        census = json.loads(out.read_text())["turnWindow"]
        assert census == {"cut": 6, "marked": 0, "whole": 4, "questions": 4, "unreported": 0}
        # The identity the four hops were written to make checkable, in the one form that survives a
        # fold: every question either reported a census or was counted as not reporting one.
        assert census["questions"] + census["unreported"] == 4

    def test_no_shard_reporting_a_window_leaves_the_field_absent(self, tmp_path):
        # Absence is not zero. `{cut: 0, marked: 0, whole: 0}` and a document with no field are the
        # same reading only if nothing downstream can tell "the cap cut nothing" from "no cap was
        # applied", and `turn_window_analysis.py` distinguishes exactly that when it reports `P1`.
        result, out = merged(tmp_path, 2, [artifact(0, 2, ["a"]), artifact(1, 2, ["b"])])
        assert result.returncode == 0, result.stderr
        assert "turnWindow" not in json.loads(out.read_text())

    def test_the_document_names_what_it_did_not_recompute(self, tmp_path):
        # The fields `runAblation` owns are absent rather than copied from one shard, and the list of
        # them is in the document: a reader who looks for `ablation.delta` has to be told where it
        # went instead of finding a number that belongs to a sixteenth of the population.
        result, out = merged(tmp_path, 2, [artifact(0, 2, ["a"]), artifact(1, 2, ["b"])])
        assert result.returncode == 0, result.stderr
        document = json.loads(out.read_text())
        assert "delta" not in document["ablation"]
        assert "baseline" not in document
        assert "ablation.delta" in document["merged"]["notRecomputed"]
        assert "runAblation" in document["merged"]["notRecomputedWhy"]


class TestTheRefusals:
    def test_a_missing_shard_is_named_rather_than_folded_away(self, tmp_path):
        # Fifteen of sixteen: the artifact set looks complete, the `n` is 1/16 low, and the row
        # would be quoted with the registered denominator.
        result, out = merged(tmp_path, 3, [artifact(0, 3, ["a"]), artifact(1, 3, ["b"])])
        assert result.returncode == 1
        assert "missing shard(s) 2 of 3" in result.stderr
        assert not out.exists()

    def test_two_shards_carrying_one_question_are_refused(self, tmp_path):
        # The index-typo defect and the duplicated-download defect produce the same document, and it
        # weights the shared questions twice in every count below it.
        result, out = merged(
            tmp_path,
            2,
            [artifact(0, 2, ["a", "b"]), artifact(1, 2, ["b", "c"])],
        )
        assert result.returncode == 1
        assert "shards overlap" in result.stderr
        assert not out.exists()

    def test_one_shard_index_twice_is_refused(self, tmp_path):
        result, out = merged(
            tmp_path,
            2,
            [artifact(0, 2, ["a"]), artifact(0, 2, ["b"])],
        )
        assert result.returncode == 1
        assert "shard 0 appears at" in result.stderr

    def test_a_shard_from_another_layer_is_refused(self, tmp_path):
        # The carry off on one side is the defect a mixed dispatch produces when one job's input was
        # mistyped: both artifacts are valid, and their delta compares two experiments.
        other = dict(CONFIG)
        other["semanticCarry"] = False
        result, out = merged(
            tmp_path,
            2,
            [artifact(0, 2, ["a"]), artifact(1, 2, ["b"], config=other)],
        )
        assert result.returncode == 1
        assert "memoryArmConfig" in result.stderr
        assert "not parts of one dispatch" in result.stderr

    def test_a_shard_with_another_repetition_count_is_refused(self, tmp_path):
        result, out = merged(
            tmp_path,
            2,
            [artifact(0, 2, ["a"], runs=2), artifact(1, 2, ["b"], runs=3)],
        )
        assert result.returncode == 1
        assert "`runs`" in result.stderr

    def test_a_shard_that_disagrees_about_the_shard_count_is_refused(self, tmp_path):
        # `--shards 3` with artifacts that claim to be one of two: the population is an unknown
        # fraction, and neither number can be trusted over the other.
        result, out = merged(
            tmp_path,
            3,
            [artifact(0, 2, ["a"]), artifact(1, 2, ["b"]), artifact(2, 2, ["c"])],
        )
        assert result.returncode == 1
        assert "declares 2 shards and the merge was asked for 3" in result.stderr

    def test_an_unsplit_artifact_is_refused(self, tmp_path):
        # A single-window, single-shard artifact has no `population.shard`, so it is not one part of
        # a split: merging it with sharded ones would count its questions twice.
        document = artifact(0, 1, ["a"])
        del document["population"]["shard"]
        result, out = merged(tmp_path, 1, [document])
        assert result.returncode == 1
        assert "population.shard" in result.stderr

    def test_vectors_that_do_not_match_the_roster_are_refused(self, tmp_path):
        document = artifact(0, 2, ["a"])
        document["ablation"]["featureCorrectByRun"] = ["111", "111"]
        result, out = merged(tmp_path, 2, [document, artifact(1, 2, ["b"])])
        assert result.returncode == 1
        assert "carries 3 verdicts for 2 questions" in result.stderr

    def test_a_census_missing_from_one_shard_is_refused(self, tmp_path):
        # A field that appears in one artifact and not another is a build that changed mid-dispatch;
        # skipping it would publish a total that omits one job's contribution.
        without = artifact(1, 2, ["b"])
        del without["supersession"]
        result, out = merged(tmp_path, 2, [artifact(0, 2, ["a"]), without])
        assert result.returncode == 1
        assert "carries no `supersession`" in result.stderr

    def test_a_turn_window_missing_from_one_shard_is_refused(self, tmp_path):
        # The same refusal as the one above, for the key whose absence was silent: a build that
        # changed mid-dispatch. Skipping the missing shard would publish a census that omits one
        # job's turns, and the ratio `P1` reports (`treatment.marked / control.cut`) would then be
        # taken over a denominator that is a fraction of the population.
        without = artifact(1, 2, ["b"])
        present = artifact(0, 2, ["a"])
        present["turnWindow"] = {"cut": 3, "marked": 0, "whole": 2, "questions": 2, "unreported": 0}
        result, out = merged(tmp_path, 2, [present, without])
        assert result.returncode == 1
        assert "carries no `turnWindow`" in result.stderr

    def test_an_empty_directory_is_refused(self, tmp_path):
        result = cli("--dir", str(tmp_path), "--shards", "2", "--out", str(tmp_path / "m.json"))
        assert result.returncode == 1
        assert "no *ablation-report.json" in result.stderr

    def test_a_zero_shard_count_is_refused(self, tmp_path):
        write(tmp_path, artifact(0, 1, ["a"]))
        result = cli("--dir", str(tmp_path), "--shards", "0", "--out", str(tmp_path / "m.json"))
        assert result.returncode == 1
        assert "not a positive whole number" in result.stderr


class TestOneRepetition:
    """The screening pass, which is the cheapest dispatch and the one this merge refused.

    `ablation.ts` writes `baselineCorrectByRun` only when `runs > 1`, and the reason is sound: at one
    repetition the vector is a second copy of `baselineCorrect`, and two arrays that must agree are two
    arrays that can disagree. The merge then required the vector unconditionally, so every screening
    dispatch -- `--ablation-runs 1`, half the cost of the pair, the pass an experiment starts with --
    reached the last step of the workflow and was refused there, **after** every answer had been paid
    for. Run `44676731032` is that failure: nine steps green, the pair answered, and a merge that refused
    the artifact whose only fault was being cheap.

    The repair cannot be "require the field anyway" (it would keep refusing the pass) and cannot be "also
    write the field at one repetition" (it would create the second expression `ablation.ts` refuses). It
    is a rebuild: at one repetition there is exactly one possible bitstring, and the artifact already
    carries it as booleans. The rebuild is therefore not a guess -- and it is recorded per shard, so a
    reader of the merged document can tell a vector that was read from one that was reconstructed.
    """

    def one_run(self, index, shards, prefixes):
        document = artifact(index, shards, prefixes, runs=1)
        # The real shape: no per-run arrays at all, and the deprecated mirrors present because every
        # reader of a single artifact reads them.
        document["ablation"] = {
            "baselineCorrect": [True, False],
            "featureCorrect": [True, True],
        }
        return document

    def test_a_single_repetition_shard_rebuilds_its_one_bitstring(self, tmp_path):
        result, out = merged(
            tmp_path,
            2,
            [self.one_run(0, 2, ["a"]), self.one_run(1, 2, ["b"])],
        )
        assert result.returncode == 0, result.stderr
        document = json.loads(out.read_text())
        assert document["runs"] == 1
        # One corpus per shard, two windows each: two questions per shard, four merged.
        assert document["ablation"]["baselineCorrectByRun"] == ["1010"]
        assert document["ablation"]["featureCorrectByRun"] == ["1111"]
        assert document["questionCount"] == 4
        # The reading the screening pass exists to produce.
        assert document["merged"]["readings"]["baselineAccuracyPerRun"] == [0.5]
        assert document["merged"]["readings"]["featureAccuracyPerRun"] == [1.0]

    def test_the_rebuild_is_recorded_so_it_is_not_silent(self, tmp_path):
        # A merged document whose vectors were reconstructed must say so: the two paths read different
        # fields, and a reader comparing two merges should not have to infer which one it holds.
        result, out = merged(tmp_path, 1, [self.one_run(0, 1, ["a"])])
        assert result.returncode == 0, result.stderr
        document = json.loads(out.read_text())
        parts = document["merged"]["parts"]
        assert parts[0]["bitstringsFrom"] == "ablation.baselineCorrect+ablation.featureCorrect"

    def test_a_multi_repetition_shard_that_names_no_rebuild_stays_silent(self, tmp_path):
        # The field is absent rather than `null` on the path that needs no repair, for the reason every
        # optional field in this artifact is: a key holding `undefined` is the state a reader cannot tell
        # from absent, and the difference here is the difference between "read" and "rebuilt".
        result, out = merged(tmp_path, 2, [artifact(0, 2, ["a"]), artifact(1, 2, ["b"])])
        assert result.returncode == 0, result.stderr
        document = json.loads(out.read_text())
        assert all("bitstringsFrom" not in part for part in document["merged"]["parts"])

    def test_one_repetition_with_no_mirror_either_is_still_refused(self, tmp_path):
        # Both paths absent is a build that wrote neither: the questions were answered and the verdicts
        # are not in the artifact. Rebuilding from nothing would produce a bitstring of zeroes, which is
        # the reading "every answer was wrong".
        document = artifact(0, 2, ["a"], runs=1)
        document["ablation"] = {}
        result, out = merged(tmp_path, 2, [document, artifact(1, 2, ["b"], runs=1)])
        assert result.returncode == 1
        assert "carries neither `baselineCorrectByRun`" in result.stderr
        assert "1 repetition" in result.stderr

    def test_a_mirror_that_is_not_boolean_is_refused_rather_than_read_as_false(self, tmp_path):
        # `baselineCorrect` is written as booleans. A string `"1"` is an older or hand-edited artifact,
        # and coercing it with `=== true` would turn every correct answer into a wrong one -- a merge
        # that reports 0% accuracy for a perfect run, with nothing in the document saying why.
        document = self.one_run(0, 2, ["a"])
        document["ablation"]["baselineCorrect"] = ["1", "0"]
        result, out = merged(tmp_path, 2, [document, self.one_run(1, 2, ["b"])])
        assert result.returncode == 1
        assert "not boolean" in result.stderr

    def test_a_rebuilt_bitstring_must_still_match_its_own_roster(self, tmp_path):
        document = self.one_run(0, 2, ["a"])
        document["ablation"]["baselineCorrect"] = [True, False, True]
        result, out = merged(tmp_path, 2, [document, self.one_run(1, 2, ["b"])])
        assert result.returncode == 1
        assert "carries 3 verdicts for 2 questions" in result.stderr


class TestWhatTheMergeCarries:
    """The list of carried keys is prose, and prose has already lost one field.

    `turnWindow` was missing from it for a round and the omission was invisible: the four hops that
    carry the census all had tests, and the merge rebuilt the document without it. `C7`'s `F3` then
    needed two vectors the list had never heard of, and the merged artifact of run `44905275457`
    reported `no density reading` while every shard artifact it was built from carried both.

    So the round added the vectors AND made the omission visible: whatever a part wrote and the merge
    did not is named in `merged.notCarried`, derived rather than restated.
    """

    def test_the_density_vectors_are_concatenated_like_the_verdicts(self, tmp_path):
        first = artifact(0, 2, ["c0", "c1"])
        second = artifact(1, 2, ["c2", "c3"])
        for document, totals in ((first, (10, 12)), (second, (14, 16))):
            count = document["questionCount"]
            document["ablation"]["baselineRoleCensuses"] = [
                {"counts": {"user": 7}, "unclassified": 0, "total": 7} for _ in range(count)
            ]
            document["ablation"]["baselinePromptChars"] = [40000 + i for i in range(count)]
            for row in document["questions"]:
                row["roleCensus"] = {"counts": {"user": 9}, "unclassified": 0, "total": 9}
                row["promptChars"] = 50000
            assert totals  # the values above are per part; the merge must not pick one of them
        result, out = merged(tmp_path, 2, [second, first])
        assert result.returncode == 0, result.stderr
        document = json.loads(out.read_text())
        # Flattened in shard order, so a reader can zip them against `questions` the way it can zip the
        # verdict bitstrings. A `first part` rule would report 4 entries for 8 questions and every
        # median computed from it would be about the smallest shard.
        assert len(document["ablation"]["baselineRoleCensuses"]) == document["questionCount"] == 8
        assert len(document["ablation"]["baselinePromptChars"]) == 8
        assert [c["total"] for c in document["ablation"]["baselineRoleCensuses"]] == [7] * 8

    def test_a_field_the_merge_does_not_carry_is_named_rather_than_dropped(self, tmp_path):
        document = artifact(0, 1, ["c0"])
        document["ablation"]["baselineMetrics"] = {"correct": 1, "total": 2}
        result, out = merged(tmp_path, 1, [document])
        assert result.returncode == 0, result.stderr
        merged_document = json.loads(out.read_text())
        assert "baselineMetrics" in merged_document["merged"]["notCarried"], (
            "a shard wrote an ablation field the merge does not carry and the merged document says "
            "nothing about it: that is the `turnWindow` omission one field over, and the only reader who "
            "could notice is one holding both artifacts"
        )
        assert "baselineCorrectByRun" not in merged_document["merged"]["notCarried"], (
            "the list must be derived from what the parts wrote against what the merge produced, so a "
            "carried field cannot appear in it"
        )
