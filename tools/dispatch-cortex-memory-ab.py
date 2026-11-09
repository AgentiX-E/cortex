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
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = "AgentiX-E/cortex"
WORKFLOW = "benchmark-cortex-memory.yml"

# The repository variable the registration gate reads (`§13.220.5`).
#
# It is written here, by the dispatcher, rather than kept by hand for the same reason the gate
# exists: the departure list is a fact about the dispatch that is about to run, and the only
# process that knows it for certain is the one choosing the inputs. `41560510937` is the run that
# made this concrete -- a 60-question glm smoke whose artifact departed on `reader.model`, whose
# gate said *"the run is an experiment that has not said so"*, and which therefore failed after
# having produced a perfectly good measurement. The gate was right; nothing had told it what to
# expect.
DECLARED_DEPARTURES_VARIABLE = "CORTEX_DECLARED_DEPARTURES"

# The evidence source (`docs/MEASURE-ORACLE-CEILING.md`). Written on every dispatch for the reason
# the declaration above is: it is a repository variable rather than a workflow input -- the
# `cortex-memory` workflow sits at 24 of GitHub's 25 `workflow_dispatch` inputs and
# `test_dispatch_inputs.py` refuses a workflow that reaches the limit -- so the only process that can
# say what a run graded is the one choosing the dispatch.
#
# Always written, including the `0` that means "the shipped corpus", and the reset is the point: a
# dispatch made outside this script would otherwise inherit the previous run's ceiling mode, and a
# shipped score published under an oracle label is the one class of number a later re-reading cannot
# repair. `--oracle` on the command line is the way to ask for the condition.
ORACLE_VARIABLE = "CORTEX_MEMORY_ORACLE"

# The reply-contract repair (§13.334). A repository variable for the same reason the evidence source
# is one -- this workflow sits at 24 of GitHub's 25 dispatch inputs -- and with the same protection:
# written on every dispatch, so a run can never inherit the previous experiment's treatment.
REPLY_REPAIR_VARIABLE = "CORTEX_MEMORY_REPLY_REPAIR"

