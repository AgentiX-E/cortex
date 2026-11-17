"""The producer for the two rows that price an absent mechanism, and the refusals that keep it honest.

Both rows were registered before a tool could write them. That is the state `S10` was in for a round,
and what it costs is specific: a dispatch can be paid for and its artifact uploaded while the file the
criterion reads never exists, so the row stays `unrun` and the money buys a number no row can see.

`S11` is the arm where nothing ranks; `S14` is the arm where the index has no vector channel. They are
one file because the refusals are identical -- an arm, a population, a registration, a declaration --
and only the values the arm must hold differ. Two files would be two copies of the refusals, and the
second copy is the one that would be wrong.

The refusals are the whole value of the file. Every one of them describes a reading that would look
correct and be wrong:

  - **No `--run`**: a figure nobody can re-derive.
  - **An unregistered configuration**: the attestation, reused from `registration-attest.py`.
  - **An arm that is not the row's arm**: `relevanceSignal` other than `none` for `S11`, or a vector
    channel for `S14`, measures a different product, and the number is a genuine measurement of it.
  - **A smaller population**: the threshold is expressed on 500 x 4, and neither row has a screening
    tier for a small run to go to.
  - **An undeclared departure**: added when the first real artifact for `S11` was refused. Both rows'
    arms are *by construction* departures from the registration, so a writer that only accepted exact
    matches accepted nothing either row would ever produce.
  - **A pair that is not a pair**: two artifacts of different corpora, rosters or repetition counts.

The last group is `S14`'s, and it exists because the row's honest sentence is a *paired* one. "85.75%
against 91.40%" is two means taken in different weeks; "of 500 questions, N answered by one arm and not
the other" is a measurement of the mechanism. The p-value behind it is computed here, and
`test_the_exact_mcnemar_agrees_with_the_one_cortex_eval_wrote` holds this implementation to the one
`cortex-eval` already ships, using a real artifact's own field as the witness.
"""

import json
import pathlib
import subprocess
import sys

import pytest

TOOL = pathlib.Path(__file__).resolve().parents[1] / "arm-reading-ledger.py"


def artifact(bits=None, signal="none", questions=500, config=None):
    bits = bits or ["1" * questions for _ in range(4)]
    return {
        "kind": "cortex-memory",
        "dataset": "longmemeval",
        "datasetFingerprint": "sha256:" + "a" * 64,
        "questionCount": questions,
        "runs": len(bits),
        "memoryArmConfig": config
        if config is not None
        else {
            "relevanceSignal": signal,
            "reader": {"model": "deepseek-chat"},
            "judge": {"model": "deepseek-chat"},
            "promptContract": "evidence-blocks-unsourced",
        },
        "questions": [{"questionId": f"q{index}"} for index in range(questions)],
        "ablation": {"featureCorrectByRun": bits},
    }


def baseline_for(report, tmp_path):
    """A registration record that matches `report`, so the write path can be exercised."""
    sys.path.insert(0, str(TOOL.parent))
    module = __import__("importlib").import_module("registration-attest")
    record = {
        "memoryArmConfigFingerprint": module.fingerprint(report["memoryArmConfig"]),
        "run": "test",
        "adoptedBy": "test",
        "memoryArmConfig": report["memoryArmConfig"],
    }
    path = pathlib.Path(tmp_path) / "baseline.json"
    path.write_text(json.dumps(record), encoding="utf-8")
    return path


def run(tmp_path, report, *args, row="S11"):
    source = pathlib.Path(tmp_path) / "artifact.json"
    source.write_text(json.dumps(report), encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(TOOL), str(source), "--row", row, *args],
        capture_output=True,
        text=True,
    )


def test_the_accuracy_is_the_mean_of_the_repetitions_not_the_first(tmp_path):
    # Four repetitions at 4/4, 3/4, 2/4 and 1/4 -> 62.5%. The first repetition alone is 100%, and
    # `questions[].correct` is exactly that one-repetition reading.
    report = artifact(bits=["1111", "1110", "1100", "1000"], questions=4)
    done = run(tmp_path, report, "--json", "--run", "1")
    assert done.returncode == 0, done.stderr
    overall = json.loads(done.stdout)["overall"]
    assert overall["accuracy"] == pytest.approx(0.625)
    assert overall["accuracyPerRun"] == [1.0, 0.75, 0.5, 0.25]
    assert overall["runs"] == 4


def test_a_ranked_arm_is_refused(tmp_path):
    # The number would be real and the product would be wrong: S11's content is that nothing ranked.
    done = run(tmp_path, artifact(signal="self-index"), "--run", "1")
    assert done.returncode == 1
    assert "S11 is the" in done.stderr and "arm where nothing ranks" in done.stderr
    assert "wrong product" in done.stderr


