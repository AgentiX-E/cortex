"""The Letta driver: the protocol on a server, and the two identity traps it must not fall into.

## Why this driver needs more than a round-trip test

Every other driver in `tools/competitor-sut/` is a library: `pip install` it and the thing you measured is the
thing the version string names. Letta is not, as of 2026-11-07, two ways:

1. `pip install letta` yields **Letta Code** (module `letta_code`, a terminal agent), not the V1 memory server;
2. `letta-ai/letta`'s `main` branch is a 15-file documentation tree pointing at `letta-code`, with the server
   retired to the `archive` branch and tags up to `0.16.8`.

So the failure mode is not a crash, it is a **successful run of the wrong product**, reported under the name of
the one MemStrata measured at 438/500. These tests therefore assert the refusals as carefully as the operations:

| asserted | why it is the point |
| --- | --- |
| `probe` refuses an endpoint without `/v1/archives/` | that is the successor product, and its number is not comparable |
| the refusal names the pinned install | a refusal that does not say what to install gets worked around |
| `ingest` returns `ok: false` when nothing was stored | `ok: true` there is a score of zero that reads as retrieval failure |
| `search` before `ingest` is a refusal | an empty archive returns `[]`, and `[]` is the system's claim, not ours |
| `reset` deletes only the id it created | a shared server must not lose someone else's store |

Everything runs on a recorder transport: no server, no key, no network, and every request the driver makes is
visible as a tuple.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

REPO = Path(__file__).resolve().parents[2]
SUT_DIR = REPO / "tools" / "competitor-sut"

sys.path.insert(0, str(SUT_DIR))

import letta_driver as driver  # noqa: E402  (path first, then the module)


class Recorder(driver.Transport):
    """A transport that scripts the answers a test cares about and answers the rest the way a server would.

    ## Why it is not a bare queue

    A queue makes every test depend on the *number* of calls the driver happens to make, so a test about passage
    tags fails when an unrelated call is added. The defaults below are what the real routes do — an archive comes
    back with an id, a batch comes back with the passages it was sent, a search comes back with a list — so a test
    writes only the answer that is the point of the test.
    """

    def __init__(self, answers: list[Any] | None = None) -> None:
        super().__init__("http://recorder.invalid")
        self.answers = list(answers or [])
        self.calls: list[tuple[str, str, Any]] = []
        self.fail_on: dict[str, driver.HttpFailure] = {}

    def request(self, method: str, path: str, body: Any | None = None) -> Any:
        self.calls.append((method, path, body))
        for prefix, failure in self.fail_on.items():
            if path.startswith(prefix):
                raise failure
        if self.answers:
            answer = self.answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer
        return self.default(method, path, body)

    @staticmethod
    def default(method: str, path: str, body: Any | None) -> Any:
        if method == "POST" and path == "/v1/archives/":
            return {"id": "archive-1"}
        if method == "POST" and path.endswith("/passages/batch"):
            sent = (body or {}).get("passages") or []
            return [{"id": f"p{index}"} for index in range(len(sent))]
        if method == "POST" and path == "/v1/passages/search":
            return []
        if method == "DELETE":
            return None
        return {}


def store_with(answers: list[Any] | None = None, **kwargs: Any) -> tuple[driver.Store, Recorder]:
    transport = Recorder(answers)
    return driver.Store(transport, "", **kwargs), transport


def test_the_manifest_declares_the_cost_class_and_the_tag_it_was_measured_at() -> None:
    store, _ = store_with()
    manifest = driver.handle(store, {"op": "manifest"}, "0.16.8")
    assert manifest["ok"] is True
    assert manifest["name"] == "letta"
    # `embedding` and not `llm` is a fact about the calls this driver makes: passages are embedded, no model is
    # asked anything. An agent-based deployment of the same server would be `llm`.
    assert manifest["build"] == "embedding"
    assert manifest["version"] == "0.16.8"
    assert driver.PINNED_TAG in manifest["notes"]
    assert "embedding-3" in manifest["notes"]
    # The dimension is in the notes because two runs in different vector spaces produce numbers that cannot be
    # placed beside each other, and nothing else in the artifact records it.
    assert "dim=1024" in manifest["notes"]


def test_the_notes_carry_what_the_driver_could_not_do(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LETTA_EMBEDDING_MODEL", "embedding-2")
    store, _ = store_with()
    store.notes = "reset could not delete archive old-id"
    manifest = driver.handle(store, {"op": "manifest"}, "0.16.8")
    assert "reset could not delete archive old-id" in manifest["notes"]
    assert "embedding=embedding-2" in manifest["notes"]


def test_search_needs_a_positive_limit() -> None:
    store, _ = store_with()
    response = driver.handle(store, {"op": "search", "query": "x", "limit": 0}, "v")
    assert response == {"ok": False, "error": "search needs a positive limit"}


def test_an_unknown_op_is_refused_rather_than_ignored() -> None:
    store, _ = store_with()
    assert driver.handle(store, {"op": "teleport"}, "v") == {"ok": False, "error": "unknown op 'teleport'"}


def test_shutdown_is_the_one_operation_with_no_payload() -> None:
    store, _ = store_with()
    assert driver.handle(store, {"op": "shutdown"}, "v") == {"ok": True}


def test_probe_reports_the_version_the_server_gave_and_not_the_one_we_hoped_for() -> None:
    transport = Recorder([{"version": "0.16.8", "status": "ok"}, []])
    assert driver.probe(transport) == {"version": "0.16.8"}
    assert transport.calls[0][:2] == ("GET", "/v1/health")


def test_probe_refuses_the_successor_product_and_says_what_to_install() -> None:
    transport = Recorder([{"version": "1.2.0"}])
    transport.fail_on["/v1/archives"] = driver.HttpFailure(404, "Not Found")
    with pytest.raises(driver.Refused) as refusal:
        driver.probe(transport)
    message = str(refusal.value)
    assert "no /v1/archives/ route" in message
    # The refusal has to carry the remedy, or it becomes a line someone deletes to get a number.
    assert driver.PINNED_INSTALL in message
    assert driver.PINNED_TAG in message


def test_probe_does_not_turn_a_broken_server_into_a_verdict() -> None:
    """A 500 on the archive listing is not evidence about the product; it is the comparison not happening."""
    transport = Recorder([{"version": "0.16.8"}])
    transport.fail_on["/v1/archives"] = driver.HttpFailure(500, "boom")
    with pytest.raises(driver.HttpFailure):
        driver.probe(transport)


def test_probe_tolerates_a_health_payload_with_no_version() -> None:
    transport = Recorder([{}, []])
    assert driver.probe(transport) == {"version": "unknown"}


def test_probe_tolerates_a_health_payload_that_is_not_an_object() -> None:
    transport = Recorder([["not", "a", "dict"], []])
    assert driver.probe(transport) == {"version": "unknown"}


def test_ingest_carries_each_turn_as_a_passage_with_its_session_its_role_and_its_time() -> None:
    store, transport = store_with([{"id": "arch-1"}])
    report = store.ingest(
        [
            {
                "id": "s1",
                "at": 1_685_000_000_000,
                "turns": [
                    {"role": "user", "content": "I adopted a golden retriever named Biscuit."},
                    {"role": "assistant", "content": "Noted."},
                ],
            }
        ]
    )
    assert report["ok"] is True
    assert report["sessions"] == 1
    assert report["turns"] == 2
    assert report["skipped"] == []
    method, path, body = transport.calls[1]
    assert (method, path) == ("POST", "/v1/archives/arch-1/passages/batch")
    first = body["passages"][0]
    assert first["text"].startswith("I adopted")
    assert first["tags"] == ["session:s1", "role:user"]
    # The timestamp is what makes the temporal capability measurable against this store at all.
    assert first["created_at"].startswith("2023-05-25T")
    assert first["created_at"].endswith("+00:00")


def test_a_session_with_no_timestamp_is_still_stored() -> None:
    store, transport = store_with()
    report = store.ingest([{"id": "s1", "turns": [{"role": "user", "content": "no time"}]}])
    assert report["ok"] is True
    assert "created_at" not in transport.calls[1][2]["passages"][0]


def test_an_empty_session_is_named_rather_than_silently_dropped() -> None:
    store, _ = store_with()
    report = store.ingest([{"id": "s-empty", "turns": []}, {"id": "s1", "turns": [{"role": "user", "content": "x"}]}])
    assert report["ok"] is True
    assert report["sessions"] == 1
    assert report["skipped"] == ["session s-empty had no turns"]


def test_a_refused_batch_is_counted_once_and_the_first_reason_is_kept() -> None:
    """Fifty thousand identical lines would bury the one thing a reader needs: which call was refused."""
    store, transport = store_with([{"id": "a"}, [], []])
    transport.fail_on["/v1/archives/a/passages/batch"] = driver.HttpFailure(400, "embedding endpoint rejected")
    report = store.ingest([{"id": "s1", "turns": [{"role": "user", "content": "x"}]}])
    # Every batch failed, so nothing was stored: a report of `ok: true` here would be a zero that reads as a
    # retrieval failure on a corpus that never entered the store.
    assert report["ok"] is False
    assert "no passage was accepted" in report["error"]


def test_a_partial_ingest_is_reported_with_the_count_it_actually_stored() -> None:
    store, transport = store_with([{"id": "a"}, [{"id": "p0"}], driver.HttpFailure(400, "second batch refused")], batch=2)
    report = store.ingest(
        [{"id": "s1", "turns": [{"role": "user", "content": f"turn {index}"} for index in range(3)]}]
    )
    assert report["ok"] is True
    assert report["turns"] == 1
    assert report["skipped"][0].startswith("passages 2-2 refused")
    assert len(transport.calls) == 3


def test_a_batch_that_returns_no_list_is_counted_by_what_was_sent() -> None:
    """A server that answers 200 with an empty body still stored the passages; the count must not become zero."""
    store, _ = store_with([{"id": "a"}, None])
    report = store.ingest([{"id": "s1", "turns": [{"role": "user", "content": "x"}]}])
    assert report["turns"] == 1


def test_an_ingest_with_no_sessions_is_not_a_failure() -> None:
    store, transport = store_with([{"id": "a"}])
    report = store.ingest([])
    assert report["ok"] is True
    assert report["turns"] == 0
    assert len(transport.calls) == 1


def test_reset_deletes_only_the_archive_this_driver_created() -> None:
    store, transport = store_with([{"id": "mine"}])
    store.create_archive()
    store.reset()
    assert transport.calls[-1] == ("DELETE", "/v1/archives/mine", None)
    assert store.archive_id is None


def test_reset_without_an_archive_makes_no_call() -> None:
    store, transport = store_with()
    store.reset()
    assert transport.calls == []


def test_a_delete_that_fails_becomes_a_note_and_not_a_crash() -> None:
    store, transport = store_with([{"id": "stale"}])
    store.create_archive()
    transport.fail_on["/v1/archives/stale"] = driver.HttpFailure(500, "gone")
    store.reset()
    # Litter rather than a wrong number: the next ingest creates a fresh id and never reads the old one, but the
    # leaked store is announced.
    assert "reset could not delete archive stale" in store.notes
    assert store.archive_id is None


def test_a_second_failed_delete_extends_the_note_rather_than_replacing_it() -> None:
    store, transport = store_with([{"id": "one"}, {"id": "two"}])
    store.notes = "an earlier note"
    store.create_archive()
    transport.fail_on["/v1/archives/one"] = driver.HttpFailure(500, "x")
    store.reset()
    assert store.notes.startswith("an earlier note; reset could not delete archive one")


def test_search_maps_passages_to_hits_with_score_and_time() -> None:
    store, transport = store_with(
        [{"id": "a"}, [], [{"passage": {"text": "Biscuit", "created_at": "2023-05-26T00:00:00Z"}, "score": 0.75}]]
    )
    store.ingest([{"id": "s1", "turns": [{"role": "user", "content": "x"}]}])
    result = store.search("dog", 5)
    assert transport.calls[-1] == ("POST", "/v1/passages/search", {"archive_id": "a", "query": "dog", "limit": 5})
    assert result["hits"] == [{"text": "Biscuit", "score": 0.75, "at": 1_685_059_200_000}]


def test_a_hit_without_a_score_or_a_readable_time_keeps_only_what_it_has() -> None:
    store, _ = store_with(
        [
            {"id": "a"},
            [],
            [{"passage": {"text": "x", "created_at": "not a time"}}],
            [{"passage": {}}],
        ]
    )
    store.ingest([{"id": "s1", "turns": [{"role": "user", "content": "x"}]}])
    first = store.search("q", 5)["hits"][0]
    assert first == {"text": "x"}
    second = store.search("q", 5)["hits"][0]
    assert second == {"text": ""}


def test_a_store_that_over_returns_is_not_truncated_here() -> None:
    """The protocol's ceiling is enforced by the parent, which fails the run. Truncating would hide the violation
    behind a plausible order and the number would be quotable."""
    hits = [{"passage": {"text": str(index)}, "score": float(index)} for index in range(7)]
    store, _ = store_with([{"id": "a"}, [], hits])
    store.ingest([{"id": "s1", "turns": [{"role": "user", "content": "x"}]}])
    assert len(store.search("q", 3)["hits"]) == 7


def test_a_search_response_that_is_not_a_list_yields_no_hits() -> None:
    store, _ = store_with([{"id": "a"}, [], {"hits": []}])
    store.ingest([{"id": "s1", "turns": [{"role": "user", "content": "x"}]}])
    assert store.search("q", 3) == {"hits": []}


def test_search_before_ingest_is_a_refusal_and_not_an_empty_result() -> None:
    """`[]` is a claim that the system found nothing. Before an ingest there is no store to find anything in."""
    store, _ = store_with()
    with pytest.raises(driver.HttpFailure):
        store.search("q", 3)
    assert driver.handle(store, {"op": "search", "query": "q", "limit": 3}, "v") == {
        "ok": False,
        "error": "HTTP 0: search before ingest: no archive exists for this question",
    }


def test_a_search_the_server_refuses_is_this_question_failing_not_the_run() -> None:
    store, transport = store_with([{"id": "a"}, []])
    store.ingest([{"id": "s1", "turns": [{"role": "user", "content": "x"}]}])
    transport.fail_on["/v1/passages/search"] = driver.HttpFailure(422, "bad query")
    response = driver.handle(store, {"op": "search", "query": "q", "limit": 3}, "v")
    assert response["ok"] is False
    assert "422" in response["error"]


def test_the_embedding_config_is_the_vector_space_the_other_arms_read_in() -> None:
    config = driver.embedding_config({})
    assert config["embedding_endpoint_type"] == "openai"
    assert config["embedding_endpoint"] == driver.DEFAULT_EMBEDDING_ENDPOINT
    assert config["embedding_model"] == "embedding-3"
    assert config["embedding_dim"] == 1024
    assert config["handle"] == "openai/embedding-3"
    # No key anywhere in the payload: the server reads it from its own environment, and a config that carried it
    # would be printed by any artifact that dumped the request.
    assert not any("key" in field.lower() for field in config)


def test_the_embedding_config_honours_every_override() -> None:
    config = driver.embedding_config(
        {
            "LETTA_EMBEDDING_ENDPOINT": "https://example.invalid/v1",
            "LETTA_EMBEDDING_MODEL": "text-embedding-3-large",
            "LETTA_EMBEDDING_DIM": "3072",
            "LETTA_EMBEDDING_CHUNK_SIZE": "512",
        }
    )
    assert config["embedding_endpoint"] == "https://example.invalid/v1"
    assert config["embedding_model"] == "text-embedding-3-large"
    assert config["embedding_dim"] == 3072
    assert config["embedding_chunk_size"] == 512
    assert config["handle"] == "openai/text-embedding-3-large"


def test_the_distribution_guard_says_nothing_when_the_server_package_is_installed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert driver.distribution_guard() is None


def test_the_distribution_guard_names_the_pypi_collision(monkeypatch: pytest.MonkeyPatch) -> None:
    real = driver.importlib.util.find_spec

    def fake(name: str, *args: Any, **kwargs: Any) -> Any:
        if name == "letta.server":
            return None
        if name == "letta_code":
            return object()
        return real(name, *args, **kwargs)

    monkeypatch.setattr(driver.importlib.util, "find_spec", fake)
    note = driver.distribution_guard()
    assert note is not None
    assert "Letta Code" in note
    assert "letta_code" in note
    assert driver.PINNED_INSTALL in note


def test_the_distribution_guard_says_nothing_when_neither_package_is_installed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The ordinary state of a client process: the server lives in its own environment. A note that said "not
    installed" on every run would train a reader to skip the field where a collision would appear."""
    monkeypatch.setattr(driver.importlib.util, "find_spec", lambda name, *a, **k: None)
    assert driver.distribution_guard() is None


