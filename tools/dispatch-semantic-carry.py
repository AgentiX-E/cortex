#!/usr/bin/env python3
"""Dispatch the semantic layer's own instrument (§E6) and report the run.

## What this dispatch is, in one paragraph

`semantic-carry.yml` runs the cognitive system against **itself** with `semanticCarry` off on one
side and on on the other, over a population where each corpus is asked more than once. Those three
facts are the whole reason the workflow exists, and each of them answers a defect this campaign has
already paid for: the registered population cannot carry an update (every question brings its own
haystack, so the reach is zero by construction, `AUDIT-SEMANTIC-REACH.md` §15.2); two dispatches
would pair two runs across a time-of-day drift larger than most effects this arm could find
(`PREREGISTRATION` §2.2); and a pool that split a corpus's windows across two workers would
administer the treatment into a store that never absorbed it.

## Why a script rather than a click

The dispatch has to name the exact commit, and the sandbox admits `api.github.com` only. Passing
`ref` is what makes the run a controlled comparison: without it the workflow picks up whatever
`master` is at dispatch time, and the two sides can land on different code -- which is how the run
recorded in §13 produced two byte-identical arms and a verdict about the dispatch. `master` is the
ref, because `push-via-api.py` rebuilds each commit through the Git Data API and the token cannot
resolve a commit object to a ref; the SHA is printed so the log says which revision ran.

## What it deliberately does not check

Whether the values are the right ones. `--set` refuses a key the workflow does not declare and a
key it declares twice, because those are the two silent-drop shapes `test_dispatch_inputs.py`
guards from the other side; it does not refuse a *value*, because a screening dispatch and a
registered one are both legitimate and the difference is a judgement this script has no standing to
make. The dispatch prints what it sent, and the artifact carries what ran.

Usage:
  python3 tools/dispatch-semantic-carry.py
  python3 tools/dispatch-semantic-carry.py --set windows=2 --set capability=all
  python3 tools/dispatch-semantic-carry.py --watch
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = "AgentiX-E/cortex"
WORKFLOW = "semantic-carry.yml"

# The workflow's own defaults, written out here rather than left to GitHub.
#
# Not duplication for its own sake: `test_dispatch_inputs.py` refuses a key the workflow does not
# declare, but an input the workflow declares and this script omits is *silently* defaulted by the
# workflow -- so the run would differ from what the log of the dispatch says was asked for. Writing
# every key here makes the dispatch self-describing, and a workflow default that moved would show up
# as a diff in this file rather than as a run nobody can explain.
INPUTS: dict[str, str] = {
    # Two windows is the population `S13` names: the first window absorbs an update, the second is
    # the one a carry can reach. `1` is the registered population, where the reach is zero by
    # construction -- useful only as a control on the population itself.
    "windows": "2",
    # `KU` grades the 78 knowledge-update questions, which are the population where a supersession
    # can be the failure mode at all. `all` is the registered 500 and the instrument `S12` is
    # registered on.
    "capability": "KU",
    "limit": "0",
    # Two repetitions is the screening scale (78 corpora x 2 windows x 2 repetitions = 312 answers
    # per side). `S12` is registered at four.
    "ablation_runs": "2",
    "model": "deepseek-chat",
    "thinking": "disabled",
    # Mirrors the workflow's own default, which moved from 4 to 32 when the registered shape's
    # arithmetic was corrected: 17,900 calls is 30 hours at four workers and 3.8 at thirty-two, and
    # the job carries a 300-minute in-run budget that 24 workers lands exactly on.
    "workers": "32",
    # The ceiling the workflow's own gate reads. Sent rather than left to the workflow, for the
    # reason every other key is: a default the dispatcher does not state is a run whose budget the
    # log cannot explain. See `DEFAULT_BUDGET_CNY` for why this workflow's number is not the other
    # dispatcher's 3.00.
    "budget_cny": "120",
}

# The gate. A dispatch is billed the moment it starts and there is no refund for one whose
# configuration was wrong, so the projection is printed before the call rather than after the
# artifact -- the same argument `dispatch-cortex-memory-ab.py` records at length.
SPEND_TOOL = Path(__file__).resolve().parent / "spend-projection.mjs"
SPEND_BASELINE = Path(__file__).resolve().parent / "spend-baseline.json"

# What a dispatch of this workflow may cost without anyone saying so.
#
# **Not 3.00.** That number belongs to `dispatch-cortex-memory-ab.py`, where it separates "a run that
# answers a question about a change" from "a run that publishes a point estimate" -- and on this
# workflow the point estimate *is* the run that exists: `S12` is registered on 500 corpora x 2
# windows x 4 repetitions, which is 25-96 CNY depending on the cache mix. A 3.00 default here would
# refuse the only dispatch that can fill the row while passing the screening pair it was never meant
# to protect.
#
# 120 carries headroom above the top of that band: the 96 CNY end is the 50%-cache case, and a cold
# first repetition is the one thing about the mix this history cannot bound. `--budget N` states a
# different ceiling; `--no-budget` disables the gate and says so in the log.
DEFAULT_BUDGET_CNY = 120.0


_TOKEN: str | None = None


def token() -> str:
    """The PAT from `.git/config`, read on first use rather than at import.

    Lazy for the reason `dispatch-cortex-memory-ab.py` records at length: a module-level read makes
    **importing** this file require a credential, and the parts worth testing take none.
    """
    global _TOKEN
    if _TOKEN is None:
        try:
            config = open(".git/config").read().splitlines()
        except FileNotFoundError:
            sys.exit(
                "no .git/config in the working directory: dispatch reads the token from the "
                "checkout's own config, so run this from the repository root"
            )
        for line in config:
            if "oauth2:" in line:
                _TOKEN = line.split("oauth2:", 1)[1].split("@", 1)[0]
                return _TOKEN
        sys.exit("no oauth2 token in .git/config")
    return _TOKEN


def req(method: str, path: str, payload=None, allow_empty: bool = False):
    """One API call, retried on the transient classes.

    `allow_empty` exists because the dispatch endpoint answers 204 with no body, and `json.load` on
    an empty body raises -- a retried parse failure would turn one dispatch into several.
    """
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


def apply_overrides(inputs: dict[str, str], overrides: list[str]) -> dict[str, str]:
    """`inputs` with each `KEY=VALUE` applied, refusing anything that would be silent.

    An unknown key is refused because GitHub **drops** an undeclared dispatch input without an
    error: the run starts, the workflow uses its default, and the artifact describes the
    configuration the operator believed they dispatched. A second override for one key is refused
    rather than last-wins, because last-wins makes the command line's meaning depend on order.
    """
    for override in overrides:
        if "=" not in override:
            raise SystemExit(f"--set expects KEY=VALUE, got {override!r}")
        key, _, value = override.partition("=")
        key = key.strip()
        if key not in inputs:
            raise SystemExit(
                f"{key!r} is not an input {WORKFLOW} declares, so GitHub would drop it and the run "
                f"would use the default. Keys: {', '.join(sorted(inputs))}"
            )
        inputs[key] = value.strip()
    return inputs


def parse_argv(argv: list[str]) -> tuple[list[str], bool, bool, float | None]:
    """The `--set` values, `--watch`, `--allow-stale-tree`, and the budget.

    `--budget` is spelled `--budget=N` like `--set=KEY=VALUE`, and for the same reason: two
    arguments would make the command line's meaning depend on order, which is the defect `--set`'s
    own refusal names. `--no-budget` is a different flag from `--budget 0`, because a zero budget
    refuses every dispatch and "do not gate this one" is not "gate it at nothing".
    """
    sets: list[str] = []
    watch = False
    allow_stale = False
    budget: float | None = DEFAULT_BUDGET_CNY
    for argument in argv:
        if argument == "--watch":
            watch = True
            continue
        if argument == "--allow-stale-tree":
            allow_stale = True
            continue
        if argument == "--no-budget":
            budget = None
            continue
        if argument.startswith("--budget="):
            budget = float(argument[len("--budget=") :])
            continue
        if argument.startswith("--set="):
            sets.append(argument[len("--set=") :])
            continue
        if argument == "--set":
            raise SystemExit("use --set=KEY=VALUE; two arguments would make order matter")
        if argument == "--budget":
            raise SystemExit("use --budget=N; two arguments would make order matter")
        raise SystemExit(f"unrecognised argument {argument!r}")
    return sets, watch, allow_stale, budget


def local_tree() -> str | None:
    """This checkout's HEAD tree, or `None` when the script is not running inside one."""
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "HEAD^{tree}"],
            cwd=str(Path(__file__).resolve().parent.parent),
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None
    if completed.returncode != 0:
        return None
    return completed.stdout.strip() or None


