"""One metered door in front of the model every system uses.

## Why this exists

The instruction is to race Mastra, Mem0 and MemCog **with the same LLM Cortex reads with**. Three of those systems
call a model internally -- Mem0 extracts facts at ingest, MemCog builds its store and then navigates it, Mastra's
Observer and Reflector compress a window -- and none of them reports what they spent. A comparison that says "same
reader" and leaves the internal bill to a vendor's README is the failure this repository has recorded five times:
a number that arrived without the configuration that produced it.

So the same LLM is not a promise, it is a **base URL**. Every driver points its client at this process; this process
forwards to the real endpoint and reads `usage` out of the response. The consequence is a table where the token
column is measured from the provider's own accounting rather than estimated from a request count, and where
"DeepSeek" appears in the manifest next to a `prompt_tokens` total that came back from DeepSeek.

## What it does not do

It does not cache, rewrite, normalise, truncate or re-order anything. The request body is forwarded as the bytes the
system produced and the response body is returned as the bytes the endpoint produced, so the system under test sees
exactly what it would have seen without this process in the path. That is the same criterion
`embed_cache_proxy.py` states for vectors: `criterion 3` of `03` §14.130 -- not "the score is unchanged" but "the
answers are identical question by question", which is the stronger claim and the one worth pre-registering.

## Streams are forwarded, and settled at the end

The first version of this file refused `stream: true`, on the argument that usage is only complete in the final chunk
and a proxy that summed deltas would report a number it did not measure. That argument was right about the summing
and wrong about the conclusion: Mastra's `agent.generate` is implemented over the streaming path -- the request it
sends carries `stream: true` and `stream_options.include_usage` -- so refusing it did not protect the measurement, it
made one of the three systems unrunnable (a `400` on every question, with an empty answer that looked like a memory
failure).

So the stream is forwarded chunk for chunk, byte for byte, and `usage` is read from **the chunk that carries it**
rather than accumulated from deltas: OpenAI-compatible endpoints emit one final `data:` frame whose `usage` is the
same object a non-streamed response would have carried, and that object is what gets counted. A stream that ends
without one is counted as a call with no usage -- visible, rather than silently zero.

## Why a `label` header

`X-Sut-Label` is set by each driver per phase (`memcog/build`, `memcog/navigate`, `mem0/extract`, ...). Without it a
single total says a system cost 1.4M tokens, which is not a sentence anything follows from: the interesting split is
how much of that was **building** the store and how much was **answering** the question, because a system whose
build is 90% of its bill has a different repair than one whose queries are.

## Why the counters are per model

`byModel` rather than one number. A run that silently switched model halfway through -- a router fallback, an
environment variable set for only one step -- would show up here as two rows instead of one, and the report can say
so. `deepseek-chat` is the default, but the field is not assumed.
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

DEFAULT_PORT = 8399
DEFAULT_UPSTREAM = "https://api.deepseek.com"


class Accountant:
    """The counters, and the only mutable state in this process.

    Thread-safe because `ThreadingHTTPServer` serves each request on its own thread. The lock is coarse on purpose:
    the critical section is a dict update of four integers, and a finer lock would cost more than it saves while
    making the invariant harder to see.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.reset()

    def reset(self) -> None:
        with self._lock:
            self.calls = 0
            self.failures = 0
            self.prompt_tokens = 0
            self.completion_tokens = 0
            self.reasoning_tokens = 0
            self.by_model: dict[str, dict[str, int]] = {}
            self.by_label: dict[str, dict[str, int]] = {}
            self.started_at = time.time()

    def record(
        self,
        *,
        model: str,
        label: str,
        prompt_tokens: int,
        completion_tokens: int,
        reasoning_tokens: int,
    ) -> None:
        with self._lock:
            self.calls += 1
            self.prompt_tokens += prompt_tokens
            self.completion_tokens += completion_tokens
            self.reasoning_tokens += reasoning_tokens
            for table, key in ((self.by_model, model), (self.by_label, label)):
                row = table.setdefault(
                    key,
                    {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "reasoning_tokens": 0},
                )
                row["calls"] += 1
                row["prompt_tokens"] += prompt_tokens
                row["completion_tokens"] += completion_tokens
                row["reasoning_tokens"] += reasoning_tokens

    def record_failure(self) -> None:
        with self._lock:
            self.failures += 1

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "calls": self.calls,
                "failures": self.failures,
                "prompt_tokens": self.prompt_tokens,
                "completion_tokens": self.completion_tokens,
                "reasoning_tokens": self.reasoning_tokens,
                "total_tokens": self.prompt_tokens + self.completion_tokens,
                "by_model": {k: dict(v) for k, v in self.by_model.items()},
                "by_label": {k: dict(v) for k, v in self.by_label.items()},
                "elapsed_seconds": round(time.time() - self.started_at, 3),
            }

    def snapshot_for(self, prefix: str) -> dict[str, Any]:
        """The totals for one system, selected by label prefix.

        One proxy serves every system in a run, so a single global total would put Mem0's extraction and MemCog's
        navigation in one column and make "what did this competitor cost" unanswerable. The prefix is supplied by the
        caller rather than derived here, because only the driver knows what it called itself.
        """
        with self._lock:
            rows = {k: v for k, v in self.by_label.items() if k == prefix or k.startswith(prefix + "/")}
        calls = sum(row["calls"] for row in rows.values())
        prompt = sum(row["prompt_tokens"] for row in rows.values())
        completion = sum(row["completion_tokens"] for row in rows.values())
        reasoning = sum(row["reasoning_tokens"] for row in rows.values())
        return {
            "prefix": prefix,
            "calls": calls,
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "reasoning_tokens": reasoning,
            "total_tokens": prompt + completion,
            "by_label": rows,
        }