def test_the_distribution_guard_survives_an_import_system_that_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def boom(name: str, *args: Any, **kwargs: Any) -> Any:
        raise ValueError(f"{name} is a module whose parent import failed")

    monkeypatch.setattr(driver.importlib.util, "find_spec", boom)
    assert driver.distribution_guard() is None


def test_a_bad_line_is_answered_and_the_stream_continues() -> None:
    store, _ = store_with()
    stream = io.StringIO('{"op": "manifest"}\nnot json\n\n{"op": "shutdown"}\n')
    responses = [response for response, _ in driver.serve(stream, store, "0.16.8")]
    assert [response["ok"] for response in responses] == [True, False, True]
    assert "not JSON" in responses[1]["error"]
    # The blank line produced no response at all, which is what keeps the one-request-one-response contract.
    assert len(responses) == 3


def test_an_http_failure_inside_a_line_does_not_end_the_stream() -> None:
    store, transport = store_with([{"id": "a"}, []])
    store.ingest([{"id": "s1", "turns": [{"role": "user", "content": "x"}]}])
    transport.fail_on["/v1/passages/search"] = driver.HttpFailure(503, "overloaded")
    stream = io.StringIO('{"op": "search", "query": "q", "limit": 2}\n{"op": "shutdown"}\n')
    responses = [response for response, _ in driver.serve(stream, store, "v")]
    assert responses[0]["ok"] is False
    assert responses[1] == {"ok": True}


