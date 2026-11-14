# The semantic layer's route: wire it, and record what the other route would have cost

**Decision**: the semantic kernel in `cortex-core` gets wired to the shipping product. The alternative — declare
store-side semantics out of scope, delete the unrealisable parts of the type system and retract the
corresponding rows of the product sheet — is **rejected**, and the price of that rejection is written down here
so a future round can take the other road without re-deriving it.

**Scope**: this is a decision about *route*, not about mechanism. It fixes the order in which the eight exit
criteria of `cortex-docs`' `06-semantic-layer-completion.md` §5 are pursued, and it fixes what "done" means for
each. It does not register a measurement, and it does not authorise a dispatch.

**Status at the time of writing**: `cortex` `3dbf57c`, semantic layer **E8 closed, E1–E7 open** (1 of 8).
Reach table `P 5 / E 5 / I 8 / T 1` ([`AUDIT-SEMANTIC-REACH.md`](AUDIT-SEMANTIC-REACH.md) §3).

**Status now**: **7 of 8 closed** — E1 (§10), E2 (§11), E3 (§12), E4 (§13), E5, E7, E8. E4 closed the way the
criterion allows and not the way it prefers: four mechanisms are now each either wired or **Declined with an
argument in §6** (`consolidate` §6.2, `resolveContradiction` §6.1, `MemoryGraph`, `sinkhorn`; `Fact.derivedFrom`
rejected as a second mechanism). E6 — the paired reading — is the last one open. It has since been given the two
things it was missing: an arm that can administer the treatment and an artifact that records whether it reached
anything (`AUDIT-SEMANTIC-REACH.md` §15). It is registered as `S12` / `S13` in the acceptance matrix rather than as
a sentence here, and `S12` declares the reach as a precondition, so its `0` cannot pass while the layer reached
nothing — on the registered population that is the predicted outcome, and §5 is the reason. The gate on
`S10`/`S9` waits for that reading. Reach table `P 11 / E 2 / I 5 / T 1`: E3 moved no row of it, because `MemoryType` is not
one of the nineteen; it is the precondition §5.2 said row 1 needed, and E4 moves none either, because a decline
that removes a candidate call site does not change what is reachable.

---

## 1. Why this needs a decision at all

`AUDIT-SEMANTIC-REACH.md` §2 counts the semantic kernel's exports that the shipping package imports: **zero**,
out of 22 imports total. §3 puts 5 of 19 capabilities on the shipping path, and the two semantic ones among
them (`#18` answer-side supersession, `#19` aggregation) are both *answer-side*. There is no store-side
semantics in the product.

The audit's own summary of the consequence is quoted from `cortex-core/src/context/assemble.ts:9`:

> a mechanism the shipping path never calls is decoration with a test suite

Two honest responses exist, and they are not equally expensive:

| | Route A — declare it out of scope | Route B — wire it |
| --- | --- | --- |
| What is true afterwards | The product is a reader over a caller-supplied window, with answer-side semantics | The product is a memory layer with a typed store |
| What has to be retracted | The product sheet's rows 5, 7, 8, 9, 11, 12; `ARCHITECTURE.md` §6's "bitemporal facts", "contradiction resolution", "FSRS", "Hebbian graph"; the charter sentence in `cortex-memory/src/index.ts:1-7` naming four mechanisms it exists to wire | nothing |
| What has to be built | a deletion: `MemoryType`'s two unreachable members, `Fact`, `consolidate`, `resolveContradiction`, `MemoryGraph`, `sinkhorn` | a fact source + four call sites + a measurement |
| What it costs if wrong | The store-side claim is gone, permanently, and the 2,899 lines become dead weight that the reach table has to keep explaining | Two mechanisms land on the measured path with no reading behind them |

The campaign's own standing rule is that a regression is reverted on evidence even when the reasoning looks
sound. Route A is the *cheap* route and Route B is the *expensive* one; that asymmetry is exactly the situation
in which the rule says **take the expensive route first and let the measurement decide**, because the expensive
route is reversible and a deletion of the product's positioning is not.

**Decision: Route B.**

---

## 2. What Route A would have cost, priced item by item

