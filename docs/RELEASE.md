# Releasing

Five packages, one version, one irreversible action. This page is the runbook; the reasons live in
`.github/workflows/release.yml`'s header and in `tools/publish-metadata.mjs`'s docblock.

## What ships

| package | what a consumer gets |
| --- | --- |
| `@agentix-e/cortex-core` | the contracts and the pure algorithms: value gates, ranking, temporal arithmetic. No I/O. |
| `@agentix-e/cortex-storage` | the stores: in-memory, SQL, PostgreSQL, browser. |
| `@agentix-e/cortex-ai` | provider construction: OpenAI-compatible LLM, embeddings, rerankers, retries, token accounting. |
| `@agentix-e/cortex-memory` | `CortexMemory` -- the composition root, and the only package most consumers import. |
| `@agentix-e/cortex-eval` | the evaluation harness. Published because the numbers in this repository have to be reproducible from a package, not from a checkout. |

Each tarball contains `dist` and nothing else. `main`, `types` and every `exports` target resolve inside
it, which `guard:publish-metadata` checks -- a package that installs and cannot be imported is the one
packaging failure the workspace symlinks hide completely.

## The three commands that matter

```bash
pnpm guard:publish-metadata   # 11 rules x 5 packages: the fields npm reads and no test can see
pnpm build                    # the tarballs are dist-only, so an empty dist publishes cleanly and fails on import
pnpm -r publish --dry-run --no-git-checks --access public
```

The first refuses a missing `publishConfig.access`, a missing `engines.node`, a `repository.directory`
that points at another package, a `files` list that would publish `src`, an entry point outside `dist`,
a version that disagrees across packages, and five more. Run it before anything else: the four failures
it prevents cost a publish attempt each, and one of them -- a scoped first publish landing in a paid
private scope -- succeeds while being wrong.

## The workflow

```bash
gh workflow run release.yml -f dry_run=true -f version=0.1.0
```

`dry_run` defaults to **true**, and it runs the whole path -- install, build, the metadata gate, the
version agreement, `pnpm -r publish --dry-run` -- without touching the registry. That is deliberate:
npm never allows a version to be reused, so a bad `0.1.0` cannot be repaired, only superseded. The dry
run is how the path gets exercised before it becomes permanent.

The real path is `-f dry_run=false` and needs one repository secret:

| secret | who grants it | what happens without it |
| --- | --- | --- |
| `NPM_TOKEN` | an npm account with publish rights on `@agentix-e` | the job stops at a step that names the secret, rather than reporting a release that did not happen |

`--provenance` is on by default on the real path and needs no secret: the workflow grants
`id-token: write`, and the attestation says which commit and which workflow produced the tarball. That
is the only claim about a release a consumer can verify without trusting the registry account.

## Why pnpm and not npm

`workspace:*` is expanded by `pnpm publish` into the concrete version and shipped **literally** by
`npm publish`. The consumer's install then fails at resolve time, in their code, for a packaging error
that is ours. The release path is pnpm for that reason alone; `release.yml` says so at the line that
runs it.

## What is not automated, on purpose

The version number. A release is a decision about what changed, and deriving it from commit messages
would produce a version nobody chose. Bump every `packages/*/package.json` together -- `one-version` is
a checked rule, because five packages at five versions make a consumer resolve two copies of
`cortex-core` -- then dispatch with `-f version=` naming the same number. The workflow refuses a
mismatch before it publishes anything.