def test_an_ingest_that_the_server_rejects_reaches_the_parent_as_a_failure() -> None:
    """Through `handle`, not through `serve`: the parent's `ingest` throws `SutFailure` on `ok: false`, and that
    is the behaviour a total ingest failure has to arrive at."""
    store, transport = store_with([{"id": "a"}])
    transport.fail_on["/v1/archives/a/passages/batch"] = driver.HttpFailure(400, "embedding refused")
    store.archive_id = "a"
    response = driver.handle(store, {"op": "ingest", "sessions": [{"id": "s", "turns": [{"role": "user", "content": "x"}]}]}, "v")
    assert response["ok"] is False
    assert "embedding refused" in response["error"]


def test_an_archive_creation_that_fails_is_reported_by_the_stream() -> None:
    store, transport = store_with()
    transport.fail_on["/v1/archives/"] = driver.HttpFailure(500, "database is locked")
    stream = io.StringIO('{"op": "ingest", "sessions": []}\n')
    responses = [response for response, _ in driver.serve(stream, store, "v")]
    assert responses[0]["ok"] is False
    assert "database is locked" in responses[0]["error"]


def test_main_exits_3_when_no_server_is_listening() -> None:
    """A dead endpoint is a comparison that did not happen, and the message has to say which URL was tried."""
    completed = subprocess.run(
        [sys.executable, str(SUT_DIR / "letta_driver.py")],
        input="",
        capture_output=True,
        text=True,
        timeout=120,
        env={**os.environ, "LETTA_BASE_URL": "http://127.0.0.1:1"},
    )
    assert completed.returncode == 3
    assert "not answering" in completed.stderr
    assert "127.0.0.1:1" in completed.stderr


