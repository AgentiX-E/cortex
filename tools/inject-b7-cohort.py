#!/usr/bin/env python3
"""Mutation injection for the B7 criterion module.

The module exists because a published criterion named a COUNT and not a ROSTER.
So the mutations here are aimed at the two things that make it more than a
transcription: that the roster is RECOMPUTED, and that the verdicts cannot be
reached by accident.

Two failure modes this harness guards against, both learned the hard way:

  * **A red baseline disguises itself as "all caught."** If the suite is already
    failing for an unrelated reason, every mutation reports "caught". The suite
    is therefore re-checked for green AFTER each restore, and a non-green
    baseline is reported as VOID and fails the run.

  * **An unreachable branch cannot be caught, and asserting it is not the fix.**
    Some mutations are behaviourally equivalent on every reachable input. Those
    are declared `unobservable` with the measurement that establishes it, not
    quietly counted as successes.
"""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PKG = ROOT / "packages" / "cortex-eval"
TARGET = PKG / "src" / "b7-cohort.ts"
TEST = "src/__tests__/b7-cohort.test.ts"
VITEST = ROOT / "node_modules" / ".bin" / "vitest"


@dataclass(frozen=True)
class Mutation:
    name: str
    anchor: str
    replacement: str
    # True when the mutation cannot change behaviour on any reachable input.
    # The reason is recorded in the report so a reader can check the claim.
    unobservable: str | None = None


MUTATIONS: list[Mutation] = [
    Mutation(
        name="grounded-checked-after-clustering",
        anchor="    if (!entry.grounded) {\n      notGrounded.push(entry.questionId);\n      continue;\n    }",
        replacement="    // moved below: grounding no longer gates clustering",
    ),
    Mutation(
        name="identical-checked-after-clustering",
        anchor="    if (valuesAreIdentical(entry.groundTruth, entry.answer)) {",
        replacement="    if (false && valuesAreIdentical(entry.groundTruth, entry.answer)) {",
    ),
    Mutation(
        name="identical-compared-by-string-equality",
        anchor="  const a = contentTerms(truth);\n  const b = contentTerms(answer);",
        replacement="  const a = truth === undefined || truth === null ? [] : [String(truth)];\n  const b = answer === undefined || answer === null ? [] : [String(answer)];",
    ),
    Mutation(
        name="identical-empty-value-counts-as-match",
        anchor="  if (a.length === 0 || b.length === 0) return false;",
        replacement="  if (a.length === 0 && b.length === 0) return true;",
    ),
    Mutation(
        name="sides-length-guard-off-by-one",
        anchor="    if (sides.length < 2) {",
        replacement="    if (sides.length < 1) {",
    ),
    Mutation(
        name="truth-cluster-read-from-answer-side",
        anchor="    const truthCluster = clusterOfIn(clusters, sides[0]!);",
        replacement="    const truthCluster = clusterOfIn(clusters, sides[1]!);",
    ),
    Mutation(
        name="missing-cluster-treated-as-a-target",
        anchor="    if (truthCluster === null || answerCluster === null) {",
        replacement="    if (false && (truthCluster === null || answerCluster === null)) {",
    ),
    # REMOVED, behaviourally equivalent rather than unobservable-by-aim.
    #
    # `cluster-identity-by-reference` replaced `sameTerms(cluster.terms, side)`
    # with `cluster.terms === side`. `clusterCandidates` builds `usable` with
    # `sides.filter(s => s.length > 0)` and stores `usable[i]` directly, so when
    # no side is empty the stored array IS the side array, and the reference
    # comparison is true exactly when the value comparison is. `computeTargetCohort`
    # reaches the lookup only after `sides.length >= 2`, and an empty side is
    # dropped by the filter without changing which sides survive, so the
    # reference identity holds on every reachable input. Measured: the mutation
    # produced byte-identical `computeTargetCohort` output over the whole test
    # corpus. Writing a test to kill it would freeze a reference-vs-value
    # distinction that no input can observe.
    Mutation(
        name="identical-set-equality-dropped",
        anchor="  return a.every((term) => bSet.has(term)) && b.every((term) => new Set(a).has(term));",
        replacement="  return a.every((term) => bSet.has(term));",
        unobservable="a.length === b.length is already required, and contentTerms de-duplicates, so a subset of b with equal length implies a == b. Measured: contentTerms('bike bike') === ['bike'].",
    ),
    Mutation(
        name="verdict-matches-without-comparing-missing",
        anchor="  if (missing.length === 0 && unexpected.length === 0) {",
        replacement="  if (unexpected.length === 0) {",
    ),
    Mutation(
        name="verdict-ignores-unexpected",
        anchor="  if (missing.length === 0 && unexpected.length === 0) {",
        replacement="  if (missing.length === 0) {",
    ),
    Mutation(
        name="regression-check-skipped",
        anchor="  if (regressed.length > 0) return { kind: 'regression', regressed };",
        replacement="  if (false && regressed.length > 0) return { kind: 'regression', regressed };",
    ),
    Mutation(
        name="no-move-check-skipped",
        anchor="  if (moved.length === 0) {",
        replacement="  if (false) {",
    ),
    Mutation(
        name="non-targets-classified-as-targets",
        anchor="    if (targetIds.has(id)) {",
        replacement="    if (true) {",
    ),
    Mutation(
        name="unmatched-question-compared-as-undefined",
        anchor="    if (!controlById.has(id)) continue;",
        replacement="    // guard removed",
    ),
    Mutation(
        name="abstention-not-distinguished-from-answer",
        anchor="    const changed = before !== after;",
        replacement="    const changed = (before === null) !== (after === null);",
    ),
    Mutation(
        name="distinct-cluster-invariant-always-true",
        anchor="    if (seen.has(cluster.id)) return false;",
        replacement="    if (false && seen.has(cluster.id)) return false;",
    ),
]


def run_suite() -> bool:
    """True when the suite is green. Used as the baseline and the restore check."""
    result = subprocess.run(
        [str(VITEST), "run", TEST],
        cwd=PKG,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def main() -> int:
    original = TARGET.read_text()

    if not run_suite():
        print("VOID: the suite is not green before injection. Nothing measured.")
        return 4

    caught: list[str] = []
    survived: list[str] = []
    declared: list[str] = []

    for mutation in MUTATIONS:
        if mutation.anchor not in original:
            print(f"SKIP  {mutation.name}: anchor not found (tool needs updating)")
            continue
        TARGET.write_text(original.replace(mutation.anchor, mutation.replacement, 1))
        try:
            green = run_suite()
        finally:
            TARGET.write_text(original)

        # Restore check. A red baseline makes every mutation look caught, and a
        # tool that reports "caught" for the wrong reason is worse than no tool.
        if not run_suite():
            print(f"VOID  {mutation.name}: the suite did not return to green after restore")
            return 4

        if not green:
            caught.append(mutation.name)
            print(f"caught        {mutation.name}")
        elif mutation.unobservable is not None:
            declared.append(mutation.name)
            print(f"unobservable  {mutation.name}: {mutation.unobservable}")
        else:
            survived.append(mutation.name)
            print(f"SURVIVED      {mutation.name}")

    print()
    print(f"{len(caught)} of {len(MUTATIONS)} caught, {len(declared)} declared unobservable")
    if survived:
        print("survivors: " + ", ".join(survived))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
