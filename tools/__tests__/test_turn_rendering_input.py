"""The workflow maps one rendering name to one cap string, and the product has to read what it wrote.

## The defect this closes

The mapping used to be a GitHub expression with a `|| '400'` tail. That tail is the whole problem: a
misspelled `turn_rendering` fell through to the **registered rendering**, so the dispatch ran
control-against-control, published a delta of zero, and reported success. Nothing in the suite could
see it because the expression lived in YAML, and the run it would have wasted is two hours and 14.26
CNY.

So the mapping is now a shell `case` that refuses a fourth value, and this file runs **the text in the
workflow** rather than a copy of it. Extracting the block is what makes that possible: a test that
re-implemented the mapping would pass while the workflow said something else, which is the failure
mode every "guard on a copy" file in this repository records.

The second half closes the other end. A workflow that spelled `400:ellipses` would pass the `case` and
fail in the parser two hours later, so every cap string the mapping produces is fed to
`cortextMemoryArmOptions` -- the product's own env reader -- and the resulting fields are asserted. The
contract is therefore stated once, in the test, and checked at both ends of the wire.
"""

from __future__ import annotations

import json
import pathlib
import shutil
import subprocess

import pytest
import yaml

REPO = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = REPO / ".github" / "workflows" / "semantic-carry.yml"
DIST = REPO / "packages" / "cortex-eval" / "dist" / "bench-memory-arm.js"

# The contract: what each rendering name must become on the wire, and what the product must make of
# it. `marker` is `none` for the registered rendering because an absent field renders silently.
EXPECTED = {
    "head": {
        "cap": "400",
        "maxTurnChars": 400,
        "turnCutMarker": "none",
        "turnWindow": None,
    },
    "ellipsis": {
        "cap": "400:ellipsis",
        "maxTurnChars": 400,
        "turnCutMarker": "ellipsis",
        "turnWindow": None,
    },
    "match": {
        "cap": "400::match",
        "maxTurnChars": 400,
        "turnCutMarker": "ellipsis",
        "turnWindow": "match",
    },
}


def _steps() -> list[dict]:
    document = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    # The job that runs the arm, found by the step it must contain rather than by its name.
    for job in document["jobs"].values():
        for step in job.get("steps", []):
            if step.get("name") == "Map the rendering to the cap string":
                return job["steps"]
    raise AssertionError("the rendering mapping is not in the workflow")


def _mapping_step() -> str:
    for step in _steps():
        if step.get("name") == "Map the rendering to the cap string":
            return step["run"]
    raise AssertionError("unreachable: _steps found it")


def mapping(rendering: str, tmp_path: pathlib.Path) -> tuple[int, str, str]:
    """Run the workflow's own `case` block with `GITHUB_ENV` pointed at a scratch file."""
    env_file = tmp_path / "github_env"
    env_file.write_text("", encoding="utf-8")
    done = subprocess.run(
        ["bash", "-c", _mapping_step()],
        capture_output=True,
        text=True,
        env={
            "PATH": "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "GITHUB_ENV": str(env_file),
            "RENDERING": rendering,
        },
    )
    written = env_file.read_text(encoding="utf-8")
    value = ""
    for line in written.splitlines():
        if line.startswith("CORTEX_MEMORY_MAX_TURN_CHARS="):
            value = line.split("=", 1)[1]
    return done.returncode, value, done.stdout + done.stderr


@pytest.mark.parametrize("rendering", sorted(EXPECTED))
def test_the_workflow_writes_the_cap_string_the_contract_names(rendering, tmp_path):
    code, value, output = mapping(rendering, tmp_path)
    assert code == 0, output
    assert value == EXPECTED[rendering]["cap"], (
        f"turn_rendering={rendering!r} wrote {value!r}; the contract is "
        f"{EXPECTED[rendering]['cap']!r}"
    )


def test_a_fourth_value_is_refused_rather_than_falling_through(tmp_path):
    # The exact defect: the expression this replaced produced `400` for anything unrecognised, and a
    # dispatch that named `ellipsis` as `ellipses` would have run the control arm twice.
    code, value, output = mapping("ellipses", tmp_path)
    assert code == 1, output
    assert value == "", "a refused rendering must not write a cap string at all"
    assert "must be head, ellipsis or match" in output


def _node() -> str:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed")
    if not DIST.exists():
        pytest.skip("packages/cortex-eval/dist is not built")
    return node


@pytest.mark.parametrize("rendering", sorted(EXPECTED))
def test_the_product_reads_the_string_the_workflow_writes(rendering, tmp_path):
    # `CORTEX_MEMORY=1` is part of the fixture, not decoration: the disabled arm projects no cap at
    # all, so a test that omitted the toggle would read `maxTurnChars: None` for every rendering.
    code, value, output = mapping(rendering, tmp_path)
    assert code == 0, output
    done = subprocess.run(
        [
            _node(),
            "-e",
            (
                "const arm = require(process.argv[1]);"
                "const options = arm.cortextMemoryArmOptions({CORTEX_MEMORY: '1', CORTEX_MEMORY_MAX_TURN_CHARS: process.argv[2]});"
                "process.stdout.write(JSON.stringify({"
                "maxTurnChars: options.maxTurnChars ?? null,"
                "turnCutMarker: options.turnCutMarker ?? null,"
                "turnWindow: options.turnWindow ?? null,"
                "}));"
            ),
            str(DIST),
            value,
        ],
        capture_output=True,
        text=True,
    )
    assert done.returncode == 0, done.stderr
    got = json.loads(done.stdout)
    expected = {key: EXPECTED[rendering][key] for key in ("maxTurnChars", "turnCutMarker", "turnWindow")}
    assert got == expected, (
        f"the workflow sent {value!r} for {rendering!r} and the product read {got}; the contract is "
        f"{expected}"
    )


def test_the_input_declares_the_three_renderings_it_accepts(tmp_path):
    """The description is the only place a dispatcher learns the values, so it has to name all three."""
    document = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    declared = document[True]["workflow_dispatch"]["inputs"]["turn_rendering"]
    assert declared["default"] == "head", "an unnamed dispatch must send the registered rendering"
    description = declared["description"]
    for rendering in EXPECTED:
        assert f"`{rendering}`" in description, (
            f"turn_rendering accepts {rendering!r} but its description does not name it"
        )
