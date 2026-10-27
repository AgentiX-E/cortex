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