def test_the_driver_is_registered_under_the_name_the_workflow_passes() -> None:
    """The registry in `competitor-sut.mjs` is the only place a competitor is named; a driver nobody can select
    is the §7.3 side-channel defect with a file rather than a field."""
    adapter = (SUT_DIR.parent / "competitor-sut.mjs").read_text()
    assert "letta: { script: 'letta_driver.py', name: 'letta' }" in adapter


def test_the_protocol_document_carries_the_resolution_the_driver_depends_on() -> None:
    """A reader who installs `pip install letta` gets a different product. The protocol is where that is said, so
    the fact does not live only in a driver's docstring."""
    protocol = (SUT_DIR / "PROTOCOL.md").read_text()
    assert "letta-nightly" in protocol
    assert driver.PINNED_TAG in protocol


def test_the_driver_prints_the_transcript_the_protocol_specifies() -> None:
    """One response per request, in order, as JSON on stdout — asserted on a real process with a dead endpoint
    replaced by a refusal, because the transport itself is the only part the recorder does not cover."""
    completed = subprocess.run(
        [sys.executable, str(SUT_DIR / "letta_driver.py")],
        input='{"op": "manifest"}\n',
        capture_output=True,
        text=True,
        timeout=120,
        env={**os.environ, "LETTA_BASE_URL": "http://127.0.0.1:1"},
    )
    # The endpoint is dead, so the driver exits before reading a line: that is the refusal working, and the empty
    # stdout is the proof that no manifest was ever published for a system that was not there.
    assert completed.returncode == 3
    assert completed.stdout == ""


