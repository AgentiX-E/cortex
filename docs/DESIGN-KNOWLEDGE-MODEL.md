# Design: a knowledge model that does not lose the relation

**Status:** proposal, pre-implementation. Nothing in this file is measured on our own
benchmark yet; the readings it quotes are either from the 20-pair review artifact
(`docs/MEASURE-ATOM-FIDELITY.md`) or from the cited papers.

---

## 1. The defect, in the reviewer's words

Two rounds of card review, 40 judgements, produced the same complaint twice, and the second
time it was precise:

> "The atom did not distil any fact, preference or summary — it just cut the sentence into
> segments. And once one sentence becomes two atoms, the (causal) relation between them is
> gone, so in those cases I want the original sentence instead of the atoms. But neither is
> good, is it?"

That is not a prompt problem. `grounding.ts` currently binds an atom to **one sentence** and
forbids any word that sentence does not contain. A relation such as "so", "but", "then" is
carried by a conjunction that belongs to *neither* half, so when the sentence is split the
conjunction has nowhere to live and is dropped — by construction, not by model error.

The measurement in `docs/MEASURE-ATOM-FIDELITY.md` puts a number on it: of 20 reviewed pairs,
9 source sentences carry an explicit relation marker, and in **5 of those 9** the marker survives
in no atom at all or survives in one atom while its counterpart disappears — and in the whole
20-pair set only **one** frame (`g04`) expresses the relation as a fact.

| card | source | atoms after the split | what was lost |
| --- | --- | --- | --- |
| `g00` | "…finished an online course on data analysis **so** I'm interested in applying my new skills…" | 2 atoms, no link | the causal link itself |
| `g05` | "Each had its own unique charm, **but** I think my favourite was the Fairmont Orchid." | "The Fairmont Orchid was my favorite." | the comparison; the other option vanished |
| `g30` | "…make a classic California roll…, **and then** try out a new recipe…" | 2 independent plans | the order |
| `g23` | "…a consistent morning routine, **but** it's tough **when** I have a lot on my plate" | keeps `when`, drops `but` | the concession |

And one pair shows the shape of the fix rather than the defect:

| card | source | atoms | why it works |
| --- | --- | --- | --- |
| `g04` | "…the online communities I've joined have been super helpful in learning new techniques…" | "Online communities **help me learn** new techniques." | the atom is a **relation**, not a thing |

`g04` is the existence proof. The model can express a relation as a proposition — it did, once,
unprompted — because a proposition with a causal verb is still one sentence and still passes
content grounding. What the system never asked for, and cannot represent, is the **edge**: two
facts and a typed link between them, which is the only form that survives a split.

## 2. What the literature actually supports

Read in the order that matters for the decision, not the order of publication. The last row is
the one that constrains everything above it.

