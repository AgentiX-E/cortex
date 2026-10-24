# Measure: how much of a relation survives the split into atoms

**Read on:** the 20-pair artifact from the second card-review round
(`cortex-docs/evidence/a3-review/review-remote.html`, `triage-proposer/v4`, remote
`deepseek-chat`). **Reproduce:**

```
python3 tools/measure-atom-fidelity.py path/to/review-remote.html
```

No model is called. This is a census over text that was already produced, so the reading does
not depend on an API key, on the embedding backend, or on the time of day.

---

## 1. The reading

| Quantity | Value |
| --- | --- |
| pairs | 20 |
| frames whose sentence carries an explicit relation marker | **9** |
| — marker survives in no atom at all | **4** (`g00`, `g05`, `g30`, `g32`) |
| — marker survives in one atom while its counterpart disappears | **1** (`g23`) |
| — **lost, entirely or in part** | **5 / 9 = 55.6%** |
| — marker text survives (may still be a false positive) | 4 (`g06`, `g12`, `g17`, `g18`) |
| frames where an atom **states** the relation | **1** (`g04`) |

The last row is the one the design is built on. The system has exactly two ways to keep a
relation: leave the marker inside an atom, or write a relational proposition. Neither is asked
for by the prompt, and a relational proposition appeared **once in nine**.

### 1.1 Detail

| card | marker | atoms | verdict |
| --- | --- | --- | --- |
| `g00` | `so` (causal) | 2 | **lost** — "finished a course" and "am interested in applying the skills" arrive as unrelated facts |
| `g05` | `but` (contrast) | 1 | **lost** — "Each had its own unique charm" is gone; only the favourite remains |
| `g30` | `then` (temporal) | 2 | **lost** — two plans, no order |
| `g32` | `since` (causal) | 1 | **lost** — the reason stays, the request it justified is filtered as non-claim |
| `g23` | `but` + `when` | 2 | **partial** — `when` kept, `but` gone |
| `g06` | `before` | 2 | kept, **but a false negative**: `before` sits inside atom 1 only, so the ordering between the two atoms is still unstated |
| `g12`, `g17`, `g18` | `if`, `when`, `during` | 1–2 | kept, and structurally honest: the marker scopes the fact it stays inside |
| `g04` | (none) | 3 | **the good case** — "Online communities **help me learn** new techniques" is a relation, expressed as a fact |

`g06` is worth keeping in the table. "The marker is still in the text" is the cheap metric and
it is wrong: a conjunction inside one atom says nothing about the other atom. The design's gate
(A1 in `DESIGN-KNOWLEDGE-MODEL.md`) is therefore stricter than this census — it demands the
marker land in a **licensed edge**, not merely in a string.

## 2. Two false positives the census found in itself

The first run counted **11** marked frames, not 9. The extra two were not relations:

- `g10`: "I've been tracking my social media analytics **for a while** now" — a duration.
- `g32`: "I was **wondering if** you could help me" — an embedded question.

Both are the same error class as the causal hallucination the design guards against, one level
down: a token that is a conjunction in one frame is something else in the next. The script
carries an eleven-entry `NOT_MARKERS` table for them, and the table is in the script rather than
in this document so that the reading and its exclusions cannot drift apart.

This is also why the gate in the design is stated as "no marker, no edge": a matcher that
tolerates ambiguity here will manufacture edges, and a manufactured edge is indistinguishable
from a hallucinated one once it is in the graph.

## 3. What this reading does **not** say

1. **It is 20 pairs.** One corpus, one prompt version, one model. It is a direction. The pairs
   are the same ones the reviewer judged, which is the point — the complaint and the number
   describe the same artifact — but 9 marked frames cannot support a percentage to one decimal
   place. Written as 5/9, not as 55.6%, when quoted.
2. **It does not say the atoms are wrong.** 14 of 20 frames carry no marker and lose nothing by
   being split. The defect is bounded to relational sentences.
3. **It does not measure downstream damage.** Whether a lost `so` costs a benchmark question is
   a separate reading, and the one that decides whether this work pays. It has not been run.
4. **`g32` may not be a defect at all.** The request was filtered because a card publishes
   claims, not requests (`claims.ts`). What is lost is the *context* of the remaining fact, not
   a fact. The design's answer to that is the frame in the delivered block, not an edge.

## 4. The gate's reading on the same twenty pairs

`node tools/knowledge-probe.mjs --html <review page>` runs the assembly gate
(`knowledge/unit.ts`) over the same atoms the reviewer saw, with no model in the loop.

```
pairs                       20
accepted as split (strict)  15 (75%)
unresolved markers          5
  g00: so   g05: but   g23: but   g30: then   g32: since
```

The gate refuses exactly the five pairs §1.1 lists as lost — with one difference worth recording.
`g23` loses `but` but keeps `when`, so §1.1 calls it **partial**; the gate also refuses it, because
its rule is per marker and not per frame. That is deliberate: a frame that keeps one of two relations
has lost one, and "mostly faithful" is not a state a publish gate can occupy.

`g06` passes, and the reason is the honest limit of the gate stated in the design: `before` sits inside
the first atom, so the marker is *scoped* to a fact and the gate accepts it — even though the ordering
between the two atoms is still unstated. The census (§1.1) records the same thing as a false negative.
**Both artefacts agree, and both are wrong in the same direction**, which is why the gate is a floor and
not a proof.

The five refusals are the size of the next prompt's job, not a reason to weaken the rule: 15 of 20
proposals are already faithful, and the five that are not are exactly the ones a person would have had
to repair by hand.
