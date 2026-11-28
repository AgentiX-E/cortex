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
import shutil
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


def find_python_312() -> str | None:
    """An interpreter the driver can re-exec into, or `None`.

    The driver refuses to run below 3.12 (MemCog's f-strings need PEP 701), so an end-to-end test needs one. It is
    looked for in three places and the search is *reported* rather than silent: `MEMCOG_PYTHON` first, then whatever
    `python3.12` resolves to, then the system path. Where there is none the end-to-end tests say so, and the protocol
    round trip is covered by the workflow step that installs 3.12 -- the same arrangement the Mastra driver uses.
    """
    for candidate in (os.environ.get("MEMCOG_PYTHON"), shutil.which("python3.12"), "/usr/bin/python3.12"):
        if candidate and os.path.exists(candidate):
            return candidate
    return None


TWELVE = find_python_312()
needs_312 = pytest.mark.skipif(
    TWELVE is None,
    reason="MemCog needs Python 3.12 (PEP 701 f-strings); the workflow covers this round trip on an installed 3.12",
)


def by_phase(stats: dict, name: str) -> int:
    """Calls the proxy recorded for one phase, summed over every question suffix.

    The label is `memcog/<phase>/q<n>`. Summing is the readable half of the assertion: a test that named the exact
    label would fail on the question index, which is a different claim and is tested separately.
    """
    return sum(
        int(row["calls"]) for label, row in stats["by_label"].items() if label.startswith(f"memcog/{name}/")
    )


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
            # The fixture cannot ship a `.git` directory -- git refuses to track one -- so the sha is declared. The
            # reader that parses a real `.git/HEAD` is tested separately, against a temporary tree this test builds.
            "MEMCOG_COMMIT": "deadbeefcafe1234",
            **({"MEMCOG_PYTHON": TWELVE} if TWELVE is not None else {}),
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


@needs_312
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
    # Measured and declared are different claims, and the manifest says which one this is.
    assert manifest["versionSource"] == "declared"
    assert "no working model client" in manifest["notes"]


@needs_312
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
    # calls, which is the failure the label split exists to prevent. Summed over the question suffix rather than
    # asserting one exact label, because the index is tested on its own below; what this test is about is the split
    # between building and navigating.
    assert by_phase(stats, "build") == 1
    assert by_phase(stats, "navigate") == 2
    assert stats["calls"] == 3


@needs_312
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


@needs_312
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


@needs_312
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


@needs_312
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


@needs_312
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


def test_failure_reason_names_the_step_that_failed():
    """`process_session` prints the reason and returns `{}`; the driver has to carry the print back.

    The real pipeline catches each step's exception, prints ` <step> failed: <exception>` when `verbose` is set and
    returns an empty dict. Run 45002769709 turned that into `the write pipeline returned nothing` for every session,
    which names a symptom every step shares and no cause at all -- so the run could not say whether the corpus, the
    model, the parser or the store was at fault.
    """
    module = _load_driver_module()

    transcript = "\nProcessing session [s1]\n Step 1: Writing sources...\n Writing sources failed: 'msg_time'\n"
    assert module.failure_reason(transcript) == "Writing sources failed: 'msg_time'"

    # A later step wins over an earlier one, because the earlier ones succeeded by definition: the pipeline returns
    # at the first failure, and a transcript that mentions two is a transcript of two sessions.
    later = " Writing sources failed: x\n Step 2: Writing context failed: y\n"
    assert module.failure_reason(later) == "Writing sources failed: x"

    # No reason printed at all is still a sentence, not an empty string, and it does not invent a cause.
    assert "printed no reason" in module.failure_reason("")
    assert "last line printed" in module.failure_reason("\n[fake] processing s1\n")


