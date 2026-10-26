# The embedding cache could not say which model wrote it

## 0. One paragraph

`deserializeEmbeddingCache` documented itself as throwing "on a corrupt or incompatible buffer so a
stale cache is never silently trusted". It checked `magic` and `version`. Neither carries the
identity of the embedding backend, so two vectors produced by two different models were
byte-indistinguishable to this reader whenever both were the same width — and the width is exactly
what the workflow configures. The documented property did not exist. The cache file now carries the
provenance that produced it (`provider`, `model`, `baseUrl`, `dimensions`), the reader compares all
four against the backend it is about to use, and a file from any other backend is refused whole.
Version-1 files are refused too, because a record with no origin cannot be trusted.

**This closes the last gap in a fix that was already specified.** `AUDIT-ZHIPU-429-ROOT-CAUSE.md` §7
lists five requirements and makes item 5 — *"record the embedding provenance … so two runs can be
compared without assuming"* — the one to do first, because "without it a green run and a red run are
not comparable". Items 1–4 landed and item 5 landed in the **report**; the **cache file** kept
travelling without one. The two halves were specified together and only one was built, which is why a
cache could be older than the model that read it and no counter would object.

## 1. Why this is a measurement defect and not a caching inconvenience

Both benchmark workflows restore the embedding cache from an Actions cache keyed on the **corpus**:

```
key: longmemeval-embedding-${{ hashFiles('data/longmemeval_s_cleaned.json') }}-${{ github.run_id }}
restore-keys: longmemeval-embedding-${{ hashFiles('data/longmemeval_s_cleaned.json') }}-
```

Nothing in that key names the model. So while the corpus does not change, a run inherits the previous
run's **haystack** vectors, and every query vector is embedded fresh. If the backend moved between
those two runs — a different model id, a different endpoint, the offline `hash` fallback, a
different normalisation behind the same name — the reader was grading fresh queries against vectors
from a different space, and it had no way to notice.

**Every counter in the artifact reads healthy in that state.** This is what makes it a measurement
defect rather than a cache bug:

| counter | why it cannot see it |
| --- | --- |
| `embedding.determinism max abs diff 0` | it embeds the same text twice **in one process** and compares. A model change is constant across both calls, so the difference stays 0 |
| `returnedDimensions 1024` | a foreign model at the same width passes |
| `cache restored N vectors` | N is a count of entries, not a claim about their origin |
| per-capability accuracy | moves, which is what one is trying to explain, not what identifies the cause |

## 2. The code that was there

```ts
const EMBEDDING_CACHE_VERSION = 1;
// header: magic(4) + version(1) + count(4) + dim(4)
```

and the reader validated the first two and then trusted the rest. The docstring above it — quoted in
§0 — is the defect in its purest form: **a comment asserting a safety property that no line
implemented**. This repository has a name for that class (`answerAbstention`'s docstring described a
gate that had no call site for a measured period, §13.10), and the countermeasure is the same: assert
the property, not the name.

## 3. The fix

### 3.1 Format, version 2

```
magic(4, BE) | version(1)=2 | provLen(4, LE) | provenance(JSON, utf8) | count(4, LE) | dim(4, LE) | payload
```

The provenance block is the literal `{provider, model, baseUrl, dimensions}` — `EmbeddingProvenance`,
the type `createEmbeddingWithProvenanceFromEnv` already returns and which the artifacts already
publish. Nothing new is invented; the field the reports were carrying is now also in the file.

### 3.2 Two checks, not one

- **Against the caller.** All four fields are compared with the backend the current run resolved. The
  error names both sides and lists **every** differing field, because a single-field comparison is
  the defect this replaces: `dimensions` alone would have let five of the six ways two backends can
  differ pass unnoticed.
- **Against the payload.** The width the payload declares is compared with the width the provenance
  declares. A header edited to match the caller's provenance must not make a differently-widthed
  payload readable.

The writer asserts the same invariant from its side, so a caller that tries to stamp vectors with
another backend's identity fails at the write with both numbers named, rather than one process later
as `Could not restore embedding cache`.

### 3.3 Version 1 is refused, not migrated

A version-1 file holds `magic, version, count, dim`. There is no evidence in it that would let a
reader decide whether its vectors belong to this run's model, and inventing a default ("assume it is
the one we are using") would reproduce the defect at the migration. Re-embedding is the recovery
path and the only honest one.

This costs a re-embed on the next dispatch of both workflows — see §5.

## 4. What pins it

`embedding-cache-provenance.test.ts`, 11 cases, written before the implementation (7 red):

