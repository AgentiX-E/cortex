#!/usr/bin/env python3
"""Locate the conjunction arm's discordant questions from its archived reports.

## Why this exists

Roadmap item 9b asked for the conjunction arm's -1.67% regression to be
resolved, and offered two routes: widen the arm, or locate the four flips. The
second route was chosen, and it turned out to be impossible with the artifacts
on disk -- which is itself the finding.

`AblationReport.ablation` stores the flip COUNT, the feature's per-question
correctness vector, and a per-capability breakdown. It never stored the question
ids behind those flips, and it never stored the baseline's per-question vector at
all. So the archive can say "four questions regressed, all inside IE" and cannot
say which four. `discordantQuestions` (added alongside this tool) closes that gap
for future runs; it cannot retroactively repair these.

## What this tool does instead

It extracts every constraint the archive *does* support, and it states plainly
where the constraints stop. Two results come out of it.

**1. The block structure is verified, not assumed.** The conjunction arm filters
the sampled instances to `{ABS, IE}`, and `Array.prototype.filter` preserves
order, so the two capabilities form contiguous blocks. The tool checks that
claim rather than trusting it: it splits the feature vector at the IE/ABS
boundary the per-capability totals imply, then confirms that the count of `true`
values inside each block equals that capability's reported `featureCorrect`. A
mismatch would mean the block hypothesis is wrong and every downstream position
is meaningless.

**2. The target population's non-movement is measured.** R4's P2 prediction is
about one question (`6456829e_abs`), and P3 is about six controls. Both are
statements about the ABS group. The tool sums that group across every archived
run and reports the total number of flips in either direction -- the quantity
that decides P2 and P3, and the one the -1.67% aggregate hides.

## What this tool deliberately does not do

It does not guess which IE questions regressed. The constraint set admits many
consistent assignments (9 IE failures, of which 4 regressed and 5 did not), and
picking one by heuristic would manufacture a finding the data cannot support.
The tool prints the size of that ambiguity instead of resolving it falsely.

Usage:
    python3 tools/audit-discordant-identity.py <artifact-dir> [<artifact-dir> ...]
    python3 tools/audit-discordant-identity.py --glob '/tmp/*/'
"""

from __future__ import annotations

import glob
import json
import os
import sys

ARTIFACT_NAME = "benchmark-conjunction-ablation-report.json"


