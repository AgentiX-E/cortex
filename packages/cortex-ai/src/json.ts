/**
 * Reading a JSON object out of a model's reply.
 *
 * ## Why this is its own file rather than a function in the HTTP adapter
 *
 * `parseJson` lived in `llm/openai-compatible.ts` until step 14, and both offline entries imported
 * it from there: `./local` (whose promise is that inference makes no network request) and `./web`
 * (whose docstring says "the browser's built-in model and nothing else"). Importing one pure
 * function pulled in that module's `retryableFetch` import, so an offline bundle carried an HTTP
 * client it could never use -- and, worse, the entry guard could not state the property that
 * actually matters: *this entry does not contain a network client at all*.
 *
 * Nothing about that was visible at runtime. The measured count of requests during a local proposal
 * is zero (docs/04 section 9.17), because the client is never called; what was wrong was the
 * dependency, and a dependency is what a bundle is.
 *
 * So the function moved to the pure module both paths already need, and `tools/entry-guard.mjs` now
 * asserts that neither offline entry reaches `llm/openai-compatible.ts` or `retry.ts`. The lesson is
 * the one this repository keeps relearning in different clothes: a helper placed in a heavy file
 * makes every importer heavy, and nothing fails.
 */

/** Extract the first JSON object from a possibly-fenced LLM response. */
export function parseJson<T>(raw: string): T {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`LLM did not return a JSON object: ${raw.slice(0, 200)}`);
  }
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}