# The values `readReplyRepair` in `cortex-eval` accepts, in the order the artifact spells them.
REPLY_REPAIRS = ("off", "commitment", "shape", "both")

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
    # §13.101. `cortex_memory_threshold` is gone: the workflow fixes it at 0, because admission-wide-open
    # is the premise of every experiment on this arm rather than a variable within it (§13.101.3).
    # `retrievalThreshold` stays, because that one gates whether admitted evidence may be answered from.
    "cortex_memory_retrieval_threshold": "0",
    "cortex_memory_source_trust": "0.5",
    # §13.283. The §13.279 instruction and the §13.279 order, with the per-turn source id withheld.
    #
    # The value replaces `evidence-blocks-instruction-first`, which `42237543941` carried. What
    # moves is the rendering and nothing else: the instruction text is the control's function
    # returned by delegation, and the assembly stays `instruction-first`, so both fields the
    # artifact prints are unchanged or explicitly empty.
    #
    # The measurement behind it is a census of the same artifact. A multi-session prompt is
    # 13.83% source id by character count -- 38 per turn, 6,650 in a 48,000-character room -- and
    # the reader reproduces an id in 4 of 500 answers, 0 of 121 on `MR` and 0 of 127 on `TR`. The
    # boundary the id draws is already drawn by the `Session N` header, which 31 of 500 answers
    # name. The room it frees is the room the coverage census says is missing: on `MR`, 34
    # questions are short of gold by 53 turns and every one of them is closed by the turns the
    # freed characters buy.
    #
    # §13.279 stays in the record as the order experiment, and its reading was negative; this is
    # not a second dispatch of it, because the order is held at the value that experiment adopted.
    "cortex_memory_prompt_contract": "evidence-blocks-unsourced",
    # §13.34: `computed` plus the two-step enumeration contract on multi-session alone.
    #
    # §13.203 replaced the value with `operands+operand-gap`. Two facts made that a registration
    # rather than a change of mind: the arm has not run `enumerated` since `40989420944`, every
    # 500-question run from `41144910162` onwards carried `--set cortex_memory_ask=operands`, and
    # nothing in this table or in §10.3 said so. `readout-arm-run.py --registration` is the check
    # that now reports that class of drift from one artifact instead of from a re-read of 22,000
    # lines. `operands` is `enumerated`'s bytes everywhere but the derivation-shaped questions on
    # multi-session, and `operand-gap` adds the abstention route's closing line — so this value is
    # a superset of the one it replaced, and what it was measured at is §13.203.3: one question,
    # converted in all four repetitions, price zero.
    # §13.248 replaced `operands+operand-gap` with `verbatim`: the reference pipeline's aggregation
    # contract migrated whole, measured at MR 96/121 (first repetition, 96.3 mean) against 93/94.5,
    # with the full/partial coverage composition identical to the control (75/46 in both) and the
    # full band moving 84.00% -> 89.33%. It is the first ask on this arm whose reading is attributable
    # because the population it is read on did not move.
    #
    # §13.327. `verbatim-acts`, adopted by §13.318.3, where this line said `verbatim` and §10.3 said
    # `verbatim` too. That agreement is the whole defect: every 500-question run from `42337560027`
    # onwards sent `--set cortex_memory_ask=verbatim-acts`, so the document and the table agreed with
    # each other and disagreed with the runs, and `test_preregistration_config.py` -- whose entire
    # subject is that pair -- could not see it. §10.3's own `ask` bullet describes this exact class
    # and was written when the value was `enumerated` and the runs were `operands`; the third
    # instance landed four concepts later, inside the paragraph naming it. `42355323615` read 91.95%
    # overall against 90.85% with `MR` 83.88% against 79.13% at this value, and `E11`/`E11a`
    # (`42452904894`, `42467392736`) redrew it twice with 500 of 500 `promptDigest` identical.
    #
    # The mechanism that closes the class is `tools/arm-config-record.py`, whose baseline is the
    # artifact's own `memoryArmConfig` projected onto these input names: three columns, where before
    # there were two that a maintainer edits by hand.
    "cortex_memory_ask": "verbatim-acts",
    # §13.64's adopted ranking: dense cosine fused with a rare-keyword channel by reciprocal
    # rank. This line said `retrieval` for six sections after that adoption, because §10.3
    # held BOTH the adoption bullet and §13.17's original one and the registration parser
    # read the last one -- so this table and the stale bullet agreed with each other and
    # disagreed only with the section that decided the question. §13.69 records the run that
    # exposed it: dispatched on `retrieval` against an adopted `retrieval-hybrid`, which
    # would have moved the ranking and the cap at once.
    "cortex_memory_relevance": "retrieval-anchored",
    # §13.260.7's adoption, as of `42013256884`. The line above carried `retrieval-hybrid` and a
    # §13.64 docblock; the mechanism that replaced it restores the neighbourhood of every retrieved
    # anchor into the pool, and its two readings are a delivery count that reproduced exactly
    # (`6,520` on two dispatches) and an accuracy effect of −1.00 point over 256 paired observations
    # against a reader whose own self-disagreement on identical bytes is −1.20.
    #
    # Kept as a dismissal of the older note rather than an addition to it: §13.64's adoption still
    # holds -- the hybrid ranking is *inside* the anchored signal -- but the value a dispatch sends
    # has one answer, and §13.69 is the run that had to be cancelled because the document and the
    # dispatch each believed their own copy of it.
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
    # §13.288. Held at the shipped default, because `INPUTS` is the **adopted** configuration and
    # §10.3 describes it; the experiment overrides with
    # `--set cortex_memory_relevance_units=session-fill`.
    #
    # The experiment is the first reading this value has ever had. §13.286.2 found `session-fill`
    # parsed by the arm, projected into the artifact's configuration line, and never forwarded to
    # the product, so §13.34's "spends the room and changes nothing" is a sentence about the `turn`
    # unit. The mechanism is §13.31's repair of §13.27's rule: whole sessions ordered by their
    # best-scoring turn, skipping one that does not fit rather than ending the pass on it. The
    # reference pipeline -- 7.43 points ahead on MR with the same reader on the same dataset -- pays
    # 2,000 characters a session and 20,000 in total, i.e. roughly ten complete sessions; this arm
    # currently spends 48,000 characters on fragments of 45.
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
    #
    # §13.295/§13.318.3. A route map rather than a scalar, because `verbatim-acts` writes 460 more
    # characters of instruction on multi-session and §13.295 paid that back instead of letting the
    # rule rent its room from the evidence: 48,460 there, the product's 48,000 on the other five.
    # A scalar input still means one room for every route -- the arm's parser decides on the colon,
    # not on a heuristic -- so the two shapes cannot be confused, and this line names the map
    # because the scalar describes a run this arm is not making.
    #
    # §13.336's redistribution, adopted by `C5` (`42533236864`). `42383171765` priced the narrower
    # allocation at 1.05 points and 24.6% of the bill; `C5` re-ran it on top of `verbatim-acts` and
    # read 91.05% at 9,201 prompt tokens per question, clearing both pre-registered criteria
    # (>= 90.80%, <= 9,300). The 0.90 points against 91.95 is below this harness's resolution: three
    # readings of the wider map already span 91.95 / 91.65 / 91.05 (`42355323615`, `42452904894`,
    # `42467392736`), so the allocation costs less than one draw. The two widened routes keep their
    # rooms because they are the two whose windows the cap reaches; the four narrow ones return to
    # the product default of 24,000, which is what the bill was spent buying.
    #
    # The pairs are sorted, because `arm-config-record.py`'s `route_rooms` renderer sorts them and
    # the comparison is string equality: an unsorted map here would report a configuration
    # difference on every run while sending the same rooms.
    "cortex_memory_max_prompt_chars": (
        "abstention:24000,assistant:24000,flat:24000,knowledge-update:24000,multi-session:48460,temporal:48000"
    ),
    # §13.84's adopted filter. `all` was the state every run before it was in; `39298662801` took
    # MR from 83 to 90 and TR from 93 to 98 with no capability regressed, so these two lines move
    # with §10.3. The reach stays scoped: the three untouched capabilities reproduce their control
    # window to the character, which is the internal control the registration asked for.
    # §13.94's second consultation, adopted as `bare` by §13.108. The value was `none` here for one
    # revision after the workflow's own default moved to `bare`, which made this script reproduce the
    # CONTROL while calling itself the registered configuration: run `40698867439` dispatched with no
    # `review_pass` input at all, arrived at `bare` through the workflow default, and read 83.40%
    # (417/500) against the 81.0% this line would have produced. Both values are legitimate and the
    # experiment still overrides with `--set`; what is not legitimate is the shipped configuration and
    # the script that reproduces it disagreeing, which is why
    # `tools/__tests__/test_preregistration_config.py` now pins this line to the workflow default.
    "cortex_memory_review_pass": "bare",
    # §13.115's switch, held at the identity in the registered configuration: `none` is the
    # retrieved order every archived artifact was produced under, so it is the control the
    # reranking increment is measured against. The experiment overrides it with
    # `--set cortex_memory_rerank=on`, which is the treatment; adoption would move this line and
    # §10.3 together, and `test_preregistration_config.py` checks that pairing.
    #
    # Sent explicitly rather than left blank even though the workflow's default is empty and the
    # product's default is `none`: the `''`-to-default path is where §38 and §13.112 both found
    # defects, and a value a run depends on should not arrive by accident.
    #
    # The arm's pool must also fit the endpoint in ONE call. Zhipu's `/rerank` takes 128 documents,
    # so the reranking dispatch runs `cortex_memory_relevance_top_k=128` as well -- which is NOT a
    # second variable but the same one re-registered: the control for that run is 128 without the
    # stage, and `PREREGISTRATION` §13.115 records the pair. The workflow declares the limit in job
    # env, and the index refuses a wider pool rather than batching it.
    "cortex_memory_rerank": "none",
    # §13.97's variable, held at the identity in the registered configuration. An experiment
    # overrides it with `--set cortex_memory_query_expansion=llm`; the marker in the log says
    # which dispatches departed from this table.
    "cortex_memory_query_expansion": "none",
    # §13.101's sample count, held at the identity in the registered configuration. The experiment
    # overrides it with `--set cortex_memory_self_consistency=3`.
    "cortex_memory_self_consistency": "none",
    "cortex_memory_evidence_roles": "user",
    "cortex_memory_evidence_roles_routes": "multi-session,temporal",
    # §13.30's ceiling is no longer a dispatch input. It is a hang detector rather than a
    # treatment, and the input surface sat one below GitHub's 25-input ceiling when §13.115's
    # `cortex_memory_rerank` needed a slot. The workflow now sets it as a constant, which is where a
    # reader of a run looks for it anyway. Same precedent as `evidenceTurnsPerRecord` (§13.94).
    #
    # The value changed on 2026-11-01 and the unit changed with it: it was 90 minutes **per pass**,
    # which permitted `8 x 90 = 720` minutes of run inside a job killed at 350 and therefore could
    # never fire. It is now 340 minutes for the **whole run**, so the in-run ceiling fails first and
    # writes a partial artifact. `tools/job-budget.py` reads this and the job timeout together.
    # §13.192.6. The reader is a configuration value and this table did not send it, so every dispatch
    # from here ran the workflow's default and the one run that changed the model (`40698883428`) was
    # dispatched outside this script. §13.192.1 measured what that leaves behind: two artifacts 7.20
    # points apart with identical `memoryArmConfig` blocks and no field naming the reader. Sent
    # explicitly for the reason this file gives everywhere else, now applied to the value with the
    # largest measured effect on the arm.
    "model": "deepseek-chat",
    # The second half of the identity, and the only half that changes a reply's shape without changing
    # the model: `resolveReaderIdentity` reports it, `DEEPSEEK_THINKING=enabled` opts in, and no
    # 500-question run in this campaign ever did. §13.192's probe moves this one.
    #
    # §13.198.4 gave the value a second form that is not a word: `multi-session+temporal` enables
    # thinking on those routes and leaves the rest where this line has them.
    #
    # §13.232 adopts the scoped form on the strength of the run that read it. `41546569106` is the
    # registered configuration with this one input moved, 500 questions, 4 repetitions, and it
    # reads **90.15%** against the registered **83.90%** -- a single declared departure, and the
    # movement lands on the two routes the value names: TR 78.74 -> 95.28, MR 71.07 -> 76.86, and
    # nothing outside them (IE -0.67, KU -1.39, ABS 0.00), which is the shape a route-scoped
    # mechanism is supposed to have rather than the shape of a general improvement.
    #
    # What it costs is measured on the same pair and is the reason this is an adoption rather than
    # a trade: prompt tokens are **flat** (28.15 M against 28.41 M, 98.6% of them prefix-cache
    # hits in both) and the completion side goes from 0.24 M to 2.35 M, which is the thinking
    # tokens. A per-question budget of ~1,050 completion tokens buys 6.25 points.
    #
    # §13.347 REVERTS the `temporal`-only reach §13.345 adopted. The 500-question confirmation run
    # (`42641469324`) reads **90.15%** against this value's **91.20%** (`42533236864`), and the
    # movement is where the reasoning was removed: paired by question id, `MR` loses 10 and gains
    # 5, and its abstentions go **1 -> 7**. The saving it bought is real but smaller than the
    # sample predicted -- 12.79 -> 10.69 CNY on the same basis, because removing the reach also
    # costs prefix-cache warmth (97.8% -> 91.6% on the feature side). A point of accuracy is not
    # worth two yuan of a ten-yuan run, so the axis closes at the earlier value and the reasoning
    # question is answered: it earns its money on `MR`.
    "thinking": "multi-session+temporal",
    # §13.345's population selector. `all` is the identity and is written down rather than omitted
    # because a dispatch value that is never sent is a value the artifact cannot be checked against
    # (§13.192.6) -- and because the registered configuration has to be readable as one object.
    #
    # It exists for the reason §13.342.8 measured: the sampler round-robins over seven buckets, so
    # `limit=200` gives `MR` 29 questions and a 4-point `MR` effect is 1.2 questions, which is why
    # two capability-scoped arms had to move their bars to `limit=400`. `capability=MR` grades the
    # 121 `MR` questions in the file for a fifth of a full pass and reads the same 4 points at 4.8
    # questions. It is a run-level selector, like `limit`, and `readout-arm-run.py`'s
    # `HARNESS_INPUTS` says so on the gate's side.
    #
    # The `thinking` reading on the line above bought **6.25 points** when it was adopted (§13.197).
    # `T1` re-read the same axis on the shipped configuration and found **1.0** (§13.344), and the
    # difference between those two numbers is a configuration, not a contradiction: the 6.25 was
    # measured before the route budget, the contract and the ask moved.
    "capability": "all",
    "limit": "0",
    "ablation_runs": "4",
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


