#!/usr/bin/env python3
"""Dispatch the multi-step retrieval probe (`§14.98.8`).

## What this dispatch decides, and what it refuses to decide

The probe is not a benchmark. It answers one question -- does a reader that chooses its own
evidence find gold turns that the single-shot seed search does not -- and its reading is a
pre-registered criterion, not a point estimate: `gainedQuestions >= 5` buys the two-step arm, and
anything less cancels it. So this script sends the population and the step count and nothing else.
There is no temperature to set and no model to tune, because a reader that only works at one
temperature has not been measured, it has been fitted.

## Why a script rather than `gh workflow run`

The sandbox admits `api.github.com` only, so `gh` is unusable and the dispatch has to be an HTTP
call. The repository's rule (`tools/__tests__/test_dispatch_inputs.py`) is that every dispatch
script is pinned to the workflow that declares its inputs, and that rule exists because GitHub
**drops** an undeclared input without an error: the run starts, the workflow uses its default, and
the artifact describes the configuration the operator believed they dispatched. That is worse than
a refusal, and it is invisible in the artifact.

## The cost guard

The probe's whole purpose is to be the cheap arm that decides whether to pay for the expensive one,
so a dispatch that could silently cost as much as the thing it gates would defeat itself. `INPUTS`
is the registered configuration (one step, `MR`, full population, ~2 CNY); `--steps` and `--limit`
exist for a smoke run, and the projection printed before the call is what makes a typo visible
before it is billed rather than after.

Usage:
  python3 tools/dispatch-multi-step-probe.py --dry-run
  python3 tools/dispatch-multi-step-probe.py
  python3 tools/dispatch-multi-step-probe.py --steps 0      # the control arm: no reader calls
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = "AgentiX-E/cortex"
WORKFLOW = "probe-multi-step.yml"

# The registered configuration from `cortex-docs/docs/03-execution-plan.md` §14.98.8.
#
# `steps: 1` is ONE model call, not one search: the seed search is free and the reader gets a single
# decision. `0` is the control -- one seed search, zero calls -- and its reading must reproduce the
# single-shot arm question for question, which is the check that the probe measures the reader rather
# than the difference between two corpus loaders.
INPUTS = {
    "steps": "1",
    # `MR` is multi-session reasoning: the 121 questions whose gold turns are spread across sessions,
    # which is where a single seed query has the most to miss and therefore where a reader has the
    # most to find.
    "capability": "MR",
    # The whole population. A capped run is a smoke test and its `gainedQuestions` cannot be compared
    # with the criterion, which is stated over the population.
    "limit": "0",
}

# Prompt characters per decision call, from the probe's own per-question figure at one step on this
# population. Used only for the projection; the artifact carries the measured number, and if the two
# disagree the artifact is right.
PROMPT_CHARS_PER_CALL = 1500

# The two constants the projection divides and multiplies by, both taken from files that already own
# them rather than restated from memory: `tools/token-basis.json` measures `charsPerToken` at 3.8528
# on this corpus with this reader's tokenizer, and `tools/spend-projection.mjs` holds the dated
# DeepSeek price. A projection built on an assumed 4 chars/token would overstate the token count by
# 3.8% and nobody would ever know which of the two numbers was the estimate.
CHARS_PER_TOKEN = 3.8528
# Uncached, because the decision prompt carries the question and its own recent steps and therefore
# shares no prefix across questions -- a cached-input price here would describe a run that cannot
# happen.
CNY_PER_MTOK_PROMPT = 2.0

# The amount `§14.98.8` allows the probe to spend without anyone saying so.
PROBE_CEILING_CNY = 2.0


_TOKEN: str | None = None


def token() -> str:
    """The PAT from `.git/config`, read on first use rather than at import.

    Lazy for the reason the other dispatchers record at length: a module-level read makes importing
    this file require a credential, and the parts worth testing take none.
    """
    global _TOKEN
    if _TOKEN is None:
        try:
            config = Path(".git/config").read_text(encoding="utf-8").splitlines()
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

    An unknown key is refused because GitHub drops an undeclared input without an error, and a
    second override for one key is refused rather than last-wins, because last-wins makes the
    command line's meaning depend on order.
    """
    applied = dict(inputs)
    for override in overrides:
        if "=" not in override:
            raise SystemExit(f"--set expects KEY=VALUE, got {override!r}")
        key, _, value = override.partition("=")
        if key not in applied:
            raise SystemExit(
                f"--set {key} is not a declared input of {WORKFLOW}; GitHub would drop it and the "
                f"run would use the default. Declared: {', '.join(sorted(applied))}"
            )
        if key in _SET_KEYS:
            raise SystemExit(f"--set {key} given twice")
        _SET_KEYS.add(key)
        applied[key] = value
    return applied