ACCOUNTANT = Accountant()


def read_usage(payload: Any) -> tuple[int, int, int]:
    """`(prompt, completion, reasoning)` from a response body, or three zeros.

    Zeros rather than an exception: an endpoint that omits `usage` (some gateways do when a request is served from a
    prompt cache and they bill it separately) must not turn a successful answer into a failed run. The counters then
    say "no usage reported", which is a fact about the response, and `calls` still counts the request.
    """
    if not isinstance(payload, dict):
        return 0, 0, 0
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return 0, 0, 0
    prompt = int(usage.get("prompt_tokens") or 0)
    completion = int(usage.get("completion_tokens") or 0)
    details = usage.get("completion_tokens_details") or {}
    reasoning = 0
    if isinstance(details, dict):
        reasoning = int(details.get("reasoning_tokens") or 0)
    # `/v1/embeddings` reports `total_tokens` and no completion, and it is not an LLM call. Counting it as a prompt
    # token would put a competitor's embedding bill in the same column as its extraction bill, which is the collapse
    # this file's `by_label` exists to prevent.
    if completion == 0 and prompt == 0:
        prompt = int(usage.get("total_tokens") or 0)
    return prompt, completion, reasoning


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # The inherited logger writes one line per request to stderr, which the driver's parent captures. Kept, because a
    # proxy that forwards a 500 must leave a trace somewhere the run's log can show.
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003 - the base class names it
        if os.environ.get("SUT_LLM_PROXY_QUIET") == "1":
            return
        print(f"[sut-llm-proxy] {fmt % args}", flush=True)

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - the base class names it
        path, _, query = self.path.partition("?")
        if path.rstrip("/") in ("/stats", "/v1/stats"):
            prefix = ""
            for part in query.split("&"):
                key, _, value = part.partition("=")
                if key == "prefix":
                    prefix = urllib.parse.unquote(value)
            payload = ACCOUNTANT.snapshot_for(prefix) if prefix else ACCOUNTANT.snapshot()
            self._send_json(200, payload)
            return
        if self.path.rstrip("/") in ("/health", "/v1/health"):
            self._send_json(200, {"ok": True})
            return
        self._send_json(404, {"ok": False, "error": f"no route {self.path}"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") in ("/reset", "/v1/reset"):
            ACCOUNTANT.reset()
            self._send_json(200, {"ok": True})
            return
        if self.path.rstrip("/") not in ("/v1/chat/completions", "/chat/completions",
                                         "/v1/embeddings", "/embeddings"):
            self._send_json(404, {"ok": False, "error": f"no route {self.path}"})
            return

        raw = self._read_body()
        if raw is None:
            return
        try:
            request = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            self._send_json(400, {"ok": False, "error": f"request is not JSON: {error}"})
            return

        streaming = isinstance(request, dict) and request.get("stream") is True

        upstream = (os.environ.get("UPSTREAM_BASE_URL") or DEFAULT_UPSTREAM).rstrip("/")
        url = f"{upstream}{self.path}"
        key = os.environ.get("UPSTREAM_API_KEY") or os.environ.get("DEEPSEEK_API_KEY") or ""
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
        }
        model = str(request.get("model") or "unknown") if isinstance(request, dict) else "unknown"
        label = self.headers.get("X-Sut-Label") or "unlabelled"

        started = time.time()
        try:
            outgoing = urllib.request.Request(url, data=raw, headers=headers, method="POST")
            upstream_response = urllib.request.urlopen(
                outgoing, timeout=float(os.environ.get("UPSTREAM_TIMEOUT", "600"))
            )
            status = upstream_response.status
            if streaming and status < 400:
                self._relay_stream(upstream_response, model=model, label=label, started=started)
                return
            body = upstream_response.read()
            upstream_response.close()
        except urllib.error.HTTPError as error:
            body = error.read()
            status = error.code
        except Exception as error:  # noqa: BLE001 - a transport failure is a recorded failure, not a crash
            ACCOUNTANT.record_failure()
            self._send_json(502, {"ok": False, "error": f"upstream transport failed: {error}"})
            return

        elapsed = round(time.time() - started, 3)
        if status >= 400:
            ACCOUNTANT.record_failure()
        else:
            try:
                decoded = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                decoded = None
            prompt, completion, reasoning = read_usage(decoded)
            ACCOUNTANT.record(
                model=model,
                label=label,
                prompt_tokens=prompt,
                completion_tokens=completion,
                reasoning_tokens=reasoning,
            )
            log_path = os.environ.get("SUT_LLM_LOG")
            if log_path:
                with open(log_path, "a", encoding="utf-8") as log:
                    log.write(
                        json.dumps(
                            {
                                "model": model,
                                "label": label,
                                "prompt_tokens": prompt,
                                "completion_tokens": completion,
                                "reasoning_tokens": reasoning,
                                "status": status,
                                "elapsed_seconds": elapsed,
                            }
                        )
                        + "\n"
                    )

        # The body is returned byte for byte. Re-serialising would be a second place a response could change, and the
        # system under test is entitled to the endpoint's own bytes.
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _relay_stream(self, upstream_response: Any, *, model: str, label: str, started: float) -> None:
        """Forward an SSE body line by line and settle the counters when the last frame arrives.

        The bytes are written unmodified, because the system under test is parsing them: a re-serialised frame can
        differ in whitespace or key order and some clients are strict about `data: [DONE]`. Only the accounting looks
        inside, and only at `usage`.
        """
        self.send_response(upstream_response.status)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        # No `Content-Length` is possible for a stream this proxy has not buffered. `Connection: close` is what tells
        # the client where the body ends, which is why it is stated rather than left to the default.
        self.send_header("Connection", "close")
        self.end_headers()

        prompt = completion = reasoning = 0
        frames = 0
        try:
            for line in upstream_response:
                self.wfile.write(line)
                self.wfile.flush()
                frames += 1
                if not line.startswith(b"data:"):
                    continue
                payload = line[5:].strip()
                if payload in (b"", b"[DONE]"):
                    continue
                try:
                    decoded = json.loads(payload.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                # Every frame may carry a `usage` key; only the final one carries numbers. Assigning rather than
                # adding is what keeps a streamed response from being counted once per frame.
                prompt, completion, reasoning = read_usage(decoded)
        finally:
            upstream_response.close()
            self.close_connection = True
        # Counted once, after the stream ends, so `calls` is a count of conversations rather than of frames.
        ACCOUNTANT.record(
            model=model,
            label=label,
            prompt_tokens=prompt,
            completion_tokens=completion,
            reasoning_tokens=reasoning,
        )
        log_path = os.environ.get("SUT_LLM_LOG")
        if log_path:
            with open(log_path, "a", encoding="utf-8") as log:
                log.write(
                    json.dumps(
                        {
                            "model": model,
                            "label": label,
                            "prompt_tokens": prompt,
                            "completion_tokens": completion,
                            "reasoning_tokens": reasoning,
                            "status": 200,
                            "stream_frames": frames,
                            "elapsed_seconds": round(time.time() - started, 3),
                        }
                    )
                    + "\n"
                )

    def _read_body(self) -> bytes | None:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._send_json(411, {"ok": False, "error": "a request with no body carried no request"})
            return None
        return self.rfile.read(length)


def main() -> int:
    port = int(os.environ.get("SUT_LLM_PROXY_PORT") or DEFAULT_PORT)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(
        f"[sut-llm-proxy] listening on http://127.0.0.1:{port} -> "
        f"{os.environ.get('UPSTREAM_BASE_URL') or DEFAULT_UPSTREAM}",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
