#!/usr/bin/env node
/**
 * Where a `<repo>/...` path in the acceptance matrix lives on this machine.
 *
 * ## The two repositories, and the two layouts
 *
 * Every evidence path in `packages/cortex-eval/src/acceptance.ts` starts with `cortex/` or `cortex-docs/`,
 * and those names are the point: they say **which repository** the rest of the path is in. The two sit
 * relative to one workspace directory, and that directory is arranged differently on the two machines that
 * run these tools:
 *
 * | machine | workspace | `cortex/…` | `cortex-docs/…` |
 * | --- | --- | --- | --- |
 * | a developer's | `..` beside both | `../cortex/…` | `../cortex-docs/…` |
 * | GitHub Actions | `$GITHUB_WORKSPACE` | `…/cortex/…` | `…/cortex/cortex-docs/…` |
 *
 * The second column of the second row is the one that bit: `actions/checkout`'s `path:` resolves against
 * the workspace, so on CI the documents repository lands **inside** the code checkout rather than beside
 * it. Every reader of evidence resolved against `path.resolve(REPO, '..')` alone, which is the first row.
 *
 * The failure did not look like a failure. A criterion whose evidence is in the documents repository
 * printed `unrun`, a document marker printed `skipped (no value in this checkout)`, and `S8` spent three
 * rounds `unrun` while the workflow had been checking that repository out the whole time. The matrix even
 * carried the wrong diagnosis in a comment — "CI without the documents repository" — because a wrong root
 * and an absent file produce the same word.
 *
 * ## The rule
 *
 * `cortex/…` names **this** checkout, so the first segment is dropped and the rest resolved against
 * `REPO` — which is right whatever the checkout directory happens to be called. `cortex-docs/…` names the
 * documents repository, which is either beside the workspace or inside this checkout. An explicit
 * `--root` is tried first and **replaces** the workspace default, because an operator naming a workspace
 * is making a statement about this run, and a fallback that overrode it would let a fixture read the real
 * evidence behind its back.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** This checkout. */
export const REPO = path.resolve(HERE, '..');

/** The workspace the two repositories sit in, as a developer arranges them: beside each other. */
export const DEFAULT_ROOT = path.resolve(REPO, '..');

/**
 * Every absolute path `relative` could name, in the order to try them, most specific first.
 *
 * Returned rather than resolved because a caller may want a directory (`cortex-docs/docs`) as well as a
 * file, and `existsSync` is the only test that covers both.
 */
export function candidates(relative, explicit) {
  const [head, ...rest] = relative.split('/');
  const out = [];
  if (explicit !== undefined) out.push(path.resolve(explicit, relative));
  if (head === 'cortex') {
    // This checkout, whatever it is called. Not a workspace question: `REPO` is where these tools live, so
    // the path resolves there however the caller named a workspace.
    out.push(path.resolve(REPO, ...rest));
  } else if (explicit === undefined) {
    // The documents repository is inside this checkout on CI. With an explicit `--root` it is **not** looked
    // for here: the flag has to be able to describe a workspace that has no documents repository at all, or
    // the "absent is skipped, not failed" path could not be exercised anywhere and every fixture would
    // silently read the real evidence.
    out.push(path.resolve(REPO, relative));
  }
  if (explicit === undefined) out.push(path.resolve(DEFAULT_ROOT, relative));
  return [...new Set(out)];
}

/**
 * The first of those paths that exists, or `undefined`.
 *
 * Returns the **path** rather than the parsed document because callers differ: one wants JSON, one wants a
 * directory scan, and both need to know whether it is there at all. A missing path stays missing; a
 * fallback that invented one would be worse than the bug this file exists for.
 */
export function locate(relative, explicit) {
  return candidates(relative, explicit).find((file) => existsSync(file));
}