def local_tree() -> str | None:
    """This checkout's HEAD tree, or `None` when the script is not running inside one.

    `None` rather than an exception because the script is also importable from tests and from a
    bare copy, and a dispatch from such a directory has nothing to compare and should not be
    blocked by that.
    """
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


def staleness_refusal(remote_tree: str, head_tree: str | None) -> str | None:
    """Why this dispatch must not run, or `None` when the remote's tree is this checkout's tree.

    The ref the workflow dispatches against is `master`, and a checkout that pushes to `main`
    leaves it behind **without any error**: run `40859309993` was dispatched against `749946f7`,
    three commits before the `derive` implementation it was meant to test, and the only signal
    was a SHA printed in the log that nobody had a reason to compare against anything. That run
    was cancelled eight seconds in, but the failure mode is a run that completes and measures the
    wrong code -- which is worse, because it produces a number.

    Trees rather than SHAs: `push-via-api.py` rebuilds each commit through the Git Data API, so
    the same content arrives under a fresh SHA and a SHA comparison would refuse every dispatch.
    """
    if head_tree is None:
        return None
    if remote_tree == head_tree:
        return None
    return (
        f"refusing to dispatch: master's tree is {remote_tree[:12]} and this checkout's HEAD tree is "
        f"{head_tree[:12]}. The run would measure code this checkout does not contain. Push the branch "
        f"the workflow reads (master) before dispatching -- pushing only main leaves master behind, "
        f"which is how 40859309993 was dispatched against 749946f7 instead of f6b9a89's successor. "
        f"Pass --allow-stale-tree to dispatch anyway when that is deliberate."
    )