This section exists because the next round that considers Route A should not have to redo the count. Every row
is a concrete artefact that would have to change, not a sentiment.

| # | Artefact | What Route A would have to say | Why that is a cost rather than a cleanup |
| ---: | --- | --- | --- |
| 1 | `cortex-memory/src/index.ts:1-7` | the package's charter sentence names four mechanisms (`decideWrite`, `decideRetrieval`, `consolidate`, `resolveContradiction`) and half of them were never wired; Route A deletes the sentence | the sentence is the only place the package states **why it is a package**. Deleting it leaves "a reader with extra steps", which is the thing the audit's §9 says the product already half was |
| 2 | `cortex-core/src/domain/memory.ts:4` | `'semantic'` and `'procedural'` are removed from `MemoryType`, leaving one member | a one-member union is a boolean wearing a type's clothes. The honest form is `type MemoryType = 'episodic'`, and then the field itself is a constant |
| 3 | `cortex-core/src/domain/fact.ts` | deleted in full: 35 lines, `Fact` and `isFactCurrentAt`, zero constructors | This is the bitemporal type. Deleting it means the product has **no** representation of "true in the world" versus "known to the system", which is the difference between a memory and a log |
| 4 | `cortex-core/src/knowledge/*` | 2,089 lines keep their tests and lose their reason | 11 of the 19 reach rows are `I`/`E`. Under Route A they become a spec suite for a system that does not exist, and the reach table has to carry that explanation forever |
| 5 | `ARCHITECTURE.md` §6 | four rows flip from "Implemented, tested, not reached by the product" to "Not implemented, and the type was deleted" | the table is the document a reader uses to decide what the product is. A row that says "implemented and unreachable" invites a wiring round; a row that says "deleted" closes it |
| 6 | Product sheet §4 rows 5, 7, 8, 9, 11, 12 | six of ten semantic rows retracted | after the retraction the sheet has four semantic rows, of which one is delivered. The product is then describable in one sentence — and that sentence is "a prompt assembler with a disclosure gate" |
| 7 | `docs/AUDIT-SEMANTIC-REACH.md` §7 | its whole P0–P4 re-scoring is moot | that section is 20 rows of argued sequencing. Route A makes all of it history |
| 8 | The four-questions exit (`context/assemble.ts`) | becomes an arm-only mechanism, permanently | `assume-ablation.ts` is its only caller. An ablation that measures a mechanism the product cannot reach is a reading about the ablation |

Row 3 and row 6 are the ones that decide it. A **memory** layer that cannot represent "this was true then and
that is true now" is not a memory layer; it is a cache with a disclosure policy. Route A is therefore not a
cleanup — it is a change of what the product is, made to avoid an engineering cost.

---

## 3. What Route B has to do, in the order that avoids the fake

The audit's P0-1 was "call `assemble({intent, asOf, ranked})` before the prompt", and `AUDIT-SEMANTIC-REACH.md`
§4.3 rejects it **as sequenced**: `assemble` consumes `KnowledgeFact[]`, and no module in either package
constructs one outside a test and one ablation. Landing it anyway would compile, return an empty block set, keep
every test green, and let the reach table say `P`.

That failure mode has a name in this repository — it is the one `MEASURE-PLAN-SHAPE.md` priced at **43 mechanism
flips for 46 damages** — and the ordering below exists to make it unavailable:

| Step | What lands | What would make it fake | The check that refuses the fake |
| ---: | --- | --- | --- |
| 1 | **Fact source** (§E1): the product constructs `KnowledgeFact`s from state it has already computed | constructing facts nothing consumes | a behavioural test in which the same corpus produces **different prompt bytes** because the fact exists |
| 2 | **Consumers** (§E2): `assemble` → `reviseLedger` → `resolveContradiction` on the product path | importing a symbol without calling it, or calling it on an empty list | `semantic-reach.test.ts` must **name** the symbols it reached; the reach table's rows flip to `P` |
| 3 | **Representability** (§E3): `MemoryType` writes and reads `'semantic'` — **landed**, `AUDIT-SEMANTIC-REACH.md` §12: `memoryForUpdate` writes the entry, `domain/retention.ts` (in `cortex-core`, since AUDIT §14) reads the type and decides which entry the bounded store gives up | a settable label nobody reads | one test: write → read back → behaviour changes — a pair of stores differing in one window's read, which is the only thing that separates "the rule read the type" from "the rule agreed with insertion order" |
| 4 | **Charter** (§E4): `consolidate` / `resolveContradiction` get a caller or an explicit `Declined` — **landed**, §6.1 and §6.2, with the arithmetic of both | silence | a `grep` hit outside tests, or a `Declined` in this file's §6 — both are, and `semantic-reach.test.ts` fails if a product module starts reading the state the declined mechanism writes |
| 5 | **One commit** (§E5) | three tables drifting | `pnpm check` green and all three diffs in one commit |
| 6 | **Measurement** (§E6) | a claim of improvement with no reading | a paired readout with `deltaQuestions ≥ −5`, same convention as `S10` |

