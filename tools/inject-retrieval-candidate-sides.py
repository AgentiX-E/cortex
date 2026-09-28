#!/usr/bin/env python3
"""Defect-injection harness for `retrievalCandidateSides`, the channel C producer.

Why a third harness for the same file
-------------------------------------
`inject-candidate-context.py` mutates the clustering and rendering of the B7
intervention; `inject-b7-wiring.py` mutates how the option reaches them. Neither
can see this function, and it is the one whose defect has the lowest visibility
of the three: an implementation that returns `[]` is not a crash and not a wrong
label -- it is the feature switching itself off. The A/B would then report two
byte-identical arms, which is exactly the failure mode `docs/16.13` records from
the previous run.

The first implementation did in fact return `[]` on the very fixture these tests
use, and it did so while reading as correct: recurrence was checked BEFORE the
spans were grouped by head, so the one modifier that appears once was discarded
and the slot was left with a single alternative. That is mutation
`require-recurrence-before-grouping` below, and it is written from the measured
output rather than from reasoning about the code.

Mutations that would be unobservable are not included. `splitSpan`'s
`space === -1` arm is one: the keys are built by template interpolation of two
tokens joined by a space, so no key can lack one. If a future revision builds
keys differently, that arm becomes reachable and gets a mutation then; adding a
test for it now would pin a branch that no input can take.

Every mutation states the defect and the tests it should break. A mutation that
leaves the suite green means the suite does not test that behaviour, which is the
finding -- not a pass. The file is restored byte-for-byte after each mutation and
the restore is verified by md5, so a crash cannot leave a mutated implementation
behind.
"""

from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

SRC = Path("/workspace/cortex/packages/cortex-eval/src/candidate-context.ts")
PKG = SRC.parent.parent
TEST = "src/__tests__/retrieval-candidate-sides.test.ts"

