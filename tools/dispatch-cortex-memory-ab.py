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
WORKFLOW = "benchmark-cortex-memory.yml"

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
#
# §13.16 read the run that capture made possible (38142407062) and it closed the evidence
# question in one direction and opened it in another. Closed: the capture works, the record
# now carries the turns the model actually read, and the offer is reported beside them --
# `evidenceTurns` and `admittedTurns` are two numbers rather than one collapsed value. Open:
# the *selection* was measured and it is wrong in kind, not in degree. The gold turn was
# inside the delivered context for **11.6%** of questions (14 of 121) while the ceiling is
# **92.1%** -- the share of questions whose answer turn is in the bundle at all
# (`MEASURE-B2-RECALL-CURVE.md`). The prompt spent its whole budget, carried 4.69% of a
# 506338-character mean context, and bought the wrong 4.69%, because nothing beneath the
# builder ranked anything and arrival order on this arm is the dataset's haystack order.
#
# So §13.17 registers the selection signal as the variable, and it is the only one this
# dispatch moves. `cortex_memory_relevance: 'retrieval'` builds an index over each
# question's own context from the arm's own bi-encoder and spends the budget on the turns
# that rank highest -- the same ranking the reference pipeline already uses, so the two
# sides answer from one notion of relevance rather than two. The signal reads the question
# text and its context and **never the answer key**; `relevance-index.ts` makes that
# structural (the ground truth is not a parameter of the case type) and a test measures it.
#
# `cortex_memory_relevance_top_k` is sent explicitly at `64` rather than left blank, and the
# reason is the guard in `tools/__tests__/test_preregistration_config.py`: a value that
# never reaches the environment is a value §10.3 cannot be compared against, so a blank here
# would let the run apply a default no registration names. Sixty-four is at or above the
# knee of the measured recall curve (`recall = 0.921` at `k = 50`, already flattened).
#
# Every other input is held at its §13 value: this run varies the selection and nothing
# else. The rendering and the ask stay as dispatched so a non-zero delta cannot be
# attributed to a change in what the prompt says rather than in which turns it says it about.
# §13.21 sets the ask to `aggregate`: the extractive block plus one sentence saying the
# answer may require combining evidence from more than one turn or session.
#
# §13.20 reverted the ask to `route` and that run (`38439899858`) is the reason this one can
# be targeted at all. It moved TR's abstention rate 69.3% -> 35.4% and its accuracy 22.05%
# -> 49.61%, KU 73.61% -> 86.11%, ABS to 100%, and the arm's delta from +9.25pp to
# **+18.20pp** with McNemar `2.737e-7` -- and it left **MR untouched** (56 of 121
# abstentions, the same 56), which is what the internal control was registered to show:
# MR's own ask already was `extractive`, so `route` is a no-op on it.
#
# That leaves MR as the only capability where the feature side loses (27.27% against the
# reference pipeline's 88.4%), and the reading localises it completely: all 56 of its
# abstentions had the gold evidence carried, and every one was the bare
# `INSUFFICIENT_EVIDENCE` token. More evidence cannot help -- there is nothing left to
# retrieve. What MR lacks is any statement that the answer may not be in one place, which
# is what multi-session questions are: the dataset's own multi-session instances ask for a
# count or a comparison across sessions, and no single turn contains the number.
#
# The instruction has to be targeted rather than global, because a global one is exactly
# what §13.20 had to undo. `aggregate` therefore reaches only the two routes whose contract
# IS `extractive` -- `multi-session` and `flat` -- and leaves the other four byte-identical,
# which the artifact reports as `askRoutes` and the product's own tests pin.
#
# Every other input is held at its §13.20 value, so a movement in MR is attributable to the
# instruction and nothing else.
#
# `38250133116` and `38394103193` both dispatched `ask: 'extractive'`, which replaces
# EVERY route's instruction block with the reference pipeline's two-line one. That block
# is not abstention-free by accident of wording -- it is *shorter*, and what it removes is
# each route's own reasoning instruction: the temporal block's "resolve every relative
# expression against that date", the knowledge-update block's "distinguish the earlier
# value from the later one". The two capabilities that need those instructions most are
# exactly the two the feature side loses on.
#
# And the loss is not retrieval. `38394103193` measured `goldOverlap` per question for the
# first time: of the 56 MR abstentions and 88 TR abstentions, **every single one** had at
# least one gold turn inside the context the model was shown (56/56 and 87/88). Every
# abstention in the whole run -- 56 MR, 88 TR, 20 IE, 3 KU -- was the bare
# `INSUFFICIENT_EVIDENCE` token and nothing else. The model is given the evidence, given
# an instruction that ends "if the evidence does not contain the answer, reply exactly
# INSUFFICIENT_EVIDENCE", and takes it.
#
# So the variable this dispatch moves is the ask, back to each route's own block. §13.9
# retired the ask line and this registration does not reopen it on the old grounds: it was
# retired while the evidence capture was being read from a fixed prompt surface, and §13.19
# makes the coverage measurement independent of the ask. What changed is the evidence, and
# the evidence now says the ask is the remaining lever for MR and TR.
#
# Every other input is held: `relevanceSignal: retrieval` at `relevanceTopK: 64` is the
# mechanism §13.17 proved, and moving it alongside the ask would make a non-zero delta
# unattributable to either.
#
# §13.22 composes the same sentence into each route's own block instead of substituting it,
# and reaches `temporal` as well. The run §13.21 dispatched (`38487229554`) is what moved
# the target: `aggregate` took MR from 27.27% to 44.63% and its abstentions from 56 of 121
# to 24 of 121, and the arm's delta to **+23.25pp** with McNemar `6.479e-12` -- the largest
# movement this arm has produced -- while **TR became the largest remaining loss**, 48.82%
# against the reference pipeline's 64.57%, with **51 of its 127 questions abstaining**.
#
# Those 51 are not a retrieval result. 50 of the 51 had the gold turn carried (the run's
# `goldOverlap` is 126 of 127 questions carrying at least one), and the whole run's
# abstention tally is 121 of 500 with `llm` as the only counted reason and
# `retrievalThreshold: 0` so the gate never closed. The questions are "how many weeks ago
# did I meet up with my aunt", "how many days passed between the day I cancelled my
# subscription and the day I ...", "what is the order of the three trips I took" -- a
# duration, a difference or an ordering assembled from several turns. That is the property
# under which the multi-session route was declining at 56 of 121 before `aggregate` moved
# it to 24 of 121, and the temporal route's own block does not address it: it says to
# resolve relative expressions against the question date and to show the resolved date, and
# its closing line concedes that the evidence may not establish a date.
#
# Why compose rather than substitute: §13.20 measured that substitution is destructive. The
# extractive block sent to every route deleted the date-resolution instruction and TR fell
# 27.6 points; §13.21's `route` restored it and TR rose the same 27.6 points back. So the
# sentence has to be added to what the temporal route already says, and `computed` is the
# ask that expresses that. On the two routes whose own block IS the extractive one it is
# byte-identical to `aggregate` -- asserted in `evidence-ask-reach.test.ts`, not claimed --
# so the single variable between `38487229554` and this run is **what the temporal route
# reads**.
#
# The reach is `['multi-session','flat','temporal']` and the omission of `abstention` is the
# load-bearing one: that route's block calls declining "expected and is a valid outcome", and
# ABS's gold IS abstention, so a sentence whose closing clause is "do not reply
# INSUFFICIENT_EVIDENCE merely because..." would invert the one route where declining scores.
# `knowledge-update` and `assistant` keep their own blocks and are controls.
#
# Every other input is held at its §13.21 value, so a movement in TR is attributable to the
# instruction and nothing else. Note that the threshold bands this registration predicts
# against are DERIVED rather than asserted -- `tools/registration-power.mjs` prints the
# one-question granularity and the binomial sd of each per-capability reading, and §13.21's
# `within 3pp` control band is retired here because on a 72-question capability it was 0.66
# sd wide and could not have held.
INPUTS = {
    "cortex_memory": "1",
    "cortex_memory_threshold": "0",
    "cortex_memory_retrieval_threshold": "0",
    "cortex_memory_source_trust": "0.5",
    "cortex_memory_prompt_contract": "abstention-evidence-blocks",
    # §13.34: `computed` plus the two-step enumeration contract on multi-session alone.
    "cortex_memory_ask": "enumerated",
    "cortex_memory_evidence_turns": "256",
    # §13.64's adopted ranking: dense cosine fused with a rare-keyword channel by reciprocal
    # rank. This line said `retrieval` for six sections after that adoption, because §10.3
    # held BOTH the adoption bullet and §13.17's original one and the registration parser
    # read the last one -- so this table and the stale bullet agreed with each other and
    # disagreed only with the section that decided the question. §13.69 records the run that
    # exposed it: dispatched on `retrieval` against an adopted `retrieval-hybrid`, which
    # would have moved the ranking and the cap at once.
    "cortex_memory_relevance": "retrieval-hybrid",
    # §13.79's adoption. The pool now reaches rank 255, which is what makes the two-route room
    # expressible: at 400 characters the room holds 68 turns against a pool of 256, and the gold
    # that k = 64 could not surface has a median rank of 114 -- inside the pool, outside the room.
    "cortex_memory_relevance_top_k": "256",
    # §13.27's single variable.
    #
    # §13.26 read the artifact the previous dispatch produced and found the mechanism rather
    # than a correlation: grouping MR by how much of the answer session the reader was shown,
    # accuracy runs 14.3%, 33.3%, 41.5%, 66.7% across the first four coverage bands, while
    # MR's carried count has a median of **14** against a median `total` of **24**. The
    # signal ranks TURNS, so the budget buys the highest-scoring turns wherever they live and
    # a multi-session answer -- spread across a whole session of statements -- is scattered
    # across the window instead of completed. The reference pipeline completes the session
    # behind each hit and scores 86.78% on MR.
    #
    # `session` spends the room on whole SESSIONS, ordered by their best-scoring turn. The
    # signal itself does not move: a session's score is the MAXIMUM of its turns' scores, so
    # this is a regrouping of the same numbers rather than a second signal. That is why the
    # key is its own input rather than a second value of `cortex_memory_relevance` -- a unit
    # folded into the signal's name would make a run that changed only the unit
    # indistinguishable, in its own configuration line, from one that changed the scoring.
    #
    # Sent explicitly rather than left blank. `turn` is the default, so omitting it would
    # happen to match -- and it would arrive through the same `''`-to-default path §38
    # identified as the source of two defects. A value this run depends on should not arrive
    # by accident, and an absent key cannot be shown to be wrong.
    # §13.31's repair of §13.27's refuted rule. `session` took the largest prefix of the
    # session ranking and stopped at the first session that did not fit, which left half the
    # room unread; `session-fill` skips it and keeps scanning. Sent explicitly rather than
    # left to the default so the run cannot arrive through the `''`-to-default path.
    # §13.34 holds the selection unit at the shipped default: the variable is the ask, so
    # §13.26 is the comparison and the room, the signal and the unit all stay as they were.
    "cortex_memory_relevance_units": "turn",
    # §13.67/§13.68's variable. `none` is the registered value and is sent explicitly rather
    # than left blank: it is the state every archived prompt was produced under, and the
    # dispatch table's own rule is that a value a run depends on should not arrive through
    # the `''`-to-default path. An experiment overrides it -- `--set
    # cortex_memory_max_turn_chars=400` -- and adoption moves this line and §10.3 together,
    # which is what `test_preregistration_config.py` enforces.
    # §13.76's adopted pair. The width and the reach are registered together because neither is a
    # configuration on its own: a cap of 400 on every route lost 30 IE questions (§13.72), and a
    # reach with no width is a statement about a cap that is not applied.
    "cortex_memory_max_turn_chars": "400",
    "cortex_memory_max_turn_chars_routes": "multi-session,temporal",
    # §13.82's adopted budget. `24000` was the product default every run before §13.81 used; the run
    # that raised it to 48,000 (`39260774611`) delivered 86.9% of MR's gold against 72.9% and added
    # nine questions to the roster, so this line and §10.3 move together. Sent explicitly for
    # the reason every other registered value is: a run's room should not depend on a constant that
    # lives in another package.
    "cortex_memory_max_prompt_chars": "48000",
    # §13.30's per-pass ceiling. 90 minutes is roughly three and a half times the longest
    # pass any completed run has produced on this arm (a full run is about 3h32m for eight
    # passes), so it is a hang detector rather than a slow-run detector.
    "cortex_memory_budget_minutes": "90",
    "limit": "0",
    "ablation_runs": "4",
    "temperature": "0",
}


