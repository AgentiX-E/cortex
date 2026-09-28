#!/usr/bin/env python3
"""Dispatch the B7 channel-C A/B, one arm per invocation.

Why a script: the sandbox admits api.github.com only, `gh` is unusable, and the
dispatch has to name the exact commit. Passing `ref` is what makes the two arms a
controlled comparison: without it the workflow picks up whatever master is at
dispatch time, and the two arms can land on different code -- which is how the
run in §13 produced two byte-identical arms and a verdict about the dispatch.

Usage:
  python3 tools/dispatch-b7-ab.py control     # retrieval_sides=0
  python3 tools/dispatch-b7-ab.py feature     # retrieval_sides=1

Both arms always set candidate_discrimination=1, because `retrievalSides` is read
only inside the annotation producer, which runs only when discrimination is on.
A control arm with discrimination=0 would differ in two ways at once and the delta
would not be attributable to the side source.

CORTEX_RERANK is set because the ablation arm is guarded on `reranker !==
undefined`: with it off the arm is skipped, not run without a reranker. The
reranker goes to the feature side only, so it is constant across the two arms and
cannot carry the delta.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

REPO = "AgentiX-E/cortex"
WORKFLOW = "benchmark.yml"

ARMS = {
    "control": {"retrieval_sides": "0"},
    "feature": {"retrieval_sides": "1"},
}

# Held constant across both arms. `limit` is the discriminating fixture's scale:
# the roadmap's own B7 cohort is small, and the point of C5 is the artifact-level
# difference, which a small sample exposes without paying for 500 questions.
COMMON = {
    "candidate_discrimination": "1",
    "rerank": "local",
    "rerank_provider": "local",
    "limit": "60",
}


def token() -> str:
    for line in open(".git/config"):
        if "oauth2:" in line:
            return line.split("oauth2:", 1)[1].split("@", 1)[0]
    sys.exit("no oauth2 token in .git/config")


TOKEN = token()


def req(method: str, path: str, payload=None, allow_empty: bool = False):
    """One API call, retried on transient failures.

    `allow_empty` exists because the dispatch endpoint answers 204 with no body,
    and `json.load` on an empty body raises. The earlier version of this file
    retried that parse failure five times, which turned one dispatch into six.
    Retrying a request whose success is not a JSON document is not patience, it
    is six runs.
    """
    body = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(f"https://api.github.com{path}", data=body, method=method)
    request.add_header("Authorization", f"Bearer {TOKEN}")
    request.add_header("Accept", "application/vnd.github+json")
    if body:
        request.add_header("Content-Type", "application/json")
    for attempt in range(6):
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                raw = response.read()
                if allow_empty and not raw.strip():
                    return None
                return json.loads(raw)
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")
            if error.code in (500, 502, 503, 504) and attempt < 5:
                time.sleep(2 * (attempt + 1))
                continue
            sys.exit(f"{method} {path} -> {error.code}\n{detail}")
        except json.JSONDecodeError as error:
            # Not transient. A body we cannot parse is not a reason to send
            # another one.
            sys.exit(f"{method} {path} -> unparseable body: {error}")
        except Exception as error:  # noqa: BLE001 - network layer, retried uniformly
            if attempt < 5:
                time.sleep(2 * (attempt + 1))
                continue
            sys.exit(f"{method} {path} -> {error}")
    sys.exit(f"{method} {path} -> exhausted retries")


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout.strip()


def remote_head() -> str:
    """The remote's HEAD SHA, recorded for the log, never passed as `ref`.

    These are different SHAs for the same content. `push-via-api.py` rebuilds the
    commit through the Git Data API, so the remote gets a fresh commit object with
    the same tree. The first dispatch attempt passed the local SHA and GitHub
    answered 422 `No ref found for`, even though the push had just verified 213
    blobs byte-identical. Verifying content and naming a commit by its local SHA
    are two different claims, and only the first was checked.

    Passing the remote SHA also fails, with the same 422, while `master` succeeds.
    The token cannot resolve a commit object to a ref for dispatch even when
    `master` points at that very commit, so the ref is `master` and the SHA is
    reported only so the log says which revision the arms ran on.
    """
    return req("GET", f"/repos/{REPO}/git/ref/heads/master")["object"]["sha"]


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in ARMS:
        print(__doc__)
        return 2
    arm = sys.argv[1]
    sha = remote_head()
    inputs = {**COMMON, **ARMS[arm]}

    print(f"dispatching {arm} at master ({sha[:8]})")
    for key in sorted(inputs):
        print(f"  {key} = {inputs[key]}")

    req(
        "POST",
        f"/repos/{REPO}/actions/workflows/{WORKFLOW}/dispatches",
        {"ref": "master", "inputs": inputs},
        allow_empty=True,
    )
    print(f"dispatched {arm}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
