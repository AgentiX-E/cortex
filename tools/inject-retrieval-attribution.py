#!/usr/bin/env python3
"""Defect-injection harness for retrieval-attribution.ts, the B2 gap attribution.

Each mutation states the defect it introduces and the tests it should break. A
mutation that leaves the suite green means the suite does not test that
behaviour, which is the finding -- not a pass.

Why this module needed a harness at all, given the suite was green and every
figure in it looked reasonable:

The module documents a partition on `admittedAtOne`:

    admittedAtOne + rankingGapQuestions + retrievalGapQuestions === considered

That identity was FALSE for inputs the upstream recall curve can emit. With
`ceiling = 0.5`, `recallAtOne = 0.8` and `considered = 100`, the function
returned `admitted = 80` against a 50-question pool and the three terms summed to
130. The old test for that very scenario asserted `rankingGapQuestions === 0` and
`retrievalGapQuestions === 50` -- the two terms that were still correct -- and
never looked at `admitted`, which was the broken one. So the suite passed while
the documented invariant was false, and the inflation landed in
`retrievalGapQuestions`, the figure that decides whether retrieval work is the
next subsystem to touch.

The lesson the mutations below encode: a test that asserts each field equals a
plausible number is not the same test as one that asserts the relation between
them. `partition-identity` is the mutation every per-field assertion misses.

The file is restored byte-for-byte after every mutation and the restore is
verified by md5, so a run that crashes cannot leave a mutated implementation
behind.
"""

from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

SRC = Path("/workspace/cortex/packages/cortex-eval/src/retrieval-attribution.ts")
PKG = SRC.parent.parent
TEST = "src/__tests__/retrieval-attribution.test.ts"

