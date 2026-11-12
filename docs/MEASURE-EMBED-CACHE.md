# The competitor axis was paying four times for one haystack

The T1 table costs what it costs because of ingest, not because of reading. Run `43170314351` measured it
exactly: **49m42s** in the system-under-test step and **54s** in the reading step that follows, a ratio of
**55×**, on twenty questions. Three structural facts make that inevitable, and only one of them is about the
competitor:

1. `PROTOCOL.md` requires one user per question (`reset` + `ingest`), so a twenty-question smoke test is
   twenty ingests rather than one;
2. `mem0` calls its embedder once per turn text;
3. the LongMemEval-S haystack **reuses sessions across questions** in large blocks — the first twenty
   questions in the round-robin subset share most of their corpus.

So the same text is embedded dozens of times and paid for dozens of times, and the campaign's own memory arm
is not exposed to it: `cortexMemoryArmEmbeddingCachePath` already exists on the product side.

Worse, one dispatch ingests **four** times: the system-under-test step, and then three reading prompts, each a
separate process that builds its own store. Against a cold cache, three of the four re-embed the same
haystack for nothing.

## 1. The mechanism

`tools/competitor-sut/embed_cache_proxy.py` is an OpenAI-compatible `/embeddings` endpoint that sits between
the competitor and the real one. It is reached through the `openai_base_url` the driver already passes to
Mem0's own OpenAI client, so **no line of the competitor's code changes** — it batches, parses and stores
exactly as before, and only the host it talks to differs.

| property | value |
| --- | --- |
| key | `sha256(model + "\0" + text)` — the model, the whole text, no normalisation, no truncation |
| store | SQLite, one table, `INSERT OR REPLACE`, so a warm file is reusable across dispatches |
| miss handling | the whole miss set in **one** upstream batch, reassembled by index in the request |
| counters | `embedderCalls`, `cacheHits`, `served`, `reuseRate`, `stored`, `path` |
| switch | `MEM0_EMBEDDER=openai-cached`; `openai` is the same driver with no proxy (the control) |

The vectors are not approximated. Same text and same model is the same vector — a functional fact about the
endpoint, not a similarity claim — and the cache stores the endpoint's own JSON and hands it back unchanged.
That is why the criterion below can be about answer identity rather than about accuracy.

## 2. What was tested, and how

`tools/__tests__/test_embed_cache_proxy.py` — 18 assertions, all against a **local upstream server** rather
than a mock, because the failure this is guarding is at the wire:

| criterion (`03` §14.130) | assertion |
| --- | --- |
| 1 — the key is the whole request | one changed character, one changed space, one changed case and one changed model are four different keys; `("a","bc")` ≠ `("ab","c")`; the composition is pinned to a `sha256` |
| 2 — a hit is the vector the endpoint returned | round-trip compared by `repr`, so `-0.0` ≠ `0.0`; a hit sends **no** upstream request; a mixed batch sends only the misses, in one call, and returns all three vectors |
| 2b — the misses come back in the order they were asked | a batch `[a, b, c]` with `b` warm must return `b`'s original vector at index 1 and distinct vectors for `a` and `c` |
| 4 — the cache says what it did | hits and upstream calls counted separately; `reuseRate` is `null` rather than `0.0` on an empty cache |
| 5 — the model travels with the vector | a second model misses; the store survives a restart; a warm second run over the same corpus makes **zero** upstream calls |

`tools/__tests__/test_embed_cache_wiring.py` — 10 assertions on the workflow, because the wiring is where this
repository keeps losing. It derives the *ingesting* steps from the workflow the same way
`test_sut_read_wiring.py` derives the reading stages, so a fourth prompt is covered the moment it exists, and
it asserts the ordering that `sqlite3.connect` requires: **`sqlite3.connect` does not create parent
directories**, so a create step after the first ingest produces `unable to open database file` several minutes
in, reported as an embedder failure.

`test_embed_cache_proxy.py` also runs the real driver end to end (`mem0ai==2.2.1` + `faiss-cpu`, both present
on the Runner): two sessions, three turn texts of which two are the same sentence, then `served == 3`,
`stored == 2`, `cacheHits == 1` — **one round trip saved out of three, exactly as counted**. The manifest
carries `embedCache` read at the end rather than at construction, because counters collected before the work
would describe a cache that did nothing.

Both files were verified the other way round: removing `MEM0_EMBEDDER` from the job environment turns two
assertions red, and moving the create step after the reads turns the ordering assertion red.

## 3. Why this is not a handicap for the competitor

The objection the design has to answer is that a cache handed to a competitor makes its row cheaper than it
would be, and therefore not comparable. It does not, and the reason is narrow:

* the vectors are **byte-identical**, so the system under test sees the same input it would have seen;
* nothing about the competitor's code path changes — it still batches, still parses, still stores;
* what disappears is a network round trip and its bill, on a text that has already been embedded.

What the run reports is the *cost the system's design would incur without the repetition*, which is the
quantity a comparison is about. The criterion that enforces this is `03` §14.130's third:

> with and without the cache, the **reader's answers must be identical question by question** — not the same
> accuracy, the same text.

That needs two dispatches and it is the reading this round sets up rather than takes.

## 4. What it is expected to buy, stated as a measurement rather than a hope

The reuse rate is unknown before the first instrumented run, and the registration says so: if it is below 2×,
the increment closes and the queue keeps its cost. The population makes a high rate likely — twenty questions
drawn round-robin share most of a haystack — but "likely" is not a number, and the number is what the next
dispatch prints.

The upper bound is worth stating because it is the reason the increment is sequenced ahead of rows three to
six of the queue: if the reuse rate is *r*, the ingest wall clock of an n-question run falls from `n · c` to
`n · c · (1 − r)`, and at the four-ingests-per-dispatch shape above it falls again by `4×` on the three
reading prompts. A 100-question decision run that currently needs ≈4h10m is minutes at `r = 0.9`.
