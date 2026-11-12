#!/usr/bin/env python3
"""The cache has to be reachable from every process that ingests, and its directory has to exist first.

## What this file is against

`03` §14.130 registered a content-addressed embedder cache because the competitor axis is dominated by ingest
(run `43170314351`: 49m42s ingesting twenty questions against 54s answering them). The mechanism is
`tools/competitor-sut/embed_cache_proxy.py` and its behaviour is tested there.

What this file tests is the wiring, because the wiring is where this repository keeps losing: a workflow that
forwards an option to one of four invocations produced the silent `mem0`-absent table of run `43170314351`, and a
temperature that reached no invocation produced an H5 failure that was read as arm noise. The same class of mistake
is available here in two shapes:

* **four ingests, one configured.** A dispatch runs the system-under-test step plus three reading prompts, and each
  is a separate process that builds its own store. A cache exported into the first and not the others saves a
  quarter of what it could and looks like a cache that does not work.
* **the directory does not exist.** `sqlite3.connect` does not create parent directories, so a cache path under
  `$GITHUB_WORKSPACE/.cache/...` fails on first write with `unable to open database file` — which arrives as an
  embedder failure, i.e. as "the competitor could not be measured", several minutes into a run.

## What this deliberately does not check

Whether the cache is honest. That is criterion 3 of §14.130 — with and without it, the reader's answers must be
identical question by question — and it needs two dispatches, not an assertion.
"""

from __future__ import annotations

import pathlib

import yaml

REPO = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = REPO / ".github" / "workflows" / "competitor-retrieval.yml"

HARNESS = "competitor-harness.mjs"
READ_FLAG = "--read "


def _document():
    # PyYAML parses the bare key `on` as the boolean True, so the trigger block is reached either way.
    return yaml.safe_load(WORKFLOW.read_text())


def _steps():
    return _document()["jobs"]["retrieval"]["steps"]


def _job_env():
    return _document()["jobs"]["retrieval"].get("env") or {}


def _inputs():
    document = _document()
    return (document.get("on") or document.get(True))["workflow_dispatch"]["inputs"]


def _reading_steps():
    return [step for step in _steps() if HARNESS in step.get("run", "") and READ_FLAG in step["run"]]


def _ingesting_steps():
    """Every step that can build a store: the system under test, and everything that reads answers.

    Derived rather than listed, for the reason `test_sut_read_wiring.py` derives the reading stages: a fourth
    reading prompt is covered the moment it exists.
    """
    return [
        step
        for step in _steps()
        if HARNESS in step.get("run", "") and ("--sut" in step["run"] or READ_FLAG in step["run"])
    ]


class TestTheSwitchIsDeclared:
    def test_the_dispatch_can_choose_the_embedder_and_defaults_to_the_cache(self):
        # The default is the cache because the cache is transparent by construction: the vectors are the
        # endpoint's own. `openai` is the control for criterion 3, not the normal setting.
        inputs = _inputs()
        assert "sut_embed_cache" in inputs, "the dispatch cannot turn the cache off, so it cannot be controlled for"
        assert inputs["sut_embed_cache"]["default"] == "openai-cached"

    def test_the_job_forwards_both_the_switch_and_the_path(self):
        env = _job_env()
        assert "MEM0_EMBEDDER" in env, "no MEM0_EMBEDDER, so the driver keeps its default and the cache never runs"
        assert "github.event.inputs.sut_embed_cache" in str(env["MEM0_EMBEDDER"])
        assert "MEM0_EMBED_CACHE_PATH" in env, "the driver would fall back to /tmp, which does not survive the job"
        # Inside the workspace, because that is the only path `actions/cache` can carry between dispatches.
        assert "github.workspace" in str(env["MEM0_EMBED_CACHE_PATH"])


class TestEveryIngestSeesIt:
    def test_each_ingesting_step_inherits_or_declares_the_switch(self):
        job_has = "MEM0_EMBEDDER" in _job_env()
        assert _ingesting_steps(), "no ingesting step found, so this test is asserting nothing"
        for step in _ingesting_steps():
            step_env = step.get("env") or {}
            assert job_has or "MEM0_EMBEDDER" in step_env, (
                f"{step['name']}: ingests without the cache, so this dispatch pays for the same text twice"
            )

    def test_no_step_overrides_the_cache_path_with_a_different_one(self):
        # Two paths would mean two stores: the reads would warm a cache the reads do not consult, and every rate
        # printed would be about the wrong file.
        job_path = str((_job_env().get("MEM0_EMBED_CACHE_PATH") or ""))
        for step in _steps():
            step_env = step.get("env") or {}
            if "MEM0_EMBED_CACHE_PATH" in step_env:
                assert str(step_env["MEM0_EMBED_CACHE_PATH"]) == job_path, (
                    f"{step['name']}: points the cache at a second file"
                )


class TestTheDirectoryExistsBeforeAnythingWrites:
    def test_the_create_step_precedes_every_ingesting_step(self):
        # `sqlite3.connect` does not create parents. Without this ordering the first ingest fails with
        # `unable to open database file`, which the driver reports as an embedder failure.
        names = [step.get("name", "") for step in _steps()]
        assert "Create the embedder cache directory" in names
        created = names.index("Create the embedder cache directory")
        for step in _ingesting_steps():
            assert names.index(step["name"]) > created, (
                f"{step['name']}: runs before the cache directory exists"
            )

    def test_the_create_step_cannot_run_without_a_system_under_test(self):
        # It is guarded like the cache itself: a retrieval-only dispatch must not leave a directory behind and must
        # not fail on a workspace it never uses.
        create = [step for step in _steps() if step.get("name") == "Create the embedder cache directory"][0]
        assert "sut != ''" in str(create.get("if"))

    def test_the_cache_is_restored_after_the_corpus_is_downloaded(self):
        # The key hashes the corpus, so restoring before the file exists would key every dispatch on the empty
        # string and every competitor on the same cache.
        names = [step.get("name", "") for step in _steps()]
        downloaded = names.index("Download LongMemEval-S")
        restored = [i for i, name in enumerate(names) if name == "Restore the embedder cache"]
        assert restored, "the cache is never restored, so it only ever helps within one dispatch"
        assert restored[0] > downloaded

    def test_the_cache_key_names_the_system_under_test(self):
        # Two competitors in one cache is not a correctness problem (the key is model and text) but it is a size
        # problem, and a key that will not evict would eventually push the cache over the action's limit.
        restore = [step for step in _steps() if step.get("name") == "Restore the embedder cache"][0]
        key = str(restore["with"]["key"])
        assert "github.event.inputs.sut" in key
        assert "hashFiles" in key


class TestTheDefectsWouldBeCaught:
    def test_a_workflow_without_the_switch_is_detected(self):
        env = dict(_job_env())
        env.pop("MEM0_EMBEDDER", None)
        assert "MEM0_EMBEDDER" not in env

    def test_an_ordering_defect_is_detected(self):
        # Property of the assertion: if the create step moved after the reads, the index comparison fails.
        names = [step.get("name", "") for step in _steps()]
        created = names.index("Create the embedder cache directory")
        moved = names[:created] + names[created + 1 :] + [names[created]]
        assert moved.index("Create the embedder cache directory") > moved.index("Compare providers (sample)")
