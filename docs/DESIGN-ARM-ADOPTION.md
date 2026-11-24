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
