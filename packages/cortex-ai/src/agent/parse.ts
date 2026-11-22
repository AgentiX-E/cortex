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

/** The first balanced-looking JSON object in `raw`, or `undefined`. */
function objectSlice(raw: string): string | undefined {
  const start = raw.indexOf('{');
  if (start < 0) return undefined;
  const end = raw.lastIndexOf('}');
  if (end <= start) return undefined;
  return raw.slice(start, end + 1);
}

/**
 * One reply, as a decision.
 *
 * `reason` is carried on the `unparsed` branch rather than logged, because the trace is the only
 * place a dispatch's reader behaviour survives, and "eleven of these were `not-json`" is the
 * sentence that decides whether the next iteration changes the contract or the model.
 */
export function parseDecision(raw: string): Decision {
  const slice = objectSlice(raw);
  if (slice === undefined) return { action: 'unparsed', reason: 'not-json' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    // One retry with the two repairs that are unambiguous: a trailing comma before a closing
    // brace, and the typographic quotes a model produces when it has been trained on prose.
    try {
      parsed = JSON.parse(slice.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"'));
    } catch {
      return { action: 'unparsed', reason: 'not-json' };
    }
  }
  // No `typeof` guard here, and that is a measurement rather than an oversight: `objectSlice` only
  // returns text that starts with `{` and ends with `}`, so `JSON.parse` of it is an object or a
  // throw, and a `not-object` branch would be a branch no reply could reach. The campaign's rule for
  // an unreachable branch is to delete it, because a branch that no test can take is a branch whose
  // behaviour is a guess.
  const record = parsed as Record<string, unknown>;
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
