"""`S11`'s producer, and the five refusals that keep it from publishing the wrong product.

The row was registered without a tool that writes it. That is the state `S10` was in for a round, and
what it costs is specific: a dispatch can be paid for and its artifact uploaded while the file the
criterion reads never exists, so the row stays `unrun` and the money buys a number no row can see.

The refusals are the whole value of the file. Every one of them describes a reading that would look
correct and be wrong:

  - **No `--run`**: a figure nobody can re-derive.
  - **An unregistered configuration**: the attestation, reused from `registration-attest.py`.
  - **An arm that ranks**: `relevanceSignal` other than `none` measures a different product, and the
    number is a genuine measurement of it.
  - **A smaller population**: the threshold is expressed on 500 x 4, and this row has no screening
    tier for a small run to go to.
  - **An undeclared departure**: the fifth, added when the first real artifact for this row was refused.
    The row's arm is *by construction* a departure from the registration, so a writer that only accepted
    exact matches accepted nothing this row would ever produce.
"""

import json
import pathlib
import subprocess
import sys

import pytest

TOOL = pathlib.Path(__file__).resolve().parents[1] / "no-ranking-ledger.py"


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


def run(tmp_path, report, *args):
    source = pathlib.Path(tmp_path) / "artifact.json"
    source.write_text(json.dumps(report), encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(TOOL), str(source), *args], capture_output=True, text=True
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
    report = artifact()
    del report["memoryArmConfig"]["relevanceSignal"]
    done = run(tmp_path, report, "--run", "1")
    assert done.returncode == 1
    assert "reads None" in done.stderr


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