| assertion | what it rules out |
| --- | --- |
| control: same provenance round-trips | a fix that broke the working path |
| different `model` id | the realistic case — a model rename at the same vendor |
| different `baseUrl` | the same model served from another endpoint |
| different `provider` at the same width | `hash` fallback vs HTTP, both configured to N |
| provenance declares a width its payload does not have | a header edited to match |
| error names both backends | a log line that cannot diagnose itself |
| version-1 buffer refused | inheriting an unattributable file |
| foreign magic still rejected first | the check order not regressing |
| `hash` provenance with null model and endpoint round-trips | a null-field comparison treated as a mismatch |
| empty cache round-trips under its provenance | the writer publishes empty files on purpose |
| a 500-character `baseUrl` round-trips | a header offset assumed to be constant (the old one was 13 bytes) |

`bench-memory-arm-cache.test.ts` adds two at the layer a run actually touches: a file written under
another model restores **0** and forces every turn back to the provider; the same holds when only
the endpoint differs at the same width and provider.

The precision assertion in the control case compares `Math.fround` on both sides. The format stores
float32 and the reader widens to float64, so the round trip is exact **in float32**; pinning the
decimal literals would assert a precision the format does not claim, and the first draft of that
test failed for exactly that reason.

## 5. Cost, stated before the next dispatch

The next run of either workflow will restore **0** vectors and re-embed the whole haystack. On the
reference pipeline that is ~115,000 turns; the diagnostic run `40378588466` reported
`cachedTexts 56,782` with `liveTexts 40`, because it was reading a cache written by an earlier run.

**This is a real cost, and the first version of this section sized its remedy to the wrong cause.**
It said the re-embed "interacts with a known quota problem", that Zhipu `embedding-3` "has been
returning `429` on a quota that is exhausted", and that the ways forward were a top-up or the offline
fallback. **Every clause of that is wrong, and `AUDIT-ZHIPU-429-ROOT-CAUSE.md` had already said so**:
`429` from this vendor carries error code `1305`, `模型当前访问量过大` — a **model concurrency cap**,
not a balance. "A funded account cannot be exhausted by definition of the error code" is that
document's §5, written about exactly this misreading, and the offline fallback is named there as a
remedy that *"would have masked all three defects"*.

The correct arithmetic, at the limits the audit tabulates:

| quantity | value |
| --- | --- |
| turns to embed | ~115,000 |
| entries per request (documented ceiling, which the adapter sits at) | 64 |
| requests | ~1,800 |
| cost of pacing the batch loop at 100 ms (`embedding_batch_interval_ms`) | ~3 minutes |

So there is no prerequisite and no obstacle: the run is ~1,800 paced requests, and the pacing input
already exists because requirement 3 of that audit implemented it. Setting it is a mitigation against
a **concurrency** cap, which is what the 429 ever was; the audit's own §11 records the measured state
after the three defects were fixed — both A/B arms at 169 calls, 169 attempts, **0 retries**,
`retryRate` 0.00%. Zero throttles, on a funded account, with no top-up.

What is **not** acceptable is to keep reading a cache whose origin is unknown in order to avoid the
bill. That is the trade this fix removes from the table — and it is the only thing this section was
ever entitled to say.

## 6. What it does and does not explain

**It does not explain the 81.0% → 44.2% gap.** That gap is two systems, not a drift
(`MEASURE-BASELINE-DRIFT.md` §8).

**It is a candidate for a different, unresolved observation**: the `benchmark.yml` arm's own reading
moved from **430/500 (86.0%)** on 2026-09 (`MEASURE-FAILURE-CENSUS.md` §2–3: IE 145/150, KU 59/72,
MR 106/121, TR 91/127, ABS 29/30) to **221/500** on 2026-10-26 (IE 1/150, KU 0/72, MR 104/121,
TR 86/127, ABS 30/30). The shape is specific: the two **single-session** capabilities collapsed and
the two **multi-session** ones barely moved.

Two mechanisms produce that shape, and they are not distinguished by any artifact that exists:

1. **A foreign vector space.** Single-session questions are served by embedding similarity alone;
   multi-session questions are also served by the lexical, turn-level and temporal channels added in
   September. A cache whose haystack vectors came from another model degrades exactly the channel
   that only the single-session questions depend on. This is the shape §1 predicts.
2. **Corpus or session-boundary change.** Also possible; the corpus is now hashed every run, which
   is what would settle it, and the hashes of the September runs were never recorded.

**This fix makes the first mechanism observable rather than silently survivable**, which is all a
cache change can do about it. The discriminating reading is the next dispatch's log line: a restore
of 0 vectors followed by accuracy that recovers towards 86% points at (1); a restore of 0 followed by
the same 44% points away from it, and the corpus hash comparison in §5 of the drift document becomes
the only remaining candidate.

**What is not claimed**: that the September reading and the October reading were the same
configuration. Nothing in the archive proves it — the September run predates `featureConfig` being
written into the artifact — so "the arm regressed by 42 points" is a hypothesis with a shape and
without a control, and it is recorded as such rather than as a finding.