def test_an_artifact_with_no_signal_field_is_refused(tmp_path):
    """Absence is refused with its own sentence, and it must not be the sentence for `null`.

    The two facts are different: no field means the run cannot be *shown* to have held the arm, and an
    explicit `null` means the run recorded an arm that is not one. This tool read both as `reads None`
    until `S15` -- which is the message that let an unrecorded arm pass for a recorded one, because a
    reader has no way to tell from "None" whether the producer omitted the field or the product wrote a
    null. `S9` is the artifact that makes the distinction concrete: it predates no field and carries no
    null, and one of these two sentences has to describe it correctly.
    """
    report = artifact()
    del report["memoryArmConfig"]["relevanceSignal"]
    done = run(tmp_path, report, "--run", "1")
    assert done.returncode == 1
    assert "records no `relevanceSignal`" in done.stderr
    assert "reads None" not in done.stderr


def test_an_explicit_null_signal_is_refused_by_reading_it_as_a_value(tmp_path):
    report = artifact()
    report["memoryArmConfig"]["relevanceSignal"] = None
    done = run(tmp_path, report, "--run", "1")
    assert done.returncode == 1
    assert "reads None" in done.stderr
    assert "records no" not in done.stderr


def test_a_smaller_population_cannot_be_written(tmp_path):
    report = artifact(questions=200)
    done = run(
        tmp_path,
        report,
        "--write",
        str(pathlib.Path(tmp_path) / "out.json"),
        "--run",
        "1",
        "--baseline",
        str(baseline_for(report, tmp_path)),
    )
    assert done.returncode == 1
    assert "200 questions over 4 repetitions" in done.stderr
    assert "500 x 4" in done.stderr
    assert "no screening tier" in done.stderr
    assert not (pathlib.Path(tmp_path) / "out.json").exists()


def test_a_three_repetition_run_cannot_be_written(tmp_path):
    report = artifact(bits=["1" * 500 for _ in range(3)])
    done = run(
        tmp_path,
        report,
        "--write",
        str(pathlib.Path(tmp_path) / "out.json"),
        "--run",
        "1",
        "--baseline",
        str(baseline_for(report, tmp_path)),
    )
    assert done.returncode == 1
    assert "3 repetitions" in done.stderr


def test_write_without_a_run_is_refused(tmp_path):
    report = artifact()
    done = run(tmp_path, report, "--write", str(pathlib.Path(tmp_path) / "out.json"))
    assert done.returncode == 1
    assert "--write requires --run" in done.stderr


def test_an_unregistered_configuration_is_refused(tmp_path):
    report = artifact()
    done = run(
        tmp_path,
        report,
        "--write",
        str(pathlib.Path(tmp_path) / "out.json"),
        "--run",
        "1",
        "--baseline",
        str(TOOL.parent / "arm-config-baseline.json"),
    )
    assert done.returncode == 1
    assert "not a measurement of the registered configuration" in done.stderr
    assert not (pathlib.Path(tmp_path) / "out.json").exists()


def test_a_vector_that_is_not_aligned_with_the_roster_is_refused(tmp_path):
    report = artifact(questions=500, bits=["1" * 499 for _ in range(4)])
    done = run(tmp_path, report, "--run", "1")
    assert done.returncode == 1
    assert "not aligned with the roster" in done.stderr


def test_an_artifact_without_vectors_is_refused(tmp_path):
    # `questions[].correct` is one repetition; a four-repetition row cannot be built from it.
    report = artifact()
    del report["ablation"]
    done = run(tmp_path, report, "--run", "1")
    assert done.returncode == 1
    assert "one-repetition reading" in done.stderr


def test_the_written_file_carries_what_the_criterion_reads(tmp_path):
    report = artifact()
    out = pathlib.Path(tmp_path) / "out.json"
    done = run(
        tmp_path,
        report,
        "--write",
        str(out),
        "--run",
        "44123456",
        "--baseline",
        str(baseline_for(report, tmp_path)),
    )
    assert done.returncode == 0, done.stderr
    written = json.loads(out.read_text())
    # The key `acceptance.ts` reads, a ratio rather than a percentage.
    assert written["overall"]["accuracy"] == pytest.approx(1.0)
    assert written["run"] == "44123456"
    assert written["tier"] == "registered"
    assert written["arm"]["relevanceSignal"] == "none"
    assert written["configurationFingerprint"].startswith("sha256:")
    assert written["dataset"]["questions"] == 500


def departure(tmp_path):
    """The S11 artifact beside the registration it departs from, which is the shape a real run has.

    The row's arm **is** a departure -- `relevanceSignal: none` against a registration that records
    `retrieval-anchored` -- so the strict path refuses every artifact this tool was built to read. Before
    these tests that was the tool's behaviour, and `test_an_unregistered_configuration_is_refused` above
    pinned it: the row could be dispatched, paid for, and its evidence file could never exist.

    The baseline carries a **projected `dispatch` block**, because that is what a recorded registration
    is: `arm-config-record.py` writes one from a real artifact, and without it `differences()` can only
    say that no input can be compared -- which would let these tests pass on a fixture that never reached
    the field-level path they exist for.
    """
    sys.path.insert(0, str(TOOL.parent))
    record = __import__("importlib").import_module("arm-config-record")
    report = artifact(signal="none")
    registered = artifact(signal="retrieval-anchored")
    path = baseline_for(registered, tmp_path)
    baseline = json.loads(path.read_text(encoding="utf-8"))
    baseline["dispatch"] = record.project(registered)
    path.write_text(json.dumps(baseline), encoding="utf-8")
    return report, path


