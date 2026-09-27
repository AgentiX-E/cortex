#!/usr/bin/env python3
"""Defect-injection harness for the embedding source accounting.

The audit's §7.5 requirement asks a diagnostics artifact to record whether a
vector came from cache or the live API. That is a claim about a counter, and a
counter is exactly the kind of code that passes its own test by accident: a field
that is always zero is still a field. Each mutation below breaks the accounting in
a way a reader would not notice from the artifacts alone, and each names the test
that must fail because of it.

Every file is restored byte-for-byte after each mutation and verified by md5.

Usage: python3 tools/inject-embedding-source-stats.py
"""
from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PKG = REPO / 'packages' / 'cortex-eval'
RETRIEVAL = PKG / 'src' / 'retrieval.ts'
TEST_FILE = 'src/__tests__/retrieval.test.ts'

RESET_BODY = """  embeddingSourceCounters.liveRequests = 0;
  embeddingSourceCounters.batches = 0;
  embeddingSourceCounters.cachedTexts = 0;
  embeddingSourceCounters.liveTexts = 0;"""

MUTATIONS: list[tuple[str, str, str, str]] = [
    (
        'cache-hits-not-counted',
        'Cache hits are served but never counted, so a fully cached run reads as zero work.',
        """      result[i] = cached;
      embeddingSourceCounters.cachedTexts += 1;""",
        """      result[i] = cached;""",
    ),
    (
        'live-texts-count-all-inputs',
        'Live texts counts every input, including the cached ones.',
        """  embeddingSourceCounters.liveTexts += missing.length;""",
        """  embeddingSourceCounters.liveTexts += texts.length;""",
    ),
    (
        'requests-counted-per-text',
        'Requests are counted per text rather than per batch, inflating the provider call count.',
        """    embeddingSourceCounters.liveRequests += 1;""",
        """    embeddingSourceCounters.liveRequests += chunk.length;""",
    ),
    (
        'batches-counted-before-shaping',
        'Batches counts the inputs instead of the batches they were shaped into.',
        """  embeddingSourceCounters.batches += batches.length;""",
        """  embeddingSourceCounters.batches += missing.length;""",
    ),
    (
        'stats-return-live-reference',
        'The snapshot is the live counter object, so later stages mutate a written-down number.',
        """  return { ...embeddingSourceCounters };""",
        """  return embeddingSourceCounters;""",
    ),
    (
        'reset-leaves-cache-fields',
        'Reset zeroes the provider side but leaves the cache side, so a reset run reports stale hits.',
        RESET_BODY,
        """  embeddingSourceCounters.liveRequests = 0;
  embeddingSourceCounters.batches = 0;""",
    ),
    (
        'reset-leaves-live-fields',
        'Reset zeroes the cache side but leaves the provider side.',
        RESET_BODY,
        """  embeddingSourceCounters.cachedTexts = 0;
  embeddingSourceCounters.liveTexts = 0;""",
    ),
    (
        'cached-hits-double-counted',
        'A cache hit increments twice, so cached plus live exceeds the input length.',
        """      result[i] = cached;
      embeddingSourceCounters.cachedTexts += 1;""",
        """      result[i] = cached;
      embeddingSourceCounters.cachedTexts += 2;""",
    ),
]


def md5(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def run_tests() -> tuple[bool, str]:
    proc = subprocess.run(
        ['npx', 'vitest', 'run', TEST_FILE],
        cwd=PKG,
        capture_output=True,
        text=True,
    )
    return proc.returncode == 0, proc.stdout + proc.stderr


def main() -> int:
    original = RETRIEVAL.read_text()
    baseline_md5 = md5(RETRIEVAL)
    print(f'baseline md5: {baseline_md5}')

    passed, output = run_tests()
    if not passed:
        print('BASELINE SUITE IS RED -- fix the suite before injecting defects')
        print(output[-4000:])
        return 2
    print('baseline suite: green\n')

    survivors: list[str] = []
    for name, intent, old, new in MUTATIONS:
        if original.count(old) != 1:
            print(f'!! {name}: anchor found {original.count(old)} times, expected 1')
            survivors.append(name)
            continue
        RETRIEVAL.write_text(original.replace(old, new, 1))
        try:
            ok, output = run_tests()
        finally:
            RETRIEVAL.write_text(original)
            if md5(RETRIEVAL) != baseline_md5:
                print(f'!! {name}: RESTORE FAILED, tree is dirty')
                return 3
        if ok:
            print(f'SURVIVED  {name}: {intent}')
            survivors.append(name)
        else:
            failed = next(
                (line.strip() for line in output.splitlines() if line.strip().startswith('×')),
                'suite failed',
            )
            print(f'caught    {name}: {failed}')

    print()
    if survivors:
        print(f'{len(survivors)} mutation(s) SURVIVED: {", ".join(survivors)}')
        return 1
    print(f'all {len(MUTATIONS)} mutations caught; file restored to {baseline_md5}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
