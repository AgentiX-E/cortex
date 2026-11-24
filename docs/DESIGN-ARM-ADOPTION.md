# The arm that ships is the arm that was measured

**Status:** implemented (`packages/cortex-memory/src/registered-arm.ts`, `tools/arm-config-guard.mjs`,
`packages/cortex-memory/src/__tests__/registered-arm.test.ts`)
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

The last row is the exception that proves the rule. `rooms.ts` carries a constant pinned to that
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
leaves `flat` byte-identical to a bare call. What remains is the **default**: a bare call still reaches every
route, which is the row `REGISTERED_ARM_UNSHIPPED` keeps honest rather than an application this document can
claim.

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

The partition has three tables, not two. `REGISTERED_ARM` holds the nineteen fields the product applies;
`REGISTERED_ARM_UNSHIPPED` holds the four the registration carries and the published entry **does not apply**
(`maxTurnChars` and `maxTurnCharsRoutes` are nameable and forwarded but nothing defaults them;
`evidenceRoles` and `evidenceRolesRoutes` have no option at all); `REGISTERED_ARM_ELSEWHERE` holds the
fourteen that are not a product decision, each with its class.

The middle table is the honest one. Writing those four into `REGISTERED_ARM` would have claimed an
application that does not happen — the same defect this document is about, one layer down — and its assertion
is bidirectional: every value still has to equal the artifact, and a bare assembly must still **not** apply it,
so shipping one turns the gate red with "move this row up" rather than passing quietly.

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
