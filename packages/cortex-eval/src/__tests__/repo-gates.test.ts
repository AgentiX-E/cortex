/**
 * The repo's own gates are code, and untested gate scripts fail the way
 * untested code does: silently, on a checkout nobody ran.
 *
 * `pnpm check` is the command the CI job and the pre-push hook both call, so a
 * defect in it is a defect in every enforcement path at once. One existed and was
 * found by running the gate on a clean checkout rather than by reading it:
 *
 *   $ git worktree add /tmp/clean HEAD && cd /tmp/clean && pnpm install && pnpm check
 *   packages/cortex-storage typecheck: src/storage/pg.ts(12,8): error TS2307:
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
import { readdirSync, readFileSync } from 'node:fs';
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
   *   packages/cortex-storage build: error TS2307: Cannot find module
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
  const PACKAGES = ['cortex-core', 'cortex-storage', 'cortex-ai', 'cortex-eval'] as const;

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

/**
 * An arm variable the harness can read and no dispatch can set is an axis nobody can price.
 *
 * The defect this block exists for was measured. `45636994046` dispatched the ask axis through
 * `benchmark-cortex-memory.yml`, which wires `CORTEX_MEMORY_RESOLUTION` to a **repository setting** with a
 * `'raw'` fallback, because the workflow sits at 24 of GitHub's 25 dispatch inputs and this suite forbids the
 * ceiling. The run therefore rendered the control arm; the comparison against the archived arm charged the ask
 * with the rendering; and the table read `-4.96` points on `MR` for a change worth `+0.83`.
 *
 * The coupling, the fallback and the absence of an input were each visible in a file. Nothing compared them, and
 * the count is the finding: **twelve of the arm's twenty-nine variables cannot be moved by a dispatch payload**
 * -- ten ride repository settings and two ride a pairing -- so a dispatch that believes it moved one field is
 * also moving whatever nine settings happen to say. That is not a documentation gap; it is the mechanism by
 * which a run measures an arm it did not name.
 *
 * So the classification is derived from the workflows rather than written down here, and the table below has to
 * agree with it in both directions: an axis that cannot be named needs a written reason, and a row whose axis
 * becomes nameable is red until the row is deleted.
 */
