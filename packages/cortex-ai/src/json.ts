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

/**
 * Every brace-balanced top-level object in `text`, in order.
 *
 * ## Why not `indexOf('{') .. lastIndexOf('}')`
 *
 * That slice is not an object when a reply carries more than one: a reasoning model restates a
 * schema example while it thinks, then emits its answer. The prose and both objects between the
 * first brace and the last parse as nothing, so a structured call throws instead of reading the
 * answer. Depth and double-quote tracking keep a `}` inside a string value from ending an object.
 */
function jsonObjects(text: string): string[] {
  const slices: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        slices.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return slices;
}

/** Extract the structured object from a possibly-fenced LLM response. */
export function parseJson<T>(raw: string): T {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : trimmed;
  const objects = jsonObjects(candidate);
  if (objects.length === 0) {
    throw new Error(`LLM did not return a JSON object: ${raw.slice(0, 200)}`);
  }
  // The last parseable object wins: reasoning precedes the conclusion, so a trailing object is the
  // one the model settled on. An earlier example that still parses is superseded by it.
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(objects[i]!) as T;
    } catch {
      // An object that does not parse is an aside; keep looking backwards.
    }
  }
  throw new Error(`LLM did not return a JSON object: ${raw.slice(0, 200)}`);
}
