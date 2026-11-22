"""The MemCog driver against a vendored stand-in, a real proxy and a real subprocess.

## Why a stand-in and not the real package

The real MemCog needs 115 MB of corpus, a DeepSeek key and about a minute per question; none of those are available
where this test runs, and a test that skipped when they were missing would never run in CI. What *is* testable
without them is the part this repository wrote: whether the driver patches the package's client before anything
imports it by name, whether it keeps the package's prints out of the protocol channel, whether it separates build
spend from navigation spend, and whether a store that failed to build produces a refusal rather than a plausible
empty answer.

The stand-in reproduces the three properties the patch depends on -- `call_llm` returning `{}` until it is replaced,
callers importing it by name, and progress prints going to stdout -- because those are the properties, not the
algorithms.

## Why a real proxy rather than a stub client

The usage block is read from `/stats?prefix=memcog` over HTTP. A stubbed client would test a counter this driver
keeps itself, which is not where the number comes from; the real proxy is what turns two phases into two rows.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
DRIVER = REPO / "tools" / "competitor-sut" / "memcog_driver.py"
PROXY = REPO / "tools" / "competitor-sut" / "sut_llm_proxy.py"
VENDOR = REPO / "tools" / "__tests__" / "fixtures" / "fake_memcog"


def load_proxy():
    spec = importlib.util.spec_from_file_location("sut_llm_proxy_memcog_test", PROXY)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class Upstream(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # noqa: A003
        return

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        body = json.dumps(
            {
                "choices": [{"message": {"role": "assistant", "content": "ok"}}],
                "usage": {"prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25},
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture()
def proxy():
    module = load_proxy()
    module.ACCOUNTANT.reset()
    upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    os.environ["UPSTREAM_BASE_URL"] = f"http://127.0.0.1:{upstream.server_address[1]}"
    os.environ["UPSTREAM_API_KEY"] = "test-key"
    os.environ["SUT_LLM_PROXY_QUIET"] = "1"
    server = ThreadingHTTPServer(("127.0.0.1", 0), module.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/v1", module
    finally:
        server.shutdown()
        upstream.shutdown()
        server.server_close()
        upstream.server_close()


class Driver:
    """One driver process, driven one request at a time."""

    def __init__(self, base_url: str, store: Path):
        env = {
            **os.environ,
            "MEMCOG_VENDOR": str(VENDOR),
            "MEMCOG_STORE": str(store),
            "SUT_LLM_BASE_URL": base_url,
            "SUT_LLM_MODEL": "deepseek-chat",
        }
        self.process = subprocess.Popen(
            [sys.executable, str(DRIVER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )

    def send(self, request: dict) -> dict:
        assert self.process.stdin is not None and self.process.stdout is not None
        self.process.stdin.write(json.dumps(request) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        assert line, f"the driver produced no response; stderr:\n{self.process.stderr.read() if self.process.stderr else ''}"
        return json.loads(line)

    def close(self) -> None:
        try:
            self.send({"op": "shutdown"})
        finally:
            self.process.wait(timeout=30)


def test_it_declares_itself_as_a_self_answering_llm_system(proxy, tmp_path):
    base_url, _ = proxy
    driver = Driver(base_url, tmp_path / "store")
    try:
        manifest = driver.send({"op": "manifest"})
    finally:
        driver.close()
    assert manifest["ok"] is True
    assert manifest["name"] == "memcog"
    # Both are claims about the architecture that the parent validates against each other: a self-answering system
    # that claimed `embedding` would land in the cheap cost class while spending a model call per question.
    assert manifest["answers"] is True
    assert manifest["build"] == "llm"
    # The commit comes from the checkout, not from a constant in the driver.
    assert manifest["version"] == "vendor@deadbeefcafe"
    assert "no working model client" in manifest["notes"]


def test_the_patch_lands_before_the_package_imports_the_client(proxy, tmp_path):
    """The failure this guards: a driver that patches after `store_build` imported `call_llm` gets `{}` forever."""
    base_url, module = proxy
    driver = Driver(base_url, tmp_path / "store")
    try:
        ingest = driver.send(
            {
                "op": "ingest",
                "sessions": [
                    {"id": "s1", "at": 1_685_000_000_000, "turns": [{"role": "user", "content": "I live in London."}]}
                ],
            }
        )
        answer = driver.send({"op": "answer", "query": "where do I live", "askedAt": "2023/05/25 (Thu) 06:13"})
    finally:
        driver.close()

    # The stand-in returns `{}` when the fixture's own client is still in place, which the pipeline turns into a
    # failed write; a stored session therefore proves the patched client answered.
    assert ingest["ok"] is True
    assert ingest["sessions"] == 1
    assert ingest["turns"] == 1
    assert answer["ok"] is True
    assert "where do I live" in answer["answer"]
    # The corpus's own spelling of the date reached the prompt, not a rendering of it.
    assert "2023/05/25" in answer["answer"]

    stats = module.ACCOUNTANT.snapshot_for("memcog")
    # One call to write the session, two in the navigation loop. Anything else means a phase is counting the other's
    # calls, which is the failure the label split exists to prevent.
    assert stats["by_label"]["memcog/build"]["calls"] == 1
    assert stats["by_label"]["memcog/navigate"]["calls"] == 2
    assert stats["calls"] == 3


def test_usage_travels_with_every_response(proxy, tmp_path):
    base_url, _ = proxy
    driver = Driver(base_url, tmp_path / "store")
    try:
        driver.send(
            {
                "op": "ingest",
                "sessions": [{"id": "s1", "at": 1_685_000_000_000, "turns": [{"role": "user", "content": "hi"}]}],
            }
        )
        evidence = driver.send({"op": "answer", "query": "hello"})
    finally:
        driver.close()
    assert evidence["usage"]["calls"] == 3
    # 3 calls x (20 prompt + 5 completion) from the upstream fixture.
    assert evidence["usage"]["prompt_tokens"] == 60
    assert evidence["usage"]["completion_tokens"] == 15


def test_search_is_empty_and_says_why(proxy, tmp_path):
    base_url, _ = proxy
    driver = Driver(base_url, tmp_path / "store")
    try:
        result = driver.send({"op": "search", "query": "anything", "limit": 10})
    finally:
        driver.close()
    # Empty because the system has no ranked retrieval, and the response says so rather than leaving a reader to
    # guess whether the store was empty.
    assert result["ok"] is True
    assert result["hits"] == []
    assert "no ranked retrieval" in result["notes"]


def test_a_store_that_never_built_refuses_the_question(proxy, tmp_path):
    """The distinction the whole protocol rests on: a refusal is a claim about the system, not an empty answer."""
    base_url, _ = proxy
    driver = Driver(base_url, tmp_path / "store")
    try:
        answer = driver.send({"op": "answer", "query": "anything"})
    finally:
        driver.close()
    assert answer["ok"] is False
    assert "index.md" in answer["error"]


def test_reset_removes_the_tree_so_the_next_question_starts_empty(proxy, tmp_path):
    base_url, _ = proxy
    store = tmp_path / "store"
    driver = Driver(base_url, store)
    try:
        driver.send(
            {
                "op": "ingest",
                "sessions": [{"id": "s1", "at": 1_685_000_000_000, "turns": [{"role": "user", "content": "hi"}]}],
            }
        )
        assert (store / "user" / "assistant" / "index.md").is_file()
        driver.send({"op": "reset"})
        after = driver.send({"op": "answer", "query": "anything"})
    finally:
        driver.close()
    assert after["ok"] is False
    assert not (store / "user" / "assistant" / "index.md").exists()


def test_a_session_the_pipeline_drops_is_counted_not_hidden(proxy, tmp_path):
    """`process_session` returns `{}` on a failed step. An ingest that counted it would score a corpus with a hole."""
    base_url, _ = proxy
    driver = Driver(base_url, tmp_path / "store")
    try:
        result = driver.send(
            {
                "op": "ingest",
                "sessions": [
                    {"id": "empty", "at": 1_685_000_000_000, "turns": []},
                    {"id": "full", "at": 1_685_000_000_000, "turns": [{"role": "user", "content": "hi"}]},
                ],
            }
        )
    finally:
        driver.close()
    assert result["sessions"] == 1
    assert len(result["skipped"]) == 1
    assert "empty" in result["skipped"][0]