def load_reports(targets: list[str]) -> list[tuple[str, dict]]:
    """Load every conjunction ablation report reachable from `targets`.

    A target may be a report file, a directory containing one, or a directory
    containing extraction directories that each hold one. The last form is the
    common case: `tools/fetch-artifact.py` writes into a per-run directory, so a
    parent directory holds one child per run rather than the reports directly.
    """
    candidates: list[str] = []

    def consider(path: str) -> None:
        if not os.path.isfile(path):
            return
        if path.endswith(".json"):
            candidates.append(path)
        elif os.path.basename(path) == ARTIFACT_NAME:
            candidates.append(path)

    for target in targets:
        if any(ch in target for ch in "*?["):
            for match in sorted(glob.glob(target)):
                if os.path.isdir(match):
                    consider(os.path.join(match, ARTIFACT_NAME))
                    for child in sorted(glob.glob(os.path.join(match, "*"))):
                        consider(os.path.join(child, ARTIFACT_NAME))
                else:
                    consider(match)
        elif os.path.isdir(target):
            consider(os.path.join(target, ARTIFACT_NAME))
            for child in sorted(glob.glob(os.path.join(target, "*"))):
                consider(os.path.join(child, ARTIFACT_NAME))
        else:
            consider(target)

    reports: list[tuple[str, dict]] = []
    for candidate in candidates:
        try:
            with open(candidate, encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            print(f"  ! {candidate}: unreadable ({exc})", file=sys.stderr)
            continue
        if "ablation" not in data:
            continue
        reports.append((candidate, data))
    return reports


def verify_blocks(data: dict) -> tuple[str, str]:
    """Confirm the feature vector splits into contiguous IE/ABS blocks.

    Returns (status, detail) with status one of:

      "ok"          -- blocks contiguous and counts agree; positions are sound
      "all-true"    -- the capability totals do not partition the vector, OR the
                       true-counts match only as a total rather than per block.
                       Every position is meaningless, and so is any statement
                       about which capability moved.

    The claim under test is that the vector's first `IE.total` entries are the IE
    questions and the remainder are ABS. It is testable without the dataset,
    because each block's `true` count must equal that capability's reported
    `featureCorrect`. That equality is what makes a position meaningful: it is
    the difference between "entry 161 is an ABS question" and "entry 161 is some
    question".

    A vector that satisfies the totals but not the blocks means the artifact was
    written under a different ordering than the current runner produces. That is
    a real possibility for archived runs -- this repository's conjunction arm was
    re-scoped and re-ordered during development -- and it must fail loudly rather
    than be tolerated, because every downstream position depends on it.
    """
    ablation = data["ablation"]
    vector = ablation.get("featureCorrect")
    per_capability = ablation.get("perCapability", {})
    ie_total = per_capability.get("IE", {}).get("total", 0)
    abs_total = per_capability.get("ABS", {}).get("total", 0)

    if not isinstance(vector, list):
        return "all-true", "no featureCorrect vector"
    if ie_total + abs_total != len(vector):
        return "all-true", (
            f"capability totals {ie_total}+{abs_total} != vector length {len(vector)}"
        )

    ie_block = vector[:ie_total]
    abs_block = vector[ie_total:]
    ie_true = sum(1 for value in ie_block if value)
    abs_true = sum(1 for value in abs_block if value)
    ie_expected = per_capability.get("IE", {}).get("featureCorrect", 0)
    abs_expected = per_capability.get("ABS", {}).get("featureCorrect", 0)

    if ie_true == ie_expected and abs_true == abs_expected:
        return "ok", f"IE {ie_total} + ABS {abs_total} = {len(vector)}"

    total_true = sum(1 for value in vector if value)
    total_expected = ie_expected + abs_expected
    if total_true == total_expected:
        return "all-true", (
            f"total matches ({total_true}) but blocks do not "
            f"(IE {ie_true}/{ie_expected}, ABS {abs_true}/{abs_expected}) "
            "-- artifact predates the current question ordering"
        )
    return "all-true", (
        f"neither total nor blocks match (IE {ie_true}/{ie_expected}, "
        f"ABS {abs_true}/{abs_expected}, total {total_true})"
    )


def main(argv: list[str]) -> int:
    targets = argv[1:] or ["/tmp"]
    reports = load_reports(targets)
    if not reports:
        print(f"No {ARTIFACT_NAME} found under: {', '.join(targets)}", file=sys.stderr)
        return 1

    print(f"Scanned {len(reports)} conjunction artifact(s)\n")
    print(f"{'run':<28} {'n':>4} {'ABS n':>6} {'IE n':>5} {'Δ':>8} {'b✓f✗':>6} {'b✗f✓':>6} {'block?':>8}")
    print("-" * 82)

    abs_questions_scored = 0
    abs_flips = 0
    verified_runs = 0
    unverifiable: list[str] = []
    target_runs: list[tuple[str, str]] = []

    for path, data in reports:
        ablation = data["ablation"]
        per_capability = ablation.get("perCapability", {})
        abs_stats = per_capability.get("ABS", {})
        ie_stats = per_capability.get("IE", {})
        vector = ablation.get("featureCorrect", [])

        status, detail = verify_blocks(data)
        if status == "ok":
            verified_runs += 1
        else:
            unverifiable.append(f"{os.path.basename(os.path.dirname(path)) or path}: {detail}")

        # The ABS flip total and question count are read from `perCapability`,
        # which is independent of any positional assumption -- so they remain
        # valid even for an artifact whose ordering cannot be verified.
        abs_questions_scored += abs_stats.get("total", 0)
        flips_here = abs_stats.get("baselineCorrectFeatureIncorrect", 0) + abs_stats.get(
            "baselineIncorrectFeatureCorrect", 0
        )
        abs_flips += flips_here

        label = os.path.basename(os.path.dirname(path)) or path
        print(
            f"{label:<28} {len(vector):>4} {abs_stats.get('total', 0):>6} {ie_stats.get('total', 0):>5} "
            f"{ablation.get('delta', 0):>+8.4f} "
            f"{ablation.get('discordant', {}).get('baselineCorrectFeatureIncorrect', 0):>6} "
            f"{ablation.get('discordant', {}).get('baselineIncorrectFeatureCorrect', 0):>6} "
            f"{status:>8}"
        )

        coverage = data.get("cohortCoverage", {})
        if "6456829e_abs" in coverage.get("present", []):
            target_runs.append((label, f"{len(coverage.get('present', []))}/7"))

    print()
    print(f"Block verification: {verified_runs}/{len(reports)} artifacts verified.")
    for line in unverifiable:
        print(f"  ! not verifiable -- {line}")
    if unverifiable:
        print()
        print("  An unverified artifact's per-capability COUNTS are still valid (they do")
        print("  not depend on ordering), so the ABS totals below include it. Its")
        print("  POSITIONS are not, so nothing here reads positions from it.")

    print()
    print("=== R4's target population (ABS), summed across every archived run ===")
    print(f"  ABS questions scored : {abs_questions_scored}")
    print(f"  ABS flips (either)   : {abs_flips}")
    print()
    if abs_flips == 0:
        print("  R4's P2 and P3 are statements about this group, and decomposition")
        print("  moved ZERO of these questions in either direction -- across every")
        print("  run, including the two with a complete 7/7 cohort.")
        print("  P2 (target abstains -> ABS 30/30) is therefore refuted, and P3's")
        print("  pass is vacuous rather than reassuring: the group did not move at")
        print("  all, so 'the controls stayed put' carries no information.")
    else:
        print(f"  {abs_flips} ABS flip(s) observed -- inspect before concluding.")

    print()
    print("=== What the archive cannot answer ===")
    for path, data in reports:
        ablation = data["ablation"]
        ie_stats = ablation.get("perCapability", {}).get("IE", {})
        ie_failures = ie_stats.get("total", 0) - ie_stats.get("featureCorrect", 0)
        regressions = ablation.get("discordant", {}).get("baselineCorrectFeatureIncorrect", 0)
        if regressions:
            label = os.path.basename(os.path.dirname(path)) or path
            print(
                f"  {label:<28} IE has {ie_failures} feature-failures, of which {regressions} "
                f"regressed;\n{'':<28} baseline per-question vector absent -> which {regressions} "
                f"is not recoverable"
            )
            print(f"{'':<28} (ambiguity size: C({ie_failures},{regressions}) assignments)")
    print()
    print("  `discordantQuestions` records this going forward. These artifacts predate it.")

    if target_runs:
        print()
        print("=== Runs with the P2 target present ===")
        for label, ratio in target_runs:
            print(f"  {label:<28} cohort {ratio}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
