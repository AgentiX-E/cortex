"""A local, deterministic OpenAI-compatible embeddings endpoint, so Mem0 can run offline.

## Why a server instead of a subclass

Mem0 validates its embedder provider against a fixed list before any factory lookup, so a custom provider class
cannot be registered from outside the package. Its `openai` provider, however, takes an `openai_base_url` — so a
four-line HTTP server speaking the one endpoint Mem0 calls puts a deterministic embedding space behind the
*vendor's own client code*, which is the part a reproduction is trying to exercise.

Nothing about Mem0's path changes: it still batches, still parses the response, still stores what comes back.
Only the vectors are ours, and the manifest says so.

## What the vectors are

Signed feature hashing over word tokens, L2-normalised — the same construction as this repository's
`HashEmbedding` in spirit. It is not a good embedding; it is a *reproducible* one, which is what a control needs
and what a rented endpoint cannot give you.

## Why `hashlib` and not `hash`

Python's built-in `hash` is salted per process. An embedder whose vectors change between two runs of one corpus
would make every comparison involving it — including this one — a comparison of two different embedding spaces.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_TOKEN = re.compile(r"[a-z0-9]+")


def vector_of(text: str, dimensions: int) -> list[float]:
    values = [0.0] * dimensions
    for token in _TOKEN.findall(str(text).lower()):
        if len(token) < 2:
            continue
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        index = int.from_bytes(digest[:4], "big") % dimensions
        sign = 1.0 if digest[4] % 2 == 0 else -1.0
        values[index] += sign
    norm = math.sqrt(sum(value * value for value in values))
    return values if norm == 0.0 else [value / norm for value in values]


class _Handler(BaseHTTPRequestHandler):
    dimensions = 256

    def do_POST(self) -> None:  # noqa: N802 - the stdlib's spelling
        length = int(self.headers.get("content-length") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self.send_error(400, "body is not JSON")
            return
        raw = payload.get("input")
        # The endpoint accepts a string or a list, which is what OpenAI's does and what a batching client will
        # send. Getting this wrong in one direction would make every batch a 400 and the failure would read as
        # "Mem0 could not embed", not "the stub could not parse".
        texts = [raw] if isinstance(raw, str) else list(raw or [])
        body = json.dumps(
            {
                "object": "list",
                "model": payload.get("model") or "deterministic",
                "data": [
                    {"object": "embedding", "index": index, "embedding": vector_of(text, self.dimensions)}
                    for index, text in enumerate(texts)
                ],
                "usage": {"prompt_tokens": 0, "total_tokens": 0},
            }
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args) -> None:
        """Silence. A per-request access log would flood the stderr the parent quotes on failure."""


class LocalEmbeddingServer:
    """A server on an ephemeral port, started in a thread and shut down with the driver."""

    def __init__(self, dimensions: int = 256) -> None:
        handler = type("_BoundHandler", (_Handler,), {"dimensions": dimensions})
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self.dimensions = dimensions

    def start(self) -> str:
        self._thread.start()
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}/v1"

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
