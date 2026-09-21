# AUDIT: the `hits[0].score` read sites behind measure B1

## 0. Why this audit exists before the measurement

The roadmap names this as B1's primary failure mode, in its own words:

> `rrf-retrieval-fusion-verdict.md` 记录 v1 被拒的根因是**同一字段被两处读取**……
> **重排同样会改排序，因此必须审计 `hits[0].score` 的所有读取点。**

The reranker is a stage whose only effect is to change the order of the retrieved hits.
The abstention decision is taken from the *score of whichever hit is first*. So a stage
that reorders and a signal that reads position 1 are coupled: turning reranking on can
change when the system declines to answer, without changing anything about how well it
answers. Measured once already: RRF v1 moved `hits[0]` and IE dropped from 95.0% to
87.5%, and the drop was attributed to the ranking change rather than to any retrieval
quality difference.

The audit below is therefore a precondition for reading the A/B, not a follow-up to it.

## 1. Complete read-site enumeration

`packages/cortex-eval/src/natural-language-memory.ts`:

| Line | Expression | Order-sensitive? | Consumer |
|---|---|---|---|
| 571 | `hits[0]?.score ?? 0` | **yes** | `respondWith(..., top1Score, ..., abstainThreshold)` — temporal path |
| 1009 | `hits[0]?.score ?? 0` | **yes** | `respondWith(..., top1Score, ..., sessionAbstainThreshold)` — aggregation path |
| 487 | `this.maxHitScore(hits)` | no | abstention confidence |
| 649 | `this.maxHitScore(hits)` | no | abstention confidence |
| 709 | `this.maxHitScore(hits)` | no | abstention confidence |
| 745 | `this.maxHitScore(hits)` | no | abstention confidence |
| 794 | `this.maxHitScore(hits)` | no | abstention confidence |

`maxHitScore` is defined at 1214-1222 and returns the maximum score over the hit list,
which is independent of the order those hits are in.

## 2. Finding

**Two of seven read sites are order-sensitive, and both feed an abstention threshold.**
The other five were already migrated to `maxHitScore` — that migration is what the
`maxHitScore` comment at 1210 describes — but `571` and `1009` were left reading position
1 directly.

This means the coupling is **not eliminated**; it is confined to two paths:

- **571** — the temporal (`eventLookup` / date-arithmetic) path, which is the TR capability.
- **1009** — the aggregation path, which is the MR capability.

The roadmap's pre-registration asks for MR **and** TR to move in the same direction. Those
are precisely the two capabilities whose abstention confidence is read from position 1. So
the confound is not adjacent to the acceptance criterion; it sits on top of it.

## 3. What this means for the verdict

The A/B cannot be read as accuracy-only. `runRerankAblation` therefore returns
`abstentionShift` — feature rate minus baseline rate — alongside the delta, and
`bench/run.ts` prints it immediately above the MR and TR lines:

```
Abstention shift: <x.xx> pp
MR: baseline a/b vs feature c/d (McNemar p=...)
TR: baseline e/f vs feature g/h (McNemar p=...)
```

The reading rule, stated before the numbers exist so that it cannot be chosen after them:

| Abstention shift | What the accuracy delta means |
|---|---|
| ≈ 0 | attributable to reranking's effect on which evidence is read |
| non-zero | **confounded** — the system changed when it declines, not only what it reads |

## 4. The available control

`rerankProtectedHead` pins the leading N hits so the reranker cannot move them. The two
paths above read `hits[0]`, so a protected head of ≥ 1 makes the abstention confidence
**invariant** under reranking, isolating the reordering effect on answer content. That is
what turns a confounded measurement into an attributable one, and it is why the option is
wired to `RERANK_PROTECTED_HEAD` in `bench/run.ts` rather than left library-internal.

Both configurations are legitimate and they answer different questions:

- **unprotected** — what happens if reranking ships as-is, abstention coupling included.
- **protected head ≥ 1** — how much of the change is reranking the evidence rather than
  moving the abstention boundary.

A verdict that reports one without the other is incomplete.

## 5. Secondary finding: the retry gap

`OpenAICompatibleReranker` was the only remote adapter not routing through
`retryableFetch`; `OpenAICompatibleLLM` (`llm/openai-compatible.ts:58`) and
`OpenAIEmbedding` (`embedding/openai.ts:41`) both did. The rerank path therefore had no
429/5xx backoff and no per-attempt deadline.

The consequence for this A/B specifically: a benchmark issues hundreds of rerank calls per
run, which is exactly the load that meets a rate limit, and without retry a single
throttled response throws and aborts the arm. Fixed in this change, with four tests
covering retry-on-429, retry-on-503, no-retry-on-400, and budget exhaustion.

## 6. Not changed

`571` and `1009` were **not** migrated to `maxHitScore`. Changing them changes the shipped
abstention behaviour, which is a separate experiment from B1 — bundling the two would make
the B1 verdict unattributable in exactly the way this document exists to prevent. They are
documented, exposed via the protected-head control, and left for their own measurement.
