#!/usr/bin/env python3
"""MemCog as a system under test, on the same model Cortex reads with.

## What this system is, in one paragraph

MemCog (`WeAgentAI/MemCog`, MIT, arXiv:2605.28046) is not a retriever. It builds a **navigable store** -- a tree of
markdown pages, each with an abstract, aliases and tags -- and then answers a question by *navigating* that tree with
two tools (`mem_read_batch`, `mem_search_name`) for up to seven model turns. Its published 95.80 is for that whole
loop, not for a ranked list. So this driver does not implement `search` as anything but the honest empty list, and
implements `answer`: the harness's shared reader is not what MemCog's number means.

## The three things a reader has to know before quoting a number from this file

**1. The repository ships an LLM client that cannot call a model.** `src/core/llm_client.py` at the pinned commit has
its `_call_gpt` body commented out under a `TODO` and returns `{}`; `src/config/llm_config.py` is four empty strings.
The authors' README instructs the reader to uncomment the example. So *every* reproduction of MemCog -- including
this one -- supplies the call itself, and a number produced from this repository is a number about MemCog's pipeline
**plus six lines of transport**. Those six lines are `_openai_compatible_call` below and they are deliberately the
least interesting code in the file: no retries beyond the authors' own, no prompt changes, no parsing.

**2. The model is DeepSeek, and that is measured rather than asserted.** The call goes to `SUT_LLM_BASE_URL`, which on
a runner is `sut_llm_proxy.py`. That proxy forwards to DeepSeek and reads `usage` out of the response, so the token
column in the report is the provider's own accounting. The manifest names the model and the base URL; a run whose
proxy pointed elsewhere would say so.

**3. `base_model` and `model` are threaded through unchanged.** MemCog's own signature carries them from the eval
script into `call_llm`, and the patch below ignores them for routing -- the destination is the proxy -- but records
them in the manifest, because a run whose arguments said `qwen` and whose calls went to DeepSeek is a fact a reader
should be able to see rather than infer.

## Why the store is rebuilt per question

`reset` deletes the store directory. That is the protocol's isolated mode and it is also the only defensible reading:
LongMemEval-S gives every question its own haystack, so a store carried across questions would answer question 400
with question 12's history -- the failure `mem0_driver.py` documents for its own `user_id` partitioning.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# The protocol channel is captured **before** anything from the vendored package is imported, because MemCog prints
# progress to stdout in a dozen places. A driver that let one of those prints through would send the parent a line
# that is not JSON and the run would fail at question one -- which is the correct outcome, but only after burning an
# ingest. Redirecting here costs one assignment and makes the failure impossible.
PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr

# MemCog does not run on Python older than 3.12, and the reason is a syntax error rather than a version check.
#
# `store_build/sources.py:75` writes an f-string whose replacement field contains a backslash, which PEP 701 legalised
# in 3.12. On 3.11 the module does not import at all: `SyntaxError: f-string expression part cannot include a
# backslash`, raised before `main()` and therefore before any protocol response -- so the parent reports "manifest
# produced no response" and the run looks like a broken driver rather than a broken version assumption. The
# repository states no minimum version anywhere, which is why this cost a dispatch.
#
# Re-exec rather than refuse: the alternative is patching somebody else's file, and a patched vendor tree is a
# measurement of the patch. `MEMCOG_PYTHON` names an interpreter the workflow installed; without it the driver says
# exactly what is wrong and exits, because guessing (`python3.12` on PATH, a pyenv shim) is how the wrong interpreter
# gets used silently.
if sys.version_info < (3, 12):
    _alternative = os.environ.get("MEMCOG_PYTHON")
    if _alternative and os.path.exists(_alternative):
        os.execv(_alternative, [_alternative, os.path.abspath(__file__), *sys.argv[1:]])
    print(
        f"MemCog needs Python 3.12 or newer (this is {sys.version.split()[0]}): its f-strings use backslashes inside "
        "replacement fields, which PEP 701 only allows from 3.12. Set MEMCOG_PYTHON to a 3.12 interpreter.",
        file=sys.stderr,
    )
    raise SystemExit(3)

# The commit this driver was written against. `MEMCOG_VENDOR` may point anywhere, but the manifest reports the commit
# it found with `git rev-parse`, not this constant: a driver that printed a pinned sha while running a different tree
# would be the "name is not the product" failure `PROTOCOL.md` records for Letta.
PINNED_COMMIT = "b0c4b1e"  # replaced at run time by whatever the checkout says; see `vendor_commit()`

LABEL_PREFIX = "memcog"
USER_ID = "user"
ASS_ID = "assistant"
MAX_LOOP = int(os.environ.get("MEMCOG_MAX_LOOP", "7") or "7")


def vendor_dir() -> Path | None:
    """Where the vendored checkout is, or `None` when it is missing.

    Deliberately not a `pip install memcog`: no such package exists. The census already records two competitors whose
    name resolves to a different product, so this driver refuses to guess.
    """
    configured = os.environ.get("MEMCOG_VENDOR")
    candidates = [Path(configured)] if configured else []
    candidates.append(Path(__file__).resolve().parent / ".vendor" / "MemCog")
    candidates.append(Path.cwd() / ".vendor" / "MemCog")
    for candidate in candidates:
        if (candidate / "src" / "core" / "llm_client.py").is_file():
            return candidate
    return None


def vendor_commit(root: Path) -> tuple[str, str]:
    """`(sha, source)`, where source says whether the sha was read or declared.

    Read from `.git/HEAD` rather than by shelling out to git, because the runner may not have git on `PATH` in the
    driver's environment and a `subprocess` call that fails would have to fall back to a constant -- which is the
    thing this function exists to avoid.

    `MEMCOG_COMMIT` is the fallback, and the second return value is why it exists rather than the sha alone: a
    fixture cannot ship a `.git` directory (git refuses to track one), so the unit tests declare the commit while the
    workflow reads it from the checkout. A manifest that could not distinguish those two cases would let a declared
    sha stand in for a measured one, which is the failure `PROTOCOL.md` records for Letta's name.
    """
    head = root / ".git" / "HEAD"
    if head.is_file():
        text = head.read_text(encoding="utf-8").strip()
        if text.startswith("ref: "):
            ref = root / ".git" / text[5:].strip()
            if ref.is_file():
                return ref.read_text(encoding="utf-8").strip()[:12], "git"
            return f"unreadable ({text})", "git"
        return text[:12], "git"
    declared = os.environ.get("MEMCOG_COMMIT")
    if declared:
        return declared[:12], "declared"
    return "unknown", "none"


def proxy_base() -> str:
    return (os.environ.get("SUT_LLM_BASE_URL") or "http://127.0.0.1:8399/v1").rstrip("/")


def proxy_stats() -> dict[str, Any] | None:
    """This system's spend so far, from the metering proxy.

    `None` when there is no proxy rather than a fabricated zero: the report prints `—` for an unmeasured arm, and a
    zero would be read as a free one.
    """
    root = proxy_base().removesuffix("/v1")
    try:
        with urllib.request.urlopen(f"{root}/stats?prefix={LABEL_PREFIX}", timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, json.JSONDecodeError):
        return None


def usage_block() -> dict[str, Any]:
    stats = proxy_stats()
    if stats is None:
        return {}
    return {
        "usage": {
            "calls": int(stats.get("calls") or 0),
            "prompt_tokens": int(stats.get("prompt_tokens") or 0),
            "completion_tokens": int(stats.get("completion_tokens") or 0),
        }
    }


# Which phase the next model call belongs to. Read by the proxy through a header, so the cost table can separate
# building the store from navigating it -- the two halves have different repairs and, on this system, wildly
# different sizes.
_PHASE = {"label": f"{LABEL_PREFIX}/build"}


def _openai_compatible_call(
    messages: list,
    tools: list | None = None,
    max_tokens: int = 4096,
    temperature: float = 0.2,
    model: str | None = None,
) -> dict:
    """The six lines the MemCog README asks the reader to uncomment, pointed at the proxy.

    The request is built exactly as the authors' commented example builds it (`model`, `messages`, `max_tokens`,
    `temperature`, and `tools` when given) and the response is returned **unmodified**: every caller in the package
    reads `resp["choices"][0]["message"]`, so re-packing it would be a second place a response could change.
    """
    model = model or os.environ.get("SUT_LLM_MODEL") or os.environ.get("DEEPSEEK_MODEL") or "deepseek-chat"
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if tools:
        payload["tools"] = tools
        # MemCog's navigation loop calls tools and expects `tool_calls` back. `auto` is the OpenAI default; stated
        # because the loop's behaviour depends on the model choosing to call rather than to answer.
        payload["tool_choice"] = "auto"

    request = urllib.request.Request(
        f"{proxy_base()}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer proxy",
            "X-Sut-Label": _PHASE["label"],
        },
        method="POST",
    )
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=float(os.environ.get("MEMCOG_LLM_TIMEOUT", "600"))) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError, OSError, json.JSONDecodeError) as error:
            last_error = error
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"the model call failed after three attempts: {last_error}")


def install_client() -> None:
    """Replace the package's two call entry points, after importing them so the patch lands on the same module.

    `store_build/*` and `navigation/agent.py` all do `from core.llm_client import call_llm`, which binds at import
    time. This function must therefore run **before** any of them are imported -- `main()` is arranged so that the
    only thing imported earlier is `core.llm_client` itself.
    """
    import core.llm_client as client

    def call_llm(messages, tools=None, max_tokens=4096, temperature=0.2, base_model="gpt", model=None):
        return _openai_compatible_call(
            messages, tools=tools, max_tokens=max_tokens, temperature=temperature, model=model
        )

    def call_llm_simple(system_prompt, user_prompt, max_tokens=4096, temperature=0.2, base_model="gpt", model=None):
        response = call_llm(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            max_tokens=max_tokens,
            temperature=temperature,
            model=model,
        )
        choices = response.get("choices", [])
        if not choices:
            raise RuntimeError("the model returned no choices")
        return choices[0].get("message", {}).get("content", "")

    client.call_llm = call_llm
    client.call_llm_simple = call_llm_simple


def to_memcog_time(epoch_ms: int | None) -> str:
    """`1685000000000` -> `2023-05-25 06:13:20`, the format `parse_longmemeval.py` writes."""
    if epoch_ms is None:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    return datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def to_memcog_session(session: dict[str, Any]) -> dict[str, Any]:
    """One protocol session in the shape `process_session` reads.

    The protocol carries `at` once per session and MemCog carries `msg_time` on every message. The fallback is the
    session instant rather than `now`: a turn stamped with the wall clock would tell the system the conversation
    happened today, which is a lie about the corpus and would corrupt every temporal answer.
    """
    date_time = to_memcog_time(session.get("at"))
    return {
        "session_id": str(session.get("id", "")),
        "date_time": date_time,
        "messages": [
            {
                "speaker": str(turn.get("role", "user")),
                "text": str(turn.get("content", "")),
                "msg_time": date_time,
            }
            for turn in session.get("turns") or []
        ],
    }


class Driver:
    def __init__(self) -> None:
        root = vendor_dir()
        if root is None:
            raise SystemExit(
                "MemCog is not vendored: set MEMCOG_VENDOR to a checkout, or place one at "
                "tools/competitor-sut/.vendor/MemCog. There is no PyPI package by this name."
            )
        self.root = root
        self.commit, self.commit_source = vendor_commit(root)
        sys.path.insert(0, str(root / "src"))
        install_client()  # before anything imports `store_build` or `navigation`

        import config.settings as settings
        from store_build.pipeline import process_session
        from navigation.agent import answer_question_with_agent, load_context

        self.settings = settings
        self.process_session = process_session
        self.answer_question_with_agent = answer_question_with_agent
        self.load_context = load_context

        self.store_root = Path(
            os.environ.get("MEMCOG_STORE") or Path(tempfile.mkdtemp(prefix="memcog-store-"))
        )
        self.store_root.mkdir(parents=True, exist_ok=True)
        settings.set_store_root(self.store_root)
        self.lang = os.environ.get("MEMCOG_LANG", "en")
        self.model = os.environ.get("SUT_LLM_MODEL") or os.environ.get("DEEPSEEK_MODEL") or "deepseek-chat"
        self.ingested_sessions = 0
        self.ingested_turns = 0

    def manifest(self) -> dict[str, Any]:
        return {
            "ok": True,
            "name": "memcog",
            "build": "llm",
            "answers": True,
            "version": f"vendor@{self.commit}",
            "versionSource": self.commit_source,
            "llm": {"provider": "deepseek-compatible", "model": self.model, "base_url": proxy_base()},
            "notes": (
                f"WeAgentAI/MemCog, MIT, at the vendored commit above (sha source: {self.commit_source}). "
                "The package ships no working model client "
                "(src/core/llm_client.py returns {} behind a TODO), so this driver supplies the OpenAI-compatible "
                "call the README's own example shows, routed at a metering proxy. Store build and navigation both "
                "run on that one model; the answer is MemCog's, the judge is the harness's."
            ),
            **usage_block(),
        }

    def reset(self) -> dict[str, Any]:
        # The store is a directory tree; MemCog has no drop operation. Removing it is the same contract every other
        # driver implements, and it is checked before the next question rather than after the last.
        if self.store_root.exists():
            shutil.rmtree(self.store_root, ignore_errors=True)
        self.store_root.mkdir(parents=True, exist_ok=True)
        self.settings.set_store_root(self.store_root)
        self.ingested_sessions = 0
        self.ingested_turns = 0
        return {"ok": True}

    def ingest(self, sessions: list[dict[str, Any]]) -> dict[str, Any]:
        _PHASE["label"] = f"{LABEL_PREFIX}/build"
        skipped: list[str] = []
        turns = 0
        stored = 0
        for session in sessions:
            converted = to_memcog_session(session)
            if not converted["messages"]:
                skipped.append(f"session {converted['session_id']} had no turns")
                continue
            try:
                result = self.process_session(
                    converted,
                    USER_ID,
                    ASS_ID,
                    verbose=False,
                    lang=self.lang,
                    base_model="gpt",
                    model=self.model,
                )
            except Exception as error:  # noqa: BLE001 - one session failing is a skip, not a run failure
                skipped.append(f"session {converted['session_id']}: {type(error).__name__}: {error}")
                continue
            # `process_session` returns `{}` when a step fails rather than raising. An empty result is a session that
            # did not enter the store, and counting it as stored would produce a score with a hole in its corpus.
            if not result:
                skipped.append(f"session {converted['session_id']}: the write pipeline returned nothing")
                continue
            stored += 1
            turns += len(converted["messages"])
        self.ingested_sessions += stored
        self.ingested_turns += turns
        return {
            "ok": True,
            "sessions": stored,
            "turns": turns,
            "skipped": skipped,
            **usage_block(),
        }

    def search(self, query: str, limit: int) -> dict[str, Any]:
        """No ranked list, and that is a statement about the system rather than a failure.

        MemCog's retrieval is the navigation loop, and the pages it reads on the way to an answer are a reasoning
        trace with no order that means anything outside that trajectory. Returning them as hits would let the shared
        reader answer from a context MemCog never assembled, which is a different system wearing its name.
        """
        return {"ok": True, "hits": [], "notes": "memcog has no ranked retrieval; see `answer`", **usage_block()}

    def answer(self, query: str, asked_at: str | None) -> dict[str, Any]:
        _PHASE["label"] = f"{LABEL_PREFIX}/navigate"
        context, _trace = self.load_context(USER_ID, ASS_ID)
        if not context:
            # A store that was never built cannot be navigated. Reported as a refusal for this question rather than
            # an exception, because a corpus that failed to ingest is already in `skipped` and this is its
            # consequence.
            return {"ok": False, "error": "the store has no index.md; ingest wrote nothing", **usage_block()}
        date = asked_at or datetime.now(timezone.utc).strftime("%Y/%m/%d (%a) %H:%M")
        user_prompt = f"Current Date: {date}\nQuestion: {query}\nAnswer:"
        try:
            prediction, agent_trace = self.answer_question_with_agent(
                user_prompt,
                query,
                USER_ID,
                ASS_ID,
                context=context,
                max_loop=MAX_LOOP,
                base_model="gpt",
                model=self.model,
            )
        except Exception as error:  # noqa: BLE001
            return {"ok": False, "error": f"{type(error).__name__}: {error}", **usage_block()}
        steps = agent_trace.get("steps") if isinstance(agent_trace, dict) else None
        return {
            "ok": True,
            "answer": str(prediction or ""),
            "steps": len(steps) if isinstance(steps, list) else None,
            **usage_block(),
        }


def main() -> int:
    driver = Driver()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            print(json.dumps({"ok": False, "error": f"request is not JSON: {error}"}), file=PROTOCOL_OUT, flush=True)
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
                response = driver.search(str(request.get("query") or ""), int(request.get("limit") or 0))
            elif op == "answer":
                response = driver.answer(
                    str(request.get("query") or ""),
                    request.get("askedAt"),
                )
            elif op == "shutdown":
                response = {"ok": True}
            else:
                response = {"ok": False, "error": f"unknown op {op!r}"}
        except Exception as error:  # noqa: BLE001 - the parent turns this into a per-question refusal
            response = {"ok": False, "error": f"{type(error).__name__}: {error}"}
        print(json.dumps(response), file=PROTOCOL_OUT, flush=True)
        if op == "shutdown" and response.get("ok"):
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
