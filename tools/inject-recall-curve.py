#!/usr/bin/env python3
"""Defect-injection harness for recall-curve.ts, the curve and its membership.

The curve answers "how many questions were recalled at k"; the membership answers
"which". Both are needed and neither is sufficient, and the failure that makes
the pair worth testing is that they can disagree:

    a curve reporting `recalled = 142` beside a membership listing 143 admitted
    ids is worse than either number alone. A reader cannot tell which to believe,
    and both look authoritative.

That disagreement is prevented by construction -- `buildRecallCurve` counts with
`isRecalled` and `classifyCurveMembership` classifies with the same predicate --
and the mutations below are aimed at that construction:

  - breaking the shared predicate, so the two disagree by one question;
  - breaking the boundary (`<` vs `<=`), which moves exactly one question between
    the admitted set and the ranking gap;
  - breaking the second boundary, which moves questions between the two GAPS;
  - dropping the id fallback, which silently names every question "" and makes the
    list unusable while still counting the right length.

The last one is the one a length assertion cannot catch, which is why the suite
asserts on ids and not only on lengths.

Files are restored byte-for-byte after every mutation and the restore is verified
by md5.
"""

from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

SRC = Path('/workspace/cortex/packages/cortex-eval/src/recall-curve.ts')
DIAG = Path('/workspace/cortex/packages/cortex-eval/src/retrieval-diagnostics.ts')
PKG = SRC.parent.parent
PNPM = '/root/.pnpm/.tools/pnpm/9.15.0_tmp_85206/node_modules/pnpm/bin/pnpm.cjs'

TESTS = [
    'src/__tests__/recall-curve.test.ts',
    'src/__tests__/retrieval-attribution.test.ts',
]

# (name, path, anchor, replacement)
MUTATIONS: list[tuple[str, Path, str, str]] = [
    (
        'membership-boundary-off-by-one',
        SRC,
        '    if (isRecalled(rank, k)) {\n      admitted.push(id);',
        '    if (rank.rankOfFirstAnswer !== null && rank.rankOfFirstAnswer <= k) {\n      admitted.push(id);',
    ),
    (
        'membership-pool-boundary-off-by-one',
        SRC,
        '    } else if (rank.rankOfFirstAnswer !== null && rank.rankOfFirstAnswer < poolWidth) {',
        '    } else if (rank.rankOfFirstAnswer !== null && rank.rankOfFirstAnswer <= poolWidth) {',
    ),
    (
        'membership-treats-missing-answer-as-in-pool',
        SRC,
        '    } else if (rank.rankOfFirstAnswer !== null && rank.rankOfFirstAnswer < poolWidth) {',
        '    } else if (rank.rankOfFirstAnswer === null || rank.rankOfFirstAnswer < poolWidth) {',
    ),
    (
        'membership-drops-the-rank-zero-case',
        SRC,
        '    if (isRecalled(rank, k)) {',
        '    if (isRecalled(rank, k) && rank.rankOfFirstAnswer !== 0) {',
    ),
    (
        'membership-swaps-the-two-gaps',
        SRC,
        '      rankingGap.push(id);\n    } else {\n      retrievalGap.push(id);',
        '      retrievalGap.push(id);\n    } else {\n      rankingGap.push(id);',
    ),
    (
        'membership-drops-everything-unrecalled',
        SRC,
        '    } else if (rank.rankOfFirstAnswer !== null && rank.rankOfFirstAnswer < poolWidth) {\n'
        '      rankingGap.push(id);\n    } else {\n      retrievalGap.push(id);\n    }',
        '    }',
    ),
    (
        'membership-loses-the-id',
        SRC,
        "    const id = rank.questionId ?? '';",
        "    const id = '';",
    ),
    (
        'membership-counts-indices-not-ids',
        SRC,
        '    const id = rank.questionId ?? \'\';',
        '    const id = String(ranks.indexOf(rank));',
    ),
    (
        # The pair's consistency, attacked from the OTHER side: leave the
        # membership correct and break the count's predicate instead. A suite that
        # only asserts each field against a literal could miss this, because the
        # membership still lists the right ids -- only the two together are wrong.
        'curve-counts-with-a-different-predicate',
        SRC,
        '    const recalled = ranks.filter((r) => isRecalled(r, k)).length;',
        '    const recalled = ranks.filter((r) => r.rankOfFirstAnswer !== null && (r.rankOfFirstAnswer as number) < k + 1).length;',
    ),
    (
        'curve-counts-null-ranks-as-recalled',
        SRC,
        'function isRecalled(rank: QuestionRank, k: number): boolean {\n  return rank.rankOfFirstAnswer !== null && rank.rankOfFirstAnswer < k;\n}',
        'function isRecalled(rank: QuestionRank, k: number): boolean {\n  return rank.rankOfFirstAnswer === null || rank.rankOfFirstAnswer < k;\n}',
    ),
    (
        'curve-membership-computed-on-a-different-k',
        SRC,
        '      k: Math.min(...cutoffs),\n      poolWidth,\n    }),',
        '      k: Math.max(...cutoffs),\n      poolWidth,\n    }),',
    ),
]


def build() -> bool:
    proc = subprocess.run(
        ['node', PNPM, 'run', 'build'], cwd=PKG, capture_output=True, text=True
    )
    if proc.returncode != 0:
        print(proc.stdout[-1500:])
        print(proc.stderr[-1500:])
    return proc.returncode == 0


def suite_green() -> bool:
    if not build():
        return False
    proc = subprocess.run(
        ['node', PNPM, 'exec', 'vitest', 'run', *TESTS],
        cwd=PKG, capture_output=True, text=True,
    )
    return proc.returncode == 0


def main() -> int:
    originals: dict[Path, str] = {}
    digests: dict[Path, str] = {}
    for path in {SRC, DIAG}:
        text = path.read_text()
        originals[path] = text
        digests[path] = hashlib.md5(text.encode()).hexdigest()
        print(f'baseline {path.name} md5 = {digests[path]}')

    if not suite_green():
        print('BASELINE RED -- refusing to inject against a failing suite')
        return 2

    survivors: list[str] = []
    for name, path, needle, replacement in MUTATIONS:
        original = originals[path]
        if needle not in original:
            print(f'  {name:<44} ANCHOR MISSING')
            survivors.append(f'{name} (anchor missing)')
            continue
        path.write_text(original.replace(needle, replacement, 1))
        try:
            caught = not suite_green()
        finally:
            path.write_text(original)
            if hashlib.md5(path.read_text().encode()).hexdigest() != digests[path]:
                print(f'  !! restore mismatch on {path.name} -- aborting')
                for p, t in originals.items():
                    p.write_text(t)
                return 3
        if not suite_green():
            print(f'  {name:<44} VOID (suite red after restore)')
            for p, t in originals.items():
                p.write_text(t)
            return 4
        print(f'  {name:<44} {"caught" if caught else "SURVIVED"}')
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
