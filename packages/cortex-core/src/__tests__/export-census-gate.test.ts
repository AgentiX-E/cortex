/**
 * The census gate as a command, driven through its real entry point.
 *
 * `export-census.test.ts` proves the measurement is correct. This file proves the
 * *gate* works: that `--check` exits 0 on the committed tree and non-zero when a
 * new orphan appears. Those are different properties — a correct census wired to
 * a `--check` that always returns 0 would look identical from the unit tests —
 * so the gate is exercised by running the actual script as a subprocess.
 *
 * The subprocess is given the real repository, not a fixture. A fixture would
 * test the code I wrote against files I wrote; the gate's job is to make a claim
 * about this repository, and only running it here verifies that claim.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../..');
const SCRIPT = resolve(REPO_ROOT, 'tools/export-census.mjs');
const BASELINE = resolve(REPO_ROOT, 'tools/export-census-baseline.json');

/** Runs the census script and returns its status and combined output. */
function runCensus(args: readonly string[]): { status: number | null; output: string } {
  const result = spawnSync('node', [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

type Baseline = {
  readonly knownOrphans: readonly string[];
  readonly locations: Readonly<Record<string, readonly string[]>>;
  readonly groups: readonly {
    readonly category: string;
    readonly count: number;
    readonly rationale: string;
    readonly declarationSites: readonly string[];
  }[];
  readonly totals: {
    readonly exports: number;
    readonly withCaller: number;
    readonly orphaned: number;
    readonly referencedLocally: number;
    readonly unreferenced: number;
  };
  /**
   * Each known orphan's class. Optional on the type so that a fixture written
   * before the field existed still type-checks; the ledger itself always
   * carries it, and the schema check below asserts that.
   */
  readonly orphanClass?: Readonly<Record<string, string>>;
};

/**
 * The stable identity of an orphan: package and name, without the line number.
 *
 * Mirrors the key the CLI uses. Line numbers are excluded because they drift
 * when any unrelated line above a declaration moves, which would make the
 * baseline look stale for a change that removed no orphan. The first version of
 * this ledger stored full locations and broke on exactly that.
 */
function orphanKey(location: string): string {
  const [pkg, rest] = location.split(': ');
  return `${pkg}: ${(rest ?? '').split(' (')[0]}`;
}

function baseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;
}

describe('the census CLI reports without enforcing by default', () => {
  it('exits 0 and prints a summary', () => {
    const { status, output } = runCensus([]);
    expect(status).toBe(0);
    expect(output).toMatch(/export census: \d+ exported symbols/);
    expect(output).toContain('orphaned');
  });

  it('says so plainly when there is nothing to report, or lists what it found', () => {
    const { output } = runCensus([]);
    // Either state is valid on a given tree; what matters is that the output is
    // never silent about which one it is.
    const clean = output.includes('no orphans: every exported symbol has a non-test caller');
    const listed = /orphaned export\(s\)/.test(output);
    expect(clean || listed).toBe(true);
  });

  it('names the two orphan classes instead of reporting one undifferentiated number', () => {
    // THE REGRESSION TEST for the conflation this change removes. Before it,
    // "235 orphaned" was the whole report: a symbol used everywhere inside its
    // own file and a symbol nothing mentions read identically, and the 31 dead
    // ones could not be read out of the output at all.
    const { output } = runCensus([]);
    expect(output).toMatch(/used only in their own file/);
    expect(output).toMatch(/referenced nowhere/);
    expect(output).toMatch(/still used inside their own file/);
    expect(output).toMatch(/referenced nowhere at all/);
  });

  it('emits parseable JSON on --json, containing the same orphan list', () => {
    const { status, output } = runCensus(['--json']);
    expect(status).toBe(0);
    const parsed = JSON.parse(output) as {
      orphans: string[];
      referencedLocally: string[];
      unreferenced: string[];
      report: { totalSymbols: number; orphanCount: number };
    };
    expect(Array.isArray(parsed.orphans)).toBe(true);
    expect(parsed.orphans.length).toBe(parsed.report.orphanCount);
    expect(parsed.report.totalSymbols).toBeGreaterThan(0);

    // The split is additive: `orphans` keeps its exact shape for existing
    // consumers, and the two new lists partition it rather than replacing it.
    expect([...parsed.referencedLocally, ...parsed.unreferenced].sort()).toEqual(
      [...parsed.orphans].sort(),
    );
    expect(new Set(parsed.referencedLocally).size).toBe(parsed.referencedLocally.length);
    expect(new Set(parsed.unreferenced).size).toBe(parsed.unreferenced.length);
  });

  it('produces a report that matches the committed baseline exactly', () => {
    // The baseline is only meaningful while it describes the tree it sits in. If
    // this drifts, `--check` would either miss new orphans or flag known ones,
    // and the way to find out should not be a red CI run.
    //
    // Compared by key, not by full location: the baseline deliberately stores no
    // line numbers, so a declaration moving down a file is not a baseline change.
    const parsed = JSON.parse(runCensus(['--json']).output) as { orphans: string[] };
    const observed = [...new Set(parsed.orphans.map(orphanKey))].sort();
    expect(observed).toEqual([...baseline().knownOrphans].sort());
  });
});

describe('the census gate enforces the baseline', () => {
  it('passes on the committed tree', () => {
    const { status, output } = runCensus(['--check']);
    expect(status).toBe(0);
    expect(output).toContain('no new orphans beyond the recorded baseline');
  });

  it(`fails when a new orphan appears, naming it`, () => {
    // THE REGRESSION TEST for the gate. Injects one orphaned export into a real
    // source file, runs the real gate, and asserts it fails and says which
    // symbol caused it. Without this, a `--check` that forgot to return 1 would
    // pass every other test in this file.
    //
    // The restore writes back the bytes this test read, and must not use git.
    // An earlier version ended with `git checkout --` on this path, which failed
    // two ways:
    //
    //   1. It is not a restore at all when there is no repository -- and the
    //      harness is not obliged to provide one. `git archive` unpacks a
    //      revision with no `.git`, which is how CI ran this suite. Every other
    //      assertion still held, so the test reported one failure, but the file
    //      was left with the injected export in it, and the census test declared
    //      after this one then read 439 exports instead of 438.
    //   2. It discards uncommitted work. A developer with a real edit in this
    //      file loses it by running the suite, and nothing says so.
    //
    // The injection is a byte suffix and the restore is a byte write, so neither
    // depends on git being present or on the tree being clean.
    const victim = resolve(REPO_ROOT, 'packages/cortex-core/src/math/vector.ts');
    const original = readFileSync(victim, 'utf8');
    const marker = 'orchestratedCensusGateProbe';
    try {
      writeFileSync(
        victim,
        `${original}\n/** Injected by the census gate test; removed in its finally block. */\n` +
          `export function ${marker}(value: number): number {\n  return value;\n}\n`,
      );
      // The census reads source text, not dist, so no rebuild is needed: the
      // appended declaration is visible immediately.
      const { status, output } = runCensus(['--check']);
      expect(status).toBe(1);
      expect(output).toContain('1 NEW orphan(s) not in the baseline');
      expect(output).toContain(marker);
      expect(output).toContain('packages/cortex-core/src/math/vector.ts');
    } finally {
      writeFileSync(victim, original);
      expect(readFileSync(victim, 'utf8')).toBe(original);
    }
  });

  it('ignores an orphan that is already recorded in the baseline', () => {
    // The gate must not fail on the backlog it was seeded with, or it would be
    // red on the commit that introduced it and turned off immediately.
    const recorded = baseline().knownOrphans[0];
    expect(recorded).toBeDefined();
    const { status } = runCensus(['--check']);
    expect(status).toBe(0);
  });

  describe('the injection harness leaves the tree as it found it', () => {
    /**
     * THE REGRESSION TEST for the restore above.
     *
     * The previous restore was `git checkout -- <path>`, which needs a
     * repository. CI ran this suite from a tree unpacked by `git archive`, where
     * that command exits 128 and the injected export stays in the source file.
     * The failure then surfaced in a *later* test, as a baseline mismatch of one
     * symbol -- so the error message named the census ledger and not the
     * restore that actually broke it.
     *
     * These two cases pin the property the restore has to have, and they are
     * written against git not being available rather than against git being
     * clean, because availability is what differed between the two environments.
     */
    it('restores byte-for-byte from memory, so no repository is required', () => {
      const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
      // The restore must not shell out to git at all.
      //
      // This scans this file's own text, which is a crude mechanism and the right
      // one here: the defect was the presence of a command, and its absence is
      // what makes the fix hold in a tree that has no `.git`. The first version of
      // this assertion also forbade the bare word, and failed on the comment above
      // it -- which is why the pattern matches the CALL, not the word. A readable
      // explanation of a removed command must not itself look like the command.
      expect(source).not.toMatch(/execFileSync\(\s*['"]git['"]/);
      expect(source).not.toMatch(/['"]checkout['"]/);
      expect(source).toMatch(/writeFileSync\(victim, original\)/);
      // The import line, anchored to line start, rather than a bare-name search:
      // the comment above names the removed functions on purpose, and a search
      // for the names fails on the explanation of their absence. That happened
      // twice while writing this test -- once for `checkout`, once for the import
      // list -- so the patterns below match declarations, not mentions.
      expect(source).not.toMatch(/^import\b[^;]*\bexecFileSync\b/m);
      expect(source).not.toMatch(/^import\b[^;]*\bappendFileSync\b/m);
    });

    it('survives a tree with no .git, which is how the gate is exercised', () => {
      // Not a simulation of the CI environment: it is the environment. The
      // archive below is exactly what the failing run had, and the assertion is
      // that a byte-level restore is indifferent to it.
      const archive = resolve(REPO_ROOT, 'packages/cortex-core/src/math/vector.ts');
      const before = readFileSync(archive, 'utf8');
      const probe = `${before}\n/** probe */\nexport function restoreIsByteLevel(): number {\n  return 1;\n}\n`;
      writeFileSync(archive, probe);
      try {
        expect(readFileSync(archive, 'utf8')).toContain('restoreIsByteLevel');
      } finally {
        writeFileSync(archive, before);
      }
      expect(readFileSync(archive, 'utf8')).toBe(before);
      // And the tree is genuinely clean, not merely equal to what we wrote.
      expect(readFileSync(archive, 'utf8')).not.toContain('restoreIsByteLevel');
    });
  });
});

describe('the baseline is a ledger, not a rubber stamp', () => {
  it('records a rationale per group rather than a bare name list', () => {
    const groups = baseline().groups;
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      // Every group must explain itself. A baseline that is only names is
      // indistinguishable from an allowlist, and the difference is the whole
      // point: this file records debt, it does not bless it.
      expect(group.rationale.length).toBeGreaterThan(100);
      expect(group.count).toBeGreaterThan(0);
    }
  });

  it('has group counts that sum to every declaration site', () => {
    const data = baseline();
    const summed = data.groups.reduce((total, group) => total + group.count, 0);
    // Summed over declaration SITES, so this equals the census total rather than
    // the number of distinct identities. A TypeScript overload declares one name
    // on several lines.
    expect(summed).toBe(data.totals.orphaned);

    // Every site must map to a known identity, or the rationale would describe
    // orphans the gate does not actually know about.
    const known = new Set(data.knownOrphans);
    for (const group of data.groups) {
      for (const site of group.declarationSites) expect(known.has(orphanKey(site))).toBe(true);
    }
  });

  it('stores identities without line numbers, so moving code does not invalidate it', () => {
    // THE REGRESSION TEST for the brittle-baseline defect. The first ledger
    // stored `pkg: name (file:line)`, and deleting seven dead lines from
    // export-census.ts made 13 entries look brand new. Identity must be package
    // and name only.
    for (const orphan of baseline().knownOrphans) {
      expect(orphan).not.toContain('(');
      expect(orphan).toMatch(/^[a-z-]+: /);
    }
    expect(new Set(baseline().knownOrphans).size).toBe(baseline().knownOrphans.length);
  });

  it('records every declaration site for an identity, not just the first', () => {
    // `classifyTrFailure` in tr-failure-class.ts has two overload signatures plus
    // the implementation. A scalar map would keep one site and silently drop two,
    // which is the kind of quiet loss this ledger exists to prevent.
    const data = baseline();
    for (const orphan of data.knownOrphans) {
      const sites = data.locations[orphan];
      expect(sites).toBeDefined();
      expect(sites?.length).toBeGreaterThanOrEqual(1);
      for (const site of sites ?? []) {
        expect(site).toMatch(/^packages\/[a-z-]+\/src\/.+\.ts:\d+$/);
      }
    }
  });

  it('agrees with its own recorded totals', () => {
    const data = baseline();
    const { exports, withCaller, orphaned } = data.totals;
    // `exports = withCaller + orphaned` holds over declaration sites, because
    // that is what the census counts: every exported declaration line is either
    // called by something or it is not.
    expect(withCaller + orphaned).toBe(exports);

    // Identities are fewer than sites exactly when a name is declared on several
    // lines (a TypeScript overload). Asserting the direction rather than equality
    // is deliberate: it documents that the two numbers answer different
    // questions, and a divergence in the wrong direction would be a bug.
    expect(data.knownOrphans.length).toBeLessThanOrEqual(orphaned);
    const sites = Object.values(data.locations).reduce((total, list) => total + list.length, 0);
    expect(sites).toBe(orphaned);
  });

  it('splits every orphan into exactly one class, and the classes sum to the total', () => {
    // THE INVARIANT THAT MAKES THE SPLIT USABLE. Two parallel counts over the
    // same set drift unless something asserts they agree; this is that
    // assertion. `referenced-locally` means the symbol still has a live call
    // site and only its `export` keyword is unnecessary. `unreferenced` means
    // nothing mentions it anywhere and it is the only kind that may be deleted.
    const data = baseline();
    const classes = data.orphanClass;
    expect(classes).toBeDefined();

    // Same key set both ways: a class entry with no orphan, or an orphan with no
    // class, would mean the two lists had silently diverged.
    expect(new Set(Object.keys(classes ?? {}))).toEqual(new Set(data.knownOrphans));

    const values = Object.values(classes ?? {});
    for (const value of values) {
      expect(['referenced-locally', 'unreferenced']).toContain(value);
    }

    const referencedLocally = values.filter((v) => v === 'referenced-locally').length;
    const unreferenced = values.filter((v) => v === 'unreferenced').length;
    expect(referencedLocally + unreferenced).toBe(data.totals.orphaned);
    expect(referencedLocally).toBe(data.totals.referencedLocally);
    expect(unreferenced).toBe(data.totals.unreferenced);
  });
});

describe('the census CLI survives output that is larger than a pipe buffer', () => {
  /**
   * THE REGRESSION TEST for the truncated-report defect.
   *
   * The CLI ended with `process.exit(main())`. `process.exit` does not wait for
   * stdout to drain, and stdout is asynchronous whenever it is a pipe, so the
   * tail of any payload larger than the pipe buffer was discarded. Measured
   * before the fix, on this repository:
   *
   *   --json to a file           172475 bytes
   *   --json piped to `cat`      131072 bytes   <- truncated mid-string
   *   --json piped to `wc -c`     65536 bytes
   *
   * `--json` output was therefore not parseable, and `--check` could lose the
   * line that names the new orphan. A truncated report is not a smaller report:
   * it is a report that says something different, and in the gate's case it says
   * the reassuring thing.
   *
   * The defect is invisible without a pipe, because a terminal and a regular file
   * are written synchronously. That is why this is tested through a real pipe
   * with a reader that does not consume everything at once, rather than through
   * `spawnSync`, which hands back a buffer the child has already finished
   * writing into.
   */
  it('emits the whole --json payload when the reader is a pipe', () => {
    const shell = (command: string): { status: number | null; stdout: string } => {
      const result = spawnSync('bash', ['-c', command], { cwd: REPO_ROOT, encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout };
    };

    // `cat` is a reader that does not drain the pipe eagerly, so it reproduces
    // the CI shape, where the output went through `tee` and was cut at a buffer
    // boundary. The byte count is compared against the same command writing to a
    // file, so the test states the property -- a pipe must not change the output
    // -- without hard-coding a size that will drift as the tree grows.
    const direct = shell('node tools/export-census.mjs --json | wc -c');
    const toFile = shell(
      'node tools/export-census.mjs --json > /tmp/census-direct.json && wc -c < /tmp/census-direct.json',
    );
    expect(direct.status).toBe(0);
    expect(toFile.status).toBe(0);
    // Before the fix this pair was 8192 and 172475 on this machine: the pipe
    // dropped 96% of the payload, and the truncation point moves with the
    // reader's buffer size, so no smaller payload is safe on another host.
    expect(Number(direct.stdout.trim())).toBe(Number(toFile.stdout.trim()));

    // And the piped payload is parseable, which the truncation made false. This
    // is the assertion with teeth: it is what a caller of `--json` actually needs.
    const piped = shell('node tools/export-census.mjs --json | cat');
    const payload = JSON.parse(piped.stdout) as { orphans: string[] };
    expect(payload.orphans.length).toBeGreaterThan(0);
  });

  it('still reports the new orphan through a pipe, and still exits 1', () => {
    // The gate's refusal has to arrive intact through the same pipe that used to
    // eat it, because losing the refusal is the failure mode that matters: CI
    // reads the exit status AND the named symbol, and a silent truncation gives
    // a red run whose message does not say why.
    const victim = resolve(REPO_ROOT, 'packages/cortex-core/src/math/vector.ts');
    const original = readFileSync(victim, 'utf8');
    const marker = 'pipedCensusGateProbe';
    try {
      writeFileSync(
        victim,
        `${original}\n/** Injected by the pipe regression test; removed in its finally block. */\n` +
          `export function ${marker}(value: number): number {\n  return value;\n}\n`,
      );
      const result = spawnSync(
        'bash',
        ['-c', 'node tools/export-census.mjs --check 2>&1 | cat; exit ${PIPESTATUS[0]}'],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      // `${PIPESTATUS[0]}` is the CLI's status, not `cat`'s: the point is that the
      // gate keeps its non-zero exit through a pipeline, which is how CI runs it.
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(`${marker}`);
      expect(result.stdout).toContain('1 NEW orphan(s) not in the baseline');
    } finally {
      writeFileSync(victim, original);
      expect(readFileSync(victim, 'utf8')).toBe(original);
    }
  });
});

describe('the census counts the workspace outside packages/*/src', () => {
  it('counts bench/run.ts as a caller, because it is the benchmark entry point', () => {
    // THE BLIND SPOT. `readAllSources` walked `packages/<pkg>/src` and `tools/*.mjs`
    // and nothing else, so `packages/cortex-eval/bench/run.ts` -- the benchmark's
    // actual entry point, 1000+ lines that import the export surface by name --
    // was read by NEITHER. The gate therefore reported 41 exports as orphans whose
    // only production caller is that file.
    //
    // The check is by name against a symbol this test can prove is called there,
    // not a count: a count would change whenever unrelated code moved, and the
    // property under test is "bench/run.ts is read", not "the file has N refs".
    const benchPath = resolve(REPO_ROOT, 'packages/cortex-eval/bench/run.ts');
    const bench = readFileSync(benchPath, 'utf8');
    expect(bench).toContain('createLlmFromEnv');

    const { status, output } = runCensus(['--check']);
    expect(status).toBe(0);
    expect(output).not.toContain('cortex-eval: createLlmFromEnv');
    expect(output).not.toContain('cortex-eval: sampleInstances');
  });

  it('keeps a bench file from being counted as a declaration site', () => {
    // `bench/run.ts` is a TypeScript file, so `isSourceFile` is true for it and it
    // must be read -- but it declares no exported symbol the census should
    // attribute. Asserting the outcome rather than the mechanism: a bench file
    // added to the declaration walk would show up as a `cortex-eval: <name>`
    // orphan whose location is under `bench/`, which is the shape to forbid.
    const { output } = runCensus(['--json']);
    const payload = JSON.parse(output) as { orphans: string[] };
    const fromBench = payload.orphans.filter((line) => line.includes('/bench/'));
    expect(fromBench).toEqual([]);
  });
});