**The order is not negotiable and step 1 is not optional.** Steps 2–4 all take a `KnowledgeFact` or a slot as
input; without step 1 they can only be satisfied by constructing facts in a test, which is the decoration the
audit charged us with.

---

## 4. What this decision explicitly does **not** authorise

| Not authorised | Why | Where that is measured |
| --- | --- | --- |
| Inferring supersession from corpus surface tokens | `MEASURE-SUPERSEDE-REACH.md` closed this axis **for the third and last time**: the tightest rule touches 77 windows, deletes the gold from 36 of them, removes the stale value from **none of the four** questions the arm was registered for | `docs/MEASURE-SUPERSEDE-REACH.md` §2 |
| Replacing original text with extracted atoms | the campaign's own `−19.62` for atom substitution stands, unretracted | `AUDIT-SEMANTIC-REACH.md` §8 bullet 3 |
| A second retriever, a second renderer, a second provenance mechanism | each already exists once; a second is the defect class this repository has caught three times (`AUDIT-REFERENCE-LOCALLY-CONVERGENCE`, the two comparators, the two room parsers) | — |
| Changing a default that alters archived bytes | any default-on change makes every published artifact unreproducible from the code, which `prompt.ts` argues against in four separate field docstrings | `prompt-turn-cap.test.ts` |
| Dispatching `S10` / `S9` before E1–E8 are green | the user's standing gate | `cortex-docs` `06` §6 |

The fact source authorised by §3 step 1 is therefore constrained to be **additive** — the sentence stays, the
fact is added beside it — and to spend **zero** new model calls. §5 records the one source that satisfies both.

---

## 5. Which fact source, and why only one survives

Three candidates were on the table. Two are already closed by measurement, and that is what makes the choice a
deduction rather than a preference:

| Candidate | Status | Closed by |
| --- | --- | --- |
| **Extract atoms from the corpus at ingest** (a model call per turn) | **Open, expensive, and out of scope here** — it is the FEB-30 / corpus-ownership programme (`T5`), not this decision | nothing; it is deferred rather than refused |
| **Infer supersession from surface tokens** | **Closed** | `MEASURE-SUPERSEDE-REACH.md` §2, three times |
| **Reuse the authorisation the product already computes** — the span-and-date check in `supersede.ts` | **Chosen** | — |

The third survives because it is the only source that is *already paid for*. `adjudicateSupersession` returns
`{ kind: 'replace', value, record }` only after three checks that are stronger than anything a token heuristic
can offer:

1. the quote appears in the evidence **character for character**;
2. the date appears **on the same evidence record** as the quote;
3. the record is **later** than the record the previous answer rests on.

A verdict that passed all three is a statement the product has *authorised* — and it is thrown away today. The
fact source is the code that stops throwing it away.

Two consequences follow, and both are recorded here rather than discovered later:

- **The source is per-question, and a fact is only relevant to a window that still contains its record.** A fact
  derived from question *n* names the evidence record it came from; question *m* can only use it when its own
  window carries that record. In the benchmark every question brings its own corpus, so the reach is **zero by
  construction** rather than by hope — and in a real session over one corpus it is exactly the capability the
  product sheet calls "knowledge update".
- **The consumer is behind a switch whose default is off.** §4's fourth row forbids changing archived bytes by
  default, and E6 has not run. The switch is what makes the byte delta *assertable* before it is *shipped*.