def departures(inputs: dict[str, str]) -> list[str]:
    """The inputs this dispatch moves away from the registered table, sorted.

    The same comparison `main` prints with a `*` marker, promoted from a decoration to the thing
    the gate is told. An input set to the value the table already holds is not a departure, and
    saying it was would make the declaration describe an intention rather than what ran -- the
    class `--departs` already refuses on the reading side (`declared but unchanged`).
    """
    return sorted(key for key in inputs if inputs[key] != INPUTS.get(key))


def write_variable(name: str, value: str) -> str:
    """Create, update or delete a repository variable, whichever the current state needs.

    Extracted from `declare_departures` when the oracle switch needed the same three paths. The
    paths are the ones §13.234 left half-tested: create answers 201 with a body, update answers
    **204 with no body** (hence `allow_empty`), and delete answers 204 as well. An empty value is a
    delete because GitHub rejects `422 Variable value cannot be empty`.
    """
    listing = req("GET", f"/repos/{REPO}/actions/variables?per_page=100")
    existing = {variable.get("name") for variable in listing.get("variables", [])}
    present = name in existing
    if not value:
        if present:
            req("DELETE", f"/repos/{REPO}/actions/variables/{name}", allow_empty=True)
        return value
    payload = {"name": name, "value": value}
    if present:
        req(
            "PATCH",
            f"/repos/{REPO}/actions/variables/{name}",
            payload,
            allow_empty=True,
        )
    else:
        req("POST", f"/repos/{REPO}/actions/variables", payload)
    return value