class _Handler:
    """A stdlib HTTP handler that answers every request with the body the test chose.

    Why a real socket instead of patching `urlopen`: `Transport.request` is the one place where a status code has
    to become a `HttpFailure`, where a password has to become a header, and where a body has to become JSON. All
    three are the boundary between this driver and every system it will ever measure, and none of them can be
    verified by a fake of the same library the driver calls.
    """

    status = 200
    payload = b'{"version": "0.16.8"}'
    seen: dict[str, Any] = {}

    def do_GET(self) -> None:  # noqa: N802 - the stdlib names it
        type(self).seen = {"method": "GET", "path": self.path, "password": self.headers.get("X-BARE-PASSWORD")}
        self._respond()

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode() if length else ""
        type(self).seen = {"method": "POST", "path": self.path, "body": body}
        self._respond()

    def _respond(self) -> None:
        self.send_response(type(self).status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(type(self).payload)))
        self.end_headers()
        self.wfile.write(type(self).payload)

    def log_message(self, *args: Any) -> None:
        """Silence: the test's assertion is the record."""


def serve_once(status: int, payload: bytes) -> tuple[str, type]:
    """Stand a one-shot server up on an ephemeral port and return its base URL and handler class."""
    import http.server
    import threading

    handler = type("Handler", (_Handler, http.server.BaseHTTPRequestHandler), {"status": status, "payload": payload})
    server = http.server.HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.handle_request, daemon=True).start()
    return f"http://127.0.0.1:{server.server_address[1]}", handler


