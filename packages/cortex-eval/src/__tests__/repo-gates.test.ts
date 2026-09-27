/**
 * The repo's own gates are code, and untested gate scripts fail the way
 * untested code does: silently, on a checkout nobody ran.
 *
 * `pnpm check` is the command the CI job and the pre-push hook both call, so a
 * defect in it is a defect in every enforcement path at once. One existed and was
 * found by running the gate on a clean checkout rather than by reading it:
 *
 *   $ git worktree add /tmp/clean HEAD && cd /tmp/clean && pnpm install && pnpm check
 *   packages/cortex-node typecheck: src/storage/pg.ts(12,8): error TS2307:
 *     Cannot find module '@agentix-e/cortex-core' or its corresponding type
 *     declarations.
 *   => exit 2
 *
 * `typecheck` resolves `@agentix-e/cortex-core` through the workspace link, which
 * points at `dist/`. `test` does not need `dist/` (vitest runs the TypeScript
 * sources), and neither does `lint`, so on a fresh clone — where no `dist/`
 * exists — `typecheck` failed while the other steps would have passed. The gate
 * therefore rejected correct code until someone ran `pnpm build` by hand, which
 * is a prerequisite that appears in no script, no README and no error message.
 *
 * The chain has since grown a sixth step, `census:check`, which enforces that no
 * new exported symbol appears without a non-test caller. It reads the census
 * implementation from `dist/`, so it must follow `build`; that ordering is
 * asserted below.
 *
 * These tests assert the ORDER, which is the property that was wrong. Asserting
 * only that the string mentions each step would pass on the broken version.
 *
 * The `package.json` is read rather than imported: importing it would make the
 * test depend on the JSON module loader's semantics for a file whose meaning here
 * is its text.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../..');

type PackageJson = {
  readonly scripts: Record<string, string>;
  readonly engines?: { readonly node?: string };
  readonly packageManager?: string;
};

function rootPackage(): PackageJson {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as PackageJson;
}

/** The steps `check` runs, in order, as written. */
function checkSteps(): string[] {
  const check = rootPackage().scripts['check'];
  if (check === undefined) throw new Error('no `check` script');
  return check.split('&&').map((step) => step.trim());
}

describe('the aggregate gate is self-sufficient on a clean checkout', () => {
  it('builds before it typechecks', () => {
    // THE REGRESSION TEST. `typecheck` needs each workspace package's `dist/`,
    // and only `build` produces it. With `build` absent from the chain the gate
    // fails on every fresh clone, which is exactly when it is most needed.
    const steps = checkSteps();
    const buildAt = steps.indexOf('pnpm build');
    const typecheckAt = steps.indexOf('pnpm typecheck');
    expect(buildAt).toBeGreaterThanOrEqual(0);
    expect(typecheckAt).toBeGreaterThanOrEqual(0);
    expect(buildAt).toBeLessThan(typecheckAt);
  });

  it('runs every gate the repository documents, and runs them at all', () => {
    // A `check` that silently drops a step is the other way this breaks; the
    // README and CONTRIBUTING both name all five.
    const steps = checkSteps();
    for (const required of [
      'pnpm build',
      'pnpm lint',
      'pnpm typecheck',
      'pnpm census:check',
      'pnpm test',
      'pnpm format',
    ]) {
      expect(steps).toContain(required);
    }
  });

  it('runs the census after the build it depends on, and before the tests', () => {
    // `census:check` reads `packages/cortex-core/dist/export-census.js`, so it is
    // only meaningful after `build`. Its findings concern what the tests
    // exercise, so it belongs before them: a new orphan is worth knowing about
    // whether or not the suite is green.
    const steps = checkSteps();
    const buildAt = steps.indexOf('pnpm build');
    const censusAt = steps.indexOf('pnpm census:check');
    const testAt = steps.indexOf('pnpm test');
    expect(censusAt).toBeGreaterThan(buildAt);
    expect(censusAt).toBeLessThan(testAt);
  });

  it('runs the typecheck before the tests', () => {
    // Order is not cosmetic: `build` emits `.d.ts` files and `tsc` fails on
    // unresolved imports, so a type error is a faster and clearer signal than a
    // test failure that may be a downstream effect of the same missing artifact.
    const steps = checkSteps();
    expect(steps.indexOf('pnpm typecheck')).toBeLessThan(steps.indexOf('pnpm test'));
  });

  it('chains with && so no step is skipped after a failure', () => {
    // A `;`-separated chain reports the LAST command's status, so a failing lint
    // followed by a passing format exits 0 and the gate passes. The standing
    // instruction forbids this shape of shortcut, and this is the test that keeps
    // it out.
    const check = rootPackage().scripts['check'] ?? '';
    expect(check).not.toContain(';');
    expect(check).not.toContain('|| true');
    expect(check).not.toContain('continue-on-error');
    expect(check.split('&&').length).toBeGreaterThan(1);
  });

  it('pins the Node major the workflow installs', () => {
    // The workflow installs Node 22 and the engines field says >=22. If these
    // drift, CI can pass on a version the package declares unsupported.
    expect(rootPackage().engines?.node).toBe('>=22.0.0');
  });

  it('pins the package manager the workflow installs', () => {
    // `pnpm/action-setup` is given 9.15.0 explicitly, so the two must agree.
    expect(rootPackage().packageManager).toBe('pnpm@9.15.0');
  });
});