def oracle_switch(environ: dict[str, str] | None = None) -> str:
    """`'1'` when this dispatch grades gold evidence, `'0'` otherwise.

    Read from the dispatcher's own environment rather than from `--set`, because `--set` is checked
    against the registered table and the table is the thing this variable is not: a `--set` key that
    is not registered is refused, and registering it would need the workflow input the ceiling
    forbids.

    Strict on the value for the reason `readOracleEvidence` is strict in `cortex-eval`: a typo that
    fell back to the corpus would produce a shipped score under a dispatch that asked for a ceiling.
    """
    raw = ((environ if environ is not None else os.environ).get(ORACLE_VARIABLE) or "").strip()
    if raw in ("", "0"):
        return "0"
    if raw == "1":
        return "1"
    raise SystemExit(
        f"{ORACLE_VARIABLE} must be '1' or unset in the dispatcher's environment, got {raw!r}. "
        "An unrecognised value is refused rather than read as off, because the run it would "
        "produce grades the shipped corpus while the dispatch asked for the reader ceiling."
    )


def reply_repair_switch(environ: dict[str, str] | None = None) -> str:
    """Which reply-contract repair this dispatch administers, `off` by default.

    Strict on the value for the reason `oracle_switch` is: `readReplyRepair` refuses an unrecognised
    name at the arm's boundary, so a typo here would fail the run three hours in rather than here --
    and a run that fell back to `off` would publish the control's reading under the treatment's name.
    """
    raw = ((environ if environ is not None else os.environ).get(REPLY_REPAIR_VARIABLE) or "").strip().lower()
    if raw == "":
        return "off"
    if raw not in REPLY_REPAIRS:
        raise SystemExit(
            f"{REPLY_REPAIR_VARIABLE} must be one of {', '.join(repr(name) for name in REPLY_REPAIRS)} "
            f"or unset in the dispatcher's environment, got {raw!r}. An unrecognised value is refused "
            "rather than read as off, because the run it would produce administers the control while "
            "the dispatch asked for the repair."
        )
    return raw