def apply_overrides(inputs: dict[str, str], overrides: list[str]) -> dict[str, str]:
    """`inputs` with each `KEY=VALUE` applied, refusing anything that would be silent.

    ## Why the refusals are the point

    The table above is edited per dispatch, and an override is how a second dispatch keeps
    the first one's record intact. The failure mode that matters is not a wrong value -- a
    wrong value shows up in the run -- it is an override that **does nothing**: a typo'd key
    would dispatch the previous configuration while the commit message described the new
    one, and the run would then be evidence for an experiment nobody ran.

    So every refusal names what was wrong, and the unknown-key refusal lists the keys that
    exist. A refusal that does not say what would have worked sends the reader back to the
    source, which is where the typo came from.

    Two overrides for one key are refused rather than last-wins: with last-wins the
    experiment is decided by argument order, which is not a thing anyone would intend and
    not a thing a reader could see in the log.
    """
    applied: dict[str, str] = {}
    for override in overrides:
        if '=' not in override:
            raise SystemExit(
                f'--set takes KEY=VALUE, and {override!r} has no "=". '
                f'Keys: {", ".join(sorted(inputs))}'
            )
        key, _, value = override.partition('=')
        if key not in inputs:
            raise SystemExit(
                f'--set {key}=... names a key the dispatch does not send. '
                f'Keys: {", ".join(sorted(inputs))}'
            )
        if key in applied:
            raise SystemExit(
                f'--set names {key} twice ({applied[key]!r} then {value!r}). '
                'One dispatch cannot send two values for one input.'
            )
        applied[key] = value

    merged = dict(inputs)
    merged.update(applied)
    return merged


