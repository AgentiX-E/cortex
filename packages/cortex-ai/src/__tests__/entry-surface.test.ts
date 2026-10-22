/**
 * The published shape of the package: three entries, three dependency profiles.
 *
 * ## Why this file exists next to `tools/entry-guard.mjs`
 *
 * The guard is the build-time gate and covers every package at once. This file is the same walk
 * applied to the claim as a reader would state it, in the package that would have to change if the
 * claim stopped being true -- and it runs on every `pnpm test`, including on a machine where the
 * guard was not run. Both use `closure`/`forbiddenIn` from the guard, so there is one
 * implementation of "what does this entry reach"; a second one would disagree exactly when it
 * mattered.
 *
 * The specific thing being protected: importing `@agentix-e/cortex-ai` must not pull an ONNX
 * runtime and 90 MB of weights into a service that only talks to an HTTP provider, and importing
 * `./web` must not pull a `node:` builtin into a page. Both are one careless re-export away.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as localEntry from '../local/index.js';
import * as webEntry from '../web/index.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs tool with no declarations; the shapes are asserted below.
import { closure, forbiddenIn } from '../../../../tools/entry-guard.mjs';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
  name: string;
  exports: Record<string, { types: string; import: string }>;
};

type Walk = { files: string[]; bare: string[]; bytes: number };

function walk(entry: string): Walk {
  return closure(join(PACKAGE_ROOT, entry)) as Walk;
}

describe('manifest', () => {
  it('is called cortex-ai', () => {
    expect(manifest.name).toBe('@agentix-e/cortex-ai');
  });

  it('publishes exactly three entries', () => {
    // Written out rather than derived: adding an entry is a deliberate act, and a fourth one would
    // need its own dependency story before it needs an `exports` key.
    expect(Object.keys(manifest.exports).sort()).toEqual(['.', './local', './web']);
  });

  it('points every entry at a file that exists', () => {
    for (const [key, target] of Object.entries(manifest.exports)) {
      const source = target.import.replace('./dist/', 'src/').replace(/\.js$/, '.ts');
      expect(existsSync(join(PACKAGE_ROOT, source)), `${key} -> ${source}`).toBe(true);
      expect(target.types.endsWith('.d.ts')).toBe(true);
    }
  });

  it('declares transformers as an optional peer rather than a dependency', () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    expect(pkg.dependencies?.['@huggingface/transformers']).toBeUndefined();
    expect(pkg.peerDependencies?.['@huggingface/transformers']).toBeDefined();
    expect(pkg.peerDependenciesMeta?.['@huggingface/transformers']?.optional).toBe(true);
  });
});

describe('the barrels a consumer actually imports', () => {
  it('./local carries the embedding, the loaders and the local reranker', () => {
    // Coverage of the barrel itself is not the point: an `exports` map that points at a file whose
    // default export is missing fails for the consumer and not for the build. Importing it here
    // means the build fails instead.
    expect(typeof localEntry.TransformersEmbedding).toBe('function');
    expect(typeof localEntry.createFeatureExtractor).toBe('function');
    expect(typeof localEntry.makeRerankPipelineFactory).toBe('function');
    expect(localEntry.DEFAULT_DTYPE).toBe('fp32');
    expect(typeof localEntry.CrossEncoderReranker).toBe('function');
  });

  it('./web carries the platform adapter and the probe', () => {
    expect(typeof webEntry.PlatformLanguageModelAdapter).toBe('function');
    expect(typeof webEntry.checkAvailability).toBe('function');
    expect(typeof webEntry.readPlatform).toBe('function');
  });
});

describe('import closures', () => {
  it('the root reaches no model runtime', () => {
    const result = walk('src/index.ts');
    expect(result.bare).not.toContain('@huggingface/transformers');
    expect(forbiddenIn(result.bare)).toEqual([]);
  });

  it('the local entry does reach it, which is what makes the root assertion mean something', () => {
    // The positive control. If this ever reports clean, the walk is broken and the assertion above
    // is measuring nothing -- the failure mode this project has already hit once, in a workflow
    // where `set -o pipefail` without `-e` made a crashed step report success.
    const result = walk('src/local/index.ts');
    expect(result.bare).toContain('@huggingface/transformers');
  });

  it('the web entry reaches neither a model runtime nor a node builtin', () => {
    const result = walk('src/web/index.ts');
    expect(result.bare).not.toContain('@huggingface/transformers');
    expect(forbiddenIn(result.bare)).toEqual([]);
  });

  it('the local entry is still browser-safe apart from the peer', () => {
    // `./local` is intended to run in a browser too (transformers.js has a web build), so a
    // `node:` import here would be a defect rather than a design choice.
    expect(forbiddenIn(walk('src/local/index.ts').bare)).toEqual([]);
  });
});