---

## 6. Declined, and what would reopen it

`E4` allows either a caller or an explicit `Declined`. This section is the register, so that "nobody got to it"
and "we decided not to" cannot be confused.

| Mechanism | State | Why, and what would reopen it |
| --- | --- | --- |
| `consolidate` (FSRS forgetting clock) | **Declined, with the arithmetic** (§6.2) | three independent reasons, each measured or grep-checkable: the elapsed time it measures inside a store is **zero by construction** (one clock, one stamp), the state it writes has **no reader** in `cortex-memory` (`0` occurrences of `.stability`), and its direction of action — forget an entry because time passed — is what `not-later` (§13.371) exists to prevent. Reopening condition: a store that holds entries stamped on **more than one** clock, which is the only shape where its input is non-empty |
| `resolveContradiction` (log-odds fusion over a slot) | **Declined, with the arithmetic** (§6.1) | reopening condition: a window in which two values claim **one instant**, and a source-trust signal that is recorded rather than invented |
| `MemoryGraph` (Hebbian multi-hop) | **Declined, with a reading** | wired into the temporal path and removed on measurement: 77.95% → 70.87%, 15 broken against 6 repaired, exact McNemar p = 0.039. Reopening condition: a multi-hop arm registered with its own criterion |
| `sinkhorn` (optimal-transport distillation) | **Declined, inert** | has no reading and no caller; deleting it is a separate decision |
| `Fact`'s `derivedFrom` | **Rejected as written** | `AUDIT-SEMANTIC-REACH.md` §4.2: `KnowledgeFact.references` already is the derivation edge and `revision.ts` cascades over it. A second mechanism on a type nothing builds |


### 6.1 `resolveContradiction`: the only defensible inputs return the refuted value

`resolveContradiction(facts: readonly Fact[])` decides between facts that claim **one instant**, by fusing
`confidence × sourceTrust` into a log-odds posterior per object. The product's fact source
(`cortex-memory/src/semantic-facts.ts`) produces a pair that is **strictly ordered** — the same-instant case is
refused before a unit is built, because a same-instant pair is a contradiction and `revision.ts` reports it as a
refuted `uniqueness` rather than letting an id break the tie. So the function has no input on the shipping path.

The temptation is to wire it anyway, on the pair, and let it pick. That pair carries neither `confidence` nor
`sourceTrust` — `KnowledgeFact` has no such fields — and those two numbers are the *whole* of the decision.
Giving both the same value is not neutral. Measured, on the pair as the fact source orders it
(`[before, after]`):

| order fed | winner | belief |
| --- | --- | --- |
| `[before, after]` — the product's order | **`20 dozen`** | 0.999 |
| `[after, before]` | `30 dozen` | 0.999 |

The belief is identical because it is the same arithmetic over the same inputs; the winner is the first key in
the `Map` the function builds, i.e. **array order**. So wiring it would return the value the revision had just
refuted, with a posterior of 0.999, and nothing in the output would show that the answer was decided by a
`for` loop. That is the `?? 0` failure `resolve.ts`'s own comment documents — a second answer to a question
that has one — arrived at from the caller instead of from the callee.

What it would take to reopen: a window in which two values genuinely claim **one instant** (a contradictory
corpus, not an update), *and* a recorded trust signal per source. Both are corpus-model questions, not wiring
questions, and neither is in E2.

### 6.2 `consolidate`: the clock has one instant in it, and nothing reads what it writes

`consolidate(memories, graph, accesses, { now })` is the "sleep" process: FSRS review per access, Hebbian edge
strengthening on co-activation, and a cull of everything whose retrievability has fallen below a threshold. It
is the most plausible of the four to wire, because unlike `resolveContradiction` it does not need a pair of
facts — it needs a store, and since E3 the product has one with `MemoryValue`s in it.

Three facts, each checkable, say it has nothing to do there.

