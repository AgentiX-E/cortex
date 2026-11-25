# The arm that ships is the arm that was measured

**Status:** implemented (`packages/cortex-memory/src/registered-arm.ts`, `tools/arm-config-guard.mjs`,
`packages/cortex-memory/src/__tests__/registered-arm.test.ts`, `assemble-turn-cap-reach.test.ts`,
`assemble-role-filter-reach.test.ts`)
**Supersedes:** nothing. **Amends:** the room table's pinning discipline, one level wider.

## 1. What was wrong, in one table

`tools/arm-config-baseline.json` records the configuration that run `44017278305` applied and that
scored **91.25%** on LongMemEval-S. The product, called the way its own manual documents it, built
something else:

| field | the registration | a bare `assembleMemory({ llm, now, storage })` |
| --- | --- | --- |
| `promptContract` | `evidence-blocks-unsourced` | `abstention` (`prompt.ts`'s own default) |
| `ask` | `verbatim-acts` | absent — each route's reference block |
| `maxPromptCharsByRoute` | 48,460 / 24,000×5 | the same, since `rooms.ts` was pinned |
| `maxTurnChars` | 400 on two routes | absent |
| `maxTurnCharsRoutes` | `multi-session,temporal` | absent — every route |
| `evidenceRoles` | `['user']` | absent — no filter, and no field to name one with |
| `evidenceRolesRoutes` | `multi-session,temporal` | absent — every route |

**Every row in that table is closed now**, in the order the campaign could pay for: the two instruction levers
(§1), the width and its reach (§1.2), and the role filter with its reach (§1.3). The table is kept as the record
of what the gap was, because a document that only describes the fixed state cannot be used to check whether the
fix is still there.

The room table is the exception that proves the rule. `rooms.ts` carries a constant pinned to that
baseline by `assemble-rooms.test.ts`, in both directions, so a re-recorded arm that forgot the room
table is a red build. Nothing else had a counterpart at all: `AssembleOptions` had no field for
`promptContract` or `ask`, so the two levers the campaign spent §12.5 and §13.291–§13.318 adopting
were **unreachable from the published composition root**. A customer calling the documented function
got the pre-`S9` arm; the number published beside it described a different one.

This is requirement ⑯'s asymmetry — "a capability that exists in a component and not in the entry
point is a capability the package does not have" — arriving through a composition root for the third
time, and it is invisible to every test that constructs `CortexMemory` directly.

### 1.1 The row that was worse than absent

`maxTurnChars`'s row understated the defect. A caller who read the manual and set the width did not get the
registered rendering with a missing field; they got the width with `CortexMemory`'s default **reach**, which
is every route. §13.72 is the run that priced the difference: the global cap bought **+13 on `MR`** and cost
**−30 on `IE`**, thirty questions that went `correct → abstention` at a median coverage of 100%. So the entry
point offered two configurations and one of them was the one a measurement had rejected, with no way to
express the one that shipped.

`maxTurnCharsRoutes` — a `CortexMemoryOptions` field and a manual row since that run — is forwarded now, and
`assemble-turn-cap-reach.test.ts` asserts it end to end: one assembly cuts `multi-session` at the width and
leaves `flat` byte-identical to the pre-cap rendering.

### 1.2 The row moved up, and the order it moved in

Both halves are now **defaulted**, on the room table's rule: a bare call assembles the registered rendering,
either field named is the caller's answer, and `minimal` withholds both for the reason it withholds the table.
That is one step further than requirement ⑯ asks for — the capability was reachable and *unpriced*, which is
the same defect stated in the other direction: a caller who named nothing got the class's uncapped rendering,
which no dispatch has ever priced, and which reads **7,448 prompt tokens per question against the capped
7,242**. The unmeasured cell was also the dearer one.

The order was the one `REGISTERED_ARM_UNSHIPPED` prescribed, and it matters: forward the field (the reach
arrives at the renderer, proven by prompt bytes), then default it, then move the row into `REGISTERED_ARM`
and flip the tripwire from "a bare call does not apply this" to "a bare call cuts where the registration
cuts". `[]` is the opt-out, which is why the reach is a list rather than a boolean.

### 1.3 The last two rows, and the one condition on their default

`evidenceRoles` and `evidenceRolesRoutes` were the table's longest-lived rows. §13.83 registered user-only
evidence at the identity, §13.84 adopted it on `multi-session` and `temporal` with no capability regressed, and
every reading from `S16` onwards was taken with the filter on — while `AssembleOptions` had no field for either.
The documented call therefore printed every assistant turn the arm excludes: the reference window, which is the
one cell four screening runs paid to remove.

Both are forwarded and defaulted now, and the default carries **one condition** the width's does not:

| what the caller wrote | what they get |
| --- | --- |
| `roleOf` only | the registration: `['user']` on `multi-session` and `temporal` |
| nothing | no filter, and `lastRoleCensus() === null` |
| `evidenceRoles` named | exactly what was named, and the constructor's refusal if no classifier came with it |
| `evidenceRolesRoutes: []` | the census runs, no turn is dropped |

The condition is not caution. A width needs nothing from the caller; a role is a property of the caller's
**corpus format**, and this package stores text. `[2023/02/15 (Wed) 03:14] user: …` is the campaign's haystack,
`Assistant: …` is a fixture's, and a transcript with one speaker has none — three formats, and a product that
read one of them would be wrong on the other two and would have a dataset's spelling inside a published
library's prompt path. So `roleOf` is an input, like `llm` and `embed`, and the honest state for a call that
brings none is "this run could not read a role" — which the census records as `null` rather than as a filter
that silently kept everything. That distinction is exactly what `43465626013` could not make from its own
artifact.

The opt-out is the width's spelling: `evidenceRolesRoutes: []`, a filter that reaches nowhere. `'all'` is not a
value, because a sentinel would give one field two meanings and because the dispatcher already spells the
unfiltered arm as *absence*, which is what every artifact before §13.84 records.

**The published adapter changed with it, and that is a finding rather than a tidy-up.** `CortexProductProvider`
— the row the product prints in a competitor table — ingests `ProviderTurn`s, which carry `role` as a field, and
the corpus stores text. Before this round it dropped the role at that boundary and assembled the **unfiltered**
arm: every comparison published for that row described a configuration the 91.6% reading did not use. The
adapter now derives a lookup over the turns it stored and supplies it as `roleOf`, so the row and the reading
are one arm; `product-provider.test.ts` holds both halves, asserting byte equality against a direct assembly
that derives the same lookup **and** inequality against one that does not.

`assemble-role-filter-reach.test.ts` proves the reach at the renderer through two routes in both directions —
the registered pair filters `multi-session` and leaves `flat` identical, and the same filter named for `flat`
alone does the opposite. The second direction is the one no dispatch has ever run, which is why it lives in a
test rather than in a paragraph: a reach that can only ever be pointed one way is a boolean wearing a list.

### 1.4 The fifth field: forwarded without being adopted

`conflicts` is the first mechanism to arrive here **without** an adopted default. It has a reach reading
(`MEASURE-CONFLICT-SURFACING.md` §2: four of the seven `KU` questions that fail in all four repetitions carry the
replacing statement inside the delivered window) and **no accuracy reading**, because an adoption needs a paired
dispatch and none has been made. The registered value is `false`, and it stays `false`.

That is precisely the configuration in which this defect is invisible. Every previous field arrived with a number
behind it, so the missing field could be found by comparing the registration against the manual. A mechanism that
is off cannot be found that way: the arm's bytes are correct, the artifact's `conflicts: false` is correct, and the
only thing wrong is that a customer who read the reach table could not turn the mechanism on. `assembleMemory` is
the only construction path the published package offers, and it had no field for it.

So the rule this round adopts is wider than "forward what ships": **every mechanism the class accepts is forwarded,
whether or not its default is the adopted one**, because the cost of forwarding is one spread expression and the
cost of not forwarding is a measurement a customer cannot reproduce. `assemble-conflict-reach.test.ts` holds the
reach at the composed level — four routes move, two stay byte-identical, and deleting the block reproduces the
off-prompt exactly — and its own mutation (deleting the forwarding line) turns three of its six assertions red.

### 1.5 The sixth field is not an experiment switch, it is the provider contract

`readerByRoute` is the first field in this list that a *customer* rather than an experiment wants. Requirement
eleven asks the design to accept different LLM providers by injection; `LLM` is one interface and `readerByRoute`
is six slots of it, and `memory.ts#readerFor` has consumed the map since the round that measured the effect. What
the published composition root could not do was **reach the slots**.

The reason it went unseen is specific, and it is not "nobody looked". Every earlier gap was found by comparing the
registration against the manual, and a field whose default is the adopted configuration has a *value* to compare.
This one has a **fallback** instead: a map that cannot be expressed is not an error, it is six routes on `llm`. So
the failure mode is a complete, valid, silent run whose reading says the per-route rule did not help — the one
conclusion the map exists to test, produced by a composition root that never passed the map on.

`assemble-reader-by-route.test.ts` therefore asserts four things a careless forwarding fails: each named route
calls its own stub (`temporal`, `multi-session`), an unnamed route calls `llm`, an absent map is the historical
behaviour, and — the assertion that survives an implementation which routes correctly but leaks identity — the
**prompt is byte-identical under two different readers**. The mutation is 4 red of 6: the two that stay green are
the two "must not move" assertions, which is the shape a mutation should have.

| field | why it was missing | what a customer lost |
| --- | --- | --- |
| `ask`, `promptContract` | arrived with a number, compared against the manual | a mechanism with a reading |
| `supersededRendering`, `evidenceRoles` | same | same |
| `conflicts` | off by default, so no value to compare | a reach table they could not act on |
| **`readerByRoute`** | **falls back instead of failing** | **the provider contract, and a per-route reading that silently measured one reader** |

### 1.6 The audit becomes a ratchet, because a hand audit already missed twice

Two fields were found by hand-comparing a registration against a manual, and both were found late. A hand
audit is not a mechanism, and for the fallback case in §1.5 it is not even a valid method: the run that
loses the map is complete, valid and silent, so there is nothing to compare.

`tools/assemble-coverage.mjs` (`guard:assemble`) makes the comparison mechanical. Every field
`CortexMemoryOptions` declares is exactly one of three things:

| identity | meaning | how it is found |
| --- | --- | --- |
| **forwarded** | the composition root reads `options.<name>` | text of `assemble.ts` |
| **explained** | deliberately not forwardable, reason recorded beside it | the tool's `EXPLAINED` table |
| **open** | not yet decided, named, and capped | the tool's `OPEN` table |

The reading is `33 field(s), 26 forwarded, 1 explained, 6/6 open`. `relevanceFor` is the only explained
entry, for the reason `AUDIT-PRODUCT-SURFACE.md` §13 records: the product ranks with its own index and the
callback is the harness's override, so forwarding both would let a caller set two rankers while the
artifact names one. The six open entries are `widthPlan`, `relevanceUnits`, `windowRadius`,
`reviewBareDecline`, `selfConsistency` and `windowOrdering`, each with the question it is waiting on.

Three rules, and each one can fail for its own reason:

- `unclaimed-field` -- declared, not forwarded, in neither table. A new field cannot land silently.
- `stale-entry` -- listed as open but already forwarded, or listed for a field the type no longer has. An
  out-of-date ledger is worse than a missing one, because it sends the next reader after a solved problem.
- `ratchet-raised` -- more than six open entries. The gap may shrink; it may not be widened by adding one
  more "later".

The live mutation is the evidence that the pipeline is real rather than the predicate: deleting the
`readerByRoute` forwarding line turns exactly one `unclaimed-field` red and exits 1, and restoring it
returns `33 / 26 / 1 / 6`. That is the same pair of readings the two earlier fields never had.

### 1.7 The six that were left, cleared in one round — and the fixture that lied first

The ratchet from §1.6 named six open fields. All six are forwarded now, and the table is empty:

| field | why it matters to a **customer**, not to an experiment | how its arrival is asserted |
| --- | --- | --- |
| `relevanceUnits` | `'session'` completes a session instead of scattering it; `§13.26` measured 14.3% → 66.7% across coverage bands | the unit changes **which** turns arrive in a room the evidence does not fit, with `'turn'` as the control |
| `windowRadius` | the diameter of `'anchor-window'` — the reference pipeline's `±2`, so naming the unit alone reproduces it | an invalid radius is **rejected** where the unit is spent |
| `widthPlan` | the only option that exists to **spend less**: `§14.126` priced 9,168 tokens per question against 3,703 at twice the gold evidence | the prompt gets strictly shorter, and absence leaves the room as the only bound |
| `windowOrdering` | a replicated competitor mechanism (the reference pipeline's time-window reorder) | a resolving window changes the prompt; a resolver naming none reproduces it **byte for byte** |
| `reviewBareDecline` | a decline that named nothing is worth one more call on every route whose gold is never a decline | two calls on a bare decline, one without it |
| `selfConsistency` | three consultations and a majority vote, for a caller who would rather pay than flap | three calls, and one without it |

Reading: `33 field(s), 32 forwarded, 1 explained, 0/0 open`. Deleting all six forwarding lines turns **7 of
8** assertions red; the one that stays green is the assertion that `'session-text'` **succeeds** when
boundaries arrive, which is the correct shape — a mutation should not move the controls.

#### The fixture that lied first, and why the first version of this test proved nothing

The `windowRadius` case was written against a **7,000-character** room, and failed: an invalid radius did not
throw. The conclusion available at that moment was "the mechanism is unreachable", and it was wrong. The
evidence:

| room | `turn` | `session` | `anchor-window`, radius 1.5 |
| --- | --- | --- | --- |
| 3,000 characters | 2,885 | 2,885 (same hash) | resolved, no throw |
| 2,600 characters | 2,600 | 2,548 (**different hash**) | **rejected** |

At 3,000 the five turns fit whole, so `fitToBudget` returns before `chooseEvidence` is called and the unit
never gets a vote; at 2,600 the evidence binds, and the same three calls separate. **A test of a selection
mechanism in a room the selection does not bind measures the renderer.** This is the second time this
campaign has read a control that was not controlling — §183 read a cross-commit comparison as a same-commit
one — and it is the same failure: the instrument was fine and the fixture was not.

That is why the assertion now names the room in a comment and why the `relevanceUnits` case carries a
`'turn'` control in the same room: the contrast is the measurement, not either side alone.

## 2. The same defect on the dispatch side

Three documents agreed with each other and disagreed with the run:

| file | what it said |
| --- | --- |
| `tools/arm-config-baseline.json` | `temporal: 24000`, `relevance: self-index`, `thinking: multi-session+temporal` |
| `tools/dispatch-cortex-memory-ab.py` (`INPUTS`) | the same |
| `docs/PREREGISTRATION-…` §10.3 | the same |
| **`semantic-carry.yml`** | **`temporal: 48000`, `relevance: retrieval-anchored`, `thinking: disabled`** |

`arm-config-record.py --check` compares the first three and was green throughout, because **the
workflows were not one of the copies** — and they are the copies that execute. `semantic-carry.yml`'s
published 87.00% was therefore taken on an arm with three undeclared departures from the registration.

`restore-counterfactual.yml` and `lexical-recall.yml` carry similar departures that *are* deliberate:
the first replays an archived configuration, the second runs an offline lexical instrument with no
reader. The defect is not that they depart. It is that nothing distinguished a departure somebody
decided from a value that had quietly stopped matching.

## 3. The mechanism

```
                 tools/arm-config-baseline.json          ← one record, written from an artifact
                       │                    │
     tools/arm-config-guard.mjs      REGISTERED_ARM (product constant)
       every workflow literal           │                │
       must equal it, or be        assembleMemory defaults │
       declared with a reason      ────────────────────┐  │
                                        │             │  │
                             registered-arm.test.ts ◄─┴──┘
                             (both directions, plus prompt bytes)
                                        │
                       CONFIGURATION_ATTESTED / _COUNTERFACTUAL
                       (every evidence file a row reads, and its mirror)
```

The partition has two tables, not three. `REGISTERED_ARM` holds the twenty-three fields the product applies —
including the four the middle table used to hold (`maxTurnChars`, `maxTurnCharsRoutes`, `evidenceRoles`,
`evidenceRolesRoutes`), each of which moved up only after its reach was proven at the renderer and, in the role
pair's case, only after the default was made conditional on a classifier existing; `REGISTERED_ARM_ELSEWHERE`
holds the fourteen that are not a product decision, each with its class.

The middle table is gone, and its disappearance is the point. While it existed it was the honest one: writing
those four into `REGISTERED_ARM` would have claimed an application that does not happen — the same defect this
document is about, one layer down — and its assertion was bidirectional, so shipping one turned the gate red
with "move this row up" rather than passing quietly. What replaces it is the positive form of the same claim:
a bare call cuts, filters and renders where the artifact says, and `registered-arm.test.ts` fails if a
re-recorded artifact disagrees in either direction.

Four claims, each with a checker:

1. **The product constant equals the record.** `registered-arm.test.ts` compares `REGISTERED_ARM`
   against `memoryArmConfig` field by field, with a projection map for the two fields whose spelling
   differs (`rerank` is `{ provider }` in the artifact and a name in the product), and asserts the
   partition is **total in both directions** — a field in the artifact and in neither table is a field
   nobody decided about, and a field in a table the artifact does not carry is a stale classification.
2. **A bare call assembles the recorded arm.** The same file compares prompt bytes: a bare assembly,
   an assembly naming the registered values explicitly, and the reference arm. Bytes, not fields,
   because a field that never reached the reader is exactly the failure being fixed.
3. **Every workflow spells the record or says why not.** `arm-config-guard.mjs` reads all fourteen
   workflows that set a `CORTEX_MEMORY_*` variable — literals, `|| 'fallback'` expressions, and the
   declared `default:` of the input an expression names. A departure is an
   `# arm-config: <VAR> departs — <reason>` comment, printed in every run; a file that replays an
   archived arm may declare one for the whole file. An exemption that names a different variable is a
   defect, because that is how an exemption widens until it licenses everything.
4. **Evidence names the configuration it was measured on — and the mirror.** `CONFIGURATION_ATTESTED`
   requires a fingerprint equal to the registration; the new `CONFIGURATION_COUNTERFACTUAL` requires a
   fingerprint that **differs**, with the departing axis written down. Without the second half, a
   contrast file could drift into carrying the registered fingerprint and its number would be quoted
   against a configuration it no longer differs from.

## 4. What this does not do

It does not raise the accuracy by one point. It makes the accuracy that was measured the accuracy that
ships, and it makes the next measurement's adoption mechanical: a re-recorded baseline that the product
does not follow is now a red build, and so is a workflow that dispatches something else.

The gap to the best published number is unchanged by this document and is not closed by it. On
LongMemEval-S, 500 questions:

| system | accuracy | bill | note |
| --- | --- | --- | --- |
| Synap | 95.6% | ~7.4K tokens | the number to beat |
| MemCog | 92.48% | — | |
| **cortex (registered arm)** | **91.25%** | **9,201 tokens** | this repository, `S16` |
| memoricai | 85.8% | ~11K | |

So the remaining work is a **4.35-point** gap on accuracy and a bill that is **24% higher** than the
leader's, and the largest measured-but-unadopted lever in the campaign is `ask: enumerated`, whose
reach is concentrated on multi-session (41 numeric mismatches and 22 refusals on `MR` in the last
census). That is a dispatch, not an edit, and this document's contribution is that the dispatch's
result can no longer be published without being shipped.