# (name, defect introduced, anchor, replacement)
MUTATIONS = [
    (
        "ranking-ids-swapped-with-retrieval",
        "Pair the ranking count with the retrieval population, so the count and "
        "the names beside it describe different sets. This is the failure the id "
        "fields exist to prevent, reintroduced: a reader comparing the two would "
        "have no way to tell which is authoritative.",
        "    rankingGapQuestionIds: [...options.membership.rankingGap],",
        "    rankingGapQuestionIds: [...options.membership.retrievalGap],",
    ),
    (
        "retrieval-ids-swapped-with-ranking",
        "The same swap on the other field, so a fix applied to one side only is "
        "still caught.",
        "    retrievalGapQuestionIds: [...options.membership.retrievalGap],",
        "    retrievalGapQuestionIds: [...options.membership.rankingGap],",
    ),
    (
        "ids-aliased-not-copied",
        "Return the caller's array instead of a copy, so a reader that sorts what "
        "it was given reorders the curve it came from. The symptom appears in a "
        "different field, later.",
        "    rankingGapQuestionIds: [...options.membership.rankingGap],",
        "    rankingGapQuestionIds: options.membership.rankingGap as string[],",
    ),
    (
        "ranking-ids-sorted",
        "Sort the ids, discarding the order the measurement produced. A diff "
        "between two runs then cannot show which questions moved, which is the "
        "one thing the list is for.",
        "    rankingGapQuestionIds: [...options.membership.rankingGap],",
        "    rankingGapQuestionIds: [...options.membership.rankingGap].sort(),",
    ),
    (
        "ranking-ids-truncated-to-admitted",
        "Report the admitted population as the ranking gap, so the names describe "
        "the questions that already work.",
        "    rankingGapQuestionIds: [...options.membership.rankingGap],",
        "    rankingGapQuestionIds: [...options.membership.admitted],",
    ),
    (
        "ranking-ids-emptied",
        "Report no population at all while the count beside it stays non-zero. "
        "The pair then reads as self-contradictory rather than as absent.",
        "    rankingGapQuestionIds: [...options.membership.rankingGap],",
        "    rankingGapQuestionIds: [],",
    ),
    (
        "partition-identity",
        "Drop the pool bound on the admitted count, so a pool narrower than the "
        "cutoff yields an admitted count above the pool and the three partition "
        "terms no longer sum to the denominator. This is the historical defect.",
        "const admittedAtOne = toQuestions(curve.recallAtOne, considered, coveredQuestions);",
        "const admittedAtOne = toQuestions(curve.recallAtOne, considered);",
    ),
    (
        "unclamp-retrieval-gap",
        "Let the retrieval gap go negative instead of clamping, so a covered count "
        "above the denominator subtracts from the partition.",
        "const retrievalGapQuestions = Math.max(0, considered - coveredQuestions);",
        "const retrievalGapQuestions = considered - coveredQuestions;",
    ),
    (
        "negative-retrieval-gap-past-denominator",
        "Compute the retrieval gap from the admitted count rather than the covered "
        "count, which double-counts the ranking gap and overstates the misses.",
        "const retrievalGapQuestions = Math.max(0, considered - coveredQuestions);",
        "const retrievalGapQuestions = Math.max(0, considered - admittedAtOne);",
    ),
    (
        "swap-the-two-gap-terms",
        "Report the covered-but-unadmitted questions as the retrieval gap and the "
        "never-retrieved ones as the ranking gap, so each figure names the wrong "
        "subsystem.",
        "  const rankingGapQuestions = Math.max(0, coveredQuestions - admittedAtOne);\n"
        "  const retrievalGapQuestions = Math.max(0, considered - coveredQuestions);",
        "  const rankingGapQuestions = Math.max(0, considered - coveredQuestions);\n"
        "  const retrievalGapQuestions = Math.max(0, coveredQuestions - admittedAtOne);",
    ),
    (
        "abstention-counted-in-gap",
        "Subtract the abstention questions from the ranking gap, double-removing a "
        "population the curve already excluded by construction.",
        "  const recoverableFromRanking = rankingGapFailureCount({\n"
        "    coveredQuestions,\n"
        "    admittedAtOne,\n"
        "    readerCorrect,\n"
        "  });",
        "  const recoverableFromRanking = Math.max(\n"
        "    0,\n"
        "    rankingGapFailureCount({\n"
        "      coveredQuestions: coveredQuestions - abstentionQuestions,\n"
        "      admittedAtOne,\n"
        "      readerCorrect,\n"
        "    }),\n"
        "  );",
    ),
    (
        "absorbed-not-subtracted",
        "Stop giving up the questions the reader already absorbed, so a ranking "
        "change is credited with questions that need no change.",
        "  const absorbed = Math.max(0, input.readerCorrect - input.admittedAtOne);",
        "  const absorbed = 0;",
    ),
    (
        "absorbed-clamped-wrong-side",
        "Compute the absorbed count as covered-minus-correct, which is negative "
        "exactly when the reader is doing well.",
        "  const absorbed = Math.max(0, input.readerCorrect - input.admittedAtOne);",
        "  const absorbed = Math.max(0, input.coveredQuestions - input.readerCorrect);",
    ),
    (
        "abstention-capability-misclassified",
        "Route the abstention capability's gain into the non-abstention total, so "
        "the +29 that came from learning to refuse is credited to retrieval.",
        "    if (abstentionSet.has(entry.capability)) {\n"
        "      improvementFromAbstention += gain;",
        "    if (false) {\n"
        "      improvementFromAbstention += gain;",
    ),
    (
        "unchanged-capability-not-reported",
        "Report a capability that went backwards as unchanged, which is what the "
        "conjunction arm needed the identity of the flips to disprove.",
        "    if (gain === 0) {\n      unchangedCapabilities.push(entry.capability);",
        "    if (gain <= 0) {\n      unchangedCapabilities.push(entry.capability);",
    ),
    (
        "unmatched-capability-scored",
        "Score a capability the baseline never measured as a gain, which is how a "
        "mismatched pair of artifacts becomes a fabricated delta.",
        "    const before = baselineByCapability.get(entry.capability);\n"
        "    if (!before) {\n      continue;\n    }",
        "    const before = baselineByCapability.get(entry.capability) ?? {\n"
        "      capability: entry.capability,\n"
        "      total: 0,\n"
        "      correct: 0,\n"
        "      abstained: 0,\n"
        "    };",
    ),
    (
        "run-denominator-from-feature",
        "Take the run's question count from the feature arm instead of the "
        "baseline, so the population is the one the accuracy does not belong to.",
        "  const runQuestionCount = baseline.reduce((sum, entry) => sum + entry.total, 0);",
        "  const runQuestionCount = feature.reduce((sum, entry) => sum + entry.total, 0);",
    ),
    (
        "absent-from-denominator-unclamped",
        "Let the absent-from-denominator count go negative when the curve covers "
        "more questions than the run graded.",
        "  absentFromDenominatorQuestions: Math.max(0, runQuestionCount - considered),",
        "  absentFromDenominatorQuestions: runQuestionCount - considered,",
    ),
    (
        "abstention-count-from-baseline",
        "Size the abstention population from the baseline arm, so the +29 the "
        "feature added reads as zero and the two populations stop being separable.",
        "  const abstentionQuestions = feature\n"
        "    .filter((entry) => abstentionSet.has(entry.capability))\n"
        "    .reduce((sum, entry) => sum + entry.total, 0);",
        "  const abstentionQuestions = baseline\n"
        "    .filter((entry) => abstentionSet.has(entry.capability))\n"
        "    .reduce((sum, entry) => sum + entry.total, 0);",
    ),
    (
        "round-down-instead-of-nearest",
        "Truncate the fraction-to-count conversion, so a 0.9626 ceiling reports one "
        "fewer covered question than the curve's own recall figure implies.",
        "  const count = Math.max(0, Math.round(fraction * considered));",
        "  const count = Math.max(0, Math.floor(fraction * considered));",
    ),
]


def md5(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def run_tests() -> tuple[bool, str]:
    proc = subprocess.run(
        ["pnpm", "exec", "vitest", "run", TEST],
        cwd=PKG,
        capture_output=True,
        text=True,
    )
    out = proc.stdout + proc.stderr
    return proc.returncode == 0, out


def main() -> int:
    original = SRC.read_text()
    baseline = md5(SRC)
    print(f"baseline md5 {baseline}")

    green, out = run_tests()
    if not green:
        print("BASELINE SUITE IS RED -- fix that before injecting.")
        print(out[-3000:])
        return 2

    caught = 0
    missed: list[str] = []
    for name, defect, old, new in MUTATIONS:
        if SRC.read_text().count(old) != 1:
            print(f"SKIP {name}: anchor not found exactly once")
            missed.append(f"{name} (anchor)")
            continue
        SRC.write_text(SRC.read_text().replace(old, new, 1))
        try:
            still_green, out = run_tests()
        finally:
            SRC.write_text(original)
        if md5(SRC) != baseline:
            print("RESTORE FAILED -- aborting.")
            return 3
        if still_green:
            print(f"MISSED {name}: {defect}")
            missed.append(name)
        else:
            summary = [ln.strip() for ln in out.splitlines() if "Tests " in ln]
            print(f"CAUGHT {name}: {summary[-1] if summary else 'tests failed'}")
            caught += 1

    print()
    if missed:
        print(f"{caught} of {len(MUTATIONS)} caught. MISSED: {', '.join(missed)}")
        return 1
    print(f"All {len(MUTATIONS)} mutations caught; implementation restored at {md5(SRC)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
