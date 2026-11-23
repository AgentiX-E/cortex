"""The product arm's two channels, asserted on the requests it made.

## Why a stand-in rather than a model

Three claims about this wiring are invisible in a score and would survive any accuracy reading:

1. **The chat call carries `X-Sut-Label`.** The metering proxy groups spend by that header; without it the
   product arm's tokens land under `unlabelled` and its cost column reads zero for the most expensive row in
   the table. A run that scored 91% with an unattributed bill is a run whose comparison cannot be read.
2. **The embeddings reach the embedder at all.** The registered arm is `self-index` with an injected embedder.
   An assembly that never embedded would still answer -- lexically -- under the same row name.
3. **The answer is the product's own parse.** `parseAnswer` collapses `Answer: X` to `X`; an arm that returned
   the raw completion would be graded on a string the product never ships.

A stand-in answers both endpoints, so each claim is checked against a recorded request rather than against a
model's output. The node fixture is the arm itself, built by the same `createProductProvider` a workflow calls.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "product-arm-smoke.mjs"

DIMENSIONS = 1024


class Recorder:
    """What the arm asked for, so the assertions can be about the requests."""

    def __init__(self) -> None:
        self.chat: list[dict[str, object]] = []
        self.embeddings: list[dict[str, object]] = []
        self.headers: list[dict[str, str]] = []


def _handler(recorder: Recorder) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 -- the stdlib's spelling
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            recorder.headers.append({k.lower(): v for k, v in self.headers.items()})
            if self.path.endswith("/embeddings"):
                inputs = body.get("input") or []
                recorder.embeddings.append({"count": len(inputs), "model": body.get("model")})
                payload = {
                    "data": [
                        {"index": at, "embedding": [((at + step) % 7) / 7 for step in range(DIMENSIONS)]}
                        for at, _ in enumerate(inputs)
                    ]
                }
            else:
                recorder.chat.append({"model": body.get("model"), "messages": body.get("messages")})
                payload = {
                    "choices": [{"message": {"role": "assistant", "content": "Answer: Porto"}}],
                    # What a provider actually charges. The arm reads this rather than counting requests, and the
                    # difference is the whole cost argument in a comparison table.
                    "usage": {"prompt_tokens": 137, "completion_tokens": 9},
                }
            encoded = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, *_args: object) -> None:
            """Silence: the test's output is the assertion, not a request log."""

    return Handler


def test_the_arm_labels_its_chat_calls_and_embeds_its_corpus() -> None:
    recorder = Recorder()
    server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(recorder))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.server_port}/v1"
        # The interpreter that can load `better-sqlite3` is the one this checkout was installed for. A bare
        # `PATH` resolves to whatever system node is present, which was v18 against a v22 ABI (`ERR_DLOPEN_FAILED`)
        # -- a failure about the test's environment that would read as a failure about the arm.
        node = shutil.which("node")
        assert node is not None, "node is not on PATH"
        result = subprocess.run(
            [node, str(FIXTURE)],
            cwd=REPO,
            env={
                "PATH": f"{Path(node).parent}:/usr/local/bin:/usr/bin:/bin",
                "HOME": str(Path.home()),
                # Both channels point at the stand-in: the proxy relays chat, and the embedder's own base URL is
                # what the product's index calls. Splitting them here would leave half the wiring unexercised.
                "SUT_LLM_BASE_URL": base,
                "SUT_LLM_API_KEY": "unused-by-the-metering-proxy",
                "SUT_LLM_MODEL": "deepseek-chat",
                "ZHIPU_API_KEY": "unused-by-the-stand-in",
                "ZHIPU_EMBED_BASE_URL": base,
                "ZHIPU_EMBED_MODEL": "embedding-3",
                "ZHIPU_EMBED_DIMENSIONS": str(DIMENSIONS),
            },
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
        assert result.returncode == 0, result.stderr

        assert recorder.chat, "the arm never called the chat channel"
        assert recorder.embeddings, "the arm never embedded its corpus"
        # The label is the cost column's only handle on this arm. Asserted per request rather than on the first,
        # because a wrapper that labelled the constructor's call and then dropped the header would pass a
        # first-request check.
        labels = {header.get("x-sut-label") for header in recorder.headers if "x-sut-label" in header}
        assert labels == {"cortex-product/answer"}, labels

        payload = json.loads(result.stdout.strip().splitlines()[-1])
        # `Answer: Porto` is what the stand-in says; `Porto` is what the product ships. The difference is the
        # parser, and an arm that returned the completion would be graded on a string the product never emits.
        assert payload["answer"] == "Porto", payload
        assert payload["build"] == "embedding", payload
        assert payload["promptBytes"] > 0, payload
        # The bill comes from the provider's own accounting. Zero here would mean the arm never read `usage`,
        # which would print as a free system rather than as an unknown one.
        assert payload["usage"] is not None, payload
        assert payload["usage"]["promptTokens"] == 137 * len(recorder.chat), payload
        assert payload["usage"]["calls"] == len(recorder.chat), payload
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=10)
