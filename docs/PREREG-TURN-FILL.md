# Pre-registration: spending the room the prefix rule returns

**Status:** pending — not dispatched, or dispatched and not yet read: no Result section exists for it.

Written before dispatch. The arithmetic it is conditioned on is `MEASURE-UNSPENT-ROOM.md`; the
refutation it repairs is run `38753835652`, recorded in `prompt.ts` at `selectBySessionFill`.

## 1. Treatment, byte for byte

One workflow input changes and no other:

| input | shipped | this run | why |
| --- | --- | --- | --- |
| `cortex_memory_relevance_units` | `turn` | **`turn-fill`** | the same unit and the same ranking, spending the room on the next turn that fits |
| `cortex_memory_max_prompt_chars` | registered table | *unchanged* | 48,460 / 24,000 is the room the hole was measured in |
| `cortex_memory_max_turn_chars` | `400` | *unchanged* | the cap that makes the hole small on two routes and large on four |
| marker segment | `none` | *unchanged* | converts wrong answers into declines on four capabilities that do not grade abstention |
| window segment | `head` | *unchanged* | the window and the marker are one indivisible change; neither is this arm |
| everything else | shipped | *unchanged* | the dispatcher names the remaining inputs from the baseline |

The arm is the full 500 questions with both sides in one job, the pairing invariant of
`PREREGISTRATION-CORTEX-MEMORY-ARM.md` §2.2, so the comparison is this dispatch's own baseline side
rather than an archived run from another day.

## 2. Population, and the number that is already known

This arm has an unusual property: **its ceiling is arithmetic, not a hypothesis.** Once the room is
fixed, the most a fill can add is the room that was previously returned, so the reachable gold is
computable from the published artifact before spending anything. On `45760081761`, over the 330
questions with a gold segment missing:

| route | questions | wrong | slack mean | gain gold | of them wrong | all of it | of them wrong |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `multi-session` | 14 | 3 | **107** | **0** | **0** | 0 | 0 |
| `temporal` | 88 | 6 | 119 | 16 | 0 | 4 | 0 |
| `abstention` | 29 | 0 | 975 | 23 | 0 | 0 | 0 |
| `knowledge-update` | 71 | 5 | 1,346 | 66 | 4 | 0 | 0 |
| `assistant` | 32 | 1 | 1,494 | 28 | 1 | 17 | 1 |
| `flat` | 90 | 6 | 1,404 | 79 | 5 | 9 | 0 |
| **all** | **330** | **21** | **950** | **215** | **10** | **31** | **1** |

**`multi-session` is registered as a null by construction.** Its slack is 107 characters against a
400-character turn cap, so the fill cannot buy one segment there and any movement on that route is
noise or a defect rather than an effect. That matters because `multi-session` is where 13 of the
arm's 14 decision faults live and where `MR`'s 88.43% is decided: **this arm is not an `MR` arm and
`MR` is not its target.**

## 3. The prediction

**`P1` — the mechanism fires.** On the **215** questions the census names, `promptChars` rises; on the
**285** it does not name, `promptChars` and `promptDigest` are identical to the baseline side. This is
the primary claim, and it is the one this arm exists to settle: the unit was unreachable on five of six
routes until `buildPrompt` forwarded `relevanceOptions` this round, and a dispatch that changes nothing
is the §13.32 defect — a configuration recorded on the artifact that the prompt never received — which
this repository has already produced once with `session-fill`.

**`P2` — accuracy is non-inferior, on every capability.** No capability loses **3 or more questions**,
and the aggregate is **≥ −2 questions**. This is a floor rather than a target, and the reason is
measured: on this artifact a question with an absent gold reads **93.64%** against **91.76%** for one
whose gold arrived whole, so "more gold delivered" is not "more answers right" and the reachable
population of **10** wrong questions is an upper bound on an effect, not a forecast of one. A fill
that delivers more text and answers fewer questions correctly is the outcome the §13.72 precedent
(+13 `MR`, −30 `IE`) says is paid for elsewhere.

**`P3` — the reachable ten convert at a measurable rate.** **≥ 3 of the 10** reachable wrong questions
change to correct. Ten is the ceiling; three is the smallest movement that could be distinguished from
the ±2-question spread the arm shows between repetitions at this population. A reading below three with
`P1` and `P2` both holding is a **registered non-inferior change with no accuracy claim**, adopted for
the room-honesty reason and never cited as a score.