def test_a_departure_without_a_declaration_is_refused_and_names_the_field(tmp_path):
    report, baseline = departure(tmp_path)
    done = run(
        tmp_path,
        report,
        "--write",
        str(pathlib.Path(tmp_path) / "out.json"),
        "--run",
        "1",
        "--baseline",
        str(baseline),
    )
    assert done.returncode == 1
    # The field name, not just "the configuration differs": the reader has to know which line moved.
    assert "cortex_memory_relevance" in done.stderr
    assert "not a measurement of the registered configuration" in done.stderr
    assert not (pathlib.Path(tmp_path) / "out.json").exists()


def test_a_declared_departure_is_written_and_the_file_says_which_field_moved(tmp_path):
    report, baseline = departure(tmp_path)
    out = pathlib.Path(tmp_path) / "out.json"
    done = run(
        tmp_path,
        report,
        "--write",
        str(out),
        "--run",
        "43793677739",
        "--departs",
        "cortex_memory_relevance",
        "--baseline",
        str(baseline),
    )
    assert done.returncode == 0, done.stderr
    written = json.loads(out.read_text())
    # Always present, for the reason every always-present field in this campaign exists: a file that
    # omitted it would make "no departures" and "written before the field" the same bytes.
    assert written["declaredDepartures"] == ["cortex_memory_relevance"]
    assert written["tier"] == "declared-departure"
    assert written["overall"]["accuracy"] == pytest.approx(1.0)
    assert "declared: cortex_memory_relevance" in done.stdout


def test_a_declaration_that_names_a_field_which_did_not_move_is_refused(tmp_path):
    # A declaration is a claim about a run that happened. Naming an input the artifact agrees with the
    # registry on would let a later reader believe a control was a treatment.
    report, baseline = departure(tmp_path)
    done = run(
        tmp_path,
        report,
        "--write",
        str(pathlib.Path(tmp_path) / "out.json"),
        "--run",
        "1",
        "--departs",
        "cortex_memory_max_turn_chars",
        "--baseline",
        str(baseline),
    )
    assert done.returncode == 1
    assert "cortex_memory_max_turn_chars" in done.stderr
    assert "did not move" in done.stderr
    assert not (pathlib.Path(tmp_path) / "out.json").exists()


def test_the_tier_is_registered_when_nothing_departs(tmp_path):
    report = artifact()
    out = pathlib.Path(tmp_path) / "out.json"
    done = run(
        tmp_path,
        report,
        "--write",
        str(out),
        "--run",
        "1",
        "--baseline",
        str(baseline_for(report, tmp_path)),
    )
    assert done.returncode == 0, done.stderr
    assert json.loads(out.read_text())["declaredDepartures"] == []
    assert "declared: none" in done.stdout


# --------------------------------------------------------------------------------------------------
# `S14`: the row that prices the vector channel.
# --------------------------------------------------------------------------------------------------


def lexical_artifact(bits=None, signal="self-index", embedding="none", questions=500, **overrides):
    report = artifact(bits=bits, signal=signal, questions=questions, **overrides)
    report["memoryArmConfig"]["indexEmbedding"] = embedding
    return report


def test_the_row_is_named_rather_than_inferred(tmp_path):
    """`--row` is required, and an unknown one is refused with the list.

    A row inferred from the artifact would be a guess, and one artifact can satisfy two rows: `S11`'s
    arm and `S14`'s differ in two fields, and the asker is the only thing that knows which question was
    asked.
    """
    done = run(tmp_path, lexical_artifact(), "--run", "1", row="S99")
    assert done.returncode == 1
    assert "S99" in done.stderr and "S11" in done.stderr and "S14" in done.stderr


def test_the_lexical_row_refuses_an_artifact_that_had_an_embedder(tmp_path):
    """The failure this row exists to prevent, in the direction that reads as good news.

    A `self-index` artifact with `indexEmbedding: injected` is the registered arm. Written under `S14`
    it would publish 91.40% as the no-embedder reading, and nothing in the number would look wrong.
    """
    done = run(tmp_path, lexical_artifact(embedding="injected"), "--run", "1", row="S14")
    assert done.returncode == 1
    assert "`indexEmbedding` reads 'injected'" in done.stderr
    assert "no embedding provider" in done.stderr


def test_the_lexical_row_refuses_an_artifact_that_predates_the_field(tmp_path):
    """Absence reads as `injected`, because that is what every published figure was produced under.

    An artifact from before the channel existed is therefore *not* the lexical one, and treating a
    missing key as "no embedder" would silently file the registered arm under `S14`.
    """
    report = lexical_artifact()
    del report["memoryArmConfig"]["indexEmbedding"]
    done = run(tmp_path, report, "--run", "1", row="S14")
    assert done.returncode == 1
    assert "`indexEmbedding` reads 'injected'" in done.stderr


