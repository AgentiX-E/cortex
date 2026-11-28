"""The metered LLM proxy: what it forwards, what it counts, and what it refuses.

## Why these assertions and not a coverage number

The proxy sits between three competitors and the one model they are all supposed to share. Every property below is
one a wrong number would survive:

* **bytes** -- a body that is re-serialised can differ in key order, float formatting or unicode escaping, and the
  system under test would then be reading a response the endpoint never sent. Asserted on the raw bytes.
* **usage** -- the whole point of the file. A counter that reads `total_tokens` for a chat completion double-counts
  the prompt (chat responses carry both `total_tokens` and its two parts).
* **labels** -- `memcog/build` and `memcog/navigate` are the sentence the cost table needs; a proxy that ignored the
  header would report one undifferentiated total.
* **refusals** -- `stream: true` must be refused rather than silently downgraded, and an upstream 4xx must be passed
  through rather than turned into a 200 with an empty body.

The last one is the failure this repository keeps recording: a transport error presented as a measurement.
"""

from __future__ import annotations

import importlib.util
import json
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
PROXY = REPO / "tools" / "competitor-sut" / "sut_llm_proxy.py"


def load_proxy():
    spec = importlib.util.spec_from_file_location("sut_llm_proxy", PROXY)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class Upstream(BaseHTTPRequestHandler):
    """A stand-in for the endpoint: records what it was sent, replies with a canned body."""

    protocol_version = "HTTP/1.1"
    seen: list[dict] = []
    reply: bytes = b"{}"
    status: int = 200
    stream: bool = False
    # Two deltas, then a frame with usage, then the terminator -- the shape an OpenAI-compatible endpoint sends when
    # `stream_options.include_usage` is set.
    stream_body: bytes = (
        b'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n'
        b'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'
        b'data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":9,"total_tokens":49}}\n\n'
        b'data: [DONE]\n\n'
    )

    def log_message(self, fmt, *args):  # noqa: A003
        return

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        type(self).seen.append({"path": self.path, "body": raw, "auth": self.headers.get("Authorization")})
        if type(self).stream:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(type(self).stream_body)
            self.wfile.flush()
            self.close_connection = True
            return
        self.send_response(type(self).status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(type(self).reply)))
        self.end_headers()
        self.wfile.write(type(self).reply)


@pytest.fixture()
def stack(monkeypatch):
    """Proxy -> fake upstream, both on ephemeral ports, with the module's singletons reset."""
    module = load_proxy()
    module.ACCOUNTANT.reset()
    Upstream.seen = []
    Upstream.reply = json.dumps(
        {
            "id": "chatcmpl-1",
            "choices": [{"message": {"role": "assistant", "content": "hello"}}],
            "usage": {
                "prompt_tokens": 11,
                "completion_tokens": 7,
                "total_tokens": 18,
                "completion_tokens_details": {"reasoning_tokens": 3},
            },
        }
    ).encode()
    Upstream.status = 200
    Upstream.stream = False

    upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    upstream_port = upstream.server_address[1]
    monkeypatch.setenv("UPSTREAM_BASE_URL", f"http://127.0.0.1:{upstream_port}")
    monkeypatch.setenv("UPSTREAM_API_KEY", "test-key-not-a-secret")
    monkeypatch.setenv("SUT_LLM_PROXY_QUIET", "1")

    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    proxy = ThreadingHTTPServer(("127.0.0.1", 0), module.Handler)
    proxy_port = proxy.server_address[1]
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{proxy_port}", module, upstream_port
    finally:
        proxy.shutdown()
        upstream.shutdown()
        proxy.server_close()
        upstream.server_close()


def post(base: str, body: dict, label: str | None = None) -> tuple[int, bytes]:
    raw = json.dumps(body).encode()
    request = urllib.request.Request(f"{base}/v1/chat/completions", data=raw, method="POST")
    request.add_header("Content-Type", "application/json")
    if label is not None:
        request.add_header("X-Sut-Label", label)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def test_body_is_forwarded_byte_for_byte(stack):
    """The system under test must see the endpoint's own bytes, not a re-encoding of them."""
    base, _module, _ = stack
    status, body = post(base, {"model": "deepseek-chat", "messages": [{"role": "user", "content": "ünïcode"}]})
    assert status == 200
    assert body == Upstream.reply
    assert Upstream.seen[-1]["body"].decode() == json.dumps(
        {"model": "deepseek-chat", "messages": [{"role": "user", "content": "ünïcode"}]}
    )


def test_usage_is_read_from_the_parts_not_the_total(stack):
    """`total_tokens` is the sum of the parts; counting it *and* a part is the double count to avoid."""
    base, module, _ = stack
    post(base, {"model": "deepseek-chat", "messages": []}, label="memcog/build")
    stats = module.ACCOUNTANT.snapshot()
    assert stats["calls"] == 1
    assert stats["prompt_tokens"] == 11
    assert stats["completion_tokens"] == 7
    assert stats["reasoning_tokens"] == 3
    assert stats["total_tokens"] == 18


def test_labels_split_build_from_query(stack):
    """A system whose build is most of its bill needs a different repair than one whose queries are."""
    base, module, _ = stack
    post(base, {"model": "deepseek-chat", "messages": []}, label="memcog/build")
    post(base, {"model": "deepseek-chat", "messages": []}, label="memcog/navigate")
    post(base, {"model": "deepseek-chat", "messages": []}, label="memcog/navigate")
    by_label = module.ACCOUNTANT.snapshot()["by_label"]
    assert by_label["memcog/build"]["calls"] == 1
    assert by_label["memcog/navigate"]["calls"] == 2
    assert by_label["memcog/navigate"]["prompt_tokens"] == 22


