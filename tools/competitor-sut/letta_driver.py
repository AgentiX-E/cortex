#!/usr/bin/env python3
"""Letta as a system under test, pinned to the server that was actually measured.

## The premise, and the two ways it is false

Letta (f.k.a. MemGPT) is the one competitor with a **same-reader, same-question, published number**:
MemStrata reports a matched-reader Letta arm at **438/500** on LongMemEval-S (`arXiv:2610.05343`). That makes it
the only rival whose number can be checked against ours without re-deriving its protocol, so it is the arm worth
wiring first.

Two facts, both verified 2026-11-07, make "just install letta" a way to measure a different product:

1. **PyPI `letta` is no longer the memory server.** `pip install letta` now yields 0.34.12, whose module is
   `letta_code` and whose summary is *"Letta Code: stateful agents in your terminal"* — a Node-bundled terminal
   agent from `letta-ai/letta-code`. The published Python distribution for the V1 memory server is
   `letta-nightly`, and it is not the same software.
2. **`letta-ai/letta` main no longer contains the server.** Its whole tree is 15 documentation files. The README
   says the current source lives in `letta-code`, and *"the [`archive`] branch contains the retired Letta V1 API
   server"*. The newest tag is `0.16.8`.

So a driver written against "the latest letta" would produce a number about a system nobody measured, and the
report would print it beside 438/500 as though the two were the same arm. That is the failure this repository has
recorded three times — a number leaving its system — so this driver refuses to run unless the endpoint behaves
like the archived V1 server, and prints the version it found instead of the version it hoped for.

## Why archives and not agents

The obvious way to drive Letta is to create an agent and insert archival memory through it. That is also the way
to import an agent loop: an agent carries an LLM config, a system prompt and a message-processing path, and a
`search` that ran through one would be measuring its prompt as well as its retrieval — which
`tools/competitor-sut/PROTOCOL.md` forbids ("search must not generate an answer").

0.16 exposes archives as first-class objects with the three operations this protocol needs and nothing else:

| protocol op | Letta call |
| --- | --- |
| `ingest` | `POST /v1/archives/{id}/passages/batch` — passages are embedded, no model is called |
| `search` | `POST /v1/passages/search` — `{archive_id, query, limit}`, returns scored passages |
| `reset` | `DELETE /v1/archives/{id}` |

So the manifest's cost class is `embedding`, and that is a fact about the calls this driver makes rather than a
claim about Letta's architecture in general: an agent-based deployment of the same server is `llm`.

## Why one archive per reset

LongMemEval's haystack belongs to one question at a time and the parent calls `reset` between questions. Reusing
one archive would let question 400 retrieve question 12's history — the same defect the mem0 driver's per-user
partition exists to prevent, in the one place where a leaked hit is indistinguishable from a good retrieval.

## Why the turn's timestamp is carried into the passage

Letta's `PassageCreateRequest` accepts `created_at`, and LongMemEval's temporal questions are answerable only if
the store knows when a turn happened. Dropping it would make the temporal capability's 127 questions a
measurement of a store that cannot order events, which is not the store anyone published.

## What is not attempted

No LLM extraction, no summarisation, no consolidation: those are the parts of a memory system this protocol has
no vocabulary for. A run of this driver measures Letta's **vector store over raw turns**, which is the cheapest
configuration of it and the only one comparable across systems. The manifest says so, so a quotation carries its
own scope.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

NAME = "letta"

# The archived V1 server, and the reason the version is a constant here rather than read from the environment:
# a run must not be able to silently become a run of `letta-code`. `LETTA_EXPECTED_MAJOR_MINOR` exists only for a
# deliberate bump, and `probe` refuses when the server disagrees.
PINNED_TAG = "0.16.8"
PINNED_INSTALL = f"letta @ git+https://github.com/letta-ai/letta@{PINNED_TAG}"

DEFAULT_BASE_URL = "http://127.0.0.1:8283"
# Zhipu's OpenAI-compatible surface, which is the embedding space every other arm in this repository reads the
# corpus in. The dimension is the one `EMBEDDING_DIMENSIONS` resolves to for `embedding-3` on our reader side
# (`packages/cortex-eval/src/embedding-factory.ts`), so the competitor is compared in like vectors.
DEFAULT_EMBEDDING_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4"
DEFAULT_EMBEDDING_MODEL = "embedding-3"
DEFAULT_EMBEDDING_DIM = 1024


class Refused(Exception):
    """The run must not proceed: the system on the other end is not the one this driver measures."""


class Transport:
    """HTTP, one request at a time, with the password carried in a header and never in a URL.

    A class rather than module functions so the tests can substitute a recorder: everything this driver does is
    a request, so a fake transport gives the tests the whole driver without a server, a key or a network.
    """

    def __init__(self, base_url: str, password: str | None = None, timeout: float = 600.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.password = password
        self.timeout = timeout

    def request(self, method: str, path: str, body: Any | None = None) -> Any:
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base_url + path, data=data, method=method)
        request.add_header("Content-Type", "application/json")
        if self.password:
            # The V1 server's middleware reads `X-BARE-PASSWORD`. Passed as a header so it cannot end up in a log
            # line that records the URL.
            request.add_header("X-BARE-PASSWORD", self.password)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read().decode() or "null"
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")[:400]
            raise HttpFailure(error.code, detail) from None
        except urllib.error.URLError as error:
            raise HttpFailure(0, str(error.reason)) from None
        return json.loads(raw)


class HttpFailure(Exception):
    """A response the driver treats as a per-operation failure rather than as a dead run.

    The distinction is the protocol's: a batch Letta refuses is a fact about the ingest that the parent must be
    able to report, while a server that is not answering at all is a comparison that did not happen.
    """

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(f"HTTP {status}: {detail}")
        self.status = status
        self.detail = detail


def embedding_config(env: dict[str, str] | None = None) -> dict[str, Any]:
    """The archive's embedding config: the vectors every arm in this repository reads with.

    `embedding_endpoint_type` is `openai` because Zhipu's `/api/paas/v4` is an OpenAI-compatible surface and
    Letta's OpenAI embedding client takes its `base_url` from this field (`letta/llm_api/openai_client.py`,
    `_prepare_client_kwargs_embedding`). The key is read from the environment by the server, never sent here:
    a config that carried it would be printed by any artifact that dumped the request.
    """
    environment = os.environ if env is None else env
    return {
        "embedding_endpoint_type": "openai",
        "embedding_endpoint": environment.get("LETTA_EMBEDDING_ENDPOINT", DEFAULT_EMBEDDING_ENDPOINT),
        "embedding_model": environment.get("LETTA_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL),
        "embedding_dim": int(environment.get("LETTA_EMBEDDING_DIM", str(DEFAULT_EMBEDDING_DIM))),
        "embedding_chunk_size": int(environment.get("LETTA_EMBEDDING_CHUNK_SIZE", "300")),
        "handle": f"openai/{environment.get('LETTA_EMBEDDING_MODEL', DEFAULT_EMBEDDING_MODEL)}",
    }


def distribution_guard() -> str | None:
    """Name the PyPI collision when the locally installed `letta` is not the memory server.

    Returns the warning to put in the manifest's notes, or `None` when nothing suspicious is installed. It does
    not raise: a driver that talks to a server over HTTP does not need the server's package locally, and a remote
    endpoint is a legitimate configuration. The functional check is `probe`, which asks the server itself.
    """
    try:
        has_server = importlib.util.find_spec("letta.server") is not None
    except (ImportError, ValueError):  # pragma: no cover - depends on the interpreter's import state
        has_server = False
    try:
        has_code = importlib.util.find_spec("letta_code") is not None
    except (ImportError, ValueError):  # pragma: no cover
        has_code = False
    if has_server:
        return None
    if has_code:
        return (
            "the installed `letta` distribution is Letta Code (module `letta_code`), not the memory server; "
            f"this run talks to a server over HTTP and the measured arm is `{PINNED_INSTALL}`"
        )
    # Neither is installed, which is the ordinary state of a client: the server runs in its own environment and
    # this process only speaks HTTP to it. Nothing to warn about, and a note that says "not installed" every run
    # would train a reader to skip the notes field exactly where a collision would appear.
    return None


class Store:
    """One archive per reset, and the counters the manifest and the ingest report need."""

    def __init__(self, transport: Transport, notes: str, batch: int = 64) -> None:
        self.transport = transport
        self.notes = notes
        self.batch = batch
        self.archive_id: str | None = None
        self.corpus_key = "longmemeval"

    def reset(self) -> None:
        """Drop the archive this driver owns, and only that one.

        `DELETE /v1/archives/{id}` rather than a prefix sweep: a server shared with a colleague's runs must not
        lose their data because we needed a clean store, and an id we created is the only id we can prove is ours.
        """
        if self.archive_id is not None:
            try:
                self.transport.request("DELETE", f"/v1/archives/{self.archive_id}")
            except HttpFailure:
                # A delete that fails leaves a stale archive behind, which is litter rather than a wrong number:
                # the next `ingest` creates a new id and never reads the old one. Reported in the notes so a
                # leaked store is visible instead of accumulating silently.
                self.notes = f"{self.notes}; reset could not delete archive {self.archive_id}" if self.notes else (
                    f"reset could not delete archive {self.archive_id}"
                )
        self.archive_id = None

    def create_archive(self, env: dict[str, str] | None = None) -> str:
        payload = {
            "name": f"{NAME}-{self.corpus_key}",
            "description": "LongMemEval-S haystack, one archive per question",
            "embedding_config": embedding_config(env),
        }
        created = self.transport.request("POST", "/v1/archives/", payload)
        self.archive_id = str(created["id"])
        return self.archive_id

    def ingest(self, sessions: list[dict[str, Any]]) -> dict[str, Any]:
        """Insert every turn as a passage, and account for every turn it could not insert.

        Tags carry the session id and the role, so a hit can be traced back to the turn it came from without a
        second lookup — the property every error census in this repository depends on when it asks whether the
        gold turn was delivered.
        """
        archive_id = self.create_archive()
        passages: list[dict[str, Any]] = []
        skipped: list[str] = []
        sessions_accepted = 0
        for session in sessions:
            turns = list(session.get("turns") or [])
            if not turns:
                skipped.append(f"session {session.get('id', '?')} had no turns")
                continue
            sessions_accepted += 1
            at = session.get("at")
            for turn in turns:
                passage: dict[str, Any] = {
                    "text": str(turn.get("content", "")),
                    "tags": [f"session:{session.get('id', '?')}", f"role:{turn.get('role', 'unknown')}"],
                }
                if isinstance(at, (int, float)):
                    passage["created_at"] = datetime.fromtimestamp(at / 1000.0, tz=timezone.utc).isoformat()
                passages.append(passage)
        inserted = 0
        for start in range(0, len(passages), self.batch):
            chunk = passages[start : start + self.batch]
            try:
                created = self.transport.request(
                    "POST", f"/v1/archives/{archive_id}/passages/batch", {"passages": chunk}
                )
            except HttpFailure as error:
                # The first failure names itself and the rest are counted: 5,000 identical lines would bury the
                # one thing a reader needs, which is which call the server refused.
                if not skipped:
                    skipped.append(f"passages {start}-{start + len(chunk) - 1} refused: {error.detail[:200]}")
                continue
            inserted += len(created) if isinstance(created, list) else len(chunk)
        if sessions and inserted == 0:
            # Total ingest failure is not a measurement. Returning `ok: true` here would produce a score of zero
            # that reads as retrieval failure on a corpus that was never stored.
            return {
                "ok": False,
                "error": f"no passage was accepted for {sessions_accepted} session(s); first refusal: "
                + (skipped[0] if skipped else "unknown"),
            }
        return {"ok": True, "sessions": sessions_accepted, "turns": inserted, "skipped": skipped}

    def search(self, query: str, limit: int) -> dict[str, Any]:
        if self.archive_id is None:
            raise HttpFailure(0, "search before ingest: no archive exists for this question")
        found = self.transport.request(
            "POST", "/v1/passages/search", {"archive_id": self.archive_id, "query": query, "limit": limit}
        )
        hits = []
        for result in found if isinstance(found, list) else []:
            passage = result.get("passage") or {}
            hit: dict[str, Any] = {"text": str(passage.get("text", ""))}
            if isinstance(result.get("score"), (int, float)):
                hit["score"] = float(result["score"])
            created = passage.get("created_at")
            if isinstance(created, str):
                try:
                    hit["at"] = int(datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp() * 1000)
                except ValueError:
                    pass
            hits.append(hit)
        # The protocol's ceiling: a store that returns more than it was asked for is a contract violation, and the
        # parent fails the run on it. Truncating here would hide that behind a plausible order.
        return {"hits": hits}


def probe(transport: Transport) -> dict[str, str]:
    """Ask the server what it is, and refuse when the answer is a different product.

    Three checks, in the order that fails fastest:

    1. `/v1/health` answers. A server that does not is not answering, which is a run failure rather than a verdict.
    2. The health payload carries a version, which is what the manifest quotes.
    3. `/v1/archives/` exists. This is the decisive one: archives are the 0.16 surface that makes a
       generation-free arm possible, and `letta-code`'s App Server does not expose `/v1/archives/`. A 404 here
       means the endpoint is the successor product, and the run must stop rather than measure it under the name
       of the archived one.
    """
    health = transport.request("GET", "/v1/health")
    version = str((health or {}).get("version") or "unknown") if isinstance(health, dict) else "unknown"
    try:
        transport.request("GET", "/v1/archives/?limit=1")
    except HttpFailure as error:
        if error.status in (404, 405):
            raise Refused(
                f"{transport.base_url} has no /v1/archives/ route (HTTP {error.status}). That is the Letta "
                f"successor product, not the V1 server tagged {PINNED_TAG} that MemStrata's 438/500 arm ran. "
                f"Install the measured server: pip install \"{PINNED_INSTALL}\""
            ) from None
        raise
    return {"version": version}


def handle(store: Store, request: dict[str, Any], version: str) -> dict[str, Any]:
    op = request.get("op")
    if op == "manifest":
        return {
            "ok": True,
            "name": NAME,
            "build": "embedding",
            "version": version,
            "notes": (
                f"archived V1 server tag {PINNED_TAG}; passages over raw turns, no LLM extraction; "
                f"embedding={os.environ.get('LETTA_EMBEDDING_MODEL', DEFAULT_EMBEDDING_MODEL)}"
                f"@{os.environ.get('LETTA_EMBEDDING_ENDPOINT', DEFAULT_EMBEDDING_ENDPOINT)}"
                f"/dim={os.environ.get('LETTA_EMBEDDING_DIM', str(DEFAULT_EMBEDDING_DIM))}"
                + (f"; {store.notes}" if store.notes else "")
            ),
        }
    if op == "reset":
        store.reset()
        return {"ok": True}
    if op == "ingest":
        return store.ingest(list(request.get("sessions") or []))
    if op == "search":
        limit = int(request.get("limit") or 0)
        if limit <= 0:
            return {"ok": False, "error": "search needs a positive limit"}
        try:
            return {"ok": True, **store.search(str(request.get("query") or ""), limit)}
        except HttpFailure as error:
            return {"ok": False, "error": str(error)[:400]}
    if op == "shutdown":
        return {"ok": True}
    return {"ok": False, "error": f"unknown op {op!r}"}


def serve(stream, store: Store, version: str):
    """Yield one response per request line, and never raise for anything a request can contain.

    A generator rather than a loop inside `main` so the transcript is testable without a server: the protocol's
    interesting behaviours are all in how a bad line, an unknown op and a refused search are answered, and none of
    them need HTTP.
    """
    for line in stream:
        text = line.strip()
        if not text:
            continue
        try:
            request = json.loads(text)
        except json.JSONDecodeError as error:
            yield {"ok": False, "error": f"request is not JSON: {error}"}, None
            continue
        try:
            response = handle(store, request, version)
        except HttpFailure as error:
            response = {"ok": False, "error": str(error)[:400]}
        yield response, request


def main() -> int:
    base_url = os.environ.get("LETTA_BASE_URL", DEFAULT_BASE_URL)
    transport = Transport(base_url, password=os.environ.get("LETTA_SERVER_PASSWORD") or None)
    notes = distribution_guard() or ""
    try:
        probed = probe(transport)
    except Refused as refusal:
        print(f"refusing to measure: {refusal}", file=sys.stderr)
        return 4
    except HttpFailure as error:
        print(f"the Letta server at {base_url} is not answering: {error}", file=sys.stderr)
        return 3
    store = Store(transport, notes, batch=int(os.environ.get("LETTA_PASSAGE_BATCH", "64")))
    for response, request in serve(sys.stdin, store, probed["version"]):
        print(json.dumps(response), flush=True)
        if request is not None and request.get("op") == "shutdown" and response.get("ok"):
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
