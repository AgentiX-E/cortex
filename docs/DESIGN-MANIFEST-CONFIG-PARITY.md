# The manifest must name the configuration that was actually built

**The defect this records.** The Mem0 competitor driver wrote the model name and the loopback proxy address into
the run's manifest, but built the client config without them: `config["llm"]["config"]` carried only an `api_key`.
Mem0's factories then substituted their own defaults, so a run that claimed to use `deepseek-reasoner` actually
called `deepseek-chat`, and a run that claimed to go through the metering proxy while configured with the
`openai` provider actually called the vendor endpoint. The manifest is the artifact a reader trusts when comparing
models; when it and the built config disagree, the comparison is not the one it says it is.

## 1. Why this is the same failure the last three iterations closed

The preceding iterations found the same shape in three other places: a zero-usage frame erasing a competitor's
bill, a variable-dimension cache key ignoring width, and a value carried to the report but not to the instrument
that produced it. In each case a number was **declared** in one place and **used** in another, and the two drifted
silently because nothing compared them. Here the number is the model identity itself.

`competitor-retrieval.yml:165` lets an operator set `sut_llm` to any model, exported as `SUT_LLM_MODEL`. The driver
read it into `llm_notes["model"]` — the manifest — but `config["llm"]["config"]` had no `model` key at all.
Mem0ai 2.x's `DeepSeekLLM` does `if not self.config.model: self.config.model = "deepseek-chat"`, so every
matched-model run against a non-default model was priced and scored against the default. The proxy's `by_model`
counter recorded the truth; the report printed the claim.

## 2. The concrete failures

1. **Model identity (high).** `SUT_LLM_MODEL=deepseek-reasoner` with `MEM0_LLM=deepseek` produced a manifest
   naming `deepseek-reasoner` while the proxy's `by_model` row read `deepseek-chat`. A reasoning-vs-weak-model
   comparison would have been scored on two weak-model arms.
2. **Proxy bypass for non-deepseek providers (medium).** The loopback base URL was injected only when
   `llm_provider == "deepseek"`. With `MEM0_LLM=openai` and a loopback `MEM0_LLM_BASE_URL`, the client still
   targeted the vendor endpoint, every question returned 401, and the manifest still claimed the proxy path.
3. **Workflow embedder names ignored (low).** The workflow exports `ZHIPU_EMBED_MODEL` and
   `ZHIPU_EMBED_DIMENSIONS`; the driver read only `ZHIPU_EMBEDDING_MODEL`/`EMBEDDING_DIMENSIONS`. Both defaults
   happened to match (`embedding-3`/`1024`), so a workflow input changing either was silently ignored, and Mem0
   could embed into a space the reader was not reading.

The reason nothing caught these: the test stand-in `Memory` ignores its config entirely. A test could assert the
manifest and pass while the config the manifest described was never built.

## 3. The fix

- `llm_model` is resolved once and written to both `config["llm"]["config"]["model"]` and `llm_notes["model"]`.
  One variable, two sinks, no second place to drift.
- The loopback base URL is injected under the field the selected provider reads — `deepseek_base_url` for
  `deepseek`, `openai_base_url` otherwise — and the manifest's `base_url` is the same resolved value.
- The embedder reads the names the workflow sets first (`ZHIPU_EMBED_MODEL`, `ZHIPU_EMBED_DIMENSIONS`), keeps the
  older names as fallbacks, and lets driver-specific `MEM0_*` names win over both. Manifest fields and config
  fields continue to come from one resolved `model`/`dimensions`.

## 4. Test method and acceptance

A new `TestManifestNamesTheConfigThatWasBuilt` class was written first and shown red against the old driver: the
declared-model case failed because `config["llm"]["config"]` had no `model`; the base-URL case failed because an
`openai` arm had no `openai_base_url`; the embedder case failed with `assert 'embedding-3' == 'custom-embed-v9'`.
After the fix all three pass, and the full competitor-SUT suite is green (26 passed, 1 skipped — the skip needs
the vendor package). The regression test for proxied credentials still passes: adding `model` to the config does
not change the credential rule that run `45015350567` established.

The whole `pnpm check` and `pnpm test:tools` chain is re-run before submission. No benchmark was dispatched, so
this iteration spent ¥0 in API calls; the value is that a future matched-model dispatch names the model and
provider path it actually used.

## 5. What remains

The MemCog driver's `_openai_compatible_call` retries `json.JSONDecodeError` three times. A reply that was charged
by the proxy but that failed to parse would be sent again, double-counting one logical call. This is a different
failure class from manifest parity and needs a stub-driven test that can simulate "charged then unparseable"
before it is changed; it is recorded for the next iteration rather than bundled here untested. The three mechanism
leads (per-question routing, extractive memory, multi-step ReAct) and Cortex's 93.40% position are unchanged.