def test_the_two_rows_refuse_each_other_s_arm(tmp_path):
    """The pair is symmetric, which is what makes either refusal evidence rather than a policy.

    `S11` on a lexical artifact and `S14` on a `none`-ranking artifact are both refused, and each message
    names its own row's content rather than the field that disagreed.
    """
    ranked_none = artifact(signal="none")
    assert run(tmp_path, ranked_none, "--run", "1", row="S14").returncode == 1
    assert run(tmp_path, lexical_artifact(), "--run", "1", row="S11").returncode == 1


def test_the_exact_mcnemar_agrees_with_the_one_cortex_eval_wrote():
    """The Python implementation is held to the anchors `a3.test.ts` already pins.

    `packages/cortex-eval/src/__tests__/a3.test.ts` asserts `exactMcNemar(0, 0) === 1`,
    `exactMcNemar(3, 3) === 1` and `exactMcNemar(0, 10) ≈ 2/1024`. Those are the definition of the
    statistic -- two-sided exact McNemar on the discordant pairs -- so agreeing with them is agreeing
    with the implementation the artifacts were produced by, without a second copy of the code.

    The last case is the closed form for a fully discordant pair: with `c = 0` the only term is
    `C(n, 0)`, so the answer is exactly `2 / 2^n`, which no accumulation can drift.
    """
    module = _tool()
    assert module.exact_mcnemar(0, 0) == 1.0
    assert module.exact_mcnemar(3, 3) == 1.0
    assert module.exact_mcnemar(0, 10) == pytest.approx(2 / 1024, rel=1e-15)
    assert module.exact_mcnemar(0, 40) == pytest.approx(2 / (1 << 40), rel=1e-15)
    # The witness, not an anchor: run `43829744532`'s own artifact carries `ablation.mcnemarPValue =
    # 1.0483893925056894e-49` for its 13-and-220 discordant pair, computed by `cortex-eval`'s
    # `exactMcNemar`. This implementation returns `1.0483893925059404e-49` -- agreement to thirteen
    # significant digits, which is the difference between two orderings of the same float sums and not
    # between two statistics.
    assert module.exact_mcnemar(13, 220) == pytest.approx(1.0483893925056894e-49, rel=1e-11)
    # Symmetry: the test is two-sided, so the direction of the difference cannot matter to the p-value.
    for left, right in ((2, 9), (7, 7), (0, 1), (13, 31)):
        assert module.exact_mcnemar(left, right) == module.exact_mcnemar(right, left)


def _tool():
    """The tool as a module, registered before it executes.

    `dataclasses.dataclass` resolves `sys.modules[cls.__module__]` while the class body runs, so a module
    loaded by path without being registered raises `AttributeError` at the decorator. Registering it
    first is what makes an import-by-path work for a file that uses the standard library normally.
    """
    import importlib.util

    spec = importlib.util.spec_from_file_location("arm_reading_ledger", TOOL)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["arm_reading_ledger"] = module
    spec.loader.exec_module(module)
    return module


def test_a_pair_is_written_with_its_four_cells_and_the_p(tmp_path):
    """The row's sentence is paired, so the file carries the pair.

    Eight questions: four both, two only this arm, one only control, one neither. `deltaQuestions` is
    `+1`, and the p-value is the exact test on `b = 2, c = 1`.
    """
    control = lexical_artifact(
        bits=["11111110", "11111110", "11111110", "11111110"], embedding="injected", questions=8
    )
    treatment = lexical_artifact(
        bits=["11111011", "11111011", "11111011", "11111011"], questions=8
    )
    done = run(
        tmp_path,
        treatment,
        "--row",
        "S14",
        "--json",
        "--run",
        "1",
        "--control-artifact",
        _write(tmp_path, control, "control.json"),
    )
    assert done.returncode == 0, done.stderr
    paired = json.loads(done.stdout)["paired"]
    assert paired["cells"] == {"both": 6, "onlyTreatment": 1, "onlyControl": 1, "neither": 0}
    assert paired["deltaQuestions"] == 0
    assert paired["mcnemarP"] == 1.0
    assert paired["control"]["relevanceSignal"] == "self-index"
    assert paired["control"]["indexEmbedding"] == "injected"


def _write(tmp_path, report, name):
    path = pathlib.Path(tmp_path) / name
    path.write_text(json.dumps(report), encoding="utf-8")
    return str(path)


def test_a_pair_across_two_corpora_is_refused(tmp_path):
    """A different fingerprint is a different population, and a paired test on it is a real number
    about the wrong comparison."""
    control = lexical_artifact(questions=500)
    control["datasetFingerprint"] = "sha256:" + "b" * 64
    done = run(
        tmp_path,
        lexical_artifact(),
        "--row",
        "S14",
        "--run",
        "1",
        "--control-artifact",
        _write(tmp_path, control, "control.json"),
    )
    assert done.returncode == 1
    assert "different corpora" in done.stderr


