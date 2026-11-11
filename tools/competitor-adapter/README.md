# Cortex inside the competitor's harness

Two files that let Maximem's LongMemEval harness read this repository's store instead of its own:

| file | what it is |
| --- | --- |
| `cortex_adapter.py` | their `Provider` ABC, implemented: `initialize` / `ingest` / `await_indexing` / `search` / `clear` |
| `bridge.mjs` | this repository's store behind `tools/competitor-sut/PROTOCOL.md`, in the direction that makes us the child |

`MEASURE-COMPETITOR-PAIRING.md` §5 licenses exactly one run through this: **same 500 questions, same answer
prompt, same judge, our retrieval**. Their answering prompt is 21,366 characters and this repository's contract
block is 229 to 580 (§6), so a run in which both sides brought their own reader would measure the prompt and the
system at once and the number would belong to neither.

## What the run can and cannot say

**Can:** how this arm scores when the reader and the judge are theirs. If the number lands near their published
one while this arm's own harness reads 91.20%, then the 4.40-point gap is the harness — a claim this campaign
has quoted twenty times without testing.

**Cannot:** be laid beside their published 95.60% as a like-for-like row. Their published arm is
`gemini-3.8-flash` answering and `gpt-4o` judging; a run from this sandbox has no OpenAI key and no Gemini key,
so both roles go to the reader this arm already pays for. **The comparison that is valid is within the run**:
their adapter and ours, same answer model, same judge, same corpus. Their adapter needs a hosted Synap instance
and an `instance_id`, so where that is unavailable the honest reading is narrower — *our score under their
pipeline*, quoted with the model substitution named in the same sentence, never as a SOTA claim.

## Recipe

Their tree is MIT and installs with a minimal requirements file:

```sh
git clone https://github.com/maximem-ai/memory_and_context_eval_harness
cd memory_and_context_eval_harness
pip install -r requirements-longmemeval.txt

# 1. The adapter and its bridge go inside their tree, because their loader imports `adapters.<module>`.
cp /path/to/cortex/tools/competitor-adapter/cortex_adapter.py adapters/
cp /path/to/cortex/tools/competitor-adapter/bridge.mjs adapters/cortex_bridge.mjs

# 2. Their registry needs the name once.
#    "cortex": "adapters.cortex_adapter.CortexProvider",   # in adapters/__init__.py PROVIDER_REGISTRY

# 3. Their LongMemEval runner instantiates Synap directly; point it at `CortexProvider` for this arm.
#    from adapters.cortex_adapter import CortexProvider
#    provider = CortexProvider()

# 4. The bridge imports this repository's build, from wherever it was copied to.
export CORTEX_ADAPTER_MEMORY=/path/to/cortex/packages/cortex-memory/dist/index.js
pnpm --dir /path/to/cortex build

# 5. A 20-question smoke before the full run: the adapter has to be shown to return hits before its score means
#    anything. `--max-questions` is theirs.
python -m benchmarks.longmemeval.run --max-questions 20 \
    --answer-model deepseek-chat --answer-api-base "$DEEPSEEK_BASE_URL" \
    --judge-model deepseek-chat  --judge-api-base  "$DEEPSEEK_BASE_URL"
```

## The refusals this adapter makes on purpose

- **No answer generation.** `search` returns admitted turns and stops. A store that answered inside `search`
  would be measured on its prompt as well as its retrieval, and the two would be inseparable.
- **`build: none` in the manifest.** The signal is term overlap; declaring `embedding` or `llm` would misreport
  the cost class, which is the one field a reader uses to decide whether two rows came from the same machine.
- **A hard top-k on the way out.** `limit` is their session count and this store's hits are turns — the unit
  error `provider.ts` records at 25.4% recall. The bridge enforces the ceiling on its own output.
- **One store per `clear`.** The provider accumulates and has no removal method, so `clear` replaces it. A store
  that kept its sessions would answer every question from every corpus it had seen, which scores well and
  measures nothing.
- **Turns carry `[<timestamp>] <role>: <text>`.** That prefix is this product's shipped corpus rendering, and
  every temporal question in the dataset resolves relative expressions against it. Sent bare, the store would be
  measured on a corpus it never sees.

## Verified

`bridge.mjs` answers all five ops over stdio against `packages/cortex-memory/dist`, and `cortex_adapter.py` runs
under their own `runner.types` (initialize → ingest → search → clear → close, `manifest` = `cortex-session`,
`build` = `none`, one session in, one hit out, zero after `clear`). What is **not** verified is a scored run:
that needs the full copy into their tree, `requirements-longmemeval.txt`, and a 20-question smoke first.
