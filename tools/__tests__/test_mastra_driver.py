"""The Mastra driver: the contract stated in source, and a live round trip when the tree is installed.

## Why two layers

The 174 packages this driver imports live in `tools/competitor-sut/package.json` and are **not** installed by the
repository's own `pnpm install`, on purpose: every push would otherwise pay for a framework that one dispatch uses.
So the unit suite cannot start the driver here, and a test that skipped when the imports were missing would be a test
that never runs.

What is asserted unconditionally is the part that broke during development and would break silently again: Mastra
rejects a configuration that sets both `model` and `observation.model`, and the failure appears as an empty answer at
question one of a paid run rather than as a type error. A source-level assertion catches it in 20 milliseconds.

The live round trip is asserted when the tree *is* installed, which includes any developer who ran the install and
the workflow step that installs before it dispatches.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
DRIVER = REPO / "tools" / "competitor-sut" / "mastra_driver.mjs"
NODE_MODULES = REPO / "tools" / "competitor-sut" / "node_modules"


def source() -> str:
    return DRIVER.read_text(encoding="utf-8")


def test_one_model_serves_all_three_positions():
    """`model` and `observation.model` are mutually exclusive in Mastra, and the error is a runtime one.

    The single `model` is also the property the comparison depends on: the answering agent, the Observer and the
    Reflector must be the same model, or "the same LLM" is three claims that can drift apart.
    """
    text = source()
    assert "model: deepSeek(modelId)," in text
    # Read the `observation` block rather than the whole file: the comment above it names `observation.model` on
    # purpose, explaining why it is absent, and a whole-file check would fail on the explanation.
    observation = text.split("observation: {", 1)[1].split("},", 1)[0]
    assert "model:" not in observation
    assert "reflection: { model:" not in text


def test_it_declares_itself_as_a_self_answering_llm_build():
    text = source()
    assert "build: 'llm'," in text
    assert "answers: true," in text
    assert "name: 'mastra'," in text


def test_every_response_carries_the_metered_usage():
    """A response without `usage` would leave the cost column printing `—` for a system that spent real tokens."""
    text = source()
    for handler in ("async manifest()", "async ingest(request)", "async answer(request)"):
        assert handler in text
    # Each of the three spend-reporting responses calls the same reader. Counted rather than asserted once, because a
    # handler that forgot it would still pass a single-occurrence check.
    assert text.count("await usageBlock()") >= 3


def test_the_labelled_fetch_is_what_makes_the_split_readable():
    """Without the header the proxy reports one total and the build/answer split is unavailable."""
    text = source()
    assert "headers.set('X-Sut-Label', phase)" in text
    assert "createDeepSeek({" in text
    assert "fetch: labelledFetch" in text


@pytest.mark.skipif(
    not NODE_MODULES.is_dir(),
    reason="the Mastra tree is installed by the workflow and by `npm install --prefix tools/competitor-sut`",
)
def test_a_live_manifest_round_trip(tmp_path):
    """Start the driver in the installed tree: four imports resolve, the protocol answers, and shutdown is clean.

    `MASTRA_STORE` names a path whose parent does not exist yet, which is the shape three reading stages were
    given: `<workspace>/.cache/mastra/store.db` with no `.cache/mastra`. libsql reports a missing parent as
    `SQLITE_CANTOPEN` at import -- before the protocol channel is even open -- so the parent is the driver's
    responsibility, and this asserts it rather than assuming it.
    """
    store = tmp_path / "not" / "created" / "yet" / "store.db"
    assert not store.parent.exists()
    completed = subprocess.run(
        ["node", str(DRIVER)],
        input='{"op":"manifest"}\n{"op":"shutdown"}\n',
        capture_output=True,
        text=True,
        timeout=240,
        cwd=REPO,
        env={**os.environ, "MASTRA_STORE": str(store)},
    )
    assert completed.returncode == 0, completed.stderr[-2000:]
    assert store.parent.is_dir(), "the driver did not create the store's parent directory"
    lines = [json.loads(line) for line in completed.stdout.strip().splitlines() if line.strip()]
    manifest = lines[0]
    assert manifest["name"] == "mastra"
    assert manifest["answers"] is True
    assert manifest["build"] == "llm"
    assert manifest["version"].startswith("@mastra/memory@")
    assert manifest["llm"]["model"]


@pytest.mark.skipif(
    not (NODE_MODULES / "@mastra" / "memory").is_dir(),
    reason="the Mastra tree is installed by the workflow and by `npm install --prefix tools/competitor-sut`",
)
def test_a_blank_trigger_means_the_vendor_default_not_zero(tmp_path) -> None:
    """The workflow passes its optional input through the environment, and a blank input arrives as `\"\"`.

    `Number("")` is `0`, and a zero-token trigger would observe every turn -- a summariser rather than a memory
    system, and a manifest that reported `messageTokens: 0` would describe a configuration nobody chose. So the
    empty string has to fall back to 30,000, and a chosen value has to reach the manifest unchanged.
    """
    for value, expected in (("", 30_000), ("4000", 4_000)):
        completed = subprocess.run(
            ["node", str(DRIVER)],
            input='{"op":"manifest"}\n{"op":"shutdown"}\n',
            capture_output=True,
            text=True,
            timeout=240,
            cwd=REPO,
            env={**os.environ, "MASTRA_STORE": str(tmp_path / f"s{expected or 0}.db"), "MASTRA_MESSAGE_TOKENS": value},
        )
        assert completed.returncode == 0, completed.stderr[-2000:]
        manifest = json.loads(completed.stdout.strip().splitlines()[0])
        assert manifest["config"]["messageTokens"] == expected, manifest["config"]