def declare_departures(names: list[str]) -> str:
    """Write the departure list where the registration gate will read it.

    Always ends with the variable describing **this** dispatch, so a registered dispatch that left a
    previous experiment's declaration in place cannot happen -- that declaration would excuse a run
    which did not make those departures.

    The empty case is a **delete**, and that is not a stylistic choice: GitHub rejects an empty
    variable value with `422 Variable value cannot be empty`, so `--value ""` would crash the
    dispatcher on the commonest dispatch there is. The absence of the variable is also the precise
    meaning -- `vars.CORTEX_DECLARED_DEPARTURES` interpolates to the empty string when it does not
    exist, which is what `--departs ""` already reads as "none declared".

    Creating versus updating is decided by a listing rather than by catching a 404, because `req`
    exits the process on any non-transient status and a missing variable is not an error here.
    """
    value = ",".join(names)
    # Delegated to `write_variable` so the three API paths have one implementation. The PATCH note
    # that used to live here travels with it -- §13.234 died on `unparseable body` because the
    # update path answers 204 with no body, and a second copy of that knowledge is a second place
    # to lose it.
    return write_variable(DECLARED_DEPARTURES_VARIABLE, value)


# ---------------------------------------------------------------- spend gate

# The tool that prices a dispatch, and the observation it scales.
#
# A gate rather than a warning, because the failure it prevents is not one a reader can undo: a
# dispatch is billed the moment it starts and there is no refund for a run whose configuration was
# wrong. `42467` is the archived full pass this projects from -- 500 questions, 4 repetitions,
# 27.23M prompt and 2.29M completion tokens, 14.26 CNY at the published 2026-11-09 prices.
SPEND_TOOL = Path(__file__).resolve().parent / "spend-projection.mjs"
SPEND_BASELINE = Path(__file__).resolve().parent / "spend-baseline.json"

# What a dispatch may cost without anyone saying so.
#
# Three CNY is the screening configuration's own price (200 questions x 2 repetitions = 2.85), so
# this is the line between "a run that answers a question about a change" and "a run that publishes
# a point estimate". The second kind is legitimate and is what the pre-registration is written for;
# it is also 14.26 CNY, and it should be a decision someone typed rather than a default that was
# never revisited. `--budget N` states a different ceiling; `--no-budget` disables the gate and says
# so in the log.
DEFAULT_BUDGET_CNY = 3.0


def split_finance(argv: list[str]) -> tuple[list[str], dict]:
    """Separate the spend flags from the dispatch flags.

    `parse_argv` refuses anything that is not `--set`, and it is right to: an unrecognised argument
    on the dispatch path is a dispatch that was not asked for. So the two kinds of flag are
    separated here rather than by widening that parser, which would make `--set` optional beside
    three more spellings and lose the refusal that keeps a typo from running the control arm.
    """
    rest: list[str] = []
    budget: float | None = DEFAULT_BUDGET_CNY
    # Whether the operator named a ceiling or is riding the default. §13.348 needs the distinction:
    # the default is right for a dispatch the projection can price, and a capability-scoped dispatch
    # is one it can only floor, so a floor under a default ceiling is not a decision anybody made.
    named = False
    index = 0
    while index < len(argv):
        argument = argv[index]
        if argument == "--budget":
            if index + 1 >= len(argv):
                raise SystemExit("--budget needs a CNY amount")
            budget = float(argv[index + 1])
            named = True
            index += 2
            continue
        if argument.startswith("--budget="):
            budget = float(argument.split("=", 1)[1])
            named = True
            index += 1
            continue
        if argument == "--no-budget":
            budget = None
            named = True
            index += 1
            continue
        if argument == "--screening":
            # The screening configuration, named once. 200 questions keeps every capability
            # represented (the sampler round-robins, so 40% of the file is 40% of each bucket) and 2
            # repetitions keeps the pairing that McNemar needs while halving the sample's cost.
            rest.extend(["--set", "limit=200", "--set", "ablation_runs=2"])
            index += 1
            continue
        rest.append(argument)
        index += 1
    return rest, {"budget": budget, "named": named}


