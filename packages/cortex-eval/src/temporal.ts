/**
 * Calendar arithmetic for the temporal engine.
 *
 * This module is the **arithmetic half** of temporal reasoning, not the routing
 * half. Question-shape detection lives in `temporal-engine.ts`
 * (`classifyTemporalQuestion`), which imports `daysBetween` from here and is what
 * `natural-language-memory.ts` calls to select an answering path.
 *
 * ## Why this file is named `temporal` and holds one function
 *
 * It previously held three. `isTemporalQuestion` and `extractDate` were a coarser
 * classifier and its date reader, written before the engine existed; the engine
 * replaced both, and they stayed as a second, divergent answer to questions the
 * package had already answered. They were removed rather than deprecated, because
 * an exported alias keeps the divergent answer reachable and tested — see
 * `docs/AUDIT-UNREFERENCED-CLASSES.md` §3.
 *
 * `daysBetween` stayed because it was never superseded: the engine's date
 * arithmetic is built on it, so what was deleted is two functions and not a module.
 */

const MS_PER_DAY = 86_400_000;

/**
 * Signed whole days from date `a` to date `b` (both `YYYY/MM/DD`), computed in
 * UTC so daylight-saving transitions never shift the result. Positive when `b`
 * is later than `a`.
 */
export function daysBetween(a: string, b: string): number {
  const toUtcDays = (s: string): number => {
    const [y, m, d] = s.split('/').map(Number);
    if (y === undefined || m === undefined || d === undefined) {
      throw new Error(`invalid date "${s}", expected YYYY/MM/DD`);
    }
    return Date.UTC(y, m - 1, d) / MS_PER_DAY;
  };
  return toUtcDays(b) - toUtcDays(a);
}