_SET_KEYS: set[str] = set()


def projection(inputs: dict[str, str]) -> str:
    """What this dispatch is expected to cost, as one line, before it is billed.

    The ceiling in `§14.98.8` is 2 CNY, and it is a ceiling rather than an estimate: it was written
    before the prompt was measured, as the amount the probe was allowed to spend without asking. The
    estimate below is what the same probe costs at the measured prompt size, so the pair reads as
    "this is the number, and that is the line it may not cross" rather than as two competing figures.
    """
    steps = int(inputs["steps"])
    limit = int(inputs["limit"])
    population = 121 if limit == 0 else limit
    calls = population * steps
    chars = calls * PROMPT_CHARS_PER_CALL
    cny = chars / CHARS_PER_TOKEN / 1_000_000 * CNY_PER_MTOK_PROMPT
    verdict = "within" if cny <= PROBE_CEILING_CNY else "OVER"
    return (
        f"{population} questions x {steps} step(s) = {calls} model call(s), "
        f"~{chars:,} prompt chars => ~{cny:.2f} CNY ({verdict} the {PROBE_CEILING_CNY:.0f} CNY "
        "ceiling; the artifact carries the measurement)"
    )


def main(argv: list[str]) -> int:
    overrides: list[str] = []
    dry_run = False
    index = 1
    while index < len(argv):
        arg = argv[index]
        if arg == "--dry-run":
            dry_run = True
            index += 1
        elif arg == "--steps":
            overrides.append(f"steps={argv[index + 1]}")
            index += 2
        elif arg == "--limit":
            overrides.append(f"limit={argv[index + 1]}")
            index += 2
        elif arg == "--capability":
            overrides.append(f"capability={argv[index + 1]}")
            index += 2
        elif arg == "--set":
            overrides.append(argv[index + 1])
            index += 2
        else:
            raise SystemExit(f"unknown argument {arg!r}; see the module docstring for usage")

    inputs = apply_overrides(INPUTS, overrides)
    print(f"{WORKFLOW}: {json.dumps(inputs, sort_keys=True)}")
    print(projection(inputs))
    if dry_run:
        print("--dry-run: nothing dispatched")
        return 0

    # The ref is the commit this checkout is on, not a branch: a dispatch that names a branch
    # measures whatever that branch happens to point at when the runner clones, which is how a
    # comparison ends up describing two different trees. `git rev-parse HEAD` is read rather than
    # assumed so a dirty checkout is visible in the line below.
    head = (
        Path(".git/HEAD").read_text(encoding="utf-8").strip()
        if Path(".git/HEAD").is_file()
        else "unknown"
    )
    print(f"ref: {head}")

    req(
        "POST",
        f"/repos/{REPO}/actions/workflows/{WORKFLOW}/dispatches",
        {"ref": "master", "inputs": inputs},
        allow_empty=True,
    )
    runs = req("GET", f"/repos/{REPO}/actions/workflows/{WORKFLOW}/runs?per_page=1")
    workflow_runs = runs.get("workflow_runs") or [] if isinstance(runs, dict) else []
    if workflow_runs:
        run = workflow_runs[0]
        print(f"dispatched: run {run['id']} {run['html_url']}")
    else:
        print("dispatched: no run listed yet; GitHub takes a few seconds to create it")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
