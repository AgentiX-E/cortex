#!/usr/bin/env python3
"""Dispatch the reader-ceiling arm: the graded runner, on the gold-only pool.

## Why this script exists rather than a line in a shell history

Three things have to be true at dispatch time and only one of them is an input:

1. the tree being measured has a verdict (`verify.yml` on the head of `master`),
2. the condition is armed on the channel `benchmark.yml` reads (`vars.ORACLE_EVIDENCE`),
3. the population and the reader are the ones the pre-registration named.

The inputs carry (3), the variable carries (2), and (1) is checked here because that is where a refusal costs
nothing: `verify.yml` runs on every push, so the commit about to be measured already has a conclusion keyed by its
SHA, and re-deriving it inside the measuring job is what cost two dispatches on the probe workflow.

## The variable, and the cost of using it

`benchmark.yml` reads `vars.ORACLE_EVIDENCE` instead of taking a 19th input, for the reason
`benchmark-cortex-memory.yml` gives for `CORTEX_MEMORY_ORACLE`: the condition is measured once per reader
generation, and a repo variable is the channel GitHub's 25-input ceiling does not bound. Its cost is that a value
can be inherited by a dispatch nobody armed, so this script writes it on **every** invocation -- `1` before the
armed dispatch and `0` before anything else -- and `--restore` exists so the reset is a command rather than a
remembered chore.

Inheritance is also detectable after the fact: the report's `dataset` carries the `+oracle` suffix and
`assertOracleReached` refuses a run whose artifact disagrees, so a leaked variable produces a visibly labelled
artifact rather than a quiet one.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request

REPO = "AgentiX-E/cortex"
WORKFLOW = "benchmark.yml"
VARIABLE = "ORACLE_EVIDENCE"

# The pre-registered configuration (`03-execution-plan.md` §14.99.4). Nothing here is a knob to be turned while
# an experiment is running: `limit=0` is the full 500, `runs=1` because the decision threshold is five points and
# the cross-run noise floor is half a point, and the reader is the one the quoted number was produced with.
INPUTS = {
    "limit": "0",
    "runs": "1",
    "ablation_runs": "1",
    "model": "deepseek-chat",
    "thinking": "disabled",
    "entity_identity_clause": "1",
    "candidate_discrimination": "0",
    "retrieval_sides": "0",
    "aggregation_critique": "0",
    "rerank": "off",
    # The hash every registered reading was taken on (`evidence/longmemeval/multi-step-probe-*.corpus.sha256`).
    # Pinned rather than empty: the workflow fetches the file from a moving branch, and a corpus that changed
    # underneath a comparison is the one explanation that survives every other, which is why it is written down
    # before the number instead of after it.
    "corpus_sha256": "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442",
}

# What one full-population pass costs, at the gold pool's size rather than the corpus's. The prompt shrinks by an
# order of magnitude (the census prints the ratio), so the bill is the judge and the reader at ~12 turns each
# rather than at ~550. Stated as an upper bound; the artifact carries the measurement.
CEILING_CNY = 10.0

_TOKEN: str | None = None


def token() -> str:
    """The PAT from `.git/config`, read on first use rather than at import."""
    global _TOKEN
    if _TOKEN is None:
        try:
            config = open(".git/config").read().splitlines()
        except FileNotFoundError:
            sys.exit("no .git/config here: run this from the repository root")
        for line in config:
            if "oauth2:" in line:
                _TOKEN = line.split("oauth2:", 1)[1].split("@", 1)[0]
                return _TOKEN
        sys.exit("no oauth2 token in .git/config")
    return _TOKEN


def req(method: str, path: str, payload=None, allow_empty: bool = False):
    body = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(f"https://api.github.com{path}", data=body, method=method)
    request.add_header("Authorization", f"Bearer {token()}")
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
            sys.exit(f"{method} {path} -> unparseable body: {error}")
        except Exception as error:  # noqa: BLE001 - network layer, retried uniformly
            if attempt < 5:
                time.sleep(2 * (attempt + 1))
                continue
            sys.exit(f"{method} {path} -> {error}")
    sys.exit(f"{method} {path} -> exhausted retries")


def set_variable(value: str) -> None:
    """Create or update `vars.ORACLE_EVIDENCE`, whichever the repository needs.

    `PATCH` and `POST` are separate endpoints and the wrong one answers `404` with a body about variables in
    general, which reads like a permissions failure. The existence check is therefore explicit rather than
    inferred from one attempt's error.
    """
    # `PATCH` first, then `POST`, then `PATCH` again. The obvious order -- read, then create or update --
    # depends on the read succeeding, and it does not: the first armed dispatch created the variable and the
    # second was answered `404` by the single-variable `GET` while `POST` answered `409 Already exists`. A
    # create/update pair that infers existence from a read is therefore wrong here, and the retry ladder says
    # what it means without asking the API which endpoint it feels like serving.
    try:
        req("PATCH", f"/repos/{REPO}/actions/variables/{VARIABLE}", {"name": VARIABLE, "value": value}, allow_empty=True)
        print(f"{VARIABLE} = {value} (updated)")
        return
    except SystemExit:
        pass
    try:
        req("POST", f"/repos/{REPO}/actions/variables", {"name": VARIABLE, "value": value}, allow_empty=True)
        print(f"{VARIABLE} = {value} (created)")
        return
    except SystemExit:
        pass
    req("PATCH", f"/repos/{REPO}/actions/variables/{VARIABLE}", {"name": VARIABLE, "value": value}, allow_empty=True)
    print(f"{VARIABLE} = {value} (updated after a create that reported it already existed)")


def await_verify(sha: str, wait_seconds: int) -> tuple[str, str]:
    """The newest `push`/`pull_request` verdict `verify.yml` reached on `sha`.

    Only those two events: a dispatched `Verify` is somebody asking the same question by hand, and gating a
    dispatch on it would let the gate be dispatched -- which is the shape of gate this repository keeps removing.
    """
    deadline = time.monotonic() + wait_seconds
    terminal = {"failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"}
    while True:
        runs = req("GET", f"/repos/{REPO}/actions/workflows/verify.yml/runs?head_sha={sha}&per_page=20")
        for run in runs.get("workflow_runs") or []:
            if run.get("event") in ("push", "pull_request"):
                conclusion = run.get("conclusion") or run.get("status") or "unknown"
                if conclusion == "success" or conclusion in terminal:
                    return conclusion, run["html_url"]
                url = run["html_url"]
                break
        else:
            url = ""
        if time.monotonic() >= deadline:
            return "pending", url
        time.sleep(15)


def main(argv: list[str]) -> int:
    if "--restore" in argv:
        set_variable("0")
        print("the condition is disarmed; every later dispatch runs the shipped corpus")
        return 0

    dry_run = "--dry-run" in argv
    wait_seconds = 0
    if "--wait" in argv:
        wait_seconds = int(argv[argv.index("--wait") + 1])

    sha = req("GET", f"/repos/{REPO}/git/ref/heads/master")["object"]["sha"]
    print(f"head of master: {sha}")
    print(f"{WORKFLOW}: {json.dumps(INPUTS, sort_keys=True)}")
    print(f"oracle evidence: armed via vars.{VARIABLE}")
    print(f"500 questions x 1 run, gold-only pools => upper bound {CEILING_CNY:.2f} CNY")
    if dry_run:
        print("--dry-run: nothing written, nothing dispatched")
        return 0

    conclusion, url = await_verify(sha, wait_seconds)
    suffix = f"  {url}" if url else ""
    print(f"verify.yml on {sha[:8]}: {conclusion}{suffix}")
    if conclusion != "success":
        raise SystemExit(
            f"refusing to dispatch: `Verify` on {sha[:8]} is {conclusion!r}, not 'success'.\n"
            "The reading is about a tree, and the tree's own verdict is the only evidence that it builds and "
            "passes its gates. `--wait N` polls for up to N seconds; there is no flag that dispatches anyway."
        )

    set_variable("1")
    req(
        "POST",
        f"/repos/{REPO}/actions/workflows/{WORKFLOW}/dispatches",
        {"ref": "master", "inputs": INPUTS},
        allow_empty=True,
    )
    print("dispatched. After the artifact is read: python3 tools/dispatch-oracle-ceiling.py --restore")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
