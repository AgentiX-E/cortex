"""The bridge that lets a competitor's harness read this store: five ops, and the failure that must not be silent.

## Why this file exists

`tools/competitor-sut/PROTOCOL.md` defines the protocol in one direction: a competitor's store as *our* child.
`tools/competitor-adapter/bridge.mjs` is the same protocol in the other direction — this store as *their* child —
and a second implementation of one document is exactly how two protocols drift apart. So the assertions here are
the document's own rows: the five ops, the `{"ok": false}` envelope, and the ceiling on `search`.

## What is deliberately not asserted

The **retrieval quality**. That needs the 500-question corpus and is the run's job, not a unit test's. What is
asserted is that a wrong retrieval cannot be confused with a broken channel: a refusal is `ok: false` with one
line, an empty result is `ok: true` with `hits: []`, and a crash is neither.

## The one structural check on the Python side

Their `Provider` is an ABC, and a subclass missing a method cannot be instantiated — which would be a run that
fails after ingestion. The five names are read out of the AST rather than imported, because importing needs their
tree, and a test that silently skips when their tree is absent is a test that never runs.
"""

from __future__ import annotations

import ast
import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BRIDGE = REPO / "tools" / "competitor-adapter" / "bridge.mjs"
ADAPTER = REPO / "tools" / "competitor-adapter" / "cortex_adapter.py"


def session(session_id: str, text: str, at: int = 1_685_000_000_000) -> dict:
    return {
        "id": session_id,
        "at": at,
        "turns": [{"role": "user", "content": f"[2023/05/20 (Sat) 03:51] user: {text}"}],
    }


def converse(requests: list[dict | str]) -> list[dict]:
    """Send each request as one line and read one response per line, which is the protocol."""
    payload = "".join(
        (request if isinstance(request, str) else json.dumps(request)) + "\n" for request in requests
    )
    completed = subprocess.run(
        ["node", str(BRIDGE)],
        input=payload,
        capture_output=True,
        text=True,
        timeout=180,
        cwd=REPO,
    )
    assert completed.returncode == 0, completed.stderr
    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    assert len(lines) == len(requests), f"{len(requests)} requests, {len(lines)} responses: {lines}"
    return [json.loads(line) for line in lines]


def test_manifest_names_the_arm_and_its_cost_class() -> None:
    (manifest,) = converse([{"op": "manifest"}])
    assert manifest["ok"] is True
    for field in ("name", "build", "version", "notes"):
        assert isinstance(manifest[field], str) and manifest[field] != "", field
    # `none`, because the ranking signal is term overlap. A wrong cost class is the one field that makes two rows
    # look like they came from the same kind of machine when they did not.
    assert manifest["build"] == "none"
    assert manifest["name"] == "cortex-session"


def test_ingest_reports_what_it_took() -> None:
    responses = converse(
        [
            {"op": "ingest", "sessions": [session("s1", "I adopted a golden retriever named Biscuit.")]},
            {"op": "search", "query": "golden retriever", "limit": 5},
        ]
    )
    ingest, search = responses
    assert ingest == {"ok": True, "sessions": 1, "turns": 1, "skipped": []}
    assert search["ok"] is True
    assert len(search["hits"]) == 1
    # The timestamp prefix is what the ingest was given, byte for byte: the adapter's job is transport, and a
    # renderer that rewrote the turn would be a second rendering of the corpus.
    assert search["hits"][0]["text"].startswith("[2023/05/20 (Sat) 03:51] user: ")


def test_reset_empties_the_store() -> None:
    responses = converse(
        [
            {"op": "ingest", "sessions": [session("s1", "I adopted a golden retriever named Biscuit.")]},
            {"op": "search", "query": "biscuit", "limit": 5},
            {"op": "reset"},
            {"op": "search", "query": "biscuit", "limit": 5},
        ]
    )
    assert len(responses[1]["hits"]) == 1
    assert responses[2] == {"ok": True}
    # The defect this guards: a store that kept its sessions across containers answers every question from every
    # corpus it has ever seen, which scores well and measures nothing.
    assert responses[3]["hits"] == []


def test_search_honours_the_ceiling_the_protocol_makes_the_caller_s_contract() -> None:
    sessions = [session(f"s{index}", f"the running log of week {index}") for index in range(4)]
    responses = converse(
        [
            {"op": "ingest", "sessions": sessions},
            {"op": "search", "query": "running log", "limit": 2},
        ]
    )
    assert len(responses[1]["hits"]) <= 2


def test_a_refusal_is_a_response_and_not_a_broken_pipe() -> None:
    responses = converse(
        [
            {"op": "nonsense"},
            {"op": "ingest", "sessions": [{"turns": []}]},
            "{not json",
            {"op": "manifest"},
        ]
    )
    for refusal in responses[:3]:
        assert refusal["ok"] is False
        assert isinstance(refusal["error"], str) and refusal["error"] != ""
        # One line, because the parent reads one line per response and a second line would desynchronise it.
        assert "\n" not in refusal["error"]
    # The channel survived all three: the fourth response is the manifest again.
    assert responses[3]["ok"] is True


def test_shutdown_answers_and_then_stops() -> None:
    responses = converse([{"op": "shutdown"}])
    assert responses[0] == {"ok": True}


def test_the_python_adapter_defines_every_method_their_abc_requires() -> None:
    tree = ast.parse(ADAPTER.read_text(encoding="utf-8"))
    provider = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "CortexProvider"
    )
    defined = {
        node.name
        for node in provider.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    # `runner/types.Provider`'s abstract set, plus the lifecycle this side adds.
    assert {"initialize", "ingest", "await_indexing", "search", "clear", "close"} <= defined
    # `name` and `build` are read by their report: a provider without them is a row with no label.
    assert provider.bases and provider.bases[0].id == "Provider"
