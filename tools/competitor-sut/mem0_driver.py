#!/usr/bin/env python3
"""Mem0 as a system under test, configured so that its number is quotable.

## What this measures, and what it refuses to claim

Mem0 is the most-reproduced memory system on LongMemEval and the reproduction disagrees with the publication:
a third-party run puts its open-source configuration at **49.0%** against a self-reported **94.4%**, and the
difference is a list of settings rather than a mistake. So the first thing this driver does is print those
settings, and the second is refuse to describe its own output as "Mem0's score".

Three settings decide what is being measured, and all three are environment variables because the point of a
reproduction is to run the *same code* several ways rather than to argue about which way is canonical:

| variable | default | what it changes |
| --- | --- | --- |
| `MEM0_INFER` | `0` | `1` runs Mem0's LLM extraction at ingest (`build: llm`, one model call per turn); `0` stores the turns as given (`build: embedding`) |
| `MEM0_LLM` | `deepseek` | the provider Mem0 uses when `infer=1`. `deepseek` is a first-class provider in mem0ai 2.x, so this is Mem0's own client and not a shim |
| `MEM0_EMBEDDER` | `openai` | `openai` is Mem0's own OpenAI client pointed at any compatible endpoint — Zhipu's `embedding-3` is one, and the Runner already holds `ZHIPU_API_KEY`, so the default needs no extra package and no model download. `fastembed` is offline but needs `pip install fastembed`, and Mem0 imports every named provider's module eagerly, so naming it without the package fails at startup |

`infer=0` is the default because `infer=1` on the full corpus is ~275,000 model calls — not a comparison, a bill.
The manifest says which one ran, so a quotation carries it.

## Why the store is one user per question

The parent calls `reset` between questions, and LongMemEval's haystack belongs to one question at a time. Mem0
partitions by `user_id`, so reusing one id across questions would make question 400 retrieve question 12's
history. `reset` drops everything, which is the same contract the other providers implement.

## Why the response shape is normalised twice

`mem0.search` has returned `{"results": [...]}` and a bare list in different 2.x releases, and `add` has
returned results with and without an `results` key. Both are handled and neither is trusted: whatever comes
back is filtered down to objects with a `memory` or `text` field, so a release that renames the envelope cannot
produce a silent zero.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

# Telemetry off before anything imports mem0: the OSS SDK posts usage events on `add`, and on a runner with no
# egress those posts retry with backoff — which shows up as an ingest that takes minutes for one session and is
# indistinguishable from a slow vector store.
os.environ.setdefault("MEM0_TELEMETRY", "False")

USER = "longmemeval"

# Embedding servers this process started, so `shutdown` can close them. A leaked thread would keep the driver
# alive after the parent asked it to stop, and the parent would then report a timeout rather than a shutdown.
_SERVERS: list[Any] = []

try:  # pragma: no cover - the import failure path is exercised by the parent, not here
    from importlib.metadata import version as _dist_version

    VERSION = _dist_version("mem0ai")
except Exception:  # pragma: no cover
    VERSION = "unknown"

try:  # pragma: no cover
    from mem0 import Memory
except Exception as error:  # pragma: no cover
    print(f"mem0 is not importable: {error}", file=sys.stderr)
    raise SystemExit(3)

# This driver's own directory, so `deterministic` can be registered as a Mem0 provider without patching the
# installed package. Appended rather than prepended: a module this directory happens to share a name with must
# still resolve to the installed one.
sys.path.append(str(__import__("pathlib").Path(__file__).resolve().parent))


def build_config() -> tuple[dict[str, Any], dict[str, Any]]:
    """The Mem0 configuration, plus the terms a reader needs in order to quote a number from it."""
    infer = os.environ.get("MEM0_INFER", "0") not in ("", "0", "false", "False")
    llm_provider = os.environ.get("MEM0_LLM", "deepseek")
    embedder_provider = os.environ.get("MEM0_EMBEDDER", "openai")
    store = os.environ.get("MEM0_VECTOR_STORE", "faiss")

    # Mem0 constructs its LLM client even when `infer=0`, and an OpenAI-compatible client refuses to exist without
    # a key. The placeholder is correct rather than a workaround: with `infer=0` the model is never called, and a
    # driver that refused to start for lack of a key it does not use would make every no-LLM reproduction need a
    # vendor account.
    llm_key = (
        os.environ.get("DEEPSEEK_API_KEY")
        or os.environ.get("MEM0_LLM_API_KEY")
        or ("unused-infer-off" if not infer else "")
    )
    config: dict[str, Any] = {
        "llm": {"provider": llm_provider, "config": {"api_key": llm_key}},
        "embedder": {"provider": embedder_provider, "config": {}},
        "vector_store": {"provider": store, "config": {"collection_name": "longmemeval"}},
    }
    embedder_notes: dict[str, Any] = {"provider": embedder_provider}
    # Resolved by whichever embedder branch below runs, then handed to the vector store. Mem0 keeps the two
    # settings apart: the embedder is told what width it produces and the store is told what width its index is,
    # and nothing checks that the two agree. Left alone, FAISS builds a 1536-dimension index (`FAISSConfig`'s
    # default) and rejects every vector of another width with a bare `AssertionError` from inside faiss.
    dimensions: int | None = None
    if embedder_provider == "deterministic":
        # No key, no network, no download. `provider: openai` because Mem0 validates its provider list against a
        # fixed table, so the only way to substitute the vectors without patching the package is to point its own
        # client at a local endpoint. Everything else on this path is Mem0's code.
        #
        # The manifest says so: a hash space is not the vendor's embedding space, and a number produced here must
        # never be quoted as "Mem0's score".
        import det_embedder

        dimensions = int(os.environ.get("MEM0_EMBEDDING_DIMS", "256"))
        SERVER = det_embedder.LocalEmbeddingServer(dimensions=dimensions)
        base_url = SERVER.start()
        _SERVERS.append(SERVER)
        config["embedder"]["provider"] = "openai"
        config["embedder"]["config"].update(
            {
                "model": "deterministic-hash",
                "embedding_dims": dimensions,
                "openai_base_url": base_url,
                "api_key": "local-deterministic",
            }
        )
        embedder_notes.update(
            {
                "provider": "openai(local stub)",
                "model": "deterministic-hash",
                "dims": dimensions,
                "comparable_to": "a hash-space run only",
            }
        )
    elif embedder_provider == "openai":
        # Explicit rather than read from ambient `OPENAI_*`: the whole point of this driver is that the report can
        # say which embedding space the vectors came from, and Mem0's default fallback would silently use
        # `text-embedding-3-small` at 1536 dimensions against whatever endpoint happened to be exported.
        dimensions = int(os.environ.get("MEM0_EMBEDDING_DIMS", os.environ.get("EMBEDDING_DIMENSIONS", "1024")))
        base_url = os.environ.get("MEM0_EMBEDDER_BASE_URL") or os.environ.get("ZHIPU_BASE_URL") or (
            "https://open.bigmodel.cn/api/paas/v4"
        )
        api_key = os.environ.get("ZHIPU_API_KEY") or os.environ.get("OPENAI_API_KEY") or ""
        config["embedder"]["config"].update(
            {
                "model": os.environ.get("MEM0_EMBEDDER_MODEL")
                or os.environ.get("ZHIPU_EMBEDDING_MODEL")
                or "embedding-3",
                "embedding_dims": dimensions,
                "openai_base_url": base_url,
                "api_key": api_key,
            }
        )
        embedder_notes.update({"model": config["embedder"]["config"]["model"], "dims": dimensions, "base_url": base_url})
    if store == "faiss":
        # A local index rather than a server, so the run has no service to start and no port to collide on.
        config["vector_store"]["config"]["path"] = os.environ.get("MEM0_FAISS_PATH", "/tmp/mem0-faiss")

    # The store has to be told the width explicitly, and refusing to guess is the point: every vector store in
    # 2.x declares `embedding_model_dims` with a default of 1536, so a driver that leaves it alone is silently
    # claiming a width no configured embedder produces unless that embedder happens to be `text-embedding-3-small`.
    # `dimensions` is `None` only for an embedder this driver does not configure, and in that case the width came
    # from somewhere the report cannot describe -- so the run stops here with a reason instead of scoring zero.
    if dimensions is None:
        raise ValueError(
            f"embedder {embedder_provider!r} does not declare an embedding width; "
            "set MEM0_EMBEDDING_DIMS so the vector store can be told the width it will receive"
        )
    config["vector_store"]["config"]["embedding_model_dims"] = dimensions

    notes = {
        "infer": infer,
        "llm": llm_provider if infer else "unused",
        "embedder": embedder_notes,
        "vector_store": store,
        # Printed because the two numbers being equal is the whole fix: the manifest is the only place a reader
        # can check that the index and the embedder were talking about the same vector space.
        "vector_store_dims": dimensions,
    }
    return config, notes


def normalise_hits(payload: Any, limit: int) -> list[dict[str, Any]]:
    """Whatever shape the release returned, reduced to the protocol's hit list."""
    if isinstance(payload, dict):
        raw = payload.get("results")
        if raw is None:
            raw = payload.get("memories")
    else:
        raw = payload
    hits: list[dict[str, Any]] = []
    for item in list(raw or [])[:limit]:
        if not isinstance(item, dict):
            continue
        text = item.get("memory") or item.get("text") or item.get("content")
        if not isinstance(text, str) or not text:
            continue
        hit: dict[str, Any] = {"text": text}
        score = item.get("score")
        if isinstance(score, (int, float)):
            hit["score"] = float(score)
        created = item.get("created_at") or item.get("timestamp")
        if isinstance(created, str):
            parsed = parse_epoch_ms(created)
            if parsed is not None:
                hit["at"] = parsed
        elif isinstance(created, (int, float)):
            hit["at"] = int(created)
        hits.append(hit)
    return hits