def test_a_pair_across_two_rosters_is_refused(tmp_path):
    """The same fingerprint with a different question list is a broken artifact, not a population."""
    control = lexical_artifact()
    control["questions"] = control["questions"][:499]
    done = run(
        tmp_path,
        lexical_artifact(),
        "--row",
        "S14",
        "--run",
        "1",
        "--control-artifact",
        _write(tmp_path, control, "control.json"),
    )
    assert done.returncode == 1
    assert "different roster" in done.stderr


def test_a_pair_across_two_repetition_counts_is_refused(tmp_path):
    """Two means over different numbers of passes are not the same statistic."""
    control = lexical_artifact(bits=["1" * 500 for _ in range(2)])
    done = run(
        tmp_path,
        lexical_artifact(),
        "--row",
        "S14",
        "--run",
        "1",
        "--control-artifact",
        _write(tmp_path, control, "control.json"),
    )
    assert done.returncode == 1
    assert "4 repetitions in this artifact against 2" in done.stderr


def test_the_reading_names_the_channel_it_was_measured_without(tmp_path):
    """The line a reader copies has to carry the field the row is about.

    `S11` and `S14` are the same product with different mechanisms withheld, so a reading that printed
    only `relevanceSignal` would be identical in shape for both and would not say which one it was.
    """
    done = run(tmp_path, lexical_artifact(), "--row", "S14", "--run", "1")
    assert done.returncode == 0, done.stderr
    assert "indexEmbedding=none" in done.stdout
    assert "S14 floor 88.0%" in done.stdout


def test_the_capability_denominator_is_the_population_not_the_sum_of_two_artifacts(tmp_path):
    """The first version of this function reported `ABS 60 questions` for a 30-question population.

    It summed the roster over both artifacts, so every denominator doubled and every percentage stayed
    right -- which is the shape that survives review: the deltas looked plausible and the populations
    did not match the ones the published matrix uses. A capability's denominator is a property of the
    population, and both sides are graded on the same questions.
    """
    def with_capability(signal, embedding, bits):
        report = lexical_artifact(bits=bits, signal=signal, embedding=embedding, questions=4)
        for entry, capability in zip(report["questions"], ["IE", "IE", "KU", "KU"]):
            entry["capability"] = capability
        return report

    # IE is the first two questions and KU the second two: the treatment keeps one IE answer and both
    # KU answers, the control keeps both IE answers and no KU answer.
    treatment = with_capability("self-index", "none", ["1011"] * 4)
    control = with_capability("self-index", "injected", ["1100"] * 4)
    done = run(
        tmp_path,
        treatment,
        "--row",
        "S14",
        "--json",
        "--run",
        "1",
        "--control-artifact",
        _write(tmp_path, control, "control.json"),
    )
    assert done.returncode == 0, done.stderr
    by_capability = json.loads(done.stdout)["paired"]["byCapability"]
    assert by_capability["IE"]["questions"] == 2
    assert by_capability["KU"]["questions"] == 2
    assert by_capability["IE"]["treatment"] == 0.5
    assert by_capability["IE"]["control"] == 1.0
    assert by_capability["IE"]["deltaPoints"] == pytest.approx(-50.0)
    assert by_capability["KU"]["treatment"] == 1.0
    assert by_capability["KU"]["control"] == 0.0


def test_the_file_names_the_arm_it_measured(tmp_path):
    """`S11`'s committed file has `"name": null`, written before the fallback existed.

    The artifact names its arm under `feature.name`; an older shape carries a top-level `kind`. A file
    that reads `null` there cannot say which product the number is about, which is the one thing the
    file exists to say.
    """
    report = lexical_artifact()
    report["feature"] = {"name": "cortex-memory"}
    done = run(tmp_path, report, "--row", "S14", "--json", "--run", "1")
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout)["arm"]["name"] == "cortex-memory"


def test_a_control_without_a_run_id_prints_the_one_it_was_given(tmp_path):
    """A raw report carries no run id of its own, so the pairing needs `--control-run`.

    Without it the file says `control.run: null`, and a paired block whose control cannot be named is a
    comparison nobody can re-derive -- which is the whole reason `--write` requires `--run`.
    """
    done = run(
        tmp_path,
        lexical_artifact(),
        "--row",
        "S14",
        "--json",
        "--run",
        "1",
        "--control-run",
        "43778036604",
        "--control-artifact",
        _write(tmp_path, lexical_artifact(embedding="injected"), "control.json"),
    )
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout)["paired"]["control"]["run"] == "43778036604"