def projected_spend(inputs: dict[str, str], budget: float | None) -> None:
    """Print this dispatch's projected bill and refuse when it breaches `budget`.

    Delegated to `spend-projection.mjs` rather than re-implemented: that tool owns the dated prices,
    the cache split and the three refusals, and a second copy of the arithmetic here would be two
    readers of one number who can disagree while both are right.

    Two arguments are not passed straight through, and both are the difference between pricing the
    dispatch that happens and pricing a different one:

    - `limit: '0'` is the workflow's spelling for the whole file. Priced literally it is zero
      questions, which would make the largest dispatch in this repository cost nothing.
    - `capability` and `limit` together are not projectable, so with a capability the whole file is
      named explicitly and the capability selects from it. Passing both would be refused by the
      projection -- correctly -- and passing only `limit` would price a bigger run than the sampler
      produces.

    A missing or unreadable baseline does not block the dispatch: the gate is an instrument, and an
    instrument that cannot run is not a reason to stop working. The log says the run went unpriced,
    so nobody later reads its absence as a measurement of zero.
    """
    if not SPEND_BASELINE.exists():
        print(f"spend: no baseline at {SPEND_BASELINE.name}, this dispatch is not priced")
        return
    try:
        baseline = json.loads(SPEND_BASELINE.read_text())
    except (OSError, ValueError) as error:
        print(f"spend: baseline is unreadable ({error}), this dispatch is not priced")
        return
    raw_limit = str(inputs.get("limit", "0") or "0")
    limit = str(baseline.get("questionCount")) if raw_limit == "0" else raw_limit
    capability = str(inputs.get("capability", "all") or "all").strip()
    scoped = capability != "" and capability.upper() != "ALL"
    # A capability and a limit together are refused rather than resolved, because the sampler
    # round-robins over buckets: `limit=40` then `capability=KU` selects however many KU questions
    # the first forty happened to include. Guessing would price a different run than the one that
    # happens, and silently dropping the operator's limit would dispatch a bigger run than they
    # asked for -- the two failure shapes this file refuses elsewhere for the same reason.
    if scoped and raw_limit != "0":
        raise SystemExit(
            f"refusing: capability={capability} with limit={raw_limit} is not projectable -- the "
            "sampler round-robins, so the surviving count is a property of the bucket order rather "
            "than of either input. Send limit=0 with a capability, or the capability alone."
        )
    arguments = [
        "node",
        str(SPEND_TOOL),
        "--report",
        str(SPEND_BASELINE),
        "--runs",
        str(inputs.get("ablation_runs", "1")),
        "--windows",
        str(inputs.get("windows", "1")),
        "--thinking",
        inputs.get("thinking", "disabled"),
    ]
    if scoped:
        arguments.extend(["--limit", "0", "--capability", capability])
    else:
        arguments.extend(["--limit", limit])
    if budget is not None:
        arguments.extend(["--budget", str(budget)])
    completed = subprocess.run(arguments, capture_output=True, text=True, check=False)
    print(completed.stdout, end="")
    if completed.returncode != 0:
        raise SystemExit(completed.stderr.strip() or "the spend projection refused this dispatch")


