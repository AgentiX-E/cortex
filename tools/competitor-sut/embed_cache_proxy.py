"""A content-addressed cache in front of an OpenAI-compatible embeddings endpoint.

## The cost this exists for

Run `43170314351` measured the shape of the competitor axis: the `mem0` ingest stage took **49m42s** on twenty
questions while the reading stage that follows took **54s**. A ratio of 55x, and none of it is the half a
comparison is about. The cause is structural rather than slow code:

* `PROTOCOL.md` requires one user per question (`reset` + `ingest`), so a twenty-question smoke test is twenty
  ingests, not one;
* `mem0` calls its embedder once per turn text;
* the LongMemEval haystack **reuses sessions across questions** in large blocks.

So the same text is embedded dozens of times and paid for dozens of times. This project's own memory arm is not
exposed to that: it has a content-addressed embedding cache (`cortexMemoryArmEmbeddingCachePath`).

## Why this is not a handicap for the competitor

Because the vectors are not approximated, they are returned **byte-identically**. Same text and same model imply
the same vector -- a functional fact about a deterministic endpoint, not a similarity claim -- so the system under
test sees exactly the input it would have seen. What the cache removes is a repeated network round trip and its
bill. The criterion that enforces this (`03` §14.130) is not "accuracy is unchanged" but **"the reader's answers
are identical question by question"**, which is a much stronger statement and is what `criterion 3` in that
registration asks for.

## Why SQLite and not a directory of files

The population is tens of thousands of turn texts, each ~1 KB in 1024 dimensions of JSON. One file per key makes
`open` the dominant cost and leaves the filesystem as the index. `sqlite3` is in the standard library, has an
atomic commit, and gives the cache a *name* that can be copied between runs -- which is the point, since the
reuse this exists for is across dispatches as much as within one.

## Why the key is a hash of model and text

`sha256(model + "\\0" + text)`. The NUL is a separator no model id contains, so `("a", "bc")` and `("ab", "c")` cannot
collide. The model is in the key because two models can produce vectors of the same width and a cache keyed on
text alone would hand one model's vectors to another -- silently, and only after someone changed an environment
variable. Criterion 5 of §14.130 is exactly that case.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCHEMA = """
CREATE TABLE IF NOT EXISTS embeddings (
    key TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    vector TEXT NOT NULL
)
"""


def cache_key(model: str, text: str) -> str:
    """The identity of one vector: which model, over exactly which text.

    No normalisation, no truncation, no lower-casing. A cache that "helpfully" normalises would return a vector the
    endpoint never produced, and the whole argument above rests on the vector being the one the system would have
    got.
    """
    return hashlib.sha256(f"{model}\x00{text}".encode("utf-8")).hexdigest()


class VectorCache:
    """A SQLite-backed map from `(model, text)` to the vector the endpoint returned.

    Thread-safe by one lock rather than by connection-per-thread: the server is one process serving one client, and
    a lock is easier to reason about than SQLite's `check_same_thread=False` plus a busy timeout.
    """

    def __init__(self, path: str) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._connection = sqlite3.connect(path, check_same_thread=False)
        self._connection.execute(SCHEMA)
        self._connection.commit()
        self.hits = 0
        self.misses = 0

    def get(self, model: str, text: str) -> list[float] | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT vector FROM embeddings WHERE key = ?", (cache_key(model, text),)
            ).fetchone()
            if row is None:
                self.misses += 1
                return None
            self.hits += 1
            return json.loads(row[0])

    def put(self, model: str, text: str, vector: list[float]) -> None:
        with self._lock:
            self._connection.execute(
                "INSERT OR REPLACE INTO embeddings (key, model, dimensions, vector) VALUES (?, ?, ?, ?)",
                (cache_key(model, text), model, len(vector), json.dumps(vector)),
            )
            self._connection.commit()

    def size(self) -> int:
        with self._lock:
            return self._connection.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0]

    def close(self) -> None:
        with self._lock:
            self._connection.close()


def _post(url: str, api_key: str, payload: dict, timeout: float) -> dict:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("content-type", "application/json")
    if api_key:
        request.add_header("authorization", f"Bearer {api_key}")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


class _Handler(BaseHTTPRequestHandler):
    """The two endpoints a client needs: embed, and ask the cache how it did."""

    cache: VectorCache
    upstream: str
    api_key: str
    model_default: str
    timeout: float

    def do_POST(self) -> None:  # noqa: N802 - the stdlib's spelling
        length = int(self.headers.get("content-length") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self.send_error(400, "body is not JSON")
            return
        raw = payload.get("input")
        # A string or a list, as OpenAI's endpoint accepts and as a batching client sends.
        texts = [raw] if isinstance(raw, str) else list(raw or [])
        model = payload.get("model") or self.model_default

        vectors: list[list[float] | None] = [self.cache.get(model, str(text)) for text in texts]
        missing = [index for index, vector in enumerate(vectors) if vector is None]
        if missing:
            # One upstream call for the whole miss set, so the request count falls with the hit rate rather than
            # being held constant by a per-text loop.
            #
            # Every field except `input` is forwarded verbatim. That is not tidiness: Zhipu's `embedding-3` is a
            # variable-dimension model and answers 400 when `dimensions` is omitted, and Mem0 sends it from its own
            # `embedding_dims`. A proxy that rebuilt the body from `{model, input}` would drop it and the vectors
            # would come back at the vendor's default width against an index created at the configured one -- a
            # width mismatch the vector store reports as a failed ingest rather than as what it is.
            forwarded = {key: value for key, value in payload.items() if key != "input"}
            forwarded["model"] = model
            forwarded["input"] = [str(texts[index]) for index in missing]
            response = _post(
                f"{self.upstream.rstrip('/')}/embeddings",
                self.api_key,
                forwarded,
                self.timeout,
            )
            for position, index in enumerate(missing):
                vector = response["data"][position]["embedding"]
                vectors[index] = vector
                self.cache.put(model, str(texts[index]), vector)

        body = json.dumps(
            {
                "object": "list",
                "model": model,
                "data": [
                    {"object": "embedding", "index": index, "embedding": vector}
                    for index, vector in enumerate(vectors)
                ],
                "usage": {"prompt_tokens": 0, "total_tokens": 0},
            }
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - the stdlib's spelling
        if self.path.rstrip("/") not in ("/__stats", "/v1/__stats"):
            self.send_error(404)
            return
        served = self.cache.hits + self.cache.misses
        body = json.dumps(
            {
                "cacheHits": self.cache.hits,
                "embedderCalls": self.cache.misses,
                "served": served,
                # The number §14.130 criterion 4 asks the report to print. Undefined on an empty cache, so it is
                # `null` rather than `0.0`, which would read as "the cache did nothing".
                "reuseRate": None if served == 0 else self.cache.hits / served,
                "stored": self.cache.size(),
                "path": self.cache.path,
            }
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args) -> None:
        """Silence, for the reason `det_embedder` is silent: the parent quotes stderr on failure."""


class CachingEmbeddingProxy:
    """A server on an ephemeral port, in a thread, wrapping the upstream endpoint.

    `start()` returns the base URL to hand the system under test. It ends in `/v1` because that is what Mem0's OpenAI
    client appends `/embeddings` to, and a base URL that is one path segment short would produce a 404 that reads as
    a broken embedder.
    """

    def __init__(self, upstream: str, api_key: str, cache_path: str, model: str = "", timeout: float = 60.0) -> None:
        self.cache = VectorCache(cache_path)
        handler = type(
            "_BoundHandler",
            (_Handler,),
            {
                "cache": self.cache,
                "upstream": upstream,
                "api_key": api_key,
                "model_default": model,
                "timeout": timeout,
            },
        )
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def start(self) -> str:
        self._thread.start()
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}/v1"

    def stats(self) -> dict:
        served = self.cache.hits + self.cache.misses
        return {
            "cacheHits": self.cache.hits,
            "embedderCalls": self.cache.misses,
            "served": served,
            "reuseRate": None if served == 0 else self.cache.hits / served,
            "stored": self.cache.size(),
            "path": self.cache.path,
        }

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self.cache.close()
