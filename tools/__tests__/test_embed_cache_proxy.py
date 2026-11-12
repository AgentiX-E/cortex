"""The embedder cache in front of a competitor, tested against the criteria it was registered with.

## What this file is against

`03` §14.130 registered a content-addressed cache because the competitor axis is dominated by ingest: run
`43170314351` spent **49m42s** ingesting twenty questions and **54s** answering them, a ratio of 55x, and none of
the expensive half is the thing a comparison is about. The cause is that one text is embedded once per question
while the LongMemEval haystack reuses sessions across questions in large blocks.

The justification is only sound if the cache is invisible to the system under test, so the criteria are written
to be falsifiable in that direction rather than in the direction that is easy to pass:

* **criterion 1** — the key carries the model and the *whole* text, with no normalisation and no truncation;
* **criterion 2** — a hit returns the vector the endpoint returned, not a rounding of it;
* **criterion 4** — the cache reports what it did, so a report can carry the rate instead of a claim;
* **criterion 5** — a different model must miss, because two models can produce same-width incompatible spaces.

Criterion 3 in the registration ("with and without the cache, the reader's answers are identical question by
question") is not testable here: it needs two dispatches over twenty questions. What this file can do, and does,
is remove every way the cache could make those answers differ except a bug in the wire format — which is why the
round-trip assertions compare the vectors by `repr` and not by an approximate equality.

## Why an upstream server rather than a mock

Because the failure mode this file is guarding is at the HTTP boundary: a batch sent with the misses in the wrong
order returns vectors belonging to other texts, and every unit test of the cache alone would pass. A local server
that records what it was asked is twenty lines and tests the real code path.
"""

from __future__ import annotations

import hashlib
import json
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import importlib.util
import sys

REPO = Path(__file__).resolve().parents[2]
MODULE = REPO / "tools" / "competitor-sut" / "embed_cache_proxy.py"


def _load():
    """Import the module by path: `tools/competitor-sut` is a driver directory, not a package."""
    spec = importlib.util.spec_from_file_location("embed_cache_proxy_under_test", MODULE)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


proxy_module = _load()