MUTATIONS = [
    (
        "require-recurrence-before-grouping",
        "Require each span to recur before grouping it by head -- the FIRST "
        "IMPLEMENTATION'S ACTUAL BUG. Measured: `racing bike` recurs while "
        "`cargo bike` appears once, so the alternative that makes the pair is "
        "discarded, the slot keeps a single modifier, and the function returns "
        "[]. The feature switches itself off and the A/B reports two identical "
        "arms. Recurrence is a property of the SLOT, not of each modifier.",
        "  const byHead = new Map<string, { modifier: string; turns: Set<number> }[]>();\n"
        "  for (const [key, turns] of spans) {",
        "  const byHead = new Map<string, { modifier: string; turns: Set<number> }[]>();\n"
        "  for (const [key, turns] of spans) {\n"
        "    if (turns.size < 2) continue;",
    ),
    (
        "drop-the-recurrence-requirement",
        "Accept a slot on two modifiers alone, with no evidence the retrieval "
        "revisits it. Then two values named in ONE sentence become a 'competition', "
        "so a question naming two bikes in a single turn reports them as "
        "alternatives it must choose between.",
        "      group.length >= 2 &&\n"
        "      (group.some((entry) => entry.turns.size >= 2) || headTurnCount(group) >= 2),",
        "      group.length >= 2 || headTurnCount(group) >= 0,",
    ),
    (
        "accept-one-turn-as-a-slot",
        "Accept a slot the retrieval touches exactly once, by counting any "
        "alternative at size >= 1. NOT INCLUDED AS A LIVE MUTATION: with "
        "`group.length >= 2` already established and every entry coming from a "
        "real span (so size >= 1 by construction), `group.some(size >= 1)` is "
        "always true, and this reduction is byte-for-byte "
        "`drop-the-recurrence-requirement` -- which IS caught. Kept here as a "
        "record so the reduction is not re-derived by hand next time. See "
        "`EQUIVALENT_MUTATIONS`.",
        "      (group.some((entry) => entry.turns.size >= 2) || headTurnCount(group) >= 2),",
        "      (group.some((entry) => entry.turns.size >= 1) || headTurnCount(group) >= 1),",
        False,
    ),
    (
        "drop-the-head-turn-count",
        "Require a recurring MODIFIER only, dropping the head count -- the defect "
        "that discarded a three-alternative bike slot (cargo/racing/touring, each "
        "named once) in favour of a two-alternative car slot, so a retrieval "
        "raising a three-way choice was annotated as the two-way one.",
        "      (group.some((entry) => entry.turns.size >= 2) || headTurnCount(group) >= 2),",
        "      (group.some((entry) => entry.turns.size >= 2) && headTurnCount(group) >= 0),",
        True,
    ),
    (
        "require-all-modifiers-to-recur",
        "Demand that EVERY modifier recur. NOT INCLUDED AS A LIVE MUTATION: "
        "enumerated over every reachable slot state (sizes (1,1) through (3,1), "
        "with and without turn overlap), it differs from the baseline on ZERO of "
        "them -- a slot whose every modifier recurs already satisfies "
        "`some(...)`, and a slot that fails `every` but passes `some` is "
        "disjoint from the two-modifier states `group.length >= 2` admits. An "
        "equivalent mutant, so no test can catch it and no test should try. Kept "
        "here as the record of that enumeration.",
        "      (group.some((entry) => entry.turns.size >= 2) || headTurnCount(group) >= 2),",
        "      (group.every((entry) => entry.turns.size >= 2) || headTurnCount(group) >= 2),",
        False,
    ),
    (
        "return-one-side-instead-of-none",
        "Return a single side when no competition is found, so a caller that "
        "trusts a non-empty result annotates a question with one candidate. "
        "`discriminateContext` would still decline, but the producer's contract "
        "-- 'fewer than two means no competition' -- would be broken silently.",
        "  if (best === undefined) return [];",
        "  if (best === undefined) return [[...spans.keys()][0] ?? 'none'];",
    ),
    (
        "keep-assistant-turns-in-the-spans",
        "Build the sides from assistant turns too. `sideForTurn` refuses assistant "
        "turns, so a side drawn only from the assistant's vocabulary matches no "
        "turn and the cluster comes back empty even though sides were produced.",
        "  const userTurns = input.retrieved.filter((turn) => parseTurn(turn.text).role !== 'assistant');",
        "  const userTurns = [...input.retrieved];",
    ),
    (
        "take-unigrams-instead-of-two-word-spans",
        "Treat each content word as a candidate instead of each two-word span. "
        "Then the sides are `bike` against `coast` -- the words the candidates "
        "SHARE -- and a turn matching both is dropped by `sideForTurn`, leaving "
        "the closer with no evidence at all.",
        "      const key = `${modifier} ${head}`;",
        "      const key = `${modifier} ${head} ${modifier}`;",
    ),
    (
        "head-becomes-the-modifier",
        "Swap the roles, so a candidate is identified by its slot word. Both "
        "sides then carry `bike` and the pair discriminates nothing.",
        "  return chosen.map((entry) => [entry.modifier, headWord]);",
        "  return chosen.map((entry) => [headWord, entry.modifier]);",
    ),
    (
        "keep-all-alternatives-instead-of-two",
        "Return every alternative rather than narrowing to two, so a "
        "three-candidate retrieval produces three sides and `sideForTurn` labels "
        "a ternary choice as if it were binary.",
        "  const chosen = ordered.length <= 2 ? ordered : pickWithAnswer(ordered, answerTerms);",
        "  const chosen = ordered;",
    ),
    (
        "ignore-the-answer-when-narrowing",
        "Narrow by position alone. Measured: the system answered `the touring "
        "bike`, which is alphabetically LAST, so the one alternative it actually "
        "chose is discarded and the clustering labels turns for a candidate the "
        "arm never produced.",
        "  if (mentioned.length !== 1) return ordered.slice(0, 2);",
        "  if (mentioned.length >= 0) return ordered.slice(0, 2);",
    ),
    (
        "narrow-on-any-answer-overlap",
        "Treat a partial mention as a decision. `mentioned.length !== 1` is what "
        "makes the answer authoritative ONLY when it commits; `>= 1` makes it "
        "authoritative whenever it overlaps at all, so an answer naming two "
        "alternatives picks them instead of declining to choose -- and the pair "
        "then depends on the ORDER OF THE HEDGE. Measured: with the answer "
        "`racing and touring bike` the baseline returns [cargo, racing] while "
        "this mutation returns [racing, cargo].",
        "  if (mentioned.length !== 1) return ordered.slice(0, 2);",
        "  if (mentioned.length < 1) return ordered.slice(0, 2);",
    ),
    (
        "order-modifiers-by-arrival-not-alphabetically",
        "Rank the alternatives by the order their spans were discovered, which is "
        "the order the retriever returned its turns. The sides then change when "
        "the retriever reorders -- an A/B that cannot be bisected.",
        "  const ordered = [...group].sort((a, b) => (a.modifier < b.modifier ? -1 : 1));",
        "  const ordered = [...group];",
    ),
    (
        "break-ties-by-most-alternatives-then-arrival",
        "Drop the alphabetical tie-break between equally competitive slots, so "
        "which slot wins depends on `Map` insertion order. Measured on a fixture "
        "where `bike` and `car` both hold two alternatives: the result changes "
        "when the turns are reversed.",
        "    a[1].length === b[1].length ? (a[0] < b[0] ? -1 : 1) : b[1].length - a[1].length,",
        "    b[1].length - a[1].length,",
    ),
    (
        "prefer-the-slot-with-the-fewest-alternatives",
        "Invert the ranking, so the LEAST contested slot wins. A retrieval that "
        "mentions a two-candidate slot and a four-candidate one would be resolved "
        "against the wrong question.",
        "    a[1].length === b[1].length ? (a[0] < b[0] ? -1 : 1) : b[1].length - a[1].length,",
        "    a[1].length === b[1].length ? (a[0] < b[0] ? -1 : 1) : a[1].length - b[1].length,",
    ),
    (
        "read-the-question-instead-of-the-retrieval",
        "Form the sides from the question's content words -- channel B by another "
        "name. The test that matters is the CONTRAST, and this mutation is what "
        "that test exists to catch: the output is well-formed, plausible, and "
        "identical in kind to the inert path the design ruling rejected.",
        "  const best = competitive.sort((a, b) =>",
        "  return [discriminatingQuestionTerms(input.question)];\n"
        "  const best = competitive.sort((a, b) =>",
    ),
    (
        "drop-the-empty-retrieval-guard",
        "Remove the early return for an empty retrieval. NOT INCLUDED AS A LIVE "
        "MUTATION: nothing below can form a span without turns, so the observable "
        "result is unchanged and this is an equivalent mutant by construction. It "
        "is recorded rather than deleted to document the measurement -- if it is "
        "ever the only entry left in EQUIVALENT_MUTATIONS that is NOT also "
        "subsumed by a live one, that would mean the guard had acquired "
        "observable behaviour, and the guard should be re-read.",
        "  if (userTurns.length === 0) return [];\n\n",
        "",
        False,
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

    live = [m for m in MUTATIONS if len(m) == 4 or m[4]]
    equivalent = [m for m in MUTATIONS if len(m) == 5 and not m[4]]
    print(f"{len(live)} live mutations, {len(equivalent)} recorded as equivalent\n")

    caught = 0
    missed: list[str] = []
    for entry in MUTATIONS:
        name, defect, old, new = entry[:4]
        is_live = len(entry) == 4 or entry[4]
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
            if is_live:
                print(f"MISSED {name}: {defect}")
                missed.append(name)
            else:
                # Expected: the entry documents a mutation that is equivalent by
                # construction, so a green suite is the CORROBORATION of that
                # claim rather than a gap. If it ever fails, the equivalence
                # argument is wrong and the entry must be promoted to live.
                print(f"CONFIRMED-EQUIVALENT {name}: the suite correctly does not see it")
        else:
            summary = [ln.strip() for ln in out.splitlines() if "Tests " in ln]
            label = "CAUGHT" if is_live else "CONTRADICTED"
            print(f"{label} {name}: {summary[-1] if summary else 'tests failed'}")
            if is_live:
                caught += 1
            else:
                missed.append(f"{name} (claimed equivalent but the suite sees it)")

    print()
    if missed:
        print(f"{caught} of {len(live)} live mutations caught. PROBLEMS: {', '.join(missed)}")
        return 1
    print(
        f"All {len(live)} live mutations caught; {len(equivalent)} equivalent ones "
        f"confirmed invisible. Implementation restored at {md5(SRC)}."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
