/**
 * The two things every browser probe does the same way: collect named checks, and agree with what is
 * committed.
 *
 * ## Why this is a module and not a paragraph in each probe
 *
 * Three probes now commit a reading -- `two-tab-probe.mjs`, `quota-probe.mjs`, `incognito-probe.mjs` --
 * and each of them needs the same two behaviours: a check list whose verdicts print in one format, and a
 * comparison against a committed copy that fails on a *reordering* as well as on a flipped verdict.
 *
 * The comparison is the part worth sharing. Its rule is the reason any of these readings count as
 * evidence: a committed reading is only evidence if something re-derives it and says so, and "it passed
 * last time" is not a derivation. Three copies of that rule would agree on the day they were written and
 * drift on the first fix -- and the drift would be in the direction of passing, because the copy that
 * gets edited is the copy whose check just failed. So the rule lives once.
 *
 * What is *not* shared is what a probe asserts. `tools/browser-reading-check.mjs` compares the three arm
 * readings by tier and digest; this compares check lists. A comparator that handled both would be a
 * comparator with a switch in it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repository root, so a `--committed` path from a workflow resolves the same from any directory. */
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/**
 * A check list that prints as it goes and keeps its verdicts.
 *
 * Printing at the point of the check rather than at the end is deliberate: when a run dies in `finally`
 * -- a browser that will not close, a `disposeContext` that throws -- the log still names the last check
 * that ran, which is how the failing step is located without a debugger.
 */
export function collector() {
  const checks = [];
  return {
    checks,
    check(name, ok, detail) {
      checks.push({ name, ok: ok === true, detail });
      console.log(
        `${ok === true ? 'ok  ' : 'FAIL'} ${name}${ok === true ? '' : ` -- ${JSON.stringify(detail)}`}`,
      );
    },
    get passed() {
      return checks.filter((entry) => entry.ok).length;
    },
  };
}

/**
 * Whether a fresh run agrees with the committed reading, check by check and in order.
 *
 * Order is compared because these checks are a sequence -- a claim, a refusal, a release, a retry -- and a
 * reordering means the flow changed while every verdict stayed green. The name is compared because a check
 * that keeps its verdict and changes its subject is not the same reading.
 */
export function agreeWithCommitted({ checks, passed, resultsPath, fallback }) {
  const flag = process.argv.indexOf('--committed');
  const named = flag >= 0 ? process.argv[flag + 1] : undefined;
  const committedPath = named === undefined ? join(HERE, fallback) : resolve(REPO_ROOT, named);
  if (!existsSync(committedPath)) {
    console.error(`FAIL no committed reading at ${committedPath}`);
    return false;
  }
  const committed = JSON.parse(readFileSync(committedPath, 'utf8'));
  const before = committed.checks ?? [];
  const differences = [];
  if (before.length !== checks.length) differences.push(`${before.length} checks against ${checks.length}`);
  for (let index = 0; index < Math.min(before.length, checks.length); index += 1) {
    const one = before[index];
    const two = checks[index];
    if (one.name !== two.name) differences.push(`#${index + 1} is named "${one.name}", fresh "${two.name}"`);
    if (one.ok !== two.ok) differences.push(`#${index + 1} "${one.name}" was ${one.ok}, fresh ${two.ok}`);
  }
  if (differences.length > 0) {
    console.error(`FAIL ${resultsPath} disagrees with ${committedPath}:`);
    for (const difference of differences) console.error(`  ${difference}`);
    return false;
  }
  console.log(
    `ok ${resultsPath} agrees with ${committedPath}: ${checks.length} checks, identical in order and` +
      ` verdict (${passed}/${checks.length} green in both)`,
  );
  return true;
}
