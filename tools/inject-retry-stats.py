#!/usr/bin/env python3
"""Mutation injection for the transport-retry counters.

A counter is only worth reading if the tests guarding it can actually fail. Each
mutation below is a plausible way for the accounting to be wrong while every
artifact still looks well-formed:

  * a retry that was performed but not counted,
  * an HTTP 5xx folded into `rateLimited`, inflating the reported throttling rate,
  * a retry the budget REFUSED still counted as performed,
  * `retryRate` computed from `retried` rather than `retriedCalls`, so one call
    retrying 40 times reports a rate of 40,
  * a transport failure counted as a 429, though no status was ever received,
  * `Retry-After` honourability counted on every retry rather than only on the
    retries that actually carried the header,
  * a call that retried recorded as a clean call,
  * the snapshot forgetting `retriedCalls`, which is the numerator of `retryRate`,
  * the reporter dropping a counter or mislabelling the scope it measured.

Every mutation must be caught by the existing suites. A survivor means the tests
cannot tell a correct counter from a wrong one — which is the failure mode this
script exists to detect, not a mutation to quietly drop.

Each file is restored from memory and md5-checked after every mutation, so a
surviving mutation can never be left behind in the tree, even if the run aborts.

Usage:  python3 tools/inject-retry-stats.py
Exit:   0 all caught, 1 survivors, 2 baseline red, 3 restore mismatch
"""
from __future__ import annotations

import hashlib
import pathlib
import subprocess
import sys

REPO = pathlib.Path('/workspace/cortex')
RETRY = REPO / 'packages/cortex-llm/src/retry.ts'
DIAG = REPO / 'packages/cortex-eval/src/retrieval-diagnostics.ts'
PNPM = '/root/.pnpm/.tools/pnpm/9.15.0_tmp_85206/node_modules/pnpm/bin/pnpm.cjs'

LLM_DIR = REPO / 'packages/cortex-llm'
EVAL_DIR = REPO / 'packages/cortex-eval'


def vitest(cwd: pathlib.Path, *files: str) -> bool:
    proc = subprocess.run(
        ['node', PNPM, 'exec', 'vitest', 'run', *files],
        cwd=cwd, capture_output=True, text=True,
    )
    return proc.returncode == 0