def parse_epoch_ms(text: str) -> int | None:
    """Mem0 returns timestamps as ISO strings; the protocol wants epoch ms or nothing."""
    from datetime import datetime, timezone

    try:
        stamp = text.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(stamp)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp() * 1000)


class Driver:
    def __init__(self) -> None:
        self.config, self.notes = build_config()
        self.memory = Memory.from_config(self.config)
        self.sessions = 0
        self.turns = 0
        self.timestamped = 0

    def manifest(self) -> dict[str, Any]:
        return {
            "ok": True,
            "name": "mem0",
            # `infer=1` builds the store with a model; `infer=0` only computes vectors. Reported from the same
            # flag that decides the behaviour, so the manifest cannot disagree with what ran.
            "build": "llm" if self.notes["infer"] else "embedding",
            "version": VERSION,
            "notes": json.dumps({**self.notes, "timestamped_sessions": self.timestamped}, sort_keys=True),
        }

    def reset(self) -> dict[str, Any]:
        self.memory.reset()
        self.sessions = 0
        self.turns = 0
        self.timestamped = 0
        return {"ok": True}

    def ingest(self, sessions: list[dict[str, Any]]) -> dict[str, Any]:
        skipped: list[str] = []
        turns = 0
        for session in sessions:
            content = session.get("turns") or []
            if not content:
                skipped.append(f"session {session.get('id', '?')} had no turns")
                continue
            messages = [
                {"role": str(turn.get("role", "user")), "content": str(turn.get("content", ""))}
                for turn in content
            ]
            at = session.get("at")
            try:
                # `timestamp=` raises "not supported by the OSS Memory SDK" in 2.x, so the session's instant
                # travels as metadata instead. That is a *real* limitation to record rather than paper over: a
                # memory system that cannot be told when a turn happened cannot answer "last month", and
                # LongMemEval's temporal questions are exactly that. `timestamped` in the manifest counts how many
                # sessions arrived with an instant so the report can state whether the comparison was even
                # possible on that axis.
                metadata = {} if at is None else {"at": int(at), "timestamp": int(at)}
                self.memory.add(
                    messages, user_id=USER, infer=self.notes["infer"], metadata=metadata or None
                )
                if at is not None:
                    self.timestamped += 1
            except Exception as error:  # noqa: BLE001 - a refused session is reportable, not fatal
                # Reported with the session id: an ingest that loses a fifth of the corpus and says nothing
                # produces a score that reads as a retrieval failure.
                skipped.append(f"session {session.get('id', '?')}: {type(error).__name__}: {error}")
                continue
            turns += len(messages)
        self.sessions += len(sessions) - len(skipped)
        self.turns += turns
        if sessions and len(skipped) == len(sessions):
            # Nothing was stored, so nothing can be retrieved, and a search over an empty index returns nothing
            # for every question. Reported as a refusal rather than as a miss: the parent then prints a failed
            # run instead of a `0.0%` row that reads as "this system retrieves nothing". The first reason
            # travels because the class of the exception is the diagnosis -- an `AssertionError` from faiss is a
            # width mismatch, a `ConnectionError` is a dead endpoint.
            return {
                "ok": False,
                "error": f"every one of {len(sessions)} session(s) was refused; first: {skipped[0]}",
                "sessions": 0,
                "turns": 0,
                "skipped": skipped,
            }
        return {"ok": True, "sessions": len(sessions) - len(skipped), "turns": turns, "skipped": skipped}

    def search(self, query: str, limit: int) -> dict[str, Any]:
        # `user_id=` at the top level is rejected in 2.x: "Use filters={'user_id': ...} instead". Both spellings
        # were tried against the installed version rather than guessed from documentation.
        payload = self.memory.search(query, filters={"user_id": USER}, top_k=limit)
        return {"ok": True, "hits": normalise_hits(payload, limit)}


def main() -> int:
    driver = Driver()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            print(json.dumps({"ok": False, "error": f"request is not JSON: {error}"}), flush=True)
            continue
        op = request.get("op")
        try:
            if op == "manifest":
                response = driver.manifest()
            elif op == "reset":
                response = driver.reset()
            elif op == "ingest":
                response = driver.ingest(list(request.get("sessions") or []))
            elif op == "search":
                limit = int(request.get("limit") or 0)
                if limit <= 0:
                    response = {"ok": False, "error": "search needs a positive limit"}
                else:
                    response = driver.search(str(request.get("query") or ""), limit)
            elif op == "shutdown":
                response = {"ok": True}
            else:
                response = {"ok": False, "error": f"unknown op {op!r}"}
        except Exception as error:  # noqa: BLE001 - the parent classifies, this reports
            response = {"ok": False, "error": f"{type(error).__name__}: {error}"}
        print(json.dumps(response), flush=True)
        if op == "shutdown" and response.get("ok"):
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