def test_the_transport_parses_a_json_body_and_carries_the_password_as_a_header() -> None:
    url, handler = serve_once(200, b'{"version": "0.16.8"}')
    transport = driver.Transport(url, password="s3cret")
    assert transport.request("GET", "/v1/health") == {"version": "0.16.8"}
    assert handler.seen == {"method": "GET", "path": "/v1/health", "password": "s3cret"}


def test_the_transport_posts_json() -> None:
    url, handler = serve_once(200, b"[]")
    assert driver.Transport(url).request("POST", "/v1/passages/search", {"query": "x"}) == []
    assert json.loads(handler.seen["body"]) == {"query": "x"}


def test_a_status_code_becomes_a_failure_that_keeps_it() -> None:
    url, _ = serve_once(404, b'{"detail": "Not Found"}')
    with pytest.raises(driver.HttpFailure) as failure:
        driver.Transport(url).request("GET", "/v1/archives/")
    assert failure.value.status == 404
    assert "Not Found" in failure.value.detail


def test_a_closed_port_is_status_zero_and_not_an_exception_about_sockets() -> None:
    with pytest.raises(driver.HttpFailure) as failure:
        driver.Transport("http://127.0.0.1:1", timeout=2).request("GET", "/v1/health")
    assert failure.value.status == 0


