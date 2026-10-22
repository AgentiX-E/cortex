/**
 * cortex-storage: the package root, which deliberately exports nothing.
 *
 * ## Why an empty root is the correct shape
 *
 * A backend is a *choice*, and each choice costs a dependency: `better-sqlite3` is a native
 * addon, `pg` is a socket client, and a browser build can have neither. If this file re-exported
 * them -- as `cortex-node` did -- then importing the package root would link both into every
 * consumer, and the failure would surface in *their* bundler as an unresolvable module rather
 * than here as a design mistake.
 *
 * So the surface is the subpaths: `./sqlite` and `./pg`, one backend each, listed in
 * `package.json#exports`. This file exists because a package needs a root target, and because
 * the rule belongs somewhere a reader will look.
 *
 * ## How the rule stays true
 *
 * `tools/entry-guard.mjs` walks this file's import closure and fails if a native module or a
 * `node:` builtin ever becomes reachable from it. Its control case is `./sqlite`, which *is*
 * expected to reach `better-sqlite3`; if that control ever reports clean, the walk is broken and
 * a green result here would mean nothing. `src/__tests__/entry-surface.test.ts` additionally
 * pins the manifest: one `exports` entry per backend, peers optional, nothing in `dependencies`
 * that should be a peer.
 */

export {};
