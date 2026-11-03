/**
 * The width is read from the environment, and a width the pass cannot honour is refused.
 *
 * ## What each assertion is for
 *
 * Two failure modes are worth a test here and neither is "the number comes back":
 *
 * 1. **A width that silently becomes one.** Every dispatch before `§14.22` ran serially, so a
 *    parser that returned 1 for anything it did not understand would look correct on every
 *    historical call and would quietly serialize the runs that exist to escape the budget.
 * 2. **A width that is logged but not used.** `8 ` with a trailing space, `2.5`, `-1`: each
 *    either rounds, clamps or throws somewhere far from the log line that already printed the
 *    value. Refusing at the boundary is what keeps the log line and the pass describing the
 *    same thing -- the shape §13.38 and §13.114 both paid for.
 */
import { describe, expect, it } from 'vitest';
import { readWorkers } from '../worker-pool.js';

describe('readWorkers', () => {
  it('defaults to one when the variable is not set', () => {
    expect(readWorkers({})).toBe(1);
  });

  it('treats a blank value as unset', () => {
    // A workflow that passes an unset input through `env` arrives here as an empty string, and
    // reading that as zero would open no worker at all.
    expect(readWorkers({ CORTEX_MEMORY_WORKERS: '' })).toBe(1);
    expect(readWorkers({ CORTEX_MEMORY_WORKERS: '   ' })).toBe(1);
  });

  it('reads a width and tolerates surrounding whitespace', () => {
    expect(readWorkers({ CORTEX_MEMORY_WORKERS: '8' })).toBe(8);
    expect(readWorkers({ CORTEX_MEMORY_WORKERS: ' 8 ' })).toBe(8);
  });

  it('accepts the ceiling and the floor', () => {
    expect(readWorkers({ CORTEX_MEMORY_WORKERS: '1' })).toBe(1);
    // 64 is the ceiling: the widest pass this campaign has any evidence for, well above the
    // eight §14.22's arithmetic needs.
    expect(readWorkers({ CORTEX_MEMORY_WORKERS: '64' })).toBe(64);
  });

  it('refuses a width above the ceiling, naming the ceiling', () => {
    expect(() => readWorkers({ CORTEX_MEMORY_WORKERS: '65' })).toThrow(/\[1, 64\]/);
  });

  it('refuses a fractional width rather than rounding it', () => {
    // Rounding would make the run's log line describe a width the pass did not use.
    expect(() => readWorkers({ CORTEX_MEMORY_WORKERS: '2.5' })).toThrow(/2\.5/);
  });

  it('refuses zero, a negative width and a non-number', () => {
    for (const raw of ['0', '-1', 'eight', 'Infinity']) {
      expect(() => readWorkers({ CORTEX_MEMORY_WORKERS: raw })).toThrow(/CORTEX_MEMORY_WORKERS/);
    }
  });

  it('names the variable and the default in its refusal', () => {
    // A refusal that does not say what would have worked sends the reader to the source, which
    // is where the value came from.
    let message = '';
    try {
      readWorkers({ CORTEX_MEMORY_WORKERS: '0' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('CORTEX_MEMORY_WORKERS');
    expect(message).toContain('unset');
    expect(message).toContain('one worker');
  });
});