**1. The elapsed time it measures is zero by construction.** A store carries one clock
(`CortexMemoryOptions.now`, a single number) and `memoryForUpdate` stamps `createdAt` and `lastAccessedAt` with
it. So for every entry the product holds, `now - lastAccessedAt === 0`, `retrievability(0, 1) === 1`, and the
default threshold is `0.01` — four and a half stable intervals away. The cull cannot fire: not rarely, not at a
boundary, but never, for as long as the store is one instance with one clock. Asserted in
`semantic-facts.test.ts` under *the forgetting clock this entry would have to run on*, together with the
counter-assertion that the same entry **is** forgotten when the batch runs a year later, so the first test is
not passing because forgetting is broken.

**2. The state it writes has no reader.** A review pass moves `stability` and `difficulty`; the forget pass reads
`stability`. In `packages/cortex-memory/src` the string `.stability` occurs **zero** times. A wired call would
therefore multiply a field by 1.25 per read and hand it to nobody — a mechanism whose only consumer is itself,
which is the decoration `AUDIT-SEMANTIC-REACH.md` charged this repository with, reached from the other end.
`semantic-reach.test.ts` now asserts the zero, so the day a product module does read the FSRS state the decline
fails loudly instead of quietly becoming wrong.

**3. Its direction of action is the one the block exists to prevent.** Forgetting removes an entry because
*time* passed. The entry is a substitution whose corpus still says `30 dozen`; dropping it does not make the
statement false, it makes the prompt fall back to the evidence, where the superseded `20 dozen` sits unmarked —
the exact outcome the `not-later` guard was written against (§13.371 of the preregistration, and the defect a
previous round found when a refuted value was printed as a fact). The question the store actually has is *which*
entry to give up when the bound is crossed, and E3 answers that by read-rank, not by decay.

**A trap found on the way, fixed rather than declined.** The forgetting pass used to read `Date.now()` while the
entries it aged had been stamped by the caller's clock. Nothing in the suite could see it, because every fixture
stamps `Date.now()`, so the two clocks agreed on every input the suite had — the same shape as the unit defect
`AUDIT-CONSOLIDATION-CLOCK.md` records, one argument further along. It matters for exactly the caller who would
wire it: a replay pins `now` to the corpus date, and a batch consolidated today then measures the difference
between 2023 and now, `exp(-1343)`, and **deletes the entire store**. `now` is a required parameter now. A
default of `Date.now()` would have been right only for callers who use wall time, so there is no default, and
`consolidation-clock.test.ts` carries the two `@ts-expect-error` lines that fail the build if one comes back.

| what the store can pass as an access instant | the review's `r` | the cull's elapsed time | the effect |
| --- | --- | --- | --- |
| `now` — the only instant it has | `1` | `0` | nothing is reviewed, nothing is forgotten: the call is a no-op with a counter |
| a turn's corpus date | a real elapsed time | `now − turn date` | a year of corpus time is enough to forget a statement that is still true, i.e. reason 3 |

What it would take to reopen: a store whose entries are stamped on **more than one** clock — a long-lived
process that ingests over wall time, rather than a per-instance store pinned to one instant — *and* a decision
that reads FSRS state to rank retention. Neither exists, and both are design changes rather than wirings.

`MemoryGraph` and `consolidate` are the two rows that are **declines with evidence** rather than deferrals, and
the difference between them is the kind of evidence: `MemoryGraph` lost a paired arm (77.95% → 70.87%, exact
McNemar p = 0.039), and `consolidate` has no arm to lose because it has no input. A mechanism that was measured
and lost is not the same as a mechanism nobody reached, and neither is the same as one whose inputs are the
empty set.

---

## 7. What would overturn this decision

The decision to wire is falsifiable, and these are the observations that would falsify it:

1. **E6 returns a reading worse than `−5` questions.** Then the semantic layer is a negative result, it enters
   `RETRACTIONS`, and Route A is reconsidered *with a reading in hand* — which is a better position than the one
   this document was written from.
2. **The fact source cannot be made additive.** If the only way to reach a `KnowledgeFact` requires rewriting
   the sentence, the `−19.62` result applies and the route fails on its own terms.
3. **The consumers turn out to need a store the product does not own.** That is `T5` (corpus ownership), a
   separate decision with its own cost, and it would move this one's scope rather than its direction.

Nothing in this document is a claim that the wiring will improve accuracy. It is a claim about what the product
**is**, and the measurement is what decides whether the version that is it, is worth being.
