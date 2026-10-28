"""The system-under-test channel: five operations, three verdicts, and the errors that must not be silent.

## What is tested, and what is deliberately not

The reference driver is tested exhaustively because it is the protocol's executable specification: every
parent-side property here holds for any driver, so a competitor added to `DRIVERS` inherits the guarantees.

The Mem0 driver is **not** exercised for correctness of its numbers here — that needs a vendor key and 500
questions, which is the workflow's job. What is asserted is the property that makes a *failed* runner run
diagnosable: a driver that cannot start must produce a `SutFailure` naming the missing package, not a zero.

## Why the error classification is the point

Three things look identical in a score and mean different things:

| what happened | what it means |
| --- | --- |
| the process died | the comparison did not happen |
| the driver answered `ok: false` | the system refused this question |
| the driver answered `hits: []` | the system found nothing |

The first must abort. The second and third must be counted separately. A harness that collapses them produces a
number that reads as "the system retrieved nothing", which is a claim about the system made from a fact about the
plumbing — the exact defect this repository has now recorded four times.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
ADAPTER = REPO / "tools" / "competitor-sut.mjs"
SUT_DIR = REPO / "tools" / "competitor-sut"


def node(script: str) -> dict:
    """Run the adapter's self-test and return what it printed."""
    completed = subprocess.run(
        ["node", str(ADAPTER), script],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


def drive(*requests: dict, env: dict[str, str] | None = None) -> list[dict]:
    """Speak the protocol directly, which is how a new driver is expected to be built and debugged."""
    payload = "".join(f"{json.dumps(request)}\n" for request in requests)
    completed = subprocess.run(
        [sys.executable, str(SUT_DIR / "stub_driver.py")],
        input=payload,
        capture_output=True,
        text=True,
        timeout=120,
        env={**({"PATH": "/usr/bin:/bin"} if env is None else env)},
    )
    assert completed.returncode == 0, completed.stderr
    return [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]


def test_round_trip_through_the_adapter() -> None:
    """The five operations over a real process, asserted through the parent a harness would use."""
    result = node("")
    assert result["manifest"]["name"] == "reference/lexical"
    assert result["manifest"]["build"] == "none"
    assert result["hits"] >= 1
    assert "golden retriever" in result["firstHit"]
    # The assertion that matters most: a driver that survives `reset` would make every isolated-mode question
    # after the first one retrieve its predecessor's history, and nothing in the output would say so.
    assert result["afterReset"] == 0
    assert result["refusals"] == 0


def test_manifest_is_the_first_answer_and_carries_a_cost_class() -> None:
    [manifest] = drive({"op": "manifest"})
    assert manifest["ok"] is True
    for field in ("name", "build", "version", "notes"):
        assert isinstance(manifest[field], str) and manifest[field], field
    assert manifest["build"] in {"llm", "embedding", "none"}


def test_ingest_reports_what_it_could_not_take() -> None:
    """An ingest that silently drops sessions produces a score that reads as a retrieval failure."""
    [response] = drive(
        {
            "op": "ingest",
            "sessions": [
                {"id": "s1", "at": 1, "turns": [{"role": "user", "content": "hello there"}]},
                {"id": "s2", "at": 2, "turns": []},
            ],
        }
    )
    assert response["ok"] is True
    assert response["sessions"] == 1
    assert response["turns"] == 1
    assert len(response["skipped"]) == 1 and "s2" in response["skipped"][0]


def test_search_returns_at_most_the_limit_and_orders_by_score() -> None:
    _, response = drive(
        {
            "op": "ingest",
            "sessions": [
                {
                    "id": "s1",
                    "at": 1,
                    "turns": [
                        {"role": "user", "content": "golden retriever named Biscuit"},
                        {"role": "user", "content": "a golden retriever"},
                        {"role": "user", "content": "nothing relevant at all"},
                    ],
                }
            ],
        },
        {"op": "search", "query": "golden retriever Biscuit", "limit": 2},
    )
    hits = response["hits"]
    assert len(hits) == 2
    assert hits[0]["score"] >= hits[1]["score"]
    # The ceiling is a contract: a driver that ignores `limit` is not being compared on the same budget.
    assert all("score" in hit for hit in hits)


def test_a_zero_limit_is_a_refusal_rather_than_an_empty_answer() -> None:
    [response] = drive({"op": "search", "query": "anything", "limit": 0})
    assert response["ok"] is False
    assert "limit" in response["error"]


def test_an_unknown_operation_is_a_named_refusal() -> None:
    [response] = drive({"op": "summarise"})
    assert response["ok"] is False
    assert "summarise" in response["error"]


def test_a_line_that_is_not_json_is_answered_not_ignored() -> None:
    """A driver that prints a banner to stdout must be caught, not silently skipped."""
    completed = subprocess.run(
        [sys.executable, str(SUT_DIR / "stub_driver.py")],
        input="not json at all\n",
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert completed.returncode == 0
    response = json.loads(completed.stdout.strip())
    assert response["ok"] is False
    assert "JSON" in response["error"]


def test_the_adapter_refuses_an_unknown_system_before_spawning_anything() -> None:
    """Naming a competitor that is not wired is an error about configuration, not a run that scored zero."""
    completed = subprocess.run(
        [
            "node",
            "-e",
            "import('./tools/competitor-sut.mjs')"
            ".then(async (m) => { try { await m.createSutProvider({ driver: 'nope' }); }"
            " catch (error) { console.log(error.name + ': ' + error.message); process.exit(0); }"
            " process.exit(1); })",
        ],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert completed.returncode == 0, completed.stderr
    assert "SutFailure" in completed.stdout
    assert "known:" in completed.stdout


def test_a_driver_that_cannot_start_names_its_missing_package() -> None:
    """The property that makes a red runner job readable instead of mysterious.

    `mem0_driver.py` needs a vendor key and, for some embedders, a package. When it cannot start, the parent has
    to say *what* was missing, quoting the driver's own stderr — because "the comparison did not happen" and
    "Mem0 scored nothing" must never be the same output.
    """
    if subprocess.run(
        [sys.executable, "-c", "import mem0"], capture_output=True
    ).returncode != 0:
        pytest.skip("mem0 is not installed in this environment")

    completed = subprocess.run(
        [
            "node",
            "-e",
            "import('./tools/competitor-sut.mjs')"
            ".then(async (m) => { try { await m.createSutProvider({ driver: 'mem0',"
            " env: { MEM0_EMBEDDER: 'fastembed' } }); }"
            " catch (error) { console.log(error.name); console.log(error.message); process.exit(0); }"
            " process.exit(1); })",
        ],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert completed.returncode == 0, completed.stderr
    assert "SutFailure" in completed.stdout
    # Either the manifest could not be produced (no key) or the fastembed module is missing; both are named.
    assert any(token in completed.stdout.lower() for token in ("fastembed", "key", "could not describe itself"))


def test_harness_runs_the_sut_as_one_more_arm() -> None:
    """The wiring that makes requirement 7 a configuration rather than a fork of the harness.

    Three things have to be visible in the printed table for the row to be quotable, and this asserts all three:
    the arm appears with its own name, its `build` cost class travels with the row, and the manifest — which says
    *which* configuration produced it — is printed before any number.
    """
    completed = subprocess.run(
        ["node", str(REPO / "tools" / "competitor-harness.mjs"), "--sut", "reference", "--limit", "3"],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert completed.returncode == 0, completed.stderr
    out = completed.stdout
    assert "system under test: reference/lexical" in out
    assert "build=none" in out
    # The row itself, in the provider table: a manifest without a row would mean the arm was described and never
    # run, which is the failure mode a print-only "supported competitor" would have.
    rows = [line for line in out.splitlines() if line.startswith("reference/lexical")]
    assert rows, out
    assert "100.0%" in rows[0]
    # And the two counts that a score cannot carry.
    assert "0 refusal(s)" in out


# ---------------------------------------------------------------------------------------------------------------
# The instrument defects found on run 40519523383, asserted so they cannot return.
#
# That run printed `mem0  embedding  0.0%  0.0%  0.000  0`. It looked like a retrieval result and it was not one:
# mem0's FAISS store built a 1536-dimension index (its default) and received 1024-dimension vectors from the
# embedder this driver configured, so `faiss.SearchParametersIVF`'s `assert d == self.d` failed on every
# `add` — inside `ingest`, where the driver caught it per session and reported it as `skipped`, which nothing
# read. The store stayed empty; every `search` then failed on the same assertion and was counted as a refusal.
# Two independent defects had to line up to turn "misconfigured index width" into "the competitor retrieves
# nothing", and both are pinned below.
# ---------------------------------------------------------------------------------------------------------------


def load_mem0_driver(monkeypatch: pytest.MonkeyPatch, fake_memory: object | None = None):
    """Import `mem0_driver` against a stand-in `mem0` package.

    The real package is a 350 kB wheel plus faiss, and importing it would test pip rather than this driver. The
    driver's own logic — which dimension it declares, what it does when every session is refused — is what the
    two tests below are about, and that logic does not need the vendor's vectors.
    """
    import importlib.util
    import types

    stub = types.ModuleType("mem0")
    stub.Memory = fake_memory if fake_memory is not None else type("Memory", (), {})
    monkeypatch.setitem(sys.modules, "mem0", stub)

    path = SUT_DIR / "mem0_driver.py"
    spec = importlib.util.spec_from_file_location("mem0_driver_under_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    ("declared", "store"),
    [("1024", "faiss"), ("256", "faiss"), ("768", "qdrant")],
)
def test_mem0_tells_the_vector_store_the_width_it_will_receive(
    monkeypatch: pytest.MonkeyPatch, declared: str, store: str
) -> None:
    """A store left at its own default silently rejects every vector of a different width.

    The width is a fact about the embedder, and the store is the only other party that needs it, so the assertion
    is that the two agree for whatever the environment declared — not that some particular number is hard-coded.
    """
    driver = load_mem0_driver(monkeypatch)
    monkeypatch.setenv("MEM0_EMBEDDER", "openai")
    monkeypatch.setenv("MEM0_VECTOR_STORE", store)
    monkeypatch.setenv("MEM0_EMBEDDING_DIMS", declared)
    monkeypatch.setenv("ZHIPU_API_KEY", "not-a-real-key")

    config, notes = driver.build_config()

    assert config["vector_store"]["config"]["embedding_model_dims"] == int(declared), config
    assert config["embedder"]["config"]["embedding_dims"] == int(declared), config
    assert notes["embedder"]["dims"] == int(declared)


def test_mem0_refuses_a_run_whose_ingest_took_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    """Zero sessions stored is a broken comparison, and a broken comparison is not a score of zero.

    Per-session skipping is right — one malformed session should not lose the other four hundred — but when
    *every* session is refused the run has measured nothing, and the parent has to be told so it can abort instead
    of printing a row.
    """

    class Refusing:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        @classmethod
        def from_config(cls, _config):
            return cls()

        def add(self, *_args, **_kwargs):
            raise AssertionError  # the exact exception faiss raised, message and all

        def reset(self) -> None:
            pass

    driver = load_mem0_driver(monkeypatch, fake_memory=Refusing)
    monkeypatch.setenv("MEM0_EMBEDDER", "openai")
    monkeypatch.setenv("MEM0_EMBEDDING_DIMS", "1024")
    monkeypatch.setenv("ZHIPU_API_KEY", "not-a-real-key")
    instance = driver.Driver()

    response = instance.ingest(
        [
            {"id": "s1", "turns": [{"role": "user", "content": "one"}]},
            {"id": "s2", "turns": [{"role": "user", "content": "two"}]},
        ]
    )

    assert response["ok"] is False, response
    assert response["sessions"] == 0
    # The reason travels, because "0.0%" without it is what the defective run printed.
    assert "AssertionError" in response["error"]
    assert len(response["skipped"]) == 2


def test_mem0_keeps_going_when_only_some_sessions_are_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    """The other half of the same rule: partial loss is reported and survived, total loss aborts."""

    class HalfRefusing:
        def __init__(self, *_args, **_kwargs) -> None:
            self.calls = 0

        @classmethod
        def from_config(cls, _config):
            return cls()

        def add(self, messages, **_kwargs):
            self.calls += 1
            if self.calls == 1:
                raise ValueError("this session is malformed")
            return {"results": []}

        def reset(self) -> None:
            pass

    driver = load_mem0_driver(monkeypatch, fake_memory=HalfRefusing)
    monkeypatch.setenv("MEM0_EMBEDDER", "openai")
    monkeypatch.setenv("MEM0_EMBEDDING_DIMS", "1024")
    monkeypatch.setenv("ZHIPU_API_KEY", "not-a-real-key")
    instance = driver.Driver()

    response = instance.ingest(
        [
            {"id": "s1", "turns": [{"role": "user", "content": "one"}]},
            {"id": "s2", "turns": [{"role": "user", "content": "two"}]},
        ]
    )

    assert response["ok"] is True, response
    assert response["sessions"] == 1
    assert len(response["skipped"]) == 1 and "s1" in response["skipped"][0]


def test_the_report_names_what_ingest_could_not_take() -> None:
    """A score is only quotable alongside the corpus that reached the store.

    The run that motivated this printed `0.0%` for a competitor whose every `add` had failed; the number was
    produced from an empty index and nothing in the report said so. The stub driver refuses sessions on request
    (`STUB_SKIP_FIRST`), which is how the report path is exercised without a vendor key or a corrupt corpus.
    """
    completed = subprocess.run(
        ["node", str(REPO / "tools" / "competitor-harness.mjs"), "--sut", "reference", "--limit", "3"],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=300,
        env={**os.environ, "STUB_SKIP_FIRST": "2"},
    )
    assert completed.returncode == 0, completed.stderr
    out = completed.stdout
    # Counts stored and offered, not just the skips: "3 refused" against 960 is a different report from the same
    # sentence against 6, and the reader cannot tell them apart without both numbers.
    assert "ingest: " in out, out
    stored = re.search(r"ingest: (\d+) of (\d+) session\(s\) stored, (\d+) refused", out)
    assert stored is not None, out
    kept, offered, refused = (int(group) for group in stored.groups())
    assert offered > kept > 0
    assert kept + refused == offered
    # And a reason, because a count without one sends the reader to the driver's source.
    assert "STUB_SKIP_FIRST" in out


def test_a_run_that_stored_nothing_aborts_instead_of_scoring_zero() -> None:
    """The parent side of the same rule: total ingest loss is a failed comparison, not a result."""
    completed = subprocess.run(
        ["node", str(REPO / "tools" / "competitor-harness.mjs"), "--sut", "reference", "--limit", "3"],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=300,
        env={**os.environ, "STUB_SKIP_FIRST": "100000"},
    )
    assert completed.returncode != 0, completed.stdout
    assert "SutFailure" in (completed.stdout + completed.stderr)
    # The row must not exist: a table with a `0.0%` line for this arm would be read as a retrieval result.
    assert not any(line.startswith("reference/lexical") for line in completed.stdout.splitlines()), (
        completed.stdout
    )
