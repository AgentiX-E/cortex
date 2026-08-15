# Contributing to Cortex

## Ground Rules

- **English only** for code, comments, external docs, and commit messages.
- **TDD**: write a failing test first, then implement, then refactor.
- **≥95% coverage** across statements, branches, functions, and lines.
- **No mocks**: use real SQLite, `pg-mem` for PostgreSQL, and real local HTTP
  servers for adapter tests.
- **No `continue-on-error`, `|| true`, or skipped tests.** Root-cause fixes only.
- **Scientific evaluation**: report min/median/max, use Welch's t-test (p < 0.05),
  and run ablations. A single lucky run is not evidence.

## Commands

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm format
pnpm check       # lint && typecheck && test && format
```

## Commit Conventions

Conventional commits, e.g. `feat(core): add bitemporal fact queries`,
`fix(node): handle TTL expiry`, `test(math): cover Sinkhorn convergence`.

## Author

All commits are authored as `Lambertyan <lambertyan@agentix-e.dev>`.
