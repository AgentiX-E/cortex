#!/usr/bin/env python3
"""Defect-injection harness for the embedding-provenance contract.

Each mutation introduces a specific defect and names the test that must fail
because of it. A mutation that SURVIVES means the suite never exercises the
behaviour it claims to protect -- the mutation is then the proof that the test
is decorative.

Every file is restored byte-for-byte after each mutation and verified by md5, so
a surviving mutation cannot leave the tree modified.

Usage: python3 tools/inject-embedding-provenance.py
"""
from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PKG = REPO / 'packages' / 'cortex-eval'
FACTORY = PKG / 'src' / 'embedding-factory.ts'
TEST_FILE = 'src/__tests__/embedding-provenance.test.ts'

MUTATIONS: list[tuple[str, str, str, str]] = [
    (
        'hash-fallback-names-zhipu',
        'A credential-less run reports the Zhipu defaults it never contacted.',
        """    provenance: {
      provider: 'hash',
      model: null,
      baseUrl: null,
      dimensions: DEFAULT_HASH_DIMENSION,
    },""",
        """    provenance: {
      provider: 'hash',
      model: DEFAULT_ZHIPU_EMBEDDING_MODEL,
      baseUrl: DEFAULT_ZHIPU_BASE_URL,
      dimensions: DEFAULT_HASH_DIMENSION,
    },""",
    ),
    (
        'hash-fallback-reports-requested-dimension',
        'The fallback reports the dimensions that were requested, not the ones it built.',
        """      dimensions: DEFAULT_HASH_DIMENSION,
    },
  };
}

/** First value that is neither undefined nor an empty/blank string. */""",
        """      dimensions,
    },
  };
}

/** First value that is neither undefined nor an empty/blank string. */""",
    ),
    (
        'remote-provenance-drops-model',
        'A remote run does not record which model produced the vectors.',
        """      provenance: { provider: 'openai-compatible', model, baseUrl, dimensions },""",
        """      provenance: {
        provider: 'openai-compatible',
        model: DEFAULT_ZHIPU_EMBEDDING_MODEL,
        baseUrl,
        dimensions,
      },""",
    ),
    (
        'empty-key-reaches-remote-path',
        'An empty API key is accepted, so an unset CI secret selects the remote path.',
        """  if (apiKey !== undefined && Number.isInteger(dimensions) && dimensions > 0) {""",
        """  if (Number.isInteger(dimensions) && dimensions > 0) {""",
    ),
    (
        'empty-string-defeats-fallback',
        'An empty string counts as a configured base URL, selecting a bogus endpoint.',
        """    if (value !== undefined && value.trim() !== '') {""",
        """    if (value !== undefined) {""",
    ),
    (
        'non-integer-dimension-accepted',
        'A non-integer dimension reaches the remote client instead of falling back.',
        """  if (apiKey !== undefined && Number.isInteger(dimensions) && dimensions > 0) {""",
        """  if (apiKey !== undefined && dimensions !== 0) {""",
    ),
    (
        'negative-dimension-accepted',
        'A negative dimension is treated as valid.',
        """  if (apiKey !== undefined && Number.isInteger(dimensions) && dimensions > 0) {""",
        """  if (apiKey !== undefined && Number.isInteger(dimensions)) {""",
    ),
    (
        'provenance-dimension-hardcoded',
        'The provenance dimension is a constant, so it drifts from the model that was built.',
        """      provenance: { provider: 'openai-compatible', model, baseUrl, dimensions },""",
        """      provenance: {
        provider: 'openai-compatible',
        model,
        baseUrl,
        dimensions: DEFAULT_ZHIPU_EMBEDDING_DIMENSIONS,
      },""",
    ),
    (
        'provider-label-inverted',
        'The remote backend is labelled as the fallback.',
        """      provenance: { provider: 'openai-compatible', model, baseUrl, dimensions },""",
        """      provenance: { provider: 'hash', model, baseUrl, dimensions },""",
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
    original = FACTORY.read_text()
    baseline_md5 = md5(FACTORY)
    print(f'baseline md5: {baseline_md5}')

    passed, output = run_tests()
    if not passed:
        print('BASELINE SUITE IS RED -- fix the suite before injecting defects')
        print(output[-4000:])
        return 2
    print('baseline suite: green\n')

    survivors: list[str] = []
    for name, intent, old, new in MUTATIONS:
        if old not in original:
            print(f'!! {name}: anchor not found, mutation cannot be applied')
            survivors.append(name)
            continue
        if original.count(old) != 1:
            print(f'!! {name}: anchor is not unique ({original.count(old)} matches)')
            survivors.append(name)
            continue
        FACTORY.write_text(original.replace(old, new, 1))
        try:
            ok, output = run_tests()
        finally:
            FACTORY.write_text(original)
            if md5(FACTORY) != baseline_md5:
                print(f'!! {name}: RESTORE FAILED, tree is dirty')
                return 3
        if ok:
            print(f'SURVIVED  {name}: {intent}')
            survivors.append(name)
        else:
            failed = [
                line.strip()
                for line in output.splitlines()
                if line.strip().startswith('×') or 'AssertionError' in line
            ]
            detail = failed[0] if failed else 'suite failed'
            print(f'caught    {name}: {detail}')

    print()
    if survivors:
        print(f'{len(survivors)} mutation(s) SURVIVED: {", ".join(survivors)}')
        return 1
    print(f'all {len(MUTATIONS)} mutations caught; file restored to {baseline_md5}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
