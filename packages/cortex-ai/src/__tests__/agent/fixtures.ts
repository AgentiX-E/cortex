/**
 * The two collaborations the loop has, written out as objects rather than mocked.
 *
 * ## Why these are implementations and not mocks
 *
 * `LLM` and `Retrieval` are interfaces this package declares the meaning of but not the
 * implementation. A mock library would replace them with a recorder that answers whatever the test
 * scripted and cannot be wrong; these are real objects with real behaviour -- `ScriptedLlm`
 * genuinely fails when its script runs out, and `scriptedRetrieval` genuinely truncates at `k` --
 * so a test that passes is a statement about the loop's use of the contract rather than about the
 * recorder agreeing with itself. The campaign's rule is the same one `cortex-memory`'s suite
 * follows: no `vi.mock`, no module interception, only objects.
 *
 * ## Why `completeStructured` throws
 *
 * It is a tripwire, not a stub. The loop's cost argument depends on the deciding call being one
 * `complete` whose prompt this package wrote; `completeStructured` prepends the schema to the
 * prompt inside the adapter, which would make `AgentTrace.promptChars` describe a prompt the
 * provider never received. If a later change reaches for it, this throws with the reason instead of
 * quietly inflating the bill.
 */
import type { CompleteOptions, JsonSchema, LLM } from '@agentix-e/cortex-core';

import type { Retrieval } from '../../agent/types.js';

/** One LLM whose every reply is scripted, and which records what it was asked. */
export class ScriptedLlm implements LLM {
  /** The exact prompts issued, in order. */
  readonly prompts: string[] = [];
  /** The options of each call, so a test can assert the cost controls were actually sent. */
  readonly options: (CompleteOptions | undefined)[] = [];
  readonly #replies: (string | Error)[];

  constructor(replies: readonly (string | Error)[]) {
    this.#replies = [...replies];
  }

  complete(prompt: string, opts?: CompleteOptions): Promise<string> {
    this.prompts.push(prompt);
    this.options.push(opts);
    const next = this.#replies.shift();
    // Refused rather than answered with a default: a loop that asks one more time than the test
    // expected must fail the test, or the budget assertions stop meaning anything.
    if (next === undefined)
      return Promise.reject(new Error('ScriptedLlm: no reply left in the script'));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  }

  completeStructured<T>(_prompt: string, _schema: JsonSchema, _opts?: CompleteOptions): Promise<T> {
    throw new Error(
      'cortex-agent must decide with one `complete` call: `completeStructured` appends the schema to ' +
        'the prompt inside the adapter, so AgentTrace.promptChars would no longer be the size of what ' +
        'the provider was sent',
    );
  }
}

/**
 * An LLM that fails the way a misbehaving transport does: by rejecting with something that is not an
 * `Error`.
 *
 * A `fetch` wrapper, a proxy and an abort library all do this, and the loop's note construction has
 * to survive it -- a `error.message` read on a string is `undefined`, and the trace would then carry
 * `llm: undefined` for every failure of that kind.
 */
export class FailingLlm implements LLM {
  readonly #reason: string;

  constructor(reason: string) {
    this.#reason = reason;
  }

  complete(): Promise<string> {
    return Promise.reject(this.#reason);
  }

  completeStructured<T>(): Promise<T> {
    return Promise.reject(new Error('cortex-agent never calls completeStructured'));
  }
}

/** What a scripted retrieval exposes beyond the interface: the queries it was actually given. */
export type ScriptedRetrieval = Retrieval & { readonly searches: readonly string[] };

/**
 * A retrieval that answers each query from a table.
 *
 * The seed query is the question, so a test names it like any other. A query with no entry returns
 * nothing, which is the honest reading of "this corpus has no turn for those words" and is the
 * state `no-new-evidence` exists to stop on.
 */
export function scriptedRetrieval(
  turns: readonly string[],
  answers: Readonly<Record<string, readonly number[]>>,
  options: { readonly sessionOf?: readonly number[] } = {},
): ScriptedRetrieval {
  const searches: string[] = [];
  const sessionOf = options.sessionOf;
  return {
    turns: turns.length,
    search(query: string, k: number): Promise<readonly { turn: number; score: number }[]> {
      searches.push(query);
      const ids = answers[query] ?? [];
      // Truncated here rather than in the loop, because `k` is the caller's bound on the tool and a
      // test that enforced it in the loop would prove the loop honours a number it never uses.
      return Promise.resolve(ids.slice(0, k).map((turn) => ({ turn, score: 1 })));
    },
    read(turn: number): string | undefined {
      return turn >= 0 && turn < turns.length ? turns[turn] : undefined;
    },
    session(turn: number): readonly number[] {
      if (turn < 0 || turn >= turns.length) return [];
      if (sessionOf === undefined) return [turn];
      const key = sessionOf[turn];
      if (key === undefined) return [turn];
      return sessionOf.flatMap((candidate, id) => (candidate === key ? [id] : []));
    },
    searches,
  };
}