**`P4` — the bill does not move.** Total cost within **1.02×** the baseline side, and median
`promptChars` up by **no more than the slack it spent** — `313,372 / 500 = 627` characters per question
on average at most. A bill that rises more than 2% means the arm is backfilling from the pool rather
than from the room, which is a different mechanism and would have to be registered as one.

## 4. Controls and gates

| gate | condition | what a breach means |
| --- | --- | --- |
| **internal control** | on `multi-session`, `promptChars` rises by **≤ 108** characters on every question, and `carried` never gains a turn | the fill reached room the cap had already removed, which cannot happen — void, and a defect |
| **superset** | no question delivers **fewer** gold turns than the baseline side | the superset is a proof (`MEASURE-UNSPENT-ROOM.md` §3), so a counterexample is a code defect, not a reading |
| **cost** | bill ≤ **1.02×**; mean `promptChars` up ≤ **627** characters | the arm is backfilling rather than spending the room |
| **population** | the treatment side's `promptChars` rises on **≥ 200** of the 215 named questions | the census and the run disagree about which questions have slack |
| **guard** | no other capability drops 3 or more questions | §13.72 |

The **superset** gate is the one that makes this dispatch cheap to read: it is the only arm in this
campaign whose null hypothesis is a theorem, so a breach is a bug report rather than an argument.

## 5. Falsification

Any one of these closes the axis rather than inviting a second room experiment:

1. **`promptChars` unchanged on the named questions.** The unit did not reach the prompt. Void, and the
   defect is in the forwarding rather than in the rule — the same shape as `session-fill`'s missing
   row, and it would be found in `buildPrompt`'s plan rather than in `selectByTurnFill`.
2. **A question delivering fewer gold turns than the baseline.** The superset proof is falsified, which
   is a bug; the axis stays open and the bug is the finding.
3. **Any capability ≤ −3 questions, or the aggregate ≤ −3.** Rejected even if another capability gains,
   on the §13.72 precedent. The axis closes and the next candidate is the **per-question room**
   (`gap` has a median of 14 and a maximum of 50 over the 21, so a single route-wide number cannot
   close it) rather than the selection rule.
4. **Bill above 1.02×.** The arm is not spending the room; it is buying more. The unit stays unadopted
   and the next step is to find what took the room.

## 6. What is deliberately not in this dispatch

- **The room.** Every `max_prompt_chars` change moves the quantity this arm holds fixed, and
  `MEASURE-UNSPENT-ROOM.md` §6 is why the two must be read in this order: the registered 5.81 CNY row
  is a *buy*, and buying before spending is what §204.7 priced at 70–100 CNY for a plan nobody would run.
- **The unit.** `session-fill` stays frozen beside `session` and this arm does not touch either — the
  session boundary is absent on five of six routes and mixing the two units would make the delta a
  statement about two changes.
- **`multi-session`.** Not a target, and §2 registers it as a null. `turn-fill` gains nothing there
  by construction and a positive reading would be a defect.
- **A second repetition.** The rejection region of `P3` is three questions; a paired comparison at one
  pass holds every other question fixed by construction, and `MEASURE-SPEND-MINIMUM.md` §206.2 is the
  arithmetic for why the second pass buys variance reduction on a metric whose noise floor is five
  questions. Two passes are taken only if `P3` lands **exactly** on three.

## 7. Adoption path (decided now, so it cannot become a later argument)

If the reading passes §4 and survives §5:

1. `turn-fill` becomes the registered unit in `tools/arm-config-baseline.json`, and
   `pnpm guard:arm-config` is re-run so the shipped configuration and the baseline file cannot drift;
2. the product default in `packages/cortex-memory/src/assemble.ts` moves with it, because the
   evaluation-side configuration and the product-side default are one decision and §16 of the standing
   instruction is the rule that says so;
3. `MEASURE-UNSPENT-ROOM.md` §7's "unknown" row becomes measured, and the census in
   `tools/turn-fill-ceiling.mjs` is re-run against the new artifact so the two agree;
4. `SOTA-BASELINE.md` §0 takes a new number only from a full 500-question run, never from this arm's
   delta.

If `P1` and `P2` hold but `P3` does not, `turn-fill` is adopted for the **room-honesty** reason only:
the arm pays for the room and a rule that returns part of it unread has to justify returning it. That
adoption carries no score claim and the registry row says so.

Nothing about accuracy is adopted from this document. It is adopted from the artifact.
