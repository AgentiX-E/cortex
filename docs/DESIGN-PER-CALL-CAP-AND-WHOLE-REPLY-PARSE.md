# Per-Call Token Cap and Whole-Reply JSON Parsing

## Summary

Three defects shared one shape: a per-call or whole-reply instruction was silently restricted to a
narrower scope than the interface promised. Two were in reasoning-reply JSON parsing; one was in the
browser language-model adapter. All three were caught by a red test that encoded the written
contract before the fix, then turned green without weakening any existing assertion.

## 1. The platform adapter dropped the caller's `maxTokens`

`CompleteOptions` declares `maxTokens` as part of the LLM contract, and the second-look reader in
`cortex-memory` passes it explicitly (`{ maxTokens, temperature: 0 }`). `OpenAICompatibleLLM` honours
it by writing `max_tokens` into the request body. `PlatformLanguageModelAdapter` did not: in
`#acquire` it read only the construction-time `this.#options.maxOutputTokens`, so a call asking for a
smaller cap reused the existing session with its old budget. The session key included
`maxOutputTokens`, but that variable never reflected the call.

This contradicted the adapter's own module contract, which states that token limits are fixed per
session and that "the key is the resolved options, not the call count". It is also not academic:
run `45974552492` measured 242 second-look decisions cut before their first content token because a
thinking reader spent its budget on reasoning. A caller that asks for a smaller cap to stay inside a
cost ceiling was ignored on the one adapter that runs with no key and no network.

**Fix.** Resolve `maxOutputTokens` as `opts.maxTokens ?? this.#options.maxOutputTokens`, mirroring
how `temperature` already merged the per-call value. Because the session key already contains this
variable, a different cap now rebuilds the session and destroys the old one, exactly as a different
temperature does.

**Red-green evidence.** A new test asks for `maxTokens: 8` on the second call and asserts two sessions
were created and the second carried `maxOutputTokens: 8`. Before the fix: `expected 1 to be 2` — the
cap was swallowed and the session reused.

## 2. Fenced-first parsing discarded the settled answer

`parseJson` (in `cortex-ai`) and `readObject` (in `cortex-memory`) both promised a
"last parseable object wins" rule, with the explicit rationale that a reasoning model restates a
schema example while thinking, then emits its answer. The brace-balanced scanner honoured that — but
both callers first sliced the reply down to the **first** fenced block via a non-greedy regex, then
ran the scanner on that slice. A reply that fenced the example and stated the answer outside the
fence therefore returned the example the model had already superseded.

**Fix.** Scan the entire reply. Fences contain no braces, so a full scan is safe; the parse loop
already skips prose and objects that do not parse. This keeps the last-parseable-object rule
consistent across the whole reply instead of only the first fence.

**Red-green evidence.**
- `parseJson('```json\n{"facts":["example"]}\n```\nAnswer: {"facts":["real"]}')` returned
  `{facts: ['example']}`; expected `['real']` — `expected "real" to be "example"`.
- `parseEventSpec` on a fenced echo followed by an unfenced plan returned
  `{kind:'refused', reason:'empty-scope'}` (it read the example, which has no scope); expected a spec
  with `operation: 'count'`.

## Why these are not style changes

Each fix is pinned to a written contract: the `CompleteOptions` interface for `maxTokens`, and the
last-parseable-object comment for both parsers. The red tests encode those contracts with concrete
inputs, fail on the old code for the exact reason described, and pass after the fix. The platform
change is confined to the browser adapter; the parse changes remove a slice step without altering
the scanner or the selection rule. No behaviour that a green test relied on was relaxed.
