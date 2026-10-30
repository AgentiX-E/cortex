/**
 * The shape of the package as consumers see it: entry points, peers, and what the root may reach.
 *
 * ## Why these assertions exist at all
 *
 * Nothing here tests a storage behaviour; `storage.test.ts` does that. These test the *packaging*,
 * because that is where the two failures this refactor exists to prevent would happen, and both
 * are invisible to a behavioural test:
 *
 *   1. the root entry re-exporting a backend, which drags a native addon into every consumer;
 *   2. a subpath being added to `src/` but forgotten in `exports`, so `import '.../sqlite'` works
 *      in the tests (which resolve by path) and fails for everyone who installs the package.
 *
 * The second one is the interesting case: it is green in every unit test and red only in the
 * published artefact, which is exactly the class of defect that a manifest assertion catches and
 * nothing else does.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PgStorage } from '../storage/pg.js';
import { SqliteStorage } from '../storage/sqlite.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..', '..');
const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
  name: string;
  exports: Record<string, { types: string; import: string }>;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
};

describe('entry points', () => {
  it('exposes nothing from the root', async () => {
    // The root used to re-export both backends, which is what put a native addon in every
    // consumer's bundle. `export {}` is not a placeholder to fill in later: the package's surface
    // is its subpaths, and a test that keys off the module itself fails the moment someone
    // restores the convenience re-export.
    const root: Record<string, unknown> = await import('../index.js');
    expect(Object.keys(root)).toEqual([]);
  });

  it('exposes each backend as a class behind its own subpath', async () => {
    expect(typeof SqliteStorage).toBe('function');
    expect(typeof PgStorage).toBe('function');
  });

  it('keeps the root free of imports altogether', () => {
    // Comments are stripped first: the docstring names a subpath as an example, and a text scan
    // that reads prose would report the package as importing itself -- which is what the entry
    // guard did on its first run.
    const source = readFileSync(join(PACKAGE_ROOT, 'src', 'index.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const specifiers = [...source.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)].map(
      (match) => match[1],
    );
    expect(specifiers).toEqual([]);
  });
});

describe('manifest', () => {
  it('declares the package under its new name', () => {
    expect(manifest.name).toBe('@agentix-e/cortex-storage');
  });

  it('declares one subpath per backend, each with types and an import target', () => {
    const subpaths = Object.keys(manifest.exports).filter((key) => key !== '.');
    // This list is the published contract, so it is written out rather than derived: adding a
    // backend is supposed to be a deliberate edit here and in `exports`, in that order. The test
    // below catches the other direction -- a subpath that names a file which does not exist.
    //
    // `./opfs/worker` is not a backend. It is the OPFS engine's other half, and it is exported
    // because a consumer bundling this package has no other supported way to obtain it: esbuild has
    // no worker support, so `new URL('./opfs-worker.js', import.meta.url)` points at a file their
    // build never emits. Naming it as a subpath is what turns "copy a file out of node_modules into
    // your public directory" into "add a second entry point" (`tools/bundle-guard.mjs` reports the
    // difference, `test/browser/bundle-probe.mjs` runs both).
    expect(subpaths.sort()).toEqual(['./idb', './opfs', './opfs/worker', './pg', './sqlite']);
    for (const [key, target] of Object.entries(manifest.exports)) {
      expect(target.types, key).toMatch(/\.d\.ts$/);
      expect(target.import, key).toMatch(/\.js$/);
    }
  });

  it('declares the native modules as optional peers rather than dependencies', () => {
    for (const peer of ['better-sqlite3', 'pg']) {
      expect(manifest.dependencies[peer], peer).toBeUndefined();
      expect(manifest.peerDependencies[peer], peer).toBeDefined();
      expect(manifest.peerDependenciesMeta[peer]?.optional, peer).toBe(true);
    }
  });

  it('points every subpath at a file that exists', () => {
    for (const [key, target] of Object.entries(manifest.exports)) {
      const source = target.import.replace('./dist/', './src/').replace(/\.js$/, '.ts');
      expect(existsSync(join(PACKAGE_ROOT, source)), `${key} -> ${source}`).toBe(true);
    }
  });
});