def projected_spend(inputs: dict[str, str], budget: float | None, named: bool = True) -> float | None:
    """Print this dispatch's projected bill and refuse when it breaches `budget`.

    Returns the projection so the caller can print it beside the inputs, or `None` when the
    baseline is missing. A missing baseline does not block the dispatch: the gate is an instrument,
    and an instrument that cannot run is not a reason to stop working -- but the log says the run
    was unmeasured rather than priced.
    """
    if not SPEND_BASELINE.exists():
        print(f"spend: no baseline at {SPEND_BASELINE.name}, this dispatch is not priced")
        return None
    # `limit: '0'` is the full dataset, not zero questions -- the workflow's own spelling for it.
    # Passing it through would price the run at nothing and then refuse it for dividing by zero,
    # which is the one reading of that value nobody has ever meant.
    try:
        baseline = json.loads(SPEND_BASELINE.read_text())
    except (OSError, ValueError) as error:
        print(f"spend: baseline is unreadable ({error}), this dispatch is not priced")
        return None
    raw_limit = str(inputs.get("limit", "0") or "0")
    limit = baseline.get("questionCount") if raw_limit == "0" else raw_limit
    arguments = [
        "node",
        str(SPEND_TOOL),
        "--report",
        str(SPEND_BASELINE),
        "--limit",
        str(limit),
        "--runs",
        str(inputs.get("ablation_runs", "1")),
        "--thinking",
        os.environ.get("CORTEX_THINKING", inputs.get("thinking", "multi-session+temporal")),
    ]
    # A capability-scoped dispatch is priced off the census rather than the file, because the
    # question axis stops being "what share of the file" and becomes "how many of this capability".
    # The gate has to price the same dispatch the workflow will run, or the number it prints is a
    # different run's bill. Here that difference decides whether the run happens at all: the `I1`
    # dispatch is `capability=MR` at two repetitions, which is 121 questions and **1.73 CNY**, and
    # a file-scaled projection would read the same inputs as 500 questions x 2 runs -- **7.13 CNY**
    # -- and refuse it against the 3.00 default. The cheap experiment would be blocked by the
    # instrument built to make cheap experiments visible. `all` is the identity and is not passed,
    # so an unfiltered run prices as it always did.
    #
    # A partial `limit` together with a capability is left to the projection to refuse rather than
    # silently overridden here: the sampler round-robins over seven buckets, so the surviving count
    # is a property of the bucket order, and quietly dropping the operator's limit would dispatch a
    # bigger run than the one that was asked for.
    capability = str(inputs.get("capability", "all") or "all").strip()
    scoped = capability != "" and capability.upper() != "ALL"
    if scoped:
        arguments.extend(["--capability", capability])
        # §13.348. A capability-scoped projection is a **floor**, not an estimate: the census is the
        # right count of questions and the wrong unit of cost, because per-question cost is
        # route-scoped and `MR` is the route that carries the reasoning. The first scoped dispatch was
        # projected at 1.73 CNY and billed 5.87 -- 3.4x -- so the default ceiling is not a ceiling
        # here. An operator who means it names a number; the alternative is a gate that reports a
        # confident figure it knows to be low, which is the defect it was built to remove.
        if not named and budget is not None:
            raise SystemExit(
                "a capability-scoped dispatch is priced as a lower bound, so it needs a stated "
                "budget: the census scales by question count and per-question cost is route-scoped "
                f"(`MR` measured 0.0243 CNY per question-run against the file's 0.0064). The last "
                f"scoped {capability} run was projected at 1.73 CNY and billed 5.87. Pass --budget N "
                "with the ceiling you mean, or --no-budget to dispatch unpriced."
            )
    if budget is not None:
        arguments.extend(["--budget", f"{budget}"])
    completed = subprocess.run(arguments, capture_output=True, text=True, check=False)
    for line in completed.stdout.splitlines():
        print(f"spend: {line}")
    if completed.returncode != 0:
        # The projection refuses for more than one reason -- an unaffordable run, but also a pair of
        # inputs it cannot price and a census that does not carry the named capability -- and those
        # refusals are printed as `REFUSED: <why>` on stdout. Quoting them back is the difference
        # between an operator who knows what to change and one who is told to buy a bigger budget
        # for a spelling mistake.
        refusal = next(
            (
                line.split("REFUSED:", 1)[1].strip()
                for line in completed.stdout.splitlines()
                if "REFUSED:" in line
            ),
            None,
        )
        detail = refusal or completed.stderr.strip() or "the projection was refused"
        # The ladder is advice about money, so it is appended only when money is what refused:
        # `--screening` does not fix an unpriceable input pair, and offering it would be a guess.
        ladder = ""
        if refusal is None or "budget" in detail.lower():
            ladder = (
                "\nRefusing to dispatch. A screening run costs 2.85 CNY: pass --screening. A full "
                "pass costs 14.26 CNY: pass --budget 20 when that is the run you mean."
            )
        raise SystemExit(f"{detail}{ladder}")
    return None