| Work | Mechanism | What it changes here | What it does **not** license |
| --- | --- | --- | --- |
| **Hindsight** — *Hindsight is 20/20*, arXiv 2512.12818 (Dec 2025) | Four logical networks (world facts / experiences / observations / mental models); `retain`/`recall`/`reflect`; **TEMPR**: dense + BM25 + entity-graph + temporal, fused by RRF, cross-encoder rerank, **token budget instead of top-K**; conflicting facts keep both states with timestamps | The four-way read path and the budget-not-K rule are the two things we lack outright. Observations as *evidence-backed beliefs refined, not overwritten* is the shape our `supersedes` edge should take. | Its 94.6% is vendor-reported on conversational data with a stronger reader; the architecture claim ("blurring evidence and inference") is what transfers, not the number. |
| **Zep / Graphiti** — arXiv 2501.13956 (Jan 2025) | `EntityEdge(source → relation → target)` with a natural-language `fact` label, **four timestamps** (`valid_at`/`invalid_at` bi-temporal + `created_at`/`expired_at`), edges **expired, never deleted**; hybrid embedding + BM25 + graph traversal, **no LLM in the read path** | This is the concrete edge schema. Copy it: an edge is a first-class row with provenance, not an adjacency weight. | Requires a graph store; we have OPFS and an in-memory index. Our edge set must be small and derived, not a general KG. |
| **MAGMA** — arXiv 2601.03236 (Jan 2026, ACL 2026) | Each memory item lives simultaneously on four **orthogonal** graphs (semantic, temporal, causal, entity); retrieval is **policy-guided traversal**, decoupled from representation | Decoupling representation from retrieval is the architectural move: our `Edge[]` is the representation, a channel set is the policy. | It reports "consistently outperforms" without a per-channel ablation in the abstract; do not assume all four channels earn their keep. |
| **Does Memory Need Graphs?** — arXiv 2601.01280 (Jan 2026, ACL 2026) | Controlled stage-wise comparison on LongMemEval/HaluMem. **SimGraph (similarity edges) is *worse* than flat.** KnowGraph (entity–relation triples) is **inconsistent**: better R@5 on S, worse on M. **DescGraph (entity *descriptions* as keys) wins everywhere** (R@5 .7661 vs flat .7064 on LongMemEval-M). With `Value=key`, graph methods *lose* to flat (.592 vs .620) because a description carries less than a `[summary+facts+keywords]` bundle. | **Two hard constraints.** (1) Never build similarity edges — they are measured noise. (2) The thing you hand the reader must stay rich; a typed graph may annotate the evidence but may not replace it. | "Add a graph" is not a win. The win is *typed* edges plus *dense* evidence. This paper is the reason the design below keeps the frame. |
| **Dense-X Retrieval** — arXiv 2312.06648 | Proposition as retrieval unit: atomic, **self-contained with pronouns resolved**, "necessary context is incorporated" | Confirms that the atom is the right *unit*; and that self-containment requires resolving references the single sentence does not carry. | Its 10.1 Recall@20 gain is over Wikipedia passages, not over a memory stream; the gain direction is not the gain size. |
| **Anthropic Contextual Retrieval** (Sep 2024) | Prepend a 50–100 token LLM-written context to each chunk before embedding **and** before BM25: top-20 failure 5.7% → 3.7% (−35%), → 2.9% (−49%) with contextual BM25, → 1.9% (−67%) with reranking | The cheapest way to stop an atom from being context-free is a header used **only at index time**. It costs no publication risk: the header never enters the card. | Measured on document corpora; ours is a conversation, where the "document" is the session. |
| **A-MEM** — arXiv 2502.12110 | Zettelkasten notes with model-generated links; new memories **evolve** older notes | Memory evolution is the alternative to `supersedes` deletion; we take the edge, not the rewriting. | Free-form links reintroduce SimGraph's failure mode unless they are typed. |
| **HippoRAG 2** — arXiv 2502.14802 (ICML 2025) | Phrase/passage dual-node KG, **Personalized PageRank** retrieval, MuSiQue F1 44.8 → 51.9 | PPR over a typed graph is the multi-hop mechanism worth stealing if 1-hop expansion proves insufficient. | Its graph is built over a corpus, not over a user's turns. |
| **Mem0 / Mem0g** — arXiv 2504.19413 | ADD/UPDATE/DELETE/NOOP controller over extracted facts; graph variant stores entity–relation triples | The controller is the right shape for our `supersedes` derivation. | Its accuracy numbers are contested across readers; not used as a target. |
| **Event Causality Identification survey** — ACM CSUR 2026 | **Causal hallucination**: models over-attribute causality, reading temporal succession (`A then B`) as causation. DECI lags SECI by 10–20 F1. | This is the guard we must build: a temporal marker may **never** produce a `causes` edge. | Do not attempt implicit causality. If no explicit marker exists, there is no edge. |

### 2.1 The decision this evidence forces

Three temptations, each killed by a citation:

1. **"Replace the atom with the original sentence."** Kills Dense-X's gain and the whole point
   of the card (a paragraph is not a decision unit). Rejected.
2. **"Build a knowledge graph of everything, link by similarity."** Exactly SimGraph, measured
   *worse than flat*. Rejected.
3. **"Let the model emit relations freely."** Causal hallucination, plus the v5 precedent:
   a prompt-only fix was disproven once already (`proposer.ts`, v5 reverted, 45→48 proposals
   but verbatim 44.1%→52.6%). Relations must be **gated by markers**, not by model confidence.

What survives is narrow and testable:

