#!/usr/bin/env python3
"""Dispatch the `cortex-memory` A/B (roadmap step 3).

Why a script: the sandbox admits api.github.com only, `gh` is unusable, and the
dispatch has to name the exact commit. Passing `ref` is what makes the run a
controlled comparison: without it the workflow picks up whatever master is at
dispatch time, and the two sides can land on different code -- which is how the
run recorded in §13 produced two byte-identical arms and a verdict about the
dispatch.

Why one invocation and not two: this arm's two sides run in the SAME job, through
one `runAblationReport` call, because they are different systems rather than two
configurations of one. That is the pairing invariant the pre-registration
document fixes (`docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md` §2.2), and splitting
the dispatch would break it into a staggered comparison -- time-of-day drift is
1.7-2.1pp, larger than most effects this arm could find.

Pre-registered before dispatch, per AUDIT-CODE-VS-DOCS.md §6.3:

  - the point estimate it must beat: the BASELINE side of this same dispatch;
  - success: McNemar p < 0.05 with delta > 0, two-sided, overall
    abstention-aware accuracy, full N=500, 4 runs, temperature 0;
  - stopping rule: one dispatch, no peeking, no re-running for a better draw.

The `CORTEX_MEMORY` toggle is what enables the arm; `cortex-eval`'s CLI skips it
when unset, and `cortex-memory/bench/run-ablation.ts` is the entry point that
constructs both sides. The workflow step that invokes it is added alongside this
script.

Usage:
  python3 tools/dispatch-cortex-memory-ab.py
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request

REPO = "AgentiX-E/cortex"
WORKFLOW = "benchmark.yml"

# The configuration registered in `docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md` §10.3,
# held constant. These values are not free parameters of this script: §10 fixed them
# before the run, and `tools/__tests__/test_preregistration_config.py` asserts that what
# is sent here is what that section names. Changing a number here without amending §10
# is the fourth form of the §7.3 defect -- the artifact would describe the intent.
#
# `limit: '0'` is the full 500 questions -- this arm's point estimate must be measured
# on the whole set, because a 60-question sample gives a Wilson interval too wide to
# distinguish the null the arm expects from the effect it is looking for.
#
# `cortex_memory_retrieval_threshold` is sent explicitly as the string `'0'`, not
# left to the workflow default. The empty string GitHub substitutes for an unfilled
# input parses to `0` today, so omitting it would happen to match -- and it would
# arrive through the `''` -> `Number('')` path that §38 identified as the source of
# two separate defects. A configuration this run depends on should not arrive via an
# accident, and an absent key cannot be shown to be wrong.
#
# The value is `0`, REVERTED FROM `0.25` BY §10.9. The `0.25` was §10's registration,
# chosen as "the midpoint of the interval the ceiling makes reachable". The run that
# spent it (`37313582403`) refuted it: abstention rose 49.40% -> 95.80% instead of
# falling as §10.4 predicted, accuracy fell 43.80% -> 6.60%, and the discordant split
# was 186 lost to 0 won (McNemar p = 2.039e-56). That is §10.4's fourth row
# (`p < 0.05 with delta < 0`), whose pre-committed recovery is exactly this revert --
# so this line executes a decision taken before the number existed rather than one
# taken after reading it. The alternative reading, `0.1`, is the redraw §4 forbids.
#
# §10.3 carries the same amendment, because `test_preregistration_config.py` compares
# these values against §10.3 itself and a revert applied to only one side would fail
# there -- which is the guard working, not an obstacle to it.
#
# `cortex_memory_source_trust` is sent for the third reason: the variable did not
# exist in `INPUTS` at all until now, and neither did the workflow input behind it.
# A dispatch that names a threshold the arm cannot compare against is the §7.3
# side-channel defect in its third form -- the run completes, and its artifact
# describes the configuration the operator intended rather than the one the code
# applied. `0.5` is the value `admission.ts` hardcoded before the field existed, so
# stating it explicitly keeps this dispatch comparable to runs `37110579101` and
# `37094200823` while making the ceiling a fact on the record instead of a property
# of a literal someone has to go read.
#
# `cortex_memory_threshold` is sent as `'0'` for the reason above applied to the other
# gate. §10.3 registers `threshold: 0`; this key was previously OMITTED, on the argument
# that the workflow default also lands on `0`. That argument is the one the paragraph
# above rejects: it lands there through `''` -> `readNumeric` -> default, and a
# registered value should not arrive via an accident. The omission is also invisible --
# an absent key cannot disagree with anything, so no artifact could show that the
# registered `threshold` was never stated. `test_preregistration_config.py` found it by
# comparing the dispatch against §10.3 rather than against the workflow's defaults.
# §12.5's single variable. The gate inputs above are held at exactly the values §10.3
# registers -- `threshold: 0`, `retrievalThreshold: 0` (reverted from `0.25` by §10.9),
# `sourceTrust: 0.5` -- because §12.3 measured that no cut in the reachable range can carry
# this arm: the hit and miss score distributions overlap almost completely (hits
# `[0.5212, 0.7861]` against misses `[0.5165, 0.7944]`), and the best precision reachable
# at full-ish recall is `0.466` against a base rate of `0.368`. A retrieval cut is
# therefore not the mechanism, and moving one alongside the rendering would make a
# non-zero MR/TR unattributable to either.
#
# What §12.4 leaves as the surviving hypothesis is what the arm PRESENTS. The feature side
# repaired **not one question** on any capability (`b-f` repairs of `0` everywhere) while
# abstaining at `95.8%` with every abstention attributed to the model (`reason: "llm"`),
# not to the gate. So the model is reached and declines, and what reaches it is the
# evidence rendering. `cortex_memory_prompt_contract` is that variable.
#
# §13 then tested the OTHER axis of "what reaches it" -- the instruction block rather than
# the rendering -- and §13.8 falsified it. With `cortex_memory_ask: 'extractive'` the
# feature side's MR went `13 -> 0` and TR `16 -> 0`, so `b✓f✗` rose by exactly what `b✗f✓`
# fell: a swap, not a repair. §13.9 retired the line. Crucially the same artifact showed
# `renderingRoutes: []` and `askRoutes: [4 routes]`, which is §13.2's independence
# requirement satisfied in one file, and 113 of the 120 outputs were the bare
# `INSUFFICIENT_EVIDENCE` token with `retrievalThreshold: 0` -- the gate never closed, so
# the model SAW evidence and declined anyway.
#
# That is the question §13.11 registers, and it is why both fields are sent together
# rather than one replacing the other. The loss is unexplained by how the arm asks, so
# what remains is the evidence itself: "the reader was shown the wrong turn" and "the
# reader was shown nothing" are repaired in different places, and until `QuestionRecord.turns`
# was wired the artifact reported both as the same absence -- `turns: []` on all 120 records
# of the §13 dispatch, because `buildArmRoster` passed `retrieved: ''` unconditionally.
# This run is the first whose artifact can tell the two apart.
#
# `cortex_memory_ask` is therefore held at §13's value rather than reverted to the shipped
# per-route blocks. Reverting it would move a second variable alongside the capture and
# make a non-empty `turns` on MR unattributable to either.
INPUTS = {
    "cortex_memory": "1",
    "cortex_memory_threshold": "0",
    "cortex_memory_retrieval_threshold": "0",
    "cortex_memory_source_trust": "0.5",
    "cortex_memory_prompt_contract": "abstention-evidence-blocks",
    "cortex_memory_ask": "extractive",
    "limit": "0",
    "ablation_runs": "4",
    "temperature": "0",
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
    and `json.load` on an empty body raises. Retrying that parse failure would
    turn one dispatch into several.
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
            sys.exit(f"{method} {path} -> unparseable body: {error}")
        except Exception as error:  # noqa: BLE001 - network layer, retried uniformly
            if attempt < 5:
                time.sleep(2 * (attempt + 1))
                continue
            sys.exit(f"{method} {path} -> {error}")
    sys.exit(f"{method} {path} -> exhausted retries")


def remote_head() -> str:
    """The remote's HEAD SHA, recorded for the log, never passed as `ref`.

    These are different SHAs for the same content: `push-via-api.py` rebuilds the
    commit through the Git Data API, so the remote gets a fresh commit object with
    the same tree. Passing a local SHA answers 422 `No ref found for`, and passing
    the remote SHA does too -- the token cannot resolve a commit object to a ref for
    dispatch even when `master` points at that very commit. So the ref is `master`
    and the SHA is reported only so the log says which revision the run used.
    """
    return req("GET", f"/repos/{REPO}/git/ref/heads/master")["object"]["sha"]


def main() -> int:
    sha = remote_head()
    print(f"dispatching cortex-memory A/B at master ({sha[:8]})")
    for key in sorted(INPUTS):
        print(f"  {key} = {INPUTS[key]}")

    req(
        "POST",
        f"/repos/{REPO}/actions/workflows/{WORKFLOW}/dispatches",
        {"ref": "master", "inputs": INPUTS},
        allow_empty=True,
    )
    print("dispatched")
    return 0


if __name__ == "__main__":
    sys.exit(main())
