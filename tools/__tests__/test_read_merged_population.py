"""The merged-population readback, and the shape it used to refuse without knowing it was refusing.

Run `43673528695` is the reason this file exists. It was `S10`'s control arm: one window per corpus,
`pairing=reference`, sixteen shards, all sixteen successful. The merge job went red anyway, because
the readback step required every question id to end in `<marker><windows>` so it could find the
second window -- and there is no second window at `windows=1`. The step was a heredoc inside the
workflow, so no test could exercise it, and the dispatch paid two hours to discover that a print
step had been written for its sibling row's shape.

The tests below are therefore mostly about what the script **declines** to do: not refusing a
one-window population, not reporting a carry reach for a pairing that never administers the carry,
and still refusing the two things that are genuinely wrong -- a roster that does not match its own
population, and a dispatch whose `windows` disagrees with the artifact's.
"""

import json
import pathlib
import subprocess

TOOL = pathlib.Path(__file__).resolve().parents[1] / "read-merged-population.py"


def document(windows=2, corpora=2, runs=2, carry=None, marker="#w"):
    """A merged evidence document, no larger than a reading needs."""
    ids = [
        f"q{corpus}{marker}{window}"
        for corpus in range(corpora)
        for window in range(1, windows + 1)
    ]
    payload = {
        "questionCount": len(ids),
        "runs": runs,
        "population": {"corpora": corpora, "windows": windows, "marker": marker},
        "merged": {"shards": 16},
        "questions": [{"questionId": question_id} for question_id in ids],
        "ablation": {
            "baselineCorrectByRun": ["1" * len(ids) for _ in range(runs)],
            "featureCorrectByRun": ["1" * len(ids) for _ in range(runs)],
        },
    }
    if carry is not None:
        payload["semanticCarry"] = carry
    return payload


def run(tmp_path, payload, *args):
    path = pathlib.Path(tmp_path) / "merged-evidence.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return subprocess.run(
        ["python3", str(TOOL), str(path), *args], capture_output=True, text=True
    )


def test_one_window_is_read_rather_than_refused(tmp_path):
    # The exact case that failed the run: `S10`'s shape, with ids that carry no second-window suffix
    # because there is no second window. Before the fix this exited 1 with a message about a marker.
    result = run(tmp_path, document(windows=1), "--windows", "1", "--pairing", "reference")
    assert result.returncode == 0, result.stderr
    assert "1 windows" in result.stdout
    assert "not taken" in result.stdout
    assert "refusing" not in result.stdout + result.stderr


def test_a_reference_pairing_does_not_report_a_carry_reach(tmp_path):
    # `reference` runs the carry off on both sides, so `matched: 0` is the configuration and not a
    # failure. A `::warning::` here would put a warning on every reference dispatch, which is how a
    # warning stops being read by the time it means something.
    result = run(
        tmp_path,
        document(windows=2, carry={"absorbed": 0, "matched": 0, "served": 0}),
        "--pairing",
        "reference",
    )
    assert result.returncode == 0, result.stderr
    assert "S13 reach" not in result.stdout
    assert "::warning::" not in result.stdout
    assert "not read from this dispatch" in result.stdout


def test_a_carry_pairing_reports_the_reach_and_the_paired_delta(tmp_path):
    # Two corpora, two windows: only the second window of each pairs. The baseline misses one of
    # them and the feature answers it, so the delta is +1.0 over n=2 with one discordant pair.
    payload = document(windows=2, carry={"absorbed": 1, "matched": 1, "served": 1})
    payload["ablation"]["baselineCorrectByRun"] = ["1010"]
    payload["ablation"]["featureCorrectByRun"] = ["1110"]
    result = run(tmp_path, payload, "--pairing", "carry")
    assert result.returncode == 0, result.stderr
    assert "S13 reach: 1" in result.stdout
    assert "second window: n=2  delta=+1.0000" in result.stdout
    assert "b=0 c=1" in result.stdout
    assert "::notice::S12 readable" in result.stdout


def test_a_reach_of_zero_is_a_warning_and_not_a_pass(tmp_path):
    result = run(tmp_path, document(windows=2, carry={"matched": 0}), "--pairing", "carry")
    assert result.returncode == 0, result.stderr
    assert "::warning::the merge reached no window" in result.stdout
    assert "S12 readable" not in result.stdout


def test_a_delta_below_the_floor_is_an_error_annotation(tmp_path):
    # Behaviour preserved from the heredoc: the annotation is printed and the exit code stays zero,
    # because the row's verdict is read from the artifact by the analysis script rather than from
    # this job's conclusion. Changing that here would be a change of instrument, not of shape.
    payload = document(windows=2, corpora=10, carry={"matched": 10})
    payload["ablation"]["featureCorrectByRun"] = ["0" * payload["questionCount"]]
    result = run(tmp_path, payload, "--pairing", "carry")
    assert result.returncode == 0, result.stderr
    assert "delta=-10.0000" in result.stdout
    assert "::error::delta -10.0 is below the -5 floor" in result.stdout


def test_a_roster_without_its_own_marker_is_refused_when_a_second_window_exists(tmp_path):
    # The refusal that was right all along: at two windows an id set carrying no suffix cannot be
    # paired, and a fallback would pair the first window against itself and call it +0.
    payload = document(windows=2)
    payload["questions"] = [
        {"questionId": f"q{index}"} for index in range(payload["questionCount"])
    ]
    result = run(tmp_path, payload, "--pairing", "carry")
    assert result.returncode == 1
    assert "does not match its own population" in result.stderr


def test_a_bitstring_that_is_not_aligned_with_the_roster_is_refused(tmp_path):
    payload = document(windows=2, carry={"matched": 1})
    payload["ablation"]["featureCorrectByRun"] = ["1"]
    result = run(tmp_path, payload, "--pairing", "carry")
    assert result.returncode == 1
    assert "not aligned with the roster" in result.stderr


def test_a_dispatch_window_count_that_disagrees_with_the_artifact_is_refused(tmp_path):
    result = run(tmp_path, document(windows=1), "--windows", "2")
    assert result.returncode == 1
    assert "different experiments" in result.stderr


def test_an_unknown_pairing_is_refused(tmp_path):
    result = run(tmp_path, document(windows=1), "--pairing", "reference-and-carry")
    assert result.returncode == 1
    assert "neither reference nor carry" in result.stderr


def test_an_unknown_argument_is_refused(tmp_path):
    result = run(tmp_path, document(windows=1), "--shards", "16")
    assert result.returncode == 1
    assert "unknown argument" in result.stderr