def test_an_empty_body_is_read_as_json_null() -> None:
    url, _ = serve_once(200, b"")
    assert driver.Transport(url).request("GET", "/v1/health") is None


def test_the_guard_is_silent_when_the_server_package_is_present(monkeypatch: pytest.MonkeyPatch) -> None:
    real = driver.importlib.util.find_spec

    def fake(name: str, *args: Any, **kwargs: Any) -> Any:
        if name == "letta.server":
            return object()
        return real(name, *args, **kwargs)

    monkeypatch.setattr(driver.importlib.util, "find_spec", fake)
    assert driver.distribution_guard() is None


def test_a_reset_request_reaches_the_store_and_nothing_else() -> None:
    store, transport = store_with([{"id": "mine"}])
    store.create_archive()
    assert driver.handle(store, {"op": "reset"}, "v") == {"ok": True}
    assert transport.calls[-1] == ("DELETE", "/v1/archives/mine", None)


def test_main_refuses_with_4_and_says_which_product_answered(monkeypatch: pytest.MonkeyPatch, capsys: Any) -> None:
    transport = Recorder([{"version": "1.2.0"}])
    transport.fail_on["/v1/archives"] = driver.HttpFailure(404, "Not Found")
    monkeypatch.setattr(driver, "Transport", lambda *a, **k: transport)
    monkeypatch.setattr(driver.sys, "stdin", io.StringIO(""))
    assert driver.main() == 4
    assert "refusing to measure" in capsys.readouterr().err


def test_main_stops_at_shutdown_and_prints_every_response(monkeypatch: pytest.MonkeyPatch, capsys: Any) -> None:
    transport = Recorder([{"version": "0.16.8"}, []])
    monkeypatch.setattr(driver, "Transport", lambda *a, **k: transport)
    monkeypatch.setattr(driver.sys, "stdin", io.StringIO('{"op": "manifest"}\n{"op": "shutdown"}\n'))
    assert driver.main() == 0
    printed = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [row["ok"] for row in printed] == [True, True]
    assert printed[0]["version"] == "0.16.8"


def test_main_returns_0_when_the_stream_ends_without_a_shutdown(monkeypatch: pytest.MonkeyPatch) -> None:
    transport = Recorder([{"version": "0.16.8"}, []])
    monkeypatch.setattr(driver, "Transport", lambda *a, **k: transport)
    monkeypatch.setattr(driver.sys, "stdin", io.StringIO('{"op": "manifest"}\n'))
    assert driver.main() == 0


def test_main_returns_3_when_the_server_is_not_answering(monkeypatch: pytest.MonkeyPatch, capsys: Any) -> None:
    """A dead endpoint is a comparison that did not happen. It must not reach the protocol loop at all, because a
    driver that starts answering `ok: false` to every question would publish 500 refusals as a system property."""
    transport = Recorder()
    transport.fail_on["/v1/health"] = driver.HttpFailure(0, "connection refused")
    monkeypatch.setattr(driver, "Transport", lambda *a, **k: transport)
    monkeypatch.setattr(driver.sys, "stdin", io.StringIO(""))
    assert driver.main() == 3
    assert "not answering" in capsys.readouterr().err