describe('every package clean removes the incremental build cache', () => {
  /**
   * A second defect found while verifying the first, and it is a real one:
   *
   *   $ rm -rf packages/<pkg>/dist      # delete only the output, keep the cache
   *   $ pnpm build
   *   packages/cortex-node build: error TS2307: Cannot find module
   *     '@agentix-e/cortex-core' ...   => exit 2
   *   $ ls packages/cortex-core/dist
   *   (still missing)
   *
   * TypeScript's incremental build reads `tsconfig.tsbuildinfo`, concludes the
   * output is already up to date, and **skips emitting**. So removing `dist/`
   * without removing the tsbuildinfo makes `build` fail AND leaves `dist/`
   * permanently absent — the next build cannot repair it either, because the
   * cache still claims the output exists. Only deleting the tsbuildinfo recovers.
   *
   * This is reachable in practice by a CI cache restoring `tsbuildinfo` without
   * `dist/`, and by any human who clears the output directory to force a rebuild.
   * `clean` is the command that exists to make this recoverable, so if `clean`
   * does not remove the tsbuildinfo it does not do its job.
   */
  const PACKAGES = ['cortex-core', 'cortex-node', 'cortex-llm', 'cortex-eval'] as const;

  function packageJson(name: string): PackageJson {
    return JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'packages', name, 'package.json'), 'utf8'),
    ) as PackageJson;
  }

  it.each(PACKAGES)('%s: clean removes dist AND the tsbuildinfo together', (name) => {
    const clean = packageJson(name).scripts['clean'];
    expect(clean).toBeDefined();
    // Both, and in one command: removing only `dist` is the failure mode above,
    // and removing only the tsbuildinfo would leave stale output to be typechecked.
    expect(clean).toContain('dist');
    expect(clean).toContain('tsbuildinfo');
  });

  it.each(PACKAGES)('%s: none of the build chain runs with a stale cache', (name) => {
    // The package must not ship a committed tsbuildinfo either, or a fresh clone
    // starts in exactly the broken state. Git-tracking is checked in the caller
    // below; here the package's own scripts must not work around it by keeping one.
    const json = packageJson(name) as unknown as Record<string, unknown>;
    expect(json['tsbuildinfo']).toBeUndefined();
  });

  it('ignores tsbuildinfo and dist so neither can be committed', () => {
    // A committed tsbuildinfo reproduces the skip-emit failure on every clone.
    const ignore = readFileSync(resolve(REPO_ROOT, '.gitignore'), 'utf8');
    expect(ignore).toContain('*.tsbuildinfo');
    expect(ignore).toContain('dist/');
  });
});
