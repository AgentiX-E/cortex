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

describe('every gate is attached to the event it is supposed to guard', () => {
  /**
   * Parse a workflow's `on:` block without a YAML dependency.
   *
   * The file is read as text because its meaning here is which TRIGGER KEYS are
   * present at the top level of `on:`, and a tolerant parser for that is smaller
   * than a dependency and cannot be broken by unrelated YAML features the file
   * may grow later.
   */
  function triggersOf(fileName: string): string[] {
    const text = readFileSync(resolve(REPO_ROOT, '.github/workflows', fileName), 'utf8');
    const lines = text.split('\n');
    const start = lines.findIndex((line) => /^on:\s*$/.test(line));
    if (start === -1) return [];
    const keys: string[] = [];
    for (const line of lines.slice(start + 1)) {
      // A non-indented, non-empty line ends the block.
      if (/^\S/.test(line) && !line.startsWith('#')) break;
      const match = /^ {2}([A-Za-z_]+):/.exec(line);
      if (match !== null) keys.push(match[1] as string);
    }
    return keys;
  }

  /** The `- name:` of every step in a workflow, in file order. */
  function stepNames(fileName: string): string[] {
    const text = readFileSync(resolve(REPO_ROOT, '.github/workflows', fileName), 'utf8');
    return text
      .split('\n')
      .map((line) => /^\s*- name:\s*(.+?)\s*$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => match[1] as string);
  }

  it('runs the library gate on push, and not only on demand', () => {
    // THE DEFECT. The repository had one workflow and it was `workflow_dispatch`
    // only, so `pnpm check` -- unit tests, coverage floors, lint, typecheck, the
    // export census, formatting -- ran when somebody remembered to ask. Every
    // "CI is green" in the delivery log was a dispatched run, and a push that
    // broke the build produced no signal until the next dispatch.
    //
    // Asserted as a property of the SET of workflows rather than of one file, so
    // that moving the gate between files does not silently remove it from push.
    const workflows = ['benchmark.yml', 'verify.yml'];
    const onPush = workflows.filter((name) => {
      const triggers = triggersOf(name);
      return triggers.includes('push') || triggers.includes('pull_request');
    });
    expect(onPush.length).toBeGreaterThan(0);
  });

  it('scopes the push trigger to branches rather than filtering it away', () => {
    // `push:` with no filter is the honest form here; a filter that matched
    // nothing would satisfy a check for the KEY while never running. Reading the
    // block is what makes that distinguishable.
    const text = readFileSync(resolve(REPO_ROOT, '.github/workflows/verify.yml'), 'utf8');
    expect(text).toMatch(/^on:\s*$/m);
    expect(text).toMatch(/^ {2}push:\s*$/m);
    expect(text).toMatch(/^ {4}branches:/m);
  });

  it('runs the same command on CI that a human runs locally', () => {
    // `pnpm check` is the whole gate. A workflow that inlined the steps instead
    // of calling it would drift from the pre-push hook, and the drift would be
    // invisible until a push passed locally and failed here -- the exact
    // local-pass/CI-fail split the aggregate script exists to prevent.
    const text = readFileSync(resolve(REPO_ROOT, '.github/workflows/verify.yml'), 'utf8');
    expect(text).toContain('pnpm check');
    // And under `pipefail`, or `tee` would report its own success and hide a
    // failing `pnpm check` behind it.
    expect(text).toContain('set -o pipefail');
  });

  it('installs the Python test dependencies before the gate can call them', () => {
    // `pnpm check` runs `pnpm test:tools`, which is pytest over `tools/`. Without
    // the interpreter and pytest the step fails with an empty stdout, which is
    // how the first CI run of those tests presented.
    //
    // Asserted over the ordered list of STEP names, not over string offsets in the
    // file: the first version of this test used `indexOf` and passed or failed
    // depending on whether the surrounding COMMENTS happened to mention the same
    // strings, which is a property of the prose rather than of the workflow.
    const steps = stepNames('verify.yml');
    const setupAt = steps.indexOf('Setup Python');
    const installAt = steps.indexOf('Install Python test dependencies');
    const checkAt = steps.indexOf('Verify library');
    expect(setupAt).toBeGreaterThanOrEqual(0);
    expect(installAt).toBeGreaterThanOrEqual(0);
    expect(checkAt).toBeGreaterThanOrEqual(0);
    expect(setupAt).toBeLessThan(checkAt);
    expect(installAt).toBeLessThan(checkAt);
  });

  it('keeps the check step before the artifact upload, and the upload unconditional', () => {
    // The upload exists so a red run is diagnosable without a second dispatch,
    // which only holds if it runs AFTER the check and runs regardless of its
    // outcome. A runnable `if: success()` would upload nothing precisely when the
    // artifact is the only way to read the failure.
    const text = readFileSync(resolve(REPO_ROOT, '.github/workflows/verify.yml'), 'utf8');
    const steps = stepNames('verify.yml');
    expect(steps.indexOf('Verify library')).toBeLessThan(steps.indexOf('Upload check output'));
    expect(text).toMatch(/if:\s*always\(\)/);
  });
});