def test_a_degraded_artifact_is_refused_by_both_rows(tmp_path):
    """A run whose embedder emptied its balance is neither arm, and the reading would look fine.

    `SearchIndex.onEmbedFailure: 'lexical'` turns a mid-run provider failure into a retrieval scored
    the way the product scores when there is no embedder -- which is the whole point of it, and the
    reason a long benchmark no longer dies at 86% of its third repetition (run `43866639154`). The
    consequence for the evidence file is the one this refuses: some questions were ranked over two
    channels and the rest over one, so the artifact's accuracy is a mixture of the arm and `S14`'s
    measured fallback, and writing it under either row would publish a number no deployment produced.

    Absence is not a degradation. Every artifact written before the field existed was produced by a
    build with no such policy, so it cannot have degraded and reading it as zero is the true reading
    rather than a lenient one.
    """
    for row, report in (
        ('S11', lexical_artifact(signal='none', embedding='injected')),
        ('S14', lexical_artifact()),
    ):
        report['memoryArmConfig']['selfIndex'] = {
            'indexes': 500,
            'turns': 742_080,
            'embedCalls': 10_422,
            'embedTexts': 536_099,
            'memoHits': 205_377,
            'reuse': True,
            'rerankCalls': 0,
            'rerankDegraded': 0,
            'embedDegraded': 40,
        }
        done = run(tmp_path, report, '--run', '1', row=row)
        assert done.returncode == 1, done.stdout
        assert 'embedDegraded' in done.stderr
        assert '40' in done.stderr
        # The sentence names what the mixture is, because "this is the wrong artifact" would send a
        # reader looking for a dispatch mistake that did not happen.
        assert 'fell back to lexical scoring' in done.stderr


def test_an_artifact_that_predates_the_policy_is_read_as_undegraded(tmp_path):
    """`S9` and `S14` carry no `selfIndex.embedDegraded`, and both are pure arms.

    The field arrives with the mechanism. A build without the policy cannot degrade a retrieval, so
    the missing key is a statement about the build rather than an unknown, and refusing here would
    reject the two artifacts this file exists to publish.
    """
    report = lexical_artifact()
    assert 'selfIndex' not in report['memoryArmConfig']
    done = run(tmp_path, report, '--row', 'S14', '--run', '1')
    assert done.returncode == 0, done.stderr


def test_zero_degradations_is_a_reading_and_not_a_refusal(tmp_path):
    """The healthy case, asserted so the guard cannot be satisfied by "any selfIndex block"."""
    report = lexical_artifact()
    report['memoryArmConfig']['selfIndex'] = {
        'indexes': 500,
        'turns': 742_080,
        'embedCalls': 10_422,
        'embedTexts': 536_099,
        'memoHits': 205_377,
        'reuse': True,
        'rerankCalls': 0,
        'rerankDegraded': 0,
        'embedDegraded': 0,
    }
    done = run(tmp_path, report, '--row', 'S14', '--run', '1')
    assert done.returncode == 0, done.stderr


# ---- `S15`: the room row, which is the first row whose arm is a table -----------------------------
#
# Every other row can be told apart from its neighbours by naming a value. `S15` cannot: it holds
# `relevanceSignal: self-index` and `indexEmbedding: injected`, which is exactly `S9`. What separates
# them is the room table, so the refusal that matters here is not "another row's arm" but "the *same*
# arm at another budget" -- a case the two-field shape could not express, and the reason the row's arm
# became a list of paths.


ROOM_ROUTES = ("abstention", "assistant", "flat", "knowledge-update", "multi-session", "temporal")


def room_config(**rooms):
    config = {
        "relevanceSignal": "self-index",
        "indexEmbedding": "injected",
        "reader": {"model": "deepseek-chat"},
        "judge": {"model": "deepseek-chat"},
        "promptContract": "evidence-blocks-unsourced",
        "maxPromptCharsByRoute": {route: 24000 for route in ROOM_ROUTES},
    }
    config["maxPromptCharsByRoute"].update(rooms)
    return config


def test_the_room_row_accepts_every_route_at_twenty_four_thousand(tmp_path):
    report = artifact(config=room_config())
    done = run(tmp_path, report, "--json", "--run", "1", row="S15")
    assert done.returncode == 0, done.stderr
    result = json.loads(done.stdout)
    assert result["row"] == "S15"
    assert result["arm"]["relevanceSignal"] == "self-index"


def test_the_room_row_refuses_the_registered_arm_it_is_a_cut_of(tmp_path):
    """`S9`'s artifact, offered to `S15`. This is the refusal the row exists for.

    The two artifacts agree about every field a two-name row could check, and they differ by 2.0 points
    on the same 500 questions. A producer that accepted this file would publish 91.40% as the reading
    for the cell that read 89.40%, and the number would look entirely correct: it is the registered
    arm's accuracy, on the registered population, under the row's own `relevanceSignal`.
    """
    report = artifact(config=room_config(**{"multi-session": 48460, "temporal": 48000}))
    done = run(tmp_path, report, "--run", "1", row="S15")
    assert done.returncode == 1
    assert "`maxPromptCharsByRoute`" in done.stderr
    assert "'multi-session': 48460" in done.stderr
    assert "two different budgets" in done.stderr


def test_the_room_row_refuses_an_artifact_that_records_no_room_table(tmp_path):
    config = room_config()
    del config["maxPromptCharsByRoute"]
    done = run(tmp_path, artifact(config=config), "--run", "1", row="S15")
    assert done.returncode == 1
    assert "records no `maxPromptCharsByRoute`" in done.stderr


