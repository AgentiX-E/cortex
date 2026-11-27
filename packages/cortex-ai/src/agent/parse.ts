/**
 * Reading the reader.
 *
 * ## Why this is tolerant where the rest of the repository is strict
 *
 * Everything else in this campaign parses a shape it also produced: an artifact this repository
 * wrote, a census this repository built. This parses a **model's** reply, and the population of
 * ways to reply with the right decision is large. Measured across the dispatching runs: a fenced
 * block, one sentence of preamble before the object, a trailing comma, and -- from a thinking model
 * that ran out of `max_tokens` mid-object -- a truncated one.
 *
 * The policy is therefore: recover what is unambiguous, and record what is not. Never throw. A run
 * that loses one question to an unreadable reply is a reading; a run that loses the dispatch is a
 * morning.
 *
 * ## Why an unknown action is `unparsed` rather than `answer`
 *
 * Because "the model said something this loop does not understand" and "the model said it has
 * enough evidence" are different facts about different problems, and the second one is a stop while
 * the first one is a contract failure that should show up in the artifact's counts. Defaulting to
 * `answer` would make a broken contract look like a working mechanism with a short budget.
 */
import type { Decision } from './types.js';

/**
 * Every brace-balanced top-level object in `raw`, in order.
 *
 * ## Why this is a scan and not `indexOf('{') .. lastIndexOf('}')`
 *
 * That slice was the first version, and it was wrong on a reply that carries more than one object:
 * a thinking model restates the three example shapes while it reasons and then emits its decision,
 * and a model that adds a remark after its decision can put another object in the remark. From the
 * first `{` to the last `}` is then not an object at all -- it is two objects and the prose between
 * them -- so `JSON.parse` fails and a decision the reader actually made is recorded as `not-json`.
 * One lost question per such reply, with a reason that blames the JSON.
 *
 * The scan counts depth and tracks double-quoted strings, so a `}` inside a query value is not a
 * boundary and a nested object does not end the outer one early. Escapes inside strings are
 * honoured for the same reason. Curly quotes need no state here: they carry no braces, and the
 * repair below converts them after the slice is cut.
 */
function objectSlices(raw: string): string[] {
  const slices: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
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
        slices.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return slices;
}

/** One sliced object, as a record, or `undefined` when neither parse nor repair succeeded. */
function parseObject(slice: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(slice) as Record<string, unknown>;
  } catch {
    // The two repairs that are unambiguous: a trailing comma before a closing brace, and the
    // typographic quotes a model produces when it has been trained on prose.
    try {
      return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"')) as Record<
        string,
        unknown
      >;
    } catch {
      return undefined;
    }
  }
}

/**
 * One reply, as a decision.
 *
 * `reason` is carried on the `unparsed` branch rather than logged, because the trace is the only
 * place a dispatch's reader behaviour survives, and "eleven of these were `not-json`" is the
 * sentence that decides whether the next iteration changes the contract or the model.
 */
/**
 * Which object wins when a reply carries several.
 *
 * ## Why the last decision, and why non-decisions are skipped
 *
 * A reasoning model writes the three example shapes back while it deliberates and then emits its
 * conclusion, so among objects that carry a decision the **last** is the one it settled on. An
 * object with no recognised `action` is not a decision -- it is a remark, an example with a
 * placeholder, or a nested value -- and skipping it keeps a trailing aside from overriding the
 * verdict. If no object parses at all, that is the same `not-json` as a reply with no object; if
 * objects parse but none carries a recognised action, the last such object names the failure
 * (`unknown-action:…`), which is the diagnostic a contract change needs.
 *
 * No `typeof` guard on the parsed value, and that is a measurement rather than an oversight: every
 * slice starts with `{` and ends with `}`, so `JSON.parse` yields an object or throws, and a
 * `not-object` branch would be a branch no reply could reach. The campaign's rule for an
 * unreachable branch is to delete it, because a branch no test can take is a branch whose behaviour
 * is a guess.
 */
function decisionFromRecord(record: Record<string, unknown>): Decision {
  const action = record['action'];
  if (action === 'answer') return { action: 'answer' };
  if (action === 'search') {
    const query = record['query'];
    // A number or an object here is a model that filled the field with the wrong thing; the loop
    // treats it as an empty query rather than as prose, because a search with no words is a stop
    // and a stop is what the reader was asking for either way.
    if (typeof query !== 'string') return { action: 'search', query: '' };
    return { action: 'search', query: query.trim() };
  }
  if (action === 'session') {
    const turn = record['turn'];
    // `Number(...)` on a digit string: a model that quotes the id has still named the id, and
    // refusing it would penalise it for JSON that carries the same information.
    const id =
      typeof turn === 'number' ? turn : typeof turn === 'string' ? Number(turn) : Number.NaN;
    if (!Number.isInteger(id)) return { action: 'unparsed', reason: 'session-without-turn' };
    return { action: 'session', turn: id };
  }
  return { action: 'unparsed', reason: `unknown-action:${String(action)}` };
}

export function parseDecision(raw: string): Decision {
  let lastDecision: Decision | undefined;
  let lastUnknown: Decision | undefined;
  for (const slice of objectSlices(raw)) {
    const record = parseObject(slice);
    if (record === undefined) continue;
    const decision = decisionFromRecord(record);
    if (decision.action === 'unparsed') {
      lastUnknown = decision;
    } else {
      // A recognised action is a decision the reader actually made; a later one supersedes an
      // earlier restatement of the contract. Non-decisions never displace it.
      lastDecision = decision;
    }
  }
  return lastDecision ?? lastUnknown ?? { action: 'unparsed', reason: 'not-json' };
}