> An atom stays an atom. Every explicit relation marker in the source must land in **one of
> two places**: folded into a relational proposition (`g04`'s shape), or materialised as a
> typed edge with a span that can be located in the source. If neither happens, the split is
> **refused**, not silently degraded.

## 3. Data model

Four levels, and the reason each exists is a defect above.

```
Frame   (verbatim utterance — the value layer, never replaced)
  └── Fact        (typed, self-contained proposition; carries slot values)
        └── Edge  (typed, directed, span-evidenced relation between two Facts)
              └── Observation (optional, evidence-counted generalisation over Facts)
```

```ts
type FactType =
  | 'event'        // something that happened, with a time
  | 'state'        // a condition that holds over an interval
  | 'preference'   // likes, dislikes, priorities
  | 'constraint'   // must / cannot / deadline
  | 'decision'     // a chosen course, with the alternatives it beat
  | 'goal'         // intended future action
  | 'attribute'    // a property of an entity (g13's "the project connects 100 villages")
  | 'evaluation'   // a judgement the speaker made ("performing really well")
  | 'relation';    // a fact *about* two facts (g04: "communities help me learn")

type EdgeType =
  | 'causes' | 'enables' | 'prevents'      // requires a causal marker
  | 'before' | 'after' | 'during'          // requires a temporal marker
  | 'condition'                            // requires if/unless/otherwise
  | 'contrast'                             // requires but/although/instead
  | 'elaborates'                           // same entity, added detail
  | 'supersedes'                           // derived: same subject+predicate, later, different value
  | 'same-entity';                         // derived: resolved coreference
```

Every `Fact` carries: `text`, `type`, `polarity` (`positive`/`negated`), `modality`
(`actual`/`planned`/`hypothetical`), optional `time` (`absolute`/`relative`/`interval`),
`sourceSpan`, and `references: { token, resolvedFrom }[]` — the words that were introduced by
resolving a reference, each traceable to a context item.

Every `Edge` carries: `from`, `to`, `type`, `marker` (the literal token that licensed it),
`evidenceSpan`, `origin` (`extracted` | `derived`).

**`origin` is the audit hinge.** An `extracted` edge was read off the sentence and can be
checked against a span. A `derived` edge was computed (`supersedes`, `same-entity`) and can be
recomputed. Nothing else may create an edge.

### 3.1 Grounding changes from "one sentence" to "this frame, plus what it may refer to"

`contentGrounded(text, source)` compares content words against one sentence. That is why `g13`
degrades: "The project connects 100 rural villages" has a subject that only exists in the
previous clause of the same sentence — tolerable — but "the afternoon session" in a follow-up
turn has no anchor at all.

The change is a widening with a proof obligation, not a relaxation:

```
grounded(text, { frame, context }) =
    every content word is in frame
    OR appears in `context[i]` for some i, and the Fact's `references` records
       { token: word, resolvedFrom: i }
```

Two properties are preserved and tested: a word that appears nowhere is still refused with
`invented:new-word`, and every resolution is inspectable in the export. What becomes newly
possible is the thing Dense-X calls self-containment.

## 4. Retrieval: four channels, and the one we refuse to build

```
query ─┬─ dense(atom + header) ─────────┐
       ├─ lexical(atom + header) BM25 ──┤
       ├─ typed 1-hop over Edge[] ──────┤── RRF(k=60) ── rerank ── budget
       └─ temporal filter ──────────────┘
```

1. **Header, index-time only.** `[<session> | <speaker> | <date> | about <entities>]` prepended
   for embedding and BM25, never rendered. This is Anthropic's finding applied to the one place
   we can afford it: an atom is smaller than a chunk, so its context deficit is larger.
2. **Typed 1-hop only.** Expansion follows `causes`/`before`/`after`/`condition`/`contrast`
   edges. **No similarity edges** (2601.01280). Depth 1 by default; depth 2 is an option that
   must earn its keep in an ablation.
3. **Budget, not top-K.** Fill a token budget with the same block shape, so context size is
   predictable across questions.
4. **The delivered block keeps the frame.** Every retrieved fact is rendered as three lines:

   ```
   fact:     I finished an online course on data analysis using Python.
   relation: -> causes -> "I am interested in applying my new skills…"   (marker: "so")
   frame:    "By the way, I just finished an online course … so I'm interested …"
   ```

   This is the direct answer to "neither is good": the reader gets the atom's precision, the
   relation that the split destroyed, and the original wording if it needs to judge.
5. **Superseded facts are labelled in place.** `[superseded 2026-03-11 by …]`. The KU failure
   already on record — the reader held both `25:50` and `27:12` and chose the older one
   (`SOTA-BASELINE.md` §5) — is a labelling failure, not a recall failure.

## 5. Acceptance

Pre-registered before implementation. Each row is falsifiable by one command.

| # | Endpoint | Threshold | Why this number |
| --- | --- | --- | --- |
| A1 | Marker survival: every explicit relation marker in the source lands in a fact or a licensed edge | **100%** on the 20-pair artifact, 0 regressions | It is a gate, not a score; a gate that passes 97% is a gate that is off. |
| A2 | Causal-hallucination rate: edges of type `causes`/`enables`/`prevents` with only a temporal marker | **0** | ACL 2026 survey names this the dominant failure. |
| A3 | Edge provenance: edges whose `evidenceSpan` cannot be located in the frame | **0** | An unlocatable edge is an invention. |
| A4 | Referential closure: content words accepted that appear nowhere in frame ∪ context | **0** | The existing `invented:new-word` gate must not loosen. |
| A5 | Atom verbatim share (the standing over-copying guard) | **≤ 35%**, must not rise | v5's lesson: a change that buys proposals by copying is not a gain. |
| A6 | Four-dimension coverage of the new modules | **≥ 95%** each | Standing rule. |
| A7 | LongMemEval-S MR / TR / KU, same-instant A/B | reported, not gated | One run is a direction; two is a conclusion. The endpoint that decides is A1–A4. |

A1–A5 are offline and can be run without a model. A7 needs the runner.

## 6. What this design refuses to do, and why

- **No implicit causality.** No marker, no causal edge. Recall we lose is recall we cannot
  audit.
- **No similarity edges, ever.** Measured worse than flat on the only controlled comparison we
  have.
- **No rewriting of the frame.** The frame is the value layer; a system that edits its own
  evidence cannot be audited by the person whose words they were.
- **No confidence field.** Same reason as `proposer.ts`: a number nothing calibrates is a
  number nobody can check. `marker` and `evidenceSpan` are checkable; "0.82" is not.
- **No graph database.** The edge set is small, derived, and lives beside the facts.

## 7. Known gaps

1. The 60% figure comes from 20 pairs, one corpus, one prompt version. It is a direction, and
   it is the only number we have — the 20-pair draw is the same artifact the reviewer used.
2. Nothing here has been run against LongMemEval-S yet. A7 exists so that the first claim will
   be a measurement rather than an argument.
3. `condition` edges have no retrieval semantics yet: a conditional fact ("I'll keep an eye on
   the weather if I plan a trip during hurricane season") should not be retrieved as though it
   were an assertion. Filed, not solved.
4. Multi-sentence relations across turns (turn 3 causes turn 9) are out of scope: the gate reads
   one frame. MAGMA's temporal graph is the reference for the day we do it.

## 8. What exists now, and what is still an argument

Built in this step, all of it pure and all of it tested without a model:

| Module | Contract it owns | Tests |
| --- | --- | --- |
| `knowledge/taxonomy.ts` | nine fact types, eleven edge types, and the licence table that decides which marker may create which edge | 6 |
| `knowledge/markers.ts` | the connective table and the eleven-phrase exclusion table, with positions | 19 |
| `knowledge/frame.ts` | the frame, the fact, the computed span, and the three closed vocabularies checked at runtime | 8 |
| `knowledge/edge.ts` | edge validation (licence, locatable marker, covering span) and `supersedes` from slots | 30 |
| `knowledge/unit.ts` | assembly, the unresolved-marker gate, and the census | 18 |
| `retrieval/fuse.ts` | RRF and a token budget | 9 |
| `retrieval/typed.ts` | typed one-hop expansion and the grouped block | 33 |
| `triage/grounding.ts` (extended) | grounding against a frame plus a declared context, with a receipt per borrowed word | 12 |

**Readings that are now measured** (`node tools/knowledge-probe.mjs --html <review page>`):

```
pairs                       20
accepted as split (strict)  15 (75%)
unresolved markers          5
  refused: unresolved-marker × 5
  g00: so   g05: but   g23: but   g30: then   g32: since

g00 repaired: 107 tokens grouped, 180 as 2 self-contained blocks
1-hop from g00#0: g00#1 via causes
supersedes:k2>k1 (derived, no marker, no span)
budget 600 tokens over 15 units: kept 8 (591 tokens), skipped 7
```

Three things follow, and only the first is comfortable.

1. **The gate agrees with the reviewer on exactly the five cards the census flagged.** Not a coincidence:
   both read the same markers, and the gate's extra clause (`foldedInto`) is why `g06` and `g18` pass.
2. **The gate, as written, would refuse 25% of the proposals a model currently produces.** That is not a
   reason to weaken it; it is the size of the work the v6 prompt has to do. A model asked for `edges`
   will produce them, and the five refusals become the target.
3. **The three-line block costs 40% less than the naive form** (107 vs 180 tokens for `g00`), because the
   frame is stated once and a relation names its other end by id when that end is in the same block.

**Still an argument, not a measurement:**

- The LongMemEval-S A/B (A7). No run has been made. The claim that this design closes part of the MR/TR
  gap is a prediction, and it is the prediction A7 exists to test.
- Any prompt change. `triage-proposer/v4` is untouched on purpose: it is the version the reviewer judged,
  and changing it in the same step as the gate would make both readings unattributable.
- `elaborates` and `same-entity` have types and no producer. They are in the closure because the
  vocabulary is not honest with holes in it; the day one is needed it will need a defined input, exactly
  as `supersedes` needed `subject`/`predicate`/`at`.
