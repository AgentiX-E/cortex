import { describe, expect, it } from 'vitest';

import { drawUnjudged } from '../a3-draw.js';

const rows = ['g00', 'g01', 'g02', 'g03', 'g04'].map((id) => ({ id }));

describe('drawUnjudged', () => {
  it('skips the judged ids and keeps corpus order', () => {
    const draw = drawUnjudged(rows, ['g01', 'g03']);
    expect(draw.rows.map((row) => row.id)).toEqual(['g00', 'g02', 'g04']);
    expect(draw.skipped).toBe(2);
  });

  it('returns every unjudged row, because the round limit counts cards and a row can fail to make one', () => {
    // The defect this pins: truncating the ROW list to the CARD limit hands back a short round
    // whenever a row is decided by the rules. Requesting twenty once produced eighteen pairs.
    const draw = drawUnjudged(rows, ['g00']);
    expect(draw.rows).toHaveLength(4);
  });

  it('throws rather than producing a page with no cards', () => {
    // The state that must not pass silently: every row judged, `prepare` exits 0, and the round
    // ships an empty page. Naming it here is cheaper than noticing an empty artifact later.
    expect(() =>
      drawUnjudged(
        rows,
        rows.map((row) => row.id),
      ),
    ).toThrow(/already judged/);
  });

  it('is unaffected by a ledger id the corpus does not contain', () => {
    // A stale id is not an error: a fixture can lose a row, and the ledger's job is to say what was
    // judged, not to police the corpus.
    const draw = drawUnjudged(rows, ['g99']);
    expect(draw.rows).toHaveLength(5);
    expect(draw.skipped).toBe(0);
  });
});
