/**
 * `turnIdFor`: a turn's identity is a function of the turn.
 *
 * ## Why identity is a property worth a suite of its own
 *
 * An id that is drawn at random is not wrong in isolation -- nothing looks a turn up by id. It becomes
 * wrong the moment identity is **rendered**, and this package renders it: the sourced evidence block
 * writes `${index}. [${turn.id}] ${content}`. From there a random id costs three separate things, all
 * of them measured in `docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md` §13.177:
 *
 *   - **Reproducibility.** Four passes of one question produced four prompts that agreed on 14 bytes.
 *   - **Cost.** A prefix cache cannot reuse anything past the first differing byte, so a run that
 *     should have shared three-quarters of its prompt tokens shared a tenth.
 *   - **Idempotence.** Re-admitting the same turn minted a second identity for one fact, which is the
 *     defect this project exists to find in other systems: two rows, one memory.
 *
 * The tests below are the four properties the fix has to have, and each one is a way the cheap
 * implementations fail: a counter (not stable across processes), a hash of content alone (merges
 * duplicates), `Math.random` (not a function), and a v4-shaped random string (not reproducible while
 * looking reproducible).
 */

import { describe, expect, it } from 'vitest';

import { admitTurns } from '../admission.js';

const NOW = 1_759_470_000_000;
const GATE = { now: NOW, threshold: 0 };

/**
 * The id a turn receives, read through the public surface.
 *
 * `turnIdFor` is not exported -- an export with one internal caller is the orphan the census refuses --
 * so every assertion below goes through `admitTurns`, which is also the only way to be sure the
 * derivation is actually *used* rather than merely correct.
 */
function idOf(content: string, ordinal: number): string {
  const turns = Array.from({ length: ordinal + 1 }, (_, index) =>
    index === ordinal ? content : `filler ${index}`,
  );
  return admitTurns(turns, GATE)[ordinal]!.id;
}

describe('a turn id is derived, not drawn', () => {
  it('is the same string every time the same turn is hashed', () => {
    const first = idOf('I moved to Lisbon in March.', 3);
    const second = idOf('I moved to Lisbon in March.', 3);
    expect(second).toBe(first);
  });

  it('separates two turns that differ only in position', () => {
    // A content-only hash would merge these. They are different evidence: the same sentence said twice
    // is two turns, and a store that collapses them loses the fact that it was said twice.
    expect(idOf('same words', 0)).not.toBe(idOf('same words', 1));
  });

  it('separates two turns that differ only in content', () => {
    expect(idOf('a', 0)).not.toBe(idOf('b', 0));
  });

  it('looks like a UUID but is not a v4 one', () => {
    // `crypto.randomUUID()` emits version 4. A reader who sees `-4` here would be right to suspect the
    // value is being drawn again somewhere; `-8` is the caller-defined version, which is what this is.
    const id = idOf('anything', 7);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id[14]).toBe('8');
  });

  it('does not collide across a realistic context', () => {
    const turns = Array.from(
      { length: 2_000 },
      (_, ordinal) => `[2023/05/20 (Sat) 03:51] user: turn ${ordinal} with filler text`,
    );
    const ids = new Set(admitTurns(turns, GATE).map((turn) => turn.id));
    expect(ids.size).toBe(2_000);
  });

  it('survives the boundary values a context can actually contain', () => {
    // Empty and one-character turns are real: a user sends a blank line, a tool returns "0".
    expect(idOf('', 0)).toMatch(/^[0-9a-f]{8}-/);
    expect(idOf('0', 0)).not.toBe(idOf('', 0));
    expect(idOf('\u0000', 0)).not.toBe(idOf('', 0));
  });
});

describe('admission uses it, so the identity a store sees is stable', () => {
  it('gives the same turns the same ids when a context is admitted twice', () => {
    const context = ['user: I moved to Lisbon.', 'assistant: Noted.', 'user: In March.'];
    const first = admitTurns(context, GATE).map((turn) => turn.id);
    const second = admitTurns(context, GATE).map((turn) => turn.id);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(3);
  });

  it('leaves everything else about an admitted turn a function of its inputs', () => {
    const [turn] = admitTurns(['user: hello'], GATE);
    expect(turn?.content).toBe('user: hello');
    expect(turn?.createdAt).toBe(NOW);
    expect(turn?.ordinal).toBe(0);
    // Deliberately not asserted as "random": the point of the fix is that no field is drawn.
    expect(turn?.id).toBe(admitTurns(['user: hello'], GATE)[0]!.id);
  });
});