def build_llm() -> bool:
    """Rebuild the library before injecting.

    The eval-side reporter test imports `@agentix-e/cortex-llm`, which resolves to
    the package's BUILT `dist/`. Without a rebuild that dist is stale relative to
    the `retry.ts` being mutated, so the eval test would keep passing against the
    pre-mutation code and report every counter mutation as a survivor. The build
    is what keeps the mutation actually reachable from the assertions.
    """
    proc = subprocess.run(
        ['node', PNPM, 'run', 'build'],
        cwd=LLM_DIR, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        print(proc.stdout[-2000:])
        print(proc.stderr[-2000:])
    return proc.returncode == 0


def suite_green() -> bool:
    """Both the library suite and the reporter suite must pass.

    `build_llm()` runs first so the mutation under test is the code the eval
    package actually loads.
    """
    if not build_llm():
        return False
    return vitest(LLM_DIR, 'src/__tests__/retry.test.ts') and vitest(
        EVAL_DIR, 'src/__tests__/transport-retry-report.test.ts'
    )


# (name, path, anchor, replacement)
MUTATIONS: list[tuple[str, pathlib.Path, str, str]] = [
    (
        'retry-not-counted',
        RETRY,
        '      stats.retried += 1;\n',
        '      // MUTATION: retry performed but not counted\n',
    ),
    (
        'rate-limited-counts-5xx',
        RETRY,
        '    if (res.status === 429) {\n      stats.rateLimited += 1;\n    }',
        '    if (res.status >= 429) {\n      stats.rateLimited += 1;\n    }',
    ),
    (
        'budget-refusal-counted',
        RETRY,
        '        return withResponse(resFromLastAttempt ?? new Response(null, { status: 429 }), stats);',
        '        stats.retried += 1;\n        return withResponse(resFromLastAttempt ?? new Response(null, { status: 429 }), stats);',
    ),
    (
        'budget-refusal-status-shifted',
        RETRY,
        '        return withResponse(resFromLastAttempt ?? new Response(null, { status: 429 }), stats);',
        '        return withResponse(resFromLastAttempt ?? new Response(null, { status: 503 }), stats);',
    ),
    (
        'retry-rate-per-retry',
        RETRY,
        'retryRate: this.#calls === 0 ? 0 : this.#retriedCalls / this.#calls,',
        'retryRate: this.#calls === 0 ? 0 : this.#retried / this.#calls,',
    ),
    (
        'transport-failure-counted',
        RETRY,
        '    } catch (err) {\n      lastError = err instanceof Error ? err : new Error(String(err));',
        '    } catch (err) {\n      stats.rateLimited += 1;\n      lastError = err instanceof Error ? err : new Error(String(err));',
    ),
    (
        'retry-after-always-honoured',
        RETRY,
        '      if (fromHeader !== null) {\n        stats.retryAfterHonoured += 1;\n      }',
        '      stats.retryAfterHonoured += 1;',
    ),
    (
        'retried-call-recorded-clean',
        RETRY,
        '      this.#retriedCalls += 1;',
        '      this.#cleanCalls += 1;',
    ),
    (
        'clean-call-recorded-retried',
        RETRY,
        '      this.#cleanCalls += 1;\n    }',
        '      this.#retriedCalls += 1;\n    }',
    ),
    (
        'snapshot-drops-retried-calls',
        RETRY,
        '      retriedCalls: this.#retriedCalls,\n',
        '',
    ),
    (
        'reset-leaves-retried-calls',
        RETRY,
        '    this.#retriedCalls = 0;\n    this.#cleanCalls = 0;\n',
        '    this.#cleanCalls = 0;\n',
    ),
    (
        'reset-leaves-attempts',
        RETRY,
        '    this.#attempts = 0;\n',
        '',
    ),
    (
        'report-drops-rate-limited',
        DIAG,
        '    rateLimited: snapshot.rateLimited,\n',
        '    rateLimited: 0,\n',
    ),
    (
        'report-drops-retry-after',
        DIAG,
        '    retryAfterHonoured: snapshot.retryAfterHonoured,\n',
        '    retryAfterHonoured: 0,\n',
    ),
    (
        'report-relabels-scope',
        DIAG,
        "    scope: 'process',\n",
        "    scope: 'provider',\n",
    ),
    (
        'report-drops-attempts',
        DIAG,
        '    attempts: snapshot.attempts,\n',
        '    attempts: snapshot.retried,\n',
    ),
]


def main() -> int:
    originals: dict[pathlib.Path, str] = {}
    digests: dict[pathlib.Path, str] = {}
    for path in {RETRY, DIAG}:
        text = path.read_text()
        originals[path] = text
        digests[path] = hashlib.md5(text.encode()).hexdigest()
        print(f'baseline {path.name} md5 = {digests[path]}')

    if not suite_green():
        print('BASELINE RED — refusing to inject against a failing suite')
        return 2

    survivors: list[str] = []
    for name, path, needle, replacement in MUTATIONS:
        original = originals[path]
        if needle not in original:
            print(f'  {name:<32} ANCHOR MISSING')
            survivors.append(f'{name} (anchor missing)')
            continue
        path.write_text(original.replace(needle, replacement, 1))
        try:
            caught = not suite_green()
        finally:
            path.write_text(original)
            if hashlib.md5(path.read_text().encode()).hexdigest() != digests[path]:
                print(f'  !! restore mismatch on {path.name} — aborting')
                for p, t in originals.items():
                    p.write_text(t)
                return 3
        print(f'  {name:<32} {"caught" if caught else "SURVIVED"}')
        if not caught:
            survivors.append(name)

    print()
    if survivors:
        print(f'{len(survivors)} survivor(s): {", ".join(survivors)}')
        return 1
    print(f'all {len(MUTATIONS)} mutations caught; files restored')
    return 0


if __name__ == '__main__':
    sys.exit(main())