def test_the_rendered_floor_is_the_rows_own(tmp_path):
    """`S15`'s floor is 0.91 and the sentence that prints it used to be a literal 88.0%.

    Both rows shared 0.88 for as long as there were two, so a hardcoded `88.0%` and a hardcoded `0.88`
    verdict agreed with every row in the table and with no other possible row. This test exists because
    the third row is the first one that can tell -- and because a printed threshold that belongs to
    another row is a number a reader will compare the reading against.
    """
    done = run(tmp_path, artifact(config=room_config(), questions=4, bits=["1110"] * 4), "--run", "1", row="S15")
    assert done.returncode == 0, done.stderr
    assert "S15 floor 91.0%" in done.stdout
    assert "88.0%" not in done.stdout
    assert "verdict: miss" in done.stdout


def test_the_room_row_names_every_route_the_product_has(tmp_path):
    """The row pins six route names, and this file is Python while the routes are TypeScript.

    A route added to the product and not to this table would leave `S15` pinning five of six, so an
    artifact at 24,000 on five routes and 48,000 on the new one would pass a row whose subject is that
    every route was cut. Read from the product's own declaration rather than from a second copy:
    `TURN_CAP_ROUTES` in `cortex-memory/src/types.ts` is the list `TurnCapRoute` is derived from.
    """
    source = (TOOL.parent.parent / "packages/cortex-memory/src/types.ts").read_text()
    block = source.split("export const TURN_CAP_ROUTES = [", 1)[1].split("] as const;", 1)[0]
    declared = sorted(part.strip().strip("'\"") for part in block.split(",") if part.strip())
    assert sorted(ROOM_ROUTES) == declared, declared


# ---- the route split, which is how a room row is read -------------------------------------------


def routed(bits, routes, chars):
    report = artifact(bits=bits, questions=len(routes))
    report["memoryArmConfig"]["relevanceSignal"] = "self-index"
    report["memoryArmConfig"]["maxPromptCharsByRoute"] = {route: 24000 for route in ROOM_ROUTES}
    for index, entry in enumerate(report["questions"]):
        entry["capability"] = "MR" if routes[index] == "multi-session" else "TR"
        entry["route"] = routes[index]
        if chars[index] is not None:
            entry["deliveredPromptChars"] = chars[index]
    return report


def test_the_pair_carries_a_route_split_with_the_room_each_route_spent(tmp_path):
    """A total over six routes cannot say which budget paid, so the pair carries the split.

    The treatment is the shape `S15` measured -- one route cut, the other left alone -- and the control
    is the registered arm. The assertion is that the split reports *delivered characters* and not only a
    delta: two routes can both fall by one question while only one of them lost any room, and that
    difference is the reading.
    """
    routes = ["multi-session", "temporal", "flat", "flat"]
    treatment = routed(["1111"] * 4, routes, [48460, 24000, 24000, 24000])
    control = routed(["1111"] * 4, routes, [48460, 48000, 24000, 24000])
    done = run(
        tmp_path,
        treatment,
        "--json",
        "--run",
        "1",
        "--control-artifact",
        str(write(tmp_path, control)),
        row="S15",
    )
    assert done.returncode == 0, done.stderr
    split = json.loads(done.stdout)["paired"]["byRoute"]
    assert set(split) == {"flat", "multi-session", "temporal"}
    assert split["multi-session"]["deliveredCharsPerQuestion"] == {"treatment": 48460.0, "control": 48460.0}
    assert split["temporal"]["deliveredCharsPerQuestion"] == {"treatment": 24000.0, "control": 48000.0}
    assert split["flat"]["questions"] == 2


def test_a_route_whose_artifact_lacks_the_character_field_reports_no_mean(tmp_path):
    """Absent is not zero: a route with no `deliveredPromptChars` must not report a mean of nothing.

    A substituted zero would print `chars 0 against 0` beside a real accuracy reading, and a reader
    would conclude the route delivered no evidence -- which is the one thing a 91%-accuracy run cannot
    have done.
    """
    routes = ["multi-session", "temporal"]
    treatment = routed(["11"] * 4, routes, [48460, None])
    control = routed(["11"] * 4, routes, [48460, None])
    done = run(
        tmp_path,
        treatment,
        "--json",
        "--run",
        "1",
        "--control-artifact",
        str(write(tmp_path, control)),
        row="S15",
    )
    assert done.returncode == 0, done.stderr
    split = json.loads(done.stdout)["paired"]["byRoute"]
    assert "deliveredCharsPerQuestion" not in split["temporal"]
    assert split["temporal"]["questions"] == 1


def write(tmp_path, report):
    path = pathlib.Path(tmp_path) / f"control-{abs(hash(json.dumps(report, sort_keys=True)))}.json"
    path.write_text(json.dumps(report), encoding="utf-8")
    return path


# ---- the route row, whose number is a pair rather than a level -----------------------------------


S16_ROOMS = {"multi-session": 48460}