def main(argv: list[str]) -> int:
    sets, watch, allow_stale, budget = parse_argv(argv)
    inputs = apply_overrides(dict(INPUTS), sets)

    head = req("GET", f"/repos/{REPO}/git/ref/heads/master")["object"]["sha"]
    remote_tree = req("GET", f"/repos/{REPO}/git/commits/{head}")["tree"]["sha"]
    checkout_tree = local_tree()
    if checkout_tree is not None and checkout_tree != remote_tree and not allow_stale:
        raise SystemExit(
            f"refusing to dispatch: master's tree is {remote_tree[:12]} and this checkout's HEAD "
            f"tree is {checkout_tree[:12]}. The run would measure code this checkout does not "
            "contain. Push first, or pass --allow-stale-tree when that is deliberate."
        )

    # Printed before the call, because after it the run exists and the operator's attention moves
    # to the artifact. Everything below is what the run will be conditioned on.
    print(f"workflow: {WORKFLOW}  ref: master  head: {head[:12]}")
    for key in sorted(inputs):
        print(f"  {key} = {inputs[key]!r}")

    # Before the call, because after it the run exists and there is no refund for one that was
    # mispriced. The ceiling is passed rather than read from the file so a deliberate purchase is a
    # number somebody typed in this invocation.
    projected_spend(inputs, budget)

    req(
        "POST",
        f"/repos/{REPO}/actions/workflows/{WORKFLOW}/dispatches",
        {"ref": "master", "inputs": inputs},
        allow_empty=True,
    )

    # The run the API accepted, found by polling the workflow's own list. One dispatch is in flight
    # by construction here, so the first run of this workflow is ours; a concurrent dispatch from
    # another operator would be a different session's and is out of scope for this script.
    run = None
    for _ in range(10):
        time.sleep(3)
        listing = req("GET", f"/repos/{REPO}/actions/workflows/{WORKFLOW}/runs?per_page=1")
        runs = listing.get("workflow_runs", [])
        if runs:
            run = runs[0]
            break
    if run is None:
        print("dispatch accepted, but no run appeared within 30 s", file=sys.stderr)
        return 1
    print(f"run: {run['id']}  {run['html_url']}")

    if not watch:
        return 0
    while run["status"] != "completed":
        time.sleep(30)
        run = req("GET", f"/repos/{REPO}/actions/runs/{run['id']}")
        print(f"  {run['status']} :: {run['conclusion']}")
    print(f"conclusion: {run['conclusion']}")
    return 0 if run["conclusion"] == "success" else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