@needs_312
def test_each_question_carries_its_own_index(proxy, tmp_path):
    """The label a call is billed to names the question, because a block that cannot be attributed to one is not
    a per-question cost.

    Run 45002769709 recorded 1198 calls, every one labelled `memcog/build`, over thirty-six minutes. Whether that
    was one question's ingest or five was not in the artifact, and the cost table's only useful question is the
    per-question one.
    """
    base_url, module = proxy
    driver = Driver(base_url, tmp_path / "store")
    sessions = [
        {"id": "s1", "at": 1_685_000_000_000, "turns": [{"role": "user", "content": "hi"}]},
        {"id": "s2", "at": 1_685_000_000_000, "turns": [{"role": "user", "content": "hello"}]},
    ]
    try:
        for session in sessions:
            driver.send({"op": "reset"})
            ingest = driver.send({"op": "ingest", "sessions": [session]})
            assert ingest["sessions"] == 1
    finally:
        driver.close()

    stats = module.ACCOUNTANT.snapshot_for("memcog")
    # One build call per session, and the index is the question's, counted from the reset that precedes it.
    assert stats["by_label"]["memcog/build/q1"]["calls"] == 1
    assert stats["by_label"]["memcog/build/q2"]["calls"] == 1
    assert by_phase(stats, "build") == 2


@needs_312
def test_a_refusal_says_what_the_store_holds(proxy, tmp_path):
    """A store with no `index.md` is two different failures, and the refusal has to say which.

    "The corpus never went in" and "the corpus went in and the navigation entry point was never written" need
    different repairs, and the earlier message said only the first -- `the store has no index.md; ingest wrote
    nothing` -- for a refusal that could be either.
    """
    base_url, _ = proxy
    driver = Driver(base_url, tmp_path / "store")
    try:
        driver.send({"op": "reset"})
        refused = driver.send({"op": "answer", "query": "where do I live"})
    finally:
        driver.close()

    assert refused["ok"] is False
    assert "holds:" in refused["error"]
    # A store that was never built says so, rather than listing an empty string.
    assert "does not exist" in refused["error"] or "empty directory" in refused["error"]


def test_the_commit_reader_parses_a_real_git_head(tmp_path):
    """The production path: a checkout, a symbolic `HEAD`, and a ref file.

    This is why the driver does not simply trust an environment variable. On a runner the vendored tree *has* a
    `.git`, and the sha a reader can check is the one in it. The test builds the smallest tree that exercises the
    parser -- `ref: refs/heads/main` plus the file it points at -- because the fixture tree itself cannot carry one.
    """
    module = _load_driver_module()
    head = tmp_path / ".git" / "HEAD"
    ref = tmp_path / ".git" / "refs" / "heads" / "main"
    ref.parent.mkdir(parents=True)
    head.write_text("ref: refs/heads/main\n", encoding="utf-8")
    ref.write_text("0123456789abcdef0123\n", encoding="utf-8")
    assert module.vendor_commit(tmp_path) == ("0123456789ab", "git")

    # A detached HEAD is a bare sha, and it must not be mistaken for a ref.
    head.write_text("fedcba9876543210\n", encoding="utf-8")
    assert module.vendor_commit(tmp_path) == ("fedcba987654", "git")

    # A tree with neither a `.git` nor a declaration has no sha, and says so rather than inventing one.
    bare = tmp_path / "bare"
    bare.mkdir()
    assert module.vendor_commit(bare) == ("unknown", "none")


def _load_driver_module():
    import importlib.util

    spec = importlib.util.spec_from_file_location("memcog_driver_under_test", DRIVER)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.mark.skipif(sys.version_info >= (3, 12), reason="the guard only fires below 3.12")
def test_the_guard_explains_the_version_it_needs():
    """The failure that cost a dispatch, in the form that costs nothing.

    On 3.11 the guard must exit 3 with a sentence naming the version, the file's requirement and the PEP -- and it
    must write nothing to stdout, because a parent that reads half a protocol response is worse off than one that
    reads none.
    """
    completed = subprocess.run(
        [sys.executable, str(DRIVER)],
        input='{"op":"manifest"}\n',
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, "MEMCOG_PYTHON": ""},
    )
    assert completed.returncode == 3
    assert completed.stdout == ""
    assert "Python 3.12" in completed.stderr
    assert "PEP 701" in completed.stderr