describe('an arm variable is nameable from a dispatch or its gap is written down', () => {
  const WORKFLOWS = ['benchmark-cortex-memory.yml', 'semantic-carry.yml'];

  /** The variables `bench-memory-arm.ts` reads, from the source rather than from a copy of the list. */
  function armVariables(): string[] {
    const source = readFileSync(
      resolve(REPO_ROOT, 'packages/cortex-eval/src/bench-memory-arm.ts'),
      'utf8',
    );
    return [...source.matchAll(/const [A-Z_]+_VARIABLE = '(CORTEX_MEMORY_[A-Z_]+)';/g)].map(
      (match) => match[1] as string,
    );
  }

  /** Every `env:` line setting this variable, as `{ file, value }`, across the arm workflows. */
  function wiring(variable: string): { file: string; value: string }[] {
    const rows: { file: string; value: string }[] = [];
    for (const file of WORKFLOWS) {
      const text = readFileSync(resolve(REPO_ROOT, '.github/workflows', file), 'utf8');
      for (const line of text.split('\n')) {
        if (!new RegExp(`^\\s*${variable}:`).test(line)) continue;
        rows.push({ file, value: line.replace(new RegExp(`^\\s*${variable}:\\s*`), '').trim() });
      }
    }
    return rows;
  }

  /**
   * How each variable reaches the harness, read off the files.
   *
   * Five classes rather than two, because they are five different claims:
   *
   * - `input` — a dispatch payload carries it. The only class a new experiment can move freely.
   * - `setting` — a `vars.` lookup, i.e. a repository setting with a fallback baked into the workflow. Movable
   *   without a code change and **not movable by a dispatch**, so it cannot appear in a dispatch's record of what
   *   it changed.
   * - `pairing` — an expression over `inputs.pairing`, so the two sides of one paired dispatch differ. A real
   *   mechanism and still not a knob: it renders `layered` only *against* `raw`.
   * - `literal` — the same constant in every workflow, so the file decides it and no run has ever varied it.
   * - `unreachable` — none of the above, which is the state this test exists to refuse.
   */
  function classify(variable: string): { kind: string; where: string[] } {
    const rows = wiring(variable);
    if (rows.length === 0) return { kind: 'unreachable', where: [] };
    const free = rows.filter((row) =>
      /^\$\{\{\s*(?:github\.event\.inputs|inputs)\.[a-z0-9_]+\s*\}\}$/.test(row.value),
    );
    if (free.length > 0) return { kind: 'input', where: free.map((row) => row.file) };
    const setting = rows.filter((row) => row.value.includes('vars.CORTEX_MEMORY'));
    if (setting.length > 0) return { kind: 'setting', where: setting.map((row) => row.file) };
    const pairing = rows.filter((row) => row.value.includes('inputs.pairing'));
    if (pairing.length > 0) return { kind: 'pairing', where: pairing.map((row) => row.file) };
    return { kind: 'literal', where: rows.map((row) => row.file) };
  }

  it('finds the variables the harness reads', () => {
    // The regex is this block's only assumption about the source. A refactor to another declaration shape would
    // empty the set, and an empty set passes every assertion below.
    expect(armVariables().length).toBeGreaterThanOrEqual(25);
    expect(armVariables()).toContain('CORTEX_MEMORY_ASK');
    expect(armVariables()).toContain('CORTEX_MEMORY_RESOLUTION');
  });

  /**
   * The twelve axes a dispatch payload cannot move, each with the reason it cannot.
   *
   * Ten are the price of the input ceiling: the workflow keeps `vars.` lookups so the value is still settable
   * without editing YAML, which is the right trade and an incomplete record -- a run whose artifact says
   * `conflicts=false` is reporting a repository setting as if it were a decision. Two are pairing axes, which is
   * the design of `semantic-carry.yml` rather than a shortfall.
   */
  const HELD: Record<string, string> = {
    CORTEX_MEMORY_THRESHOLD: 'settings; the admission floor rides `vars.` with a `0` fallback',
    CORTEX_MEMORY_CONFIDENCE: 'settings; the value gate rides `vars.` with a `none` fallback',
    CORTEX_MEMORY_ORACLE: 'settings; oracle evidence rides `vars.` with a `0` fallback',
    CORTEX_MEMORY_REPLY_REPAIR: 'settings; the repair pass rides `vars.` with an `off` fallback',
    CORTEX_MEMORY_CONFLICTS:
      'settings; the KU conflict block rides `vars.` with no fallback at all',
    CORTEX_MEMORY_SUPERSEDED:
      'settings; the superseded rendering rides `vars.` with an `off` fallback',
    CORTEX_MEMORY_INDEX_EMBEDDING:
      'settings; the index embedding rides `vars.` with an `injected` fallback',
    CORTEX_MEMORY_LEXICAL_WEIGHTING:
      'settings; lexical weighting rides `vars.` with a `flat` fallback',
    CORTEX_MEMORY_SESSION_CLOCK:
      'settings and pairing; `vars.` in the A/B workflow, `pairing == clock` in carry',
    CORTEX_MEMORY_RESOLUTION:
      'settings and pairing; `vars.` with a `raw` fallback in the A/B workflow, `pairing == resolution` in ' +
      'carry -- and `raw` is the control rendering, which is how a dispatch came to measure an arm it did not name',
    CORTEX_MEMORY_SEMANTIC_CARRY: 'pairing; `pairing == carry` in the carry workflow',
    CORTEX_MEMORY_EVIDENCE_TURNS: 'literal; `256` in all four workflows that set it',
  };

  it('has a written reason for every axis a dispatch cannot name', () => {
    const held = armVariables()
      .filter((variable) => classify(variable).kind !== 'input')
      .sort();
    expect(held).toEqual(Object.keys(HELD).sort());
  });

  it('drops a row as soon as its axis becomes nameable', () => {
    // The other direction, and the one a table like this usually lacks: a stale exemption is a claim that a
    // capability does not exist, and it survives exactly as long as nobody re-reads it.
    const freed = armVariables().filter(
      (variable) => classify(variable).kind === 'input' && Object.hasOwn(HELD, variable),
    );
    expect(freed).toEqual([]);
  });

  it('passes an input the workflow actually declares', () => {
    // A passthrough naming an input the `on:` block does not declare renders as an empty string, which the
    // harness reads as "not named" -- i.e. the control, silently, which is the same failure one level up.
    const declared = (file: string): string[] => {
      const text = readFileSync(resolve(REPO_ROOT, '.github/workflows', file), 'utf8');
      const start = text.indexOf('\n    inputs:');
      if (start === -1) return [];
      return [...text.slice(start).matchAll(/\n {6}([a-z0-9_]+):\n/g)].map(
        (match) => match[1] as string,
      );
    };
    const missing: string[] = [];
    for (const file of WORKFLOWS) {
      for (const variable of armVariables()) {
        for (const row of wiring(variable).filter((entry) => entry.file === file)) {
          const match = /^\$\{\{\s*(?:github\.event\.inputs|inputs)\.([a-z0-9_]+)\s*\}\}$/.exec(
            row.value,
          );
          if (match === null) continue;
          if (!declared(file).includes(match[1] as string)) missing.push(`${file}:${variable}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  /**
   * The absence this block used to assert, and the sentence it promised to rewrite.
   *
   * It read: *"the workflow that can move the ask falls back to `raw`, the workflow that renders `layered`
   * hardcodes `CORTEX_MEMORY_ASK: verbatim-acts` on one line, so every ask reading in the register is a
   * reading of a configuration the product does not ship"* — asserted as an ABSENCE, with the note that
   * "when the input exists this test is red, and the sentence above has to be rewritten rather than left
   * standing". It went red, and this is the rewrite.
   *
   * The input did not come from the arm's workflow, which is at 24 of GitHub's 25 dispatch inputs. It came
   * from the **pairing** workflow, which was at 13 and whose `pairing` input is an enumerable axis
   * selector: adding `ask` to that enum costs no slot, and the shape it produces is the one the register
   * has been missing — one pass, one corpus, one instruction block between the two sides, both rendering
   * `layered`.
   *
   * Three facts make it true and all three are asserted: the ask is a dispatch value in that workflow, the
   * rendering branch puts `ask` on the layered side, and the declared default is the block the product
   * ships — so a bare `pairing=ask` dispatch prices **the shipped ask** against the reference block, which
   * is exactly the reading `13.291`'s adoption was never given.
   */
  it('prices an ask at the rendering that ships, in the pairing workflow', () => {
    const ask = wiring('CORTEX_MEMORY_ASK').filter((row) => row.file === 'semantic-carry.yml');
    expect(ask.map((row) => row.value)).toEqual(['${{ inputs.ask }}']);

    const resolution = wiring('CORTEX_MEMORY_RESOLUTION').filter(
      (row) => row.file === 'semantic-carry.yml',
    );
    // The branch is asserted by its two names rather than by equality with a whole expression: a workflow
    // that grew a third pairing on the layered side would still pass, and one that dropped `ask` from it
    // would not. The rendering is what the pairing is for, so the guard has to name it.
    expect(resolution).toHaveLength(1);
    expect(resolution[0]?.value).toContain("inputs.pairing == 'ask'");
    expect(resolution[0]?.value).toContain("'layered'");

    // The declared default, read off the `ask` input block rather than from anywhere in the file: a
    // `default: verbatim-acts` under another input would satisfy a whole-file search.
    const text = readFileSync(resolve(REPO_ROOT, '.github/workflows/semantic-carry.yml'), 'utf8');
    const block = /\n {6}ask:\n([\s\S]*?)(?=\n {6}[a-z_]+:\n)/.exec(text);
    expect(block).not.toBeNull();
    expect(block?.[1]).toContain('default: verbatim-acts');
    expect(block?.[1]).toContain('required: false');
  });
});

/**
 * A copy of a constant is a claim that it still agrees with the original.
 *
 * `tools/room-census.mjs` prints its rows in the product's route order, which means it holds a second copy
 * of `TURN_CAP_ROUTES`. That is the right trade -- the census is a diagnostic script and importing the
 * product to read six strings would make the tool depend on a build -- and it is only right while a gate
 * re-reads both. `assemble-rooms.test.ts` is the same shape one constant over: `REGISTERED_ROOMS` duplicates
 * the arm's recorded table and a gate compares them, because the alternative is a tool that reports a
 * route order the product no longer has, under a heading that claims it is the product's.
 *
 * Equality rather than set equality on purpose: the order is the whole claim being made. A route added to
 * the product and appended by this tool would pass a set comparison and print a table in an order no
 * product file states.
 */
describe('the room census prints the product route order', () => {
  it('lists TURN_CAP_ROUTES in the order the product declares them', () => {
    const types = readFileSync(resolve(REPO_ROOT, 'packages/cortex-memory/src/types.ts'), 'utf8');
    const declared = /export const TURN_CAP_ROUTES = \[([\s\S]*?)\] as const;/.exec(types);
    expect(declared).not.toBeNull();
    const productOrder = [...(declared?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map(
      (match) => match[1] as string,
    );
    // The regex is this gate's only assumption about the declaration. An emptied match passes every
    // assertion below, so the count is asserted first.
    expect(productOrder.length).toBe(6);
    expect(productOrder).toContain('multi-session');

    const tool = readFileSync(resolve(REPO_ROOT, 'tools/room-census.mjs'), 'utf8');
    const printed = /const ROUTES = \[([\s\S]*?)\];/.exec(tool);
    expect(printed).not.toBeNull();
    const toolOrder = [...(printed?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map(
      (match) => match[1] as string,
    );

    expect(toolOrder).toEqual(productOrder);
  });
});

/**
 * The failure census holds two copies of product vocabularies, and each one is a claim that it agrees.
 *
 * `tools/failure-classes.mjs` prints its rows in `TURN_CAP_ROUTES`' order and classifies a decline by
 * `parse.ts`'s abstain token. Both are copies rather than imports for `room-census.mjs`'s reason -- a
 * diagnostic script that imported the product would need a build -- and both fail in the same silent way:
 * a moved spelling makes `declined` never fire, so an entire cascade is reported as `empty`, and a moved
 * route order prints a table under a heading that claims it is the product's.
 */
describe('the failure census reads the vocabularies it copies', () => {
  const routeOrder = (text: string, pattern: RegExp): string[] => {
    const block = pattern.exec(text);
    expect(block).not.toBeNull();
    return [...(block?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map((match) => match[1] as string);
  };

  it('lists TURN_CAP_ROUTES in the order the product declares them', () => {
    const types = readFileSync(resolve(REPO_ROOT, 'packages/cortex-memory/src/types.ts'), 'utf8');
    const tool = readFileSync(resolve(REPO_ROOT, 'tools/failure-classes.mjs'), 'utf8');
    expect(routeOrder(tool, /const ROUTES = \[([\s\S]*?)\];/)).toEqual(
      routeOrder(types, /export const TURN_CAP_ROUTES = \[([\s\S]*?)\] as const;/),
    );
  });

  it('copies the abstain token from the parser rather than from memory', () => {
    const parse = readFileSync(resolve(REPO_ROOT, 'packages/cortex-memory/src/parse.ts'), 'utf8');
    const declared = /export const ABSTAIN_TOKEN = '([A-Z_]+)';/.exec(parse);
    expect(declared).not.toBeNull();
    const tool = readFileSync(resolve(REPO_ROOT, 'tools/failure-classes.mjs'), 'utf8');
    const copied = /const ABSTAIN_TOKEN = '([A-Z_]+)';/.exec(tool);
    expect(copied?.[1]).toBe(declared?.[1]);
  });
});

describe('a guard script cannot exist without running in the check chain', () => {
  /**
   * The three that are not gates, each with the reason rather than a preference.
   *
   * A `guard:` prefix is a claim that the script enforces something, and a script that enforces
   * something from nowhere is a rule nobody is held to. The failure this table is built for is the
   * ordinary one: a new check is written, added to `scripts`, run by hand once, and the chain is
   * never touched again -- which is how `census:check` came to depend on `build` without saying so
   * (the defect at the top of this file). Naming the exemption is therefore the price of an
   * exemption, and a stale entry is also a failure: an exemption for a script that no longer exists
   * is a permit nobody revoked.
   */
  const EXEMPT: Readonly<Record<string, string>> = {
    'guard:diagnose':
      'takes a target argument; it diagnoses one failure, it does not gate the tree',
    'guard:sh': 'reads a shell fragment on stdin; it is the helper the other gates call',
    'guard:shim': 'its pytest file is run by `test:tools`, which is in the chain',
  };

  it('wires every guard into check, or writes down why not', () => {
    const scripts = rootPackage().scripts;
    const check = scripts['check'];
    expect(check).toBeDefined();

    const unwired = Object.keys(scripts)
      .filter((name) => name.startsWith('guard:'))
      .filter((name) => !(check as string).includes(name));
    for (const name of unwired) {
      expect(
        EXEMPT[name],
        `${name} is a guard the check chain never runs and no exemption names`,
      ).toBeDefined();
    }
  });

  it('keeps no exemption for a guard that no longer exists', () => {
    const scripts = rootPackage().scripts;
    for (const name of Object.keys(EXEMPT)) {
      // A stale permit reads as coverage in every later review, which is worse than no table: the
      // reader counts four exemptions and the tree has three guards.
      expect(scripts[name], `EXEMPT names ${name}, which is not a script`).toBeDefined();
    }
  });

  it('runs the queue-floor instrument, because the floor it computes orders the queue', () => {
    // The specific member this table was extended for. `AUDIT-QUEUE-FLOOR.md` re-ranks every
    // remaining mechanism by the floor in this file; a floor that is not computed on every push is
    // a number in a document.
    expect(rootPackage().scripts['check']).toContain('pnpm guard:queue-floor');
  });
});

describe('a workflow cannot call a package script that does not exist', () => {
  /**
   * The failure this is built for is not hypothetical and it is not cheap.
   *
   * A dispatch is the only way to run a paid measurement, and it is the only environment where a
   * misspelled script name is discovered. `pnpm --filter <pkg> <script>` that names a script the
   * package does not declare fails **after** the checkout, the install and the 100 MB corpus
   * download, so the cost of the typo is a full dispatch and a reading that has to be re-run. The
   * repository has eighteen workflows and five packages; nothing else checks this seam, because a
   * workflow is not compiled and a `package.json` does not know who calls it.
   */
  it('resolves every `pnpm --filter <package> <script>` in every workflow', () => {
    const workflowDir = resolve(REPO_ROOT, '.github/workflows');
    const manifests = new Map<string, PackageJson>();
    for (const dir of readdirSync(resolve(REPO_ROOT, 'packages'))) {
      const manifest = JSON.parse(
        readFileSync(resolve(REPO_ROOT, 'packages', dir, 'package.json'), 'utf8'),
      ) as PackageJson & { readonly name?: string };
      if (manifest.name !== undefined) manifests.set(manifest.name, manifest);
    }

    const calls: string[] = [];
    for (const name of readdirSync(workflowDir).filter((entry) => entry.endsWith('.yml'))) {
      const body = readFileSync(resolve(workflowDir, name), 'utf8');
      for (const match of body.matchAll(/pnpm --filter (\S+) (\S+)/g)) {
        const pkg = match[1] as string;
        const script = match[2] as string;
        // `pnpm --filter ... --` is a turbo fan-out rather than a script call, and the `--` is the
        // argument separator; every other filtered call names a script this test has to resolve.
        if (script.startsWith('-')) continue;
        calls.push(`${name} → ${pkg} ${script}`);
        const manifest = manifests.get(pkg);
        expect(manifest, `${name} filters ${pkg}, which is not a workspace package`).toBeDefined();
        expect(
          manifest?.scripts[script],
          `${name} runs \`${pkg} ${script}\`, and no such script exists`,
        ).toBeDefined();
      }
    }
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('the specification ceiling is measured without a model, and says so in the file', () => {
  const body = readFileSync(
    resolve(REPO_ROOT, '.github/workflows/measure-spec-ceiling.yml'),
    'utf8',
  );

  it('carries no model credential, because the search executes plans and never consults a reader', () => {
    // A workflow that carries a key it never uses is a key that leaks the day someone copies the
    // file, and it is also a claim that the run costs money -- which would make a zero-cost
    // measurement look like something to avoid dispatching.
    //
    // Read as an *assignment to a secret*, not as the string: the file explains in prose why it has
    // no key, and a check that refused the word would forbid the sentence that documents the rule.
    const keyed = [...body.matchAll(/(DEEPSEEK_API_KEY|ZHIPU_API_KEY)\s*:\s*\$\{\{/g)].map(
      (match) => match[1],
    );
    expect(keyed).toEqual([]);
  });

  it('measures the registered population rather than the failing set of whatever report is at hand', () => {
    // `--artifact` would select the failures of the arm that ran last, and the twelve questions this
    // registration is written against are named in `docs/AUDIT-NUMERIC-MEMBERSHIP.md`, not derived
    // from a report. A run that silently fell back to the report would publish a ceiling over a
    // different population with the same name.
    expect(body).toContain('--population');
    expect(body).toContain('spec-ceiling-population.json');
  });

  it('searches both vocabularies, because the question vocabulary is the reading and the history one is the bound', () => {
    expect(body).toContain('--keywords "$MODE"');
    expect(body).toContain('for MODE in question history');
  });
});