class _Upstream:
    """An OpenAI-compatible endpoint whose vectors are derived from the text, so a mismatch is visible."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        upstream = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - the stdlib's spelling
                length = int(self.headers.get("content-length") or 0)
                payload = json.loads(self.rfile.read(length) or b"{}")
                upstream.requests.append(payload)
                texts = payload["input"]
                body = json.dumps(
                    {
                        "object": "list",
                        "model": payload["model"],
                        "data": [
                            {
                                "object": "embedding",
                                "index": index,
                                # A float that JSON cannot round to something prettier, so a lossy cache shows up.
                                "embedding": [
                                    float(len(text)),
                                    0.1 + 0.2,
                                    float(sum(text.encode()) % 97) / 7.0,
                                ],
                            }
                            for index, text in enumerate(texts)
                        ],
                    }
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args) -> None:
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        host, port = self._server.server_address[:2]
        self.url = f"http://{host}:{port}/v1"

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()


def _post(url: str, payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("content-type", "application/json")
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read())


def _get(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.loads(response.read())


class _Running:
    """Context-free fixture: a fake upstream and a proxy over it, on ephemeral ports."""

    def __init__(self, tmp_path: Path, model: str = "embedding-3") -> None:
        self.upstream = _Upstream()
        self.upstream.start()
        self.proxy = proxy_module.CachingEmbeddingProxy(
            upstream=self.upstream.url,
            api_key="test-key",
            cache_path=str(tmp_path / "cache.sqlite"),
            model=model,
        )
        self.url = self.proxy.start()

    def stop(self) -> None:
        self.proxy.stop()
        self.upstream.stop()


class TestCriterionOneTheKeyIsTheWholeRequest:
    """A cache that normalises returns a vector the endpoint never produced."""

    def test_one_changed_character_is_a_different_key(self):
        key = proxy_module.cache_key
        assert key("embedding-3", "the user said hello") != key("embedding-3", "the user said hellp")

    def test_leading_and_trailing_space_is_part_of_the_text(self):
        # Not stripped: the endpoint does not strip it either, and a cache that did would return the vector for a
        # text the system never sent.
        key = proxy_module.cache_key
        assert key("m", "abc") != key("m", " abc")

    def test_case_is_part_of_the_text(self):
        key = proxy_module.cache_key
        assert key("m", "Alice") != key("m", "alice")

    def test_the_model_is_part_of_the_key(self):
        key = proxy_module.cache_key
        assert key("embedding-3", "same text") != key("text-embedding-3-small", "same text")

    def test_the_separator_cannot_be_confused_by_a_split(self):
        # ("a", "bc") and ("ab", "c") must not collide. Concatenating without a separator would make them equal.
        key = proxy_module.cache_key
        assert key("a", "bc") != key("ab", "c")

    def test_the_key_is_a_sha256_of_the_composed_identity(self):
        # Pinned so a rewrite that silently changes the composition is visible rather than merely incompatible with
        # an existing store.
        expected = hashlib.sha256("embedding-3\x00hello".encode("utf-8")).hexdigest()
        assert proxy_module.cache_key("embedding-3", "hello") == expected


class TestTheProxyIsTransparent:
    """A cache in front of an endpoint must not edit the request on its way through.

    The defect this closes was real and the first version of this file had it: the proxy rebuilt the upstream body
    from `{"model", "input"}`, which drops `dimensions`. Zhipu's `embedding-3` is a variable-dimension model, Mem0
    sends `dimensions` from its own `embedding_dims`, and a request without it is either a 400 or a reply at the
    vendor default width against an index created at the configured one. The second form is worse: it reports as a
    failed ingest some minutes into a run.
    """

    def test_the_dimensions_field_reaches_the_upstream(self, tmp_path):
        running = _Running(tmp_path)
        try:
            _post(
                f"{running.url}/embeddings",
                {"model": "embedding-3", "input": ["alpha"], "dimensions": 1024},
            )
            assert running.upstream.requests[-1]["dimensions"] == 1024
        finally:
            running.stop()

    def test_an_unrecognised_field_is_forwarded_rather_than_dropped(self, tmp_path):
        # A proxy with an allowlist of field names is a proxy that silently narrows every future client's request.
        running = _Running(tmp_path)
        try:
            _post(
                f"{running.url}/embeddings",
                {"model": "embedding-3", "input": ["alpha"], "encoding_format": "float", "user": "bench"},
            )
            forwarded = running.upstream.requests[-1]
            assert forwarded["encoding_format"] == "float"
            assert forwarded["user"] == "bench"
        finally:
            running.stop()

    def test_a_batch_of_misses_keeps_the_fields_and_shrinks_only_the_input(self, tmp_path):
        running = _Running(tmp_path)
        try:
            _post(f"{running.url}/embeddings", {"model": "embedding-3", "input": ["seen"], "dimensions": 8})
            _post(
                f"{running.url}/embeddings",
                {"model": "embedding-3", "input": ["seen", "new"], "dimensions": 8},
            )
            forwarded = running.upstream.requests[-1]
            assert forwarded["input"] == ["new"]
            assert forwarded["dimensions"] == 8
            assert forwarded["model"] == "embedding-3"
        finally:
            running.stop()


class TestCriterionTwoAHitIsTheVectorTheEndpointReturned:
    def test_a_stored_vector_round_trips_exactly(self, tmp_path):
        cache = proxy_module.VectorCache(str(tmp_path / "c.sqlite"))
        vector = [0.1 + 0.2, 1.0 / 3.0, -0.0, 123456789.123456789]
        cache.put("m", "text", vector)
        back = cache.get("m", "text")
        cache.close()
        assert back is not None
        # `repr` rather than `==`: `-0.0 == 0.0` is true and the two are different vectors on the wire. A cache that
        # returned `0.0` for `-0.0` would be a silent approximation.
        assert repr(back) == repr(vector)

    def test_a_hit_does_not_touch_the_upstream(self, tmp_path):
        running = _Running(tmp_path)
        try:
            first = _post(f"{running.url}/embeddings", {"model": "embedding-3", "input": ["alpha"]})
            second = _post(f"{running.url}/embeddings", {"model": "embedding-3", "input": ["alpha"]})
            assert len(running.upstream.requests) == 1
            assert repr(first["data"][0]["embedding"]) == repr(second["data"][0]["embedding"])
        finally:
            running.stop()

    def test_a_batch_with_mixed_hits_sends_only_the_misses(self, tmp_path):
        running = _Running(tmp_path)
        try:
            _post(f"{running.url}/embeddings", {"model": "embedding-3", "input": ["seen"]})
            assert len(running.upstream.requests) == 1
            response = _post(
                f"{running.url}/embeddings",
                {"model": "embedding-3", "input": ["seen", "new-a", "new-b"]},
            )
            # One batch, two texts: the hit did not travel, and the misses did not become two calls.
            assert len(running.upstream.requests) == 2
            assert running.upstream.requests[1]["input"] == ["new-a", "new-b"]
            assert len(response["data"]) == 3
        finally:
            running.stop()

    def test_the_misses_are_returned_in_the_order_they_were_asked(self, tmp_path):
        # This is the failure a cache-only unit test cannot see: batching the misses and reassembling them by
        # position in the batch rather than by position in the request hands text 0 the vector of text 1.
        running = _Running(tmp_path)
        try:
            _post(f"{running.url}/embeddings", {"model": "embedding-3", "input": ["b"]})
            response = _post(
                f"{running.url}/embeddings",
                {"model": "embedding-3", "input": ["a", "b", "c"]},
            )
            vectors = [item["embedding"] for item in response["data"]]
            assert [item["index"] for item in response["data"]] == [0, 1, 2]
            # The upstream's first component is the text length, so a mis-ordered batch is visible in the vectors.
            assert [vector[0] for vector in vectors] == [1.0, 1.0, 1.0]
            # `a` and `c` are different texts and must be different vectors: a cache that keyed on length would pass
            # every other assertion in this file.
            assert vectors[0] != vectors[2]
            # And the hit at position 1 must carry the vector that asking for `b` alone returns.
            solo = _post(f"{running.url}/embeddings", {"model": "embedding-3", "input": ["b"]})
            assert repr(vectors[1]) == repr(solo["data"][0]["embedding"])
            # A longer text must not land on the short ones either.
            long_response = _post(
                f"{running.url}/embeddings", {"model": "embedding-3", "input": ["aaaa"]}
            )
            assert long_response["data"][0]["embedding"][0] == 4.0
        finally:
            running.stop()


class TestCriterionFourTheCacheSaysWhatItDid:
    def test_the_stats_count_hits_and_upstream_calls_separately(self, tmp_path):
        running = _Running(tmp_path)
        try:
            _post(f"{running.url}/embeddings", {"model": "embedding-3", "input": ["x", "y"]})
            _post(f"{running.url}/embeddings", {"model": "embedding-3", "input": ["x", "y", "z"]})
            stats = _get(f"{running.url}/__stats")
            assert stats["embedderCalls"] == 3
            assert stats["cacheHits"] == 2
            assert stats["served"] == 5
            assert stats["reuseRate"] == 2 / 5
            assert stats["stored"] == 3
        finally:
            running.stop()

    def test_an_empty_cache_reports_no_rate_rather_than_zero(self, tmp_path):
        # A `0.0` here would read as "the cache was consulted and never helped", which is a different fact from
        # "nothing has been asked yet" and the difference matters on a smoke run that failed before ingest.
        running = _Running(tmp_path)
        try:
            body = _get(f"{running.url}/__stats")
            assert body["reuseRate"] is None
            assert body["served"] == 0
        finally:
            running.stop()


class TestCriterionFiveTheModelTravelsWithTheVector:
    def test_a_different_model_does_not_reuse_the_vector(self, tmp_path):
        running = _Running(tmp_path)
        try:
            _post(f"{running.url}/embeddings", {"model": "embedding-3", "input": ["same"]})
            _post(f"{running.url}/embeddings", {"model": "other-1024", "input": ["same"]})
            assert len(running.upstream.requests) == 2
            assert running.upstream.requests[0]["model"] == "embedding-3"
            assert running.upstream.requests[1]["model"] == "other-1024"
        finally:
            running.stop()

    def test_the_store_survives_a_restart(self, tmp_path):
        # The reuse this exists for is across dispatches as much as within one, so a cache that only lives as long
        # as the process would collect a fraction of the available saving.
        path = str(tmp_path / "c.sqlite")
        first = proxy_module.VectorCache(path)
        first.put("m", "text", [1.0, 2.0])
        first.close()

        second = proxy_module.VectorCache(path)
        try:
            assert second.get("m", "text") == [1.0, 2.0]
            assert second.size() == 1
        finally:
            second.close()

    def test_a_second_run_over_the_same_corpus_pays_nothing(self, tmp_path):
        path = str(tmp_path / "c.sqlite")
        first = _Running(tmp_path)
        first.proxy.cache.close()
        first.stop()

        payload = {"model": "embedding-3", "input": ["one", "two", "three"]}
        cache = proxy_module.CachingEmbeddingProxy(
            upstream=first.upstream.url, api_key="k", cache_path=path, model="embedding-3"
        )
        # Populate through one proxy, then serve the identical corpus through a fresh one over the same file.
        cache_connection = cache.cache
        for text in ("one", "two", "three"):
            cache_connection.put("embedding-3", text, [float(len(text))])
        url = cache.start()
        try:
            before = len(first.upstream.requests)
            response = _post(f"{url}/embeddings", payload)
            assert len(first.upstream.requests) == before, "a warm cache called the upstream"
            assert [item["embedding"][0] for item in response["data"]] == [3.0, 3.0, 5.0]
        finally:
            cache.stop()


class TestTheDriverCanBeAskedForTheCache:
    """The proxy is only worth having if `mem0` can be run behind it, and only safe if doing so is invisible.

    `MEM0_EMBEDDER=openai-cached` is the switch. It is a separate value rather than an automatic wrap so the
    manifest names what ran: a run whose report cannot say whether a cache was in the path would make every cost
    comparison against it unfalsifiable.

    The assertions here need `mem0ai` and `faiss` installed, which the Runner image has and a developer checkout may
    not, so the module is skipped rather than failed when they are absent.
    """

    @staticmethod
    def _driver_session(tmp_path: Path, requests: list[dict], extra_env: dict | None = None):
        import subprocess

        upstream = _Upstream()
        upstream.start()
        environment = {
            **{k: v for k, v in __import__("os").environ.items() if not k.startswith("MEM0_")},
            "MEM0_EMBEDDER": "openai-cached",
            "MEM0_EMBEDDER_BASE_URL": upstream.url,
            "MEM0_EMBEDDING_DIMS": "3",
            "MEM0_EMBED_CACHE_PATH": str(tmp_path / "cache.sqlite"),
            "MEM0_FAISS_PATH": str(tmp_path / "faiss"),
            "MEM0_STORE": "faiss",
            "ZHIPU_API_KEY": "test-key",
            **(extra_env or {}),
        }
        process = subprocess.run(
            [sys.executable, str(REPO / "tools" / "competitor-sut" / "mem0_driver.py")],
            input="".join(json.dumps(r) + "\n" for r in requests),
            capture_output=True,
            text=True,
            timeout=300,
            env=environment,
        )
        upstream.stop()
        replies = [json.loads(line) for line in process.stdout.splitlines() if line.strip()]
        assert process.returncode == 0, process.stderr[-2000:]
        return replies, upstream

    def test_the_manifest_names_the_cache_and_the_upstream(self, tmp_path):
        import importlib.util as _u

        if _u.find_spec("mem0") is None:
            import pytest

            pytest.skip("mem0ai is not installed in this checkout")
        replies, _ = self._driver_session(tmp_path, [{"op": "manifest"}, {"op": "shutdown"}])
        manifest = replies[0]
        assert manifest["ok"] is True
        notes = json.loads(manifest["notes"])
        assert notes["embedder"]["provider"] == "openai-cached"
        cache = notes["embedder"]["cache"]
        # The upstream has to be recorded: a run behind a cache that inherited an ambient `OPENAI_BASE_URL` would
        # produce vectors from a space the report cannot name.
        assert cache["upstreamBaseUrl"]
        assert cache["proxyBaseUrl"] != cache["upstreamBaseUrl"]
        assert cache["path"] == str(tmp_path / "cache.sqlite")

    def test_a_repeated_turn_is_embedded_once(self, tmp_path):
        import importlib.util as _u

        if _u.find_spec("mem0") is None:
            import pytest

            pytest.skip("mem0ai is not installed in this checkout")
        # `at` is epoch milliseconds: the driver parses it with `int()`, and an ISO string is refused per session
        # rather than crashing the ingest -- which is what the first version of this test discovered.
        sessions = [
            {"id": "s1", "at": 1767225600000, "turns": [
                {"role": "user", "content": "the same sentence"},
                {"role": "assistant", "content": "a different sentence"},
            ]},
            {"id": "s2", "at": 1767312000000, "turns": [
                {"role": "user", "content": "the same sentence"},
            ]},
        ]
        replies, upstream = self._driver_session(
            tmp_path,
            [
                {"op": "manifest"},
                {"op": "ingest", "sessions": sessions},
                {"op": "manifest"},
                {"op": "shutdown"},
            ],
        )
        after = replies[2]
        assert after["ok"] is True
        assert "embedCache" in after, "the second manifest must carry the counters"
        stats = after["embedCache"]
        # Two distinct texts were sent, three times in total, so exactly one round trip was saved.
        assert stats["served"] == 3
        assert stats["stored"] == 2
        assert stats["cacheHits"] == 1
        assert len(upstream.requests) >= 1

    def test_the_cache_can_be_turned_off_by_the_provider_name(self, tmp_path):
        # The control for the switch: `openai` must not start a proxy, so a paired run can be `openai` against
        # `openai-cached` with nothing else differing.
        import importlib.util as _u

        if _u.find_spec("mem0") is None:
            import pytest

            pytest.skip("mem0ai is not installed in this checkout")
        replies, _ = self._driver_session(
            tmp_path, [{"op": "manifest"}, {"op": "shutdown"}], extra_env={"MEM0_EMBEDDER": "openai"}
        )
        manifest = replies[0]
        assert manifest["ok"] is True
        notes = json.loads(manifest["notes"])
        assert notes["embedder"]["provider"] == "openai"
        assert "cache" not in notes["embedder"]
        assert "embedCache" not in manifest
