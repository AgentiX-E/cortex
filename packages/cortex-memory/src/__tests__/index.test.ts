/**
 * The package's public surface, asserted rather than assumed.
 *
 * Two jobs: make the barrel's re-exports count as covered (they are the API a
 * consumer sees), and fail loudly if a symbol is dropped during a refactor. The
 * design note behind every name here is in `docs/DESIGN-CORTEX-MEMORY.md`.
 */
import { describe, expect, it } from 'vitest';
import * as memory from '../index.js';

describe('cortex-memory package exports', () => {
  it('exposes the composition entry point', () => {
    expect(typeof memory.CortexMemory).toBe('function');
  });

  it('exposes the admission layer', () => {
    expect(typeof memory.admitTurns).toBe('function');
    expect(typeof memory.clockAwareValueFunction).toBe('function');
    expect(typeof memory.admissionOptionsFrom).toBe('function');
  });

  it('exposes the session layer', () => {
    expect(typeof memory.admitSessions).toBe('function');
    expect(typeof memory.selectSessionBudget).toBe('function');
  });

  it('exposes prompt construction', () => {
    expect(typeof memory.buildPrompt).toBe('function');
    expect(typeof memory.buildSessionPrompt).toBe('function');
    expect(typeof memory.formatEvidence).toBe('function');
    expect(typeof memory.truncateCodePointSafe).toBe('function');
    expect(memory.DEFAULT_MAX_PROMPT_CHARS).toBeGreaterThan(0);
  });

  it('exposes answer parsing and the shared abstention token', () => {
    expect(typeof memory.parseAnswer).toBe('function');
    expect(typeof memory.isAbstention).toBe('function');
    expect(typeof memory.ABSTAIN_TOKEN).toBe('string');
  });

  it('constructs a working system from the public surface alone', async () => {
    // The whole point of a barrel test: a consumer must be able to build the
    // system with nothing but these exports.
    const system = new memory.CortexMemory({
      now: 0,
      llm: {
        complete: async () => 'ok',
        completeStructured: async <T>() => JSON.parse('{}') as T,
      },
      gate: { threshold: 0, sessionBudget: 10 },
    });

    expect(system.name).toBe('cortex-memory');
    expect(await system.answer('Q?', ['turn'])).toBe('ok');
  });
});