def main(argv: list[str] | None = None) -> int:
    raw = sys.argv[1:] if argv is None else argv
    dispatch_argv, finance = split_finance(raw)
    inputs = apply_overrides(INPUTS, parse_argv(dispatch_argv))
    sha = remote_head()
    tree = req("GET", f"/repos/{REPO}/git/commits/{sha}")["tree"]["sha"]
    refusal = staleness_refusal(tree, local_tree())
    if refusal is not None and "--allow-stale-tree" not in (sys.argv[1:] if argv is None else argv):
        raise SystemExit(refusal)
    print(f"dispatching cortex-memory A/B at master ({sha[:8]}, tree {tree[:8]})")
    # Overridden keys are marked, so the log says which values this dispatch chose rather
    # than leaving a reader to diff the output against the source.
    for key in sorted(inputs):
        marker = " *" if inputs[key] != INPUTS.get(key) else ""
        print(f"  {key} = {inputs[key]}{marker}")

    # Before anything is written and long before the POST, because this is the only step whose
    # failure leaves no trace: a rejected configuration produces an artifact that says what it did,
    # a dispatch nobody could afford produces a bill. The gate runs on the values actually about to
    # be sent, so `--screening` and a hand-set pair of `--set` flags are priced identically.
    projected_spend(inputs, finance["budget"], finance["named"])

    # Before the dispatch, because the workflow reads the variable when the job starts: written
    # after, it would describe the next run rather than this one, and the gate §13.220.5 installed
    # would be checking a record nobody had written yet.
    declared = departures(inputs)
    # The oracle switch joins the declaration, and the name is the **artifact's** field rather than
    # the switch's: `readout-arm-run.py --registration` refuses a departure that resolves to no
    # field, and `42500412709` was refused for exactly that -- the first oracle dispatch declared
    # `oracleEvidence`, which is a repository variable's name and appears nowhere in the artifact.
    # `evidenceSource` is the field the gate compares and the one a reader can look at, so declaring
    # it is a record of what the artifact will say rather than a claim about the payload.
    #
    # Declared only when the condition is on. When it is off the artifact reads `corpus`, which is
    # the registered value, so a declaration would be the "names a field this run did not move"
    # case the gate reports as an intention.
    oracle = oracle_switch()
    repair = reply_repair_switch()
    # Both conditions join the declaration on the same rule: the name is the **artifact's** field, and
    # only when the condition is on -- declaring a field the run left at its registered value would be
    # the "names a field this run did not move" case the gate reports as an intention.
    declared = sorted(
        {
            *declared,
            *(("evidenceSource",) if oracle == "1" else ()),
            *(("replyRepair",) if repair != "off" else ()),
        }
    )
    declare_departures(declared)
    print(f"declaring departures: {declared if declared else 'none'}")
    # Before the dispatch and unconditionally, for the reason the declaration is: the workflow reads
    # it when the job starts, and a stale `1` from a previous experiment would turn this run into a
    # ceiling measurement nobody asked for. Written even when it is `0`.
    write_variable(ORACLE_VARIABLE, oracle)
    print(f"{ORACLE_VARIABLE} = {oracle}{' *' if oracle == '1' else ''}")
    # Written unconditionally for the same reason, and it is the second variable that has to be: a stale
    # `both` left behind by the last experiment would administer a treatment this dispatch did not name.
    write_variable(REPLY_REPAIR_VARIABLE, repair)
    print(f"{REPLY_REPAIR_VARIABLE} = {repair}{' *' if repair != 'off' else ''}")

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