def test_models_are_not_collapsed(stack):
    """A silent model switch must show as two rows, not one average."""
    base, module, _ = stack
    post(base, {"model": "deepseek-chat", "messages": []})
    post(base, {"model": "deepseek-reasoner", "messages": []})
    by_model = module.ACCOUNTANT.snapshot()["by_model"]
    assert set(by_model) == {"deepseek-chat", "deepseek-reasoner"}


def test_stream_is_forwarded_and_settled_from_the_final_frame(stack):
    """Mastra's `agent.generate` runs over the streaming path, so refusing it made one system unrunnable.

    Two properties, and the second is the one a naive implementation gets wrong: the bytes must be forwarded
    unmodified (the client is parsing SSE), and `usage` must be taken from the frame that carries it rather than
    summed from deltas -- otherwise a five-frame answer is counted five times.
    """
    base, module, _ = stack
    Upstream.stream = True
    status, body = post(base, {"model": "deepseek-chat", "messages": [], "stream": True})
    assert status == 200
    # Byte-level: the client sees `data: [DONE]` and the exact frames the endpoint sent.
    assert body == Upstream.stream_body
    stats = module.ACCOUNTANT.snapshot()
    # One conversation, not five frames.
    assert stats["calls"] == 1
    assert stats["prompt_tokens"] == 40
    assert stats["completion_tokens"] == 9


def test_a_trailing_zero_usage_frame_does_not_erase_the_bill(stack):
    """Some gateways emit a zero-usage frame after the one that carries accounting.

    `_relay_stream` assigns `usage` on every frame, so a zero placeholder *after* the real
    frame overwrites 40/9 with 0/0 and the competitor's bill silently reads as free. The meter
    must keep the last frame that actually carried usage, not the last frame that had the key.
    """
    base, module, _ = stack
    original = Upstream.stream_body
    Upstream.stream = True
    Upstream.stream_body = (
        b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
        b'data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":9,"total_tokens":49}}\n\n'
        b'data: {"choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}\n\n'
        b'data: [DONE]\n\n'
    )
    try:
        status, body = post(base, {"model": "deepseek-chat", "messages": [], "stream": True})
        assert status == 200
        assert body == Upstream.stream_body  # still byte-for-byte, including the zero frame
        stats = module.ACCOUNTANT.snapshot()
        assert stats["calls"] == 1
        assert stats["prompt_tokens"] == 40
        assert stats["completion_tokens"] == 9
    finally:
        Upstream.stream_body = original


def test_upstream_error_is_passed_through_and_counted(stack):
    """A 429 is a fact about the run. Turning it into a 200 with an empty body would hide it."""
    base, module, _ = stack
    Upstream.status = 429
    Upstream.reply = b'{"error": {"message": "rate limited"}}'
    status, body = post(base, {"model": "deepseek-chat", "messages": []})
    assert status == 429
    assert b"rate limited" in body
    stats = module.ACCOUNTANT.snapshot()
    assert stats["failures"] == 1
    assert stats["calls"] == 0


def test_embeddings_count_their_total_tokens_once(stack):
    """`/v1/embeddings` reports `total_tokens` and no completion; it must not land in the completion column."""
    base, module, _ = stack
    Upstream.reply = json.dumps({"data": [], "usage": {"prompt_tokens": 5, "total_tokens": 5}}).encode()
    raw = json.dumps({"model": "embedding-3", "input": ["a"]}).encode()
    request = urllib.request.Request(f"{base}/v1/embeddings", data=raw, method="POST")
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=20) as response:
        assert response.status == 200
    stats = module.ACCOUNTANT.snapshot()
    assert stats["prompt_tokens"] == 5
    assert stats["completion_tokens"] == 0


def test_reset_clears_the_counters_without_restarting(stack):
    """`reset` between questions would otherwise restart the run's bill every time."""
    base, module, _ = stack
    post(base, {"model": "deepseek-chat", "messages": []})
    request = urllib.request.Request(f"{base}/reset", data=b"{}", method="POST")
    with urllib.request.urlopen(request, timeout=20) as response:
        assert response.status == 200
    assert module.ACCOUNTANT.snapshot()["calls"] == 0


def test_missing_usage_is_zero_and_still_counted(stack):
    """A gateway that omits `usage` must not turn a successful answer into a failed run."""
    base, module, _ = stack
    Upstream.reply = json.dumps({"choices": [{"message": {"content": "x"}}]}).encode()
    status, _ = post(base, {"model": "deepseek-chat", "messages": []})
    assert status == 200
    stats = module.ACCOUNTANT.snapshot()
    assert stats["calls"] == 1
    assert stats["total_tokens"] == 0
    assert stats["failures"] == 0


def test_prefix_selects_one_system_out_of_a_shared_proxy(stack):
    """One proxy serves every system in a run; the cost table needs one system's rows, not all of them."""
    base, module, _ = stack
    post(base, {"model": "deepseek-chat", "messages": []}, label="memcog/build")
    post(base, {"model": "deepseek-chat", "messages": []}, label="memcog/navigate")
    post(base, {"model": "deepseek-chat", "messages": []}, label="mem0/extract")
    with urllib.request.urlopen(f"{base}/stats?prefix=memcog", timeout=20) as response:
        payload = json.loads(response.read())
    assert payload["calls"] == 2
    assert payload["prompt_tokens"] == 22
    assert set(payload["by_label"]) == {"memcog/build", "memcog/navigate"}
    # And the global view is unchanged: a filtered read must not consume or move anything.
    assert module.ACCOUNTANT.snapshot()["calls"] == 3
