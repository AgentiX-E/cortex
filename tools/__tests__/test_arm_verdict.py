"""`tools/arm-verdict.mjs`, checked on reports built to fail one refusal at a time.

`§13.354.5` registers `V4`: a paired arm verdict must come from **one** implementation that reads the
per-question masks, because two hand readings of the same two artifacts produced two claims the
artifacts contradict — an arm's `baseline` line compared against the other arm's `perCapability`
field, and a bar whose population was a `max` across repetitions where the artifacts hold a mask.

So the tests below are mostly about the tool's **refusals**, and each moves exactly one thing:

  * a capability filter that yields different populations on the two sides (the archive is 500
    questions, a scoped arm is 72 — the filter must make them equal or the run was not the filter it
    claims);
  * unequal repetition counts, because a pass **count** is not comparable across them;
  * evidence that moved when the caller declared the mechanism cannot move it — the check that made
    both `conflicts` readings admissible;
  * a mask that does not describe the question list it is attached to.

The one positive reading is a twelve-question fixture whose numbers are copied from the published
reading of `42758152902` (`docs/MEASURE-CONFLICT-SURFACING.md` §5): `255 -> 260 of 288` becomes
`27 -> 32 of 48`, `16 / 11` discordant cells, four conversions, five regressions, and a falsifier
that fires. That is what makes the tool's output checkable against a document rather than against
itself.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "arm-verdict.mjs"

# The twelve questions of `42758152902` that moved or anchor the control, masks in `questions[]`
# order, control first. Copied from the artifacts, not invented: the cell totals reproduce the
# published 16 improved / 11 worsened exactly, because every agreeing question contributes zero.
MOVED = [
    ("ce6d2d27", "0000", "1111"),
    ("9ea5eabc", "0000", "1111"),
    ("ed4ddc30", "0000", "1111"),
    ("59524333", "0000", "0010"),
    ("c4ea545c", "1001", "1011"),
    ("c7dc5443", "1111", "1111"),
    ("6a1eabeb", "1111", "0110"),
    ("89941a93", "1111", "1010"),
    ("6071bd76", "1111", "1011"),
    ("07741c45", "1111", "0111"),
    ("f9e8c073", "1101", "0000"),
    ("852ce960", "0101", "1010"),
]


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", str(TOOL), *args],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=120,
    )


def report(
    path: Path,
    masks: list[str],
    rows: list[tuple[str, str]],
    *,
    capability: str = "KU",
    evidence: int | None = 23_084,
) -> Path:
    """A minimal ablation report: `rows` is (questionId, mask), `masks` is one per repetition."""
    payload = {
        "questions": [
            {
                "questionId": question_id,
                "capability": capability,
                **({} if evidence is None else {"evidenceChars": evidence}),
            }
            for question_id, _ in rows
        ],
        "ablation": {
            "featureCorrectByRun": [
                "".join(mask[run_index] for _, mask in rows) for run_index in range(len(masks[0]))
            ]
        },
    }
    path.write_text(json.dumps(payload))
    return path


def pair(tmp_path: Path) -> tuple[Path, Path]:
    control = report(
        tmp_path / "control.json",
        ["0000"],
        [(question_id, before) for question_id, before, _ in MOVED],
    )
    arm = report(
        tmp_path / "arm.json",
        ["0000"],
        [(question_id, after) for question_id, _, after in MOVED],
    )
    return control, arm


def test_the_published_reading_is_reproduced(tmp_path: Path) -> None:
    control, arm = pair(tmp_path)
    result = run(
        "--control",
        str(control),
        "--arm",
        str(arm),
        "--capability",
        "KU",
        "--bar",
        "conversions=3,falsifier=2",
    )
    assert result.returncode == 0, result.stderr
    out = result.stdout
    assert "passes 27 -> 32  (56.25% -> 66.67%, +10.42 points)" in out
    assert "cells 16 improved / 11 worsened, exact McNemar p = 0.4421" in out
    assert "questions up/down sign test p = 1.0000" in out
    assert "control-perfect 5" in out
    assert "bar: conversions met=true no-regression met=false falsified=true -> REJECTED" in out


def test_json_carries_the_whole_verdict(tmp_path: Path) -> None:
    control, arm = pair(tmp_path)
    result = run("--control", str(control), "--arm", str(arm), "--json")
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    verdict = payload["verdict"]
    assert verdict["comparable"] is True
    assert [move["id"] for move in verdict["conversions"]] == [
        "ce6d2d27",
        "9ea5eabc",
        "ed4ddc30",
        "59524333",
    ]
    assert [move["lost"] for move in verdict["controlPerfectRegressions"]] == [2, 2, 1, 1]
    assert verdict["controlPerfect"] == 5
    assert verdict["bar"] is None, "no --bar means nothing is decided"


def test_a_capability_filter_that_yields_different_populations_is_refused(tmp_path: Path) -> None:
    control = report(tmp_path / "control.json", ["0000"], [(question_id, before) for question_id, before, _ in MOVED])
    arm = report(
        tmp_path / "arm.json",
        ["0000"],
        [(question_id, after) for question_id, _, after in MOVED],
        capability="MR",
    )
    result = run("--control", str(control), "--arm", str(arm), "--capability", "KU")
    assert result.returncode == 3
    assert "INADMISSIBLE:" in result.stdout
    assert "question-sets-differ" in result.stdout


def test_unequal_repetitions_are_refused(tmp_path: Path) -> None:
    control = report(tmp_path / "control.json", ["0000"], [(question_id, before) for question_id, before, _ in MOVED])
    arm = report(
        tmp_path / "arm.json",
        ["00"],
        [(question_id, after[:2]) for question_id, _, after in MOVED],
    )
    result = run("--control", str(control), "--arm", str(arm))
    assert result.returncode == 3
    assert "repetitions-differ" in result.stdout


def test_evidence_that_moved_is_refused_only_when_the_caller_declares_it_cannot(tmp_path: Path) -> None:
    control = report(
        tmp_path / "control.json", ["0000"], [(question_id, before) for question_id, before, _ in MOVED]
    )
    arm = report(
        tmp_path / "arm.json",
        ["0000"],
        [(question_id, after) for question_id, _, after in MOVED],
        evidence=24_200,
    )
    refused = run(
        "--control", str(control), "--arm", str(arm), "--require-identical-evidence"
    )
    assert refused.returncode == 3
    assert "evidence-not-identical" in refused.stdout
    accepted = run("--control", str(control), "--arm", str(arm))
    assert accepted.returncode == 0


def test_a_report_without_widely_known_evidence_is_refused_when_identity_is_required(
    tmp_path: Path,
) -> None:
    control = report(
        tmp_path / "control.json",
        ["0000"],
        [(question_id, before) for question_id, before, _ in MOVED],
        evidence=None,
    )
    arm = report(
        tmp_path / "arm.json",
        ["0000"],
        [(question_id, after) for question_id, _, after in MOVED],
        evidence=None,
    )
    result = run("--control", str(control), "--arm", str(arm), "--require-identical-evidence")
    assert result.returncode == 3
    assert "evidence-not-identical" in result.stdout


def test_a_mask_that_does_not_describe_the_question_list_is_a_usage_error(tmp_path: Path) -> None:
    path = tmp_path / "broken.json"
    path.write_text(
        json.dumps(
            {
                "questions": [
                    {"questionId": "ce6d2d27", "capability": "KU", "evidenceChars": 1},
                ],
                "ablation": {"featureCorrectByRun": ["00"]},
            }
        )
    )
    result = run("--control", str(path), "--arm", str(path))
    assert result.returncode == 2
    assert "characters for 1 questions" in result.stderr


def test_missing_arguments_and_a_bad_side_are_usage_errors(tmp_path: Path) -> None:
    control, arm = pair(tmp_path)
    assert run("--control", str(control)).returncode == 2
    assert run("--control", str(control), "--arm", str(arm), "--side", "both").returncode == 2
    assert run("--control", str(control), "--arm", str(arm), "--bar", "conversions=x").returncode == 2


def test_an_unreadable_report_is_a_usage_error(tmp_path: Path) -> None:
    control, arm = pair(tmp_path)
    result = run("--control", str(tmp_path / "absent.json"), "--arm", str(arm))
    assert result.returncode == 2
    assert "cannot read control report" in result.stderr
    assert run("--control", str(control), "--arm", str(control)).returncode == 0


def test_a_report_without_masks_is_a_usage_error(tmp_path: Path) -> None:
    path = tmp_path / "nomask.json"
    path.write_text(json.dumps({"questions": [{"questionId": "ce6d2d27", "capability": "KU"}]}))
    result = run("--control", str(path), "--arm", str(path))
    assert result.returncode == 2
    assert "no ablation.featureCorrectByRun" in result.stderr


def test_the_baseline_side_can_be_read_instead(tmp_path: Path) -> None:
    control, arm = pair(tmp_path)
    result = run("--control", str(control), "--arm", str(arm), "--side", "baseline")
    assert result.returncode == 2
    assert "no ablation.baselineCorrectByRun" in result.stderr