def parse_argv(argv: list[str]) -> list[str]:
    """The `--set` values from `argv`, refusing anything that is not one.

    Strict rather than permissive: an unrecognised argument is a dispatch that was not
    asked for, and this script's job is to send the experiment it printed.
    """
    sets: list[str] = []
    index = 0
    while index < len(argv):
        argument = argv[index]
        if argument == '--set':
            if index + 1 >= len(argv):
                raise SystemExit('--set needs a KEY=VALUE argument')
            sets.append(argv[index + 1])
            index += 2
            continue
        if argument.startswith('--set='):
            sets.append(argument[len('--set=') :])
            index += 1
            continue
        raise SystemExit(f'unrecognised argument {argument!r}; this script takes --set KEY=VALUE')
    return sets


_TOKEN: str | None = None


def token() -> str:
    """The PAT from `.git/config`, read on first use rather than at import.

    ## Why this is lazy, and the CI failure that made it so

    It used to be `TOKEN = token()` at module level, which made **importing this module**
    require a credential. That was invisible until `tools/__tests__/test_dispatch_overrides.py`
    imported it to test `apply_overrides`, and CI failed with

        SystemExit: no oauth2 token in .git/config

    on all ten new tests: a test suite that cannot import the function it tests on a machine
    that has no token. `tools/__tests__` is collected on every push, so the failure was not
    about dispatch at all -- it was about a module-level side effect in a file whose pure
    parts are worth testing.

    The parts that matter here -- `apply_overrides`, `parse_argv`, `INPUTS` -- take no
    credential. Only `req` does, so only `req` pays for one.
    """
    global _TOKEN
    if _TOKEN is None:
        # A missing file and a file without a token are different problems and get
        # different sentences. `open` raising `FileNotFoundError` out of here would print a
        # traceback about a path, when what the reader needs to know is "you are not in the
        # checkout" -- and the fix for that is a different one from "this config has no
        # token".
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
    """One API call, retried on transient failures.

    `allow_empty` exists because the dispatch endpoint answers 204 with no body,
    and `json.load` on an empty body raises. Retrying that parse failure would
    turn one dispatch into several.
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


def main(argv: list[str] | None = None) -> int:
    inputs = apply_overrides(INPUTS, parse_argv(sys.argv[1:] if argv is None else argv))
    sha = remote_head()
    print(f"dispatching cortex-memory A/B at master ({sha[:8]})")
    # Overridden keys are marked, so the log says which values this dispatch chose rather
    # than leaving a reader to diff the output against the source.
    for key in sorted(inputs):
        marker = " *" if inputs[key] != INPUTS.get(key) else ""
        print(f"  {key} = {inputs[key]}{marker}")

    req(
        "POST",
        f"/repos/{REPO}/actions/workflows/{WORKFLOW}/dispatches",
        {"ref": "master", "inputs": inputs},
        allow_empty=True,
    )
    print("dispatched")
    return 0


if __name__ == "__main__":
    sys.exit(main())