# ---------------------------------------------------------------------------------------------------------------
# A 200 response has already been charged by the proxy before the driver decodes it (the proxy records the call on
# any <400 status, even when the body is not JSON and usage comes back as zero). A decode failure on such a body is
# therefore a *billed* failure: re-sending it charges the same logical call a second and third time and inflates
# `calls` on the leaderboard. Only transport failures -- where the proxy records a failure and no call -- may be
# retried. These two cases must take different branches.


class _MalformedUpstream(BaseHTTPRequestHandler):
    """A 200 whose body is not JSON: the proxy bills it, and the driver cannot decode it."""

    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # noqa: A003
        return

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        body = b"<html>upstream returned a web page, not JSON</html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class _CountingFailUpstream(BaseHTTPRequestHandler):
    """A 503 whose hits are counted: the driver sees HTTPError, the proxy would book a failure, no call is billed."""

    protocol_version = "HTTP/1.1"
    hits: list[int] = []

    def log_message(self, fmt, *args):  # noqa: A003
        return

    def do_POST(self):  # noqa: N802
        type(self).hits.append(1)
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        self.send_error(503, "unavailable")


class TestABilledResponseIsNeverRetried:
    """The retry decision must turn on whether the call was billed, not on the exception type alone."""

    @staticmethod
    def _driver_without_backoff(monkeypatch):
        driver = _load_driver_module()
        # Timing is not under test; keep the red case fast (before the fix it sleeps 2+4+6s across three tries).
        monkeypatch.setattr(driver.time, "sleep", lambda _seconds: None)
        return driver

    def test_a_malformed_billed_200_is_reported_once_not_retried(self, monkeypatch):
        """A non-JSON 200 was billed once; decoding it again must not add two more calls to the bill."""
        module = load_proxy()
        module.ACCOUNTANT.reset()
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), _MalformedUpstream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        os.environ["UPSTREAM_BASE_URL"] = f"http://127.0.0.1:{upstream.server_address[1]}"
        os.environ["UPSTREAM_API_KEY"] = "test-key"
        os.environ["SUT_LLM_PROXY_QUIET"] = "1"
        proxy = ThreadingHTTPServer(("127.0.0.1", 0), module.Handler)
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
        try:
            driver = self._driver_without_backoff(monkeypatch)
            monkeypatch.setenv("SUT_LLM_BASE_URL", f"http://127.0.0.1:{proxy.server_address[1]}/v1")
            with pytest.raises(RuntimeError, match="already billed"):
                driver._openai_compatible_call([{"role": "user", "content": "hello"}])

            # One logical call was sent and billed once; a retry would show up as three calls here.
            assert module.ACCOUNTANT.snapshot()["calls"] == 1, module.ACCOUNTANT.snapshot()
        finally:
            proxy.shutdown()
            upstream.shutdown()
            proxy.server_close()
            upstream.server_close()

    def test_an_unbilled_transport_failure_is_still_retried(self, monkeypatch):
        """A 503 books no call, so the three transport attempts must still reach the server."""
        _CountingFailUpstream.hits = []
        driver = self._driver_without_backoff(monkeypatch)
        server = ThreadingHTTPServer(("127.0.0.1", 0), _CountingFailUpstream)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            monkeypatch.setenv("SUT_LLM_BASE_URL", f"http://127.0.0.1:{server.server_address[1]}/v1")
            with pytest.raises(RuntimeError, match="after three attempts"):
                driver._openai_compatible_call([{"role": "user", "content": "hello"}])
            assert len(_CountingFailUpstream.hits) == 3, "a transport failure that bills no call must be retried"
        finally:
            server.shutdown()
            server.server_close()
