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

    def test_an_empty_directory_is_refused(self, tmp_path):
        result = cli("--dir", str(tmp_path), "--shards", "2", "--out", str(tmp_path / "m.json"))
        assert result.returncode == 1
        assert "no *ablation-report.json" in result.stderr

    def test_a_zero_shard_count_is_refused(self, tmp_path):
        write(tmp_path, artifact(0, 1, ["a"]))
        result = cli("--dir", str(tmp_path), "--shards", "0", "--out", str(tmp_path / "m.json"))
        assert result.returncode == 1
        assert "not a positive whole number" in result.stderr