def test_the_route_row_accepts_the_one_route_kept_wide(tmp_path):
    """`S16`'s arm is `S15`'s with one route's room given back, and it needs a pair to have a number."""
    treatment = artifact(config=room_config(**S16_ROOMS))
    control = artifact(config=room_config(**{"multi-session": 48460, "temporal": 48000}))
    done = run(
        tmp_path,
        treatment,
        "--json",
        "--run",
        "1",
        "--control-artifact",
        str(write(tmp_path, control)),
        row="S16",
    )
    assert done.returncode == 0, done.stderr
    result = json.loads(done.stdout)
    assert result["row"] == "S16"
    assert result["arm"]["maxPromptCharsByRoute"]["temporal"] == 24000


def test_the_route_row_refuses_the_arm_where_every_route_was_cut(tmp_path):
    """`S15`'s artifact offered to `S16`: the arm the route row is the repair of.

    The two agree on `relevanceSignal`, on `indexEmbedding` and on five of the six rooms, and the
    difference is one entry. A producer that accepted this file would publish the 24,000 arm's number
    under a row whose whole content is that `multi-session` was not cut -- and the delta in it would be
    a comparison of an arm with itself.
    """
    report = artifact(config=room_config())
    done = run(tmp_path, report, "--run", "1", row="S16")
    assert done.returncode == 1
    assert "`maxPromptCharsByRoute`" in done.stderr
    assert "'multi-session': 48460" in done.stderr
    assert "two different budgets" in done.stderr


def test_the_route_row_refuses_the_registered_table(tmp_path):
    """`S9`'s table, which is the control. `S16` is the middle of the curve, not its left end."""
    report = artifact(config=room_config(**{"multi-session": 48460, "temporal": 48000}))
    done = run(tmp_path, report, "--run", "1", row="S16")
    assert done.returncode == 1
    assert "'temporal': 24000" in done.stderr


def test_a_count_row_refuses_to_be_written_without_a_pair(tmp_path):
    """A file with no `paired` block cannot carry this row's number, so it must not be written.

    `S16`'s criterion reads `paired.deltaQuestions`. A producer that wrote the file anyway would emit
    the one thing it can compute -- the level -- under a row that reads the pair, and the criterion
    would find no key: the row would read `unrun` while a paid artifact sat on disk. The refusal names
    the field the criterion reads rather than the flag that is missing.
    """
    report = artifact(config=room_config(**S16_ROOMS))
    done = run(
        tmp_path,
        report,
        "--run",
        "1",
        "--write",
        str(pathlib.Path(tmp_path) / "route-room.json"),
        row="S16",
    )
    assert done.returncode == 1
    assert "paired.deltaQuestions" in done.stderr
    assert not (pathlib.Path(tmp_path) / "route-room.json").exists()


def test_the_count_row_decides_on_the_pair_and_not_on_the_level(tmp_path):
    """Two arms, and the verdict is the opposite of what their accuracies would say.

    The first keeps 89.00% -- below every ratio floor in this table -- and passes, because it answers
    three questions the control answers and loses none. The second keeps 96.00% and fails, because the
    twenty questions it lost are the row's subject. A row whose verdict is read off `overall.accuracy`
    would get both of them backwards, which is why `unit` is a field and not an assumption.
    """
    kept = artifact(bits=["1" * 445 + "0" * 55] * 4, config=room_config(**S16_ROOMS))
    control = artifact(bits=["1" * 448 + "0" * 52] * 4, config=room_config(**{"multi-session": 48460, "temporal": 48000}))
    passed = run(
        tmp_path,
        kept,
        "--run",
        "1",
        "--control-artifact",
        str(write(tmp_path, control)),
        row="S16",
    )
    assert passed.returncode == 0, passed.stderr
    assert "verdict: pass" in passed.stdout, passed.stdout
    assert "-3 questions" in passed.stdout
    assert "S16 allows -5" in passed.stdout

    wide = artifact(bits=["1" * 480 + "0" * 20] * 4, config=room_config(**S16_ROOMS))
    full = artifact(bits=["1" * 500] * 4, config=room_config(**{"multi-session": 48460, "temporal": 48000}))
    failed = run(
        tmp_path,
        wide,
        "--run",
        "1",
        "--control-artifact",
        str(write(tmp_path, full)),
        row="S16",
    )
    assert failed.returncode == 0, failed.stderr
    assert "verdict: miss" in failed.stdout, failed.stdout
    assert "-20 questions" in failed.stdout


def test_rendering_a_count_row_without_a_pair_reports_it_unread(tmp_path):
    """No pair, no number. The honest render is `unread`, not a comparison against nothing.

    Rendering is allowed without `--write`, so this path is reachable: an operator pointing the tool at
    a fresh artifact before deciding whether to pay for a control. A verdict computed from `None` would
    be a `TypeError` at best and, if written defensively, a pass or a miss that no reading supports.
    """
    done = run(tmp_path, artifact(config=room_config(**S16_ROOMS)), "--run", "1", row="S16")
    assert done.returncode == 0, done.stderr
    assert "verdict: unread" in done.stdout
    assert "no pair" in done.stdout
