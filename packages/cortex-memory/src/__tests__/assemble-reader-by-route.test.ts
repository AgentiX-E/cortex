/**
 * The per-route reader map is reachable from the composition root, and it routes by route.
 *
 * ## Why this file exists
 *
 * `CortexMemoryOptions.readerByRoute` has existed since `§13.197` measured the reader axis as a per-route
 * effect, and `memory.ts#readerFor` has consumed it since that round. `assembleMemory` did not forward it,
 * so the published package -- which offers no other construction path -- could not express the one shape
 * that measurement asked for. The contract supported six readers; the composition root supported one.
 *
 * That defect is invisible from either side alone. A component test of `#readerFor` passes, because the
 * class accepts the map. A typecheck passes, because `AssembleOptions` simply did not name it. Only a test
 * that goes **through the function a customer calls** can tell the two apart, so every assertion here is
 * made on an assembled memory and every reader is a stub: no network, no credential, no spend.
 *
 * ## What is asserted, and why each one can fail
 *
 *   - a named route calls the reader it names (`temporal`, `multi-session`);
 *   - a route the map omits calls `llm`, so a one-entry map is a complete configuration;
 *   - the prompt is **byte-identical** under two different readers, because the reader is a field of the
 *     call and never of the block -- if changing the reader moved a byte, every per-route reading in
 *     `MEASURE-PROMPT-IDENTITY.md`'s sense would be comparing two prompts and calling it one reader.
 *
 * The last one is the assertion that survives a careless implementation: routing to the right stub is
 * cheap to get right and cheap to get wrong, but a prompt that carries the reader's identity would make
 * the map unusable for measurement while still passing the first three.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

import { assembleMemory } from '../assemble.js';
import type { CortexMemory } from '../memory.js';

const NOW = 1_759_470_000_000;

const FIRST = 'I have got 1250 followers on Instagram now, so insights would help.';
const SECOND = 'I think I am close to 1300 followers on Instagram now, honestly.';
const QUESTION = 'How many followers do I have on Instagram now?';

/** A reader that records every prompt it is handed and answers with its own name. */
function stub(name: string): LLM & { readonly seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    complete: async (prompt: string) => {
      seen.push(prompt);
      return name;
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function build(
  llm: LLM,
  readerByRoute?: Partial<
    Record<
      'abstention' | 'multi-session' | 'temporal' | 'knowledge-update' | 'assistant' | 'flat',
      LLM
    >
  >,
): CortexMemory {
  return assembleMemory({
    llm,
    now: NOW,
    storage: new SqliteStorage(),
    ...(readerByRoute === undefined ? {} : { readerByRoute }),
  }).memory;
}

describe('the per-route reader map, through the composition root', () => {
  it('sends a named route to the reader it names and leaves the rest on `llm`', async () => {
    const base = stub('base');
    const temporal = stub('temporal-reader');
    const memory = build(base, { temporal });

    await memory.answerTemporal(QUESTION, [FIRST, SECOND], '2023/06/01');

    expect(temporal.seen).toHaveLength(1);
    expect(base.seen).toHaveLength(0);
  });

  it('routes each named route independently, so one map can hold two readers', async () => {
    const base = stub('base');
    const temporal = stub('temporal-reader');
    const sessions = stub('session-reader');
    const memory = build(base, { temporal, 'multi-session': sessions });

    await memory.answerTemporal(QUESTION, [FIRST, SECOND], '2023/06/01');
    await memory.answerSessions(QUESTION, [[FIRST], [SECOND]]);

    expect(temporal.seen).toHaveLength(1);
    expect(sessions.seen).toHaveLength(1);
    expect(base.seen).toHaveLength(0);
  });

  it('falls back to `llm` on a route the map omits, so a one-entry map is complete', async () => {
    const base = stub('base');
    const temporal = stub('temporal-reader');
    const memory = build(base, { temporal });

    await memory.answer(QUESTION, [FIRST, SECOND]);

    expect(base.seen).toHaveLength(1);
    expect(temporal.seen).toHaveLength(0);
  });

  it('is the historical behaviour when the field is absent: every route uses `llm`', async () => {
    const base = stub('base');
    const memory = build(base);

    await memory.answerTemporal(QUESTION, [FIRST, SECOND], '2023/06/01');
    await memory.answer(QUESTION, [FIRST, SECOND]);

    expect(base.seen).toHaveLength(2);
  });

  it('changes no byte of the prompt: the same route, two readers, one prompt', async () => {
    const base = stub('base');
    const other = stub('other');
    const plain = stub('unused');

    const underBase = build(base, { temporal: base });
    const underOther = build(plain, { temporal: other });

    await underBase.answerTemporal(QUESTION, [FIRST, SECOND], '2023/06/01');
    await underOther.answerTemporal(QUESTION, [FIRST, SECOND], '2023/06/01');

    expect(base.seen[0]).toBe(other.seen[0]);
  });

  it("keeps the answer it was given, so the route reading is the named reader's", async () => {
    const base = stub('base');
    const temporal = stub('the named reader answered this');
    const memory = build(base, { temporal });

    const answer = await memory.answerTemporal(QUESTION, [FIRST, SECOND], '2023/06/01');

    expect(JSON.stringify(answer)).toContain('the named reader answered this');
  });
});
