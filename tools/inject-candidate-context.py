#!/usr/bin/env python3
"""Defect-injection harness for candidate-context.ts, the B7 intervention.

Each mutation states the defect it introduces and the tests it should break. A
mutation that leaves the suite green means the suite does not test that
behaviour, which is the finding -- not a pass.

This module has a history that makes the harness unusually load-bearing. Its first
revision annotated ZERO of 17 real questions while passing 46 unit tests: the
tests and the implementation agreed with each other and both disagreed with the
data. Three of the mutations below are the actual defects that run exposed, so a
green suite under them would reproduce the original failure inside the harness.

The file is restored byte-for-byte after every mutation and the restore is
verified by md5, so a run that crashes cannot leave a mutated implementation
behind.

Three mutations from the first revision were unobservable and were replaced
rather than kept, because a mutation nothing can see reports nothing. The
replacements came out of measuring the mutated output instead of reasoning about
it:

  * "label-on-empty-context" and "accept-out-of-range-index" guarded code that
    no input could reach. The correct response was to DELETE the guards, not to
    test them -- the null-context case is already covered by the newline/turn
    disagreement check, and an out-of-range index already falls out of the
    membership lookup unlabelled. Adding a test for either would have pinned a
    branch that does nothing.
  * "drop-the-role-preserving-fallback" was equivalent to the code it mutated:
    collapse appendLabel's three shape-matching arms into a plain append and the
    suite stayed green, so the arms were deleted. That deletion is itself the
    finding -- the arms made the reader's role adjacency look load-bearing when
    the line shape was carrying it.

Every remaining mutation changes what a caller observes. If a new one does not,
read the mutated output before touching the suite: the defect may be the
implementation, not the tests.
"""

from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

SRC = Path("/workspace/cortex/packages/cortex-eval/src/candidate-context.ts")
PKG = SRC.parent.parent
TEST = "src/__tests__/candidate-context.test.ts"

MUTATIONS = [
    (
        "cluster-on-question-framing",
        "Cluster on the question's content words instead of the two sides' -- the "
        "defect that annotated 0 of 17 real questions while all 46 tests passed.",
        "  const sides = candidateSides(options);\n"
        "  if (sides.length < 2) {",
        "  const sides = [discriminatingQuestionTerms(options.question)];\n"
        "  if (sides.length < 1) {",
    ),
    (
        "keep-shared-tokens-in-both-sides",
        "Leave a token shared by both sides in both, so it cannot discriminate and "
        "both candidates land on the same turns.",
        "  const truthOnly = truth.filter((term) => !answerSet.has(term));\n"
        "  const answerOnly = answer.filter((term) => !truthSet.has(term));",
        "  const truthOnly = [...truth];\n"
        "  const answerOnly = [...answer];",
    ),
    (
        "require-all-terms-instead-of-any",
        "Require every token of a side rather than any -- the defect that placed the "
        "truth in no cluster on 11 of 17 real questions, because a paraphrase spreads "
        "its tokens across turns.",
        "    if (required.some((term) => hasWord(haystack, foldSuffix(term)))) matched.push(i);",
        "    if (required.every((term) => hasWord(haystack, foldSuffix(term)))) matched.push(i);",
    ),
    (
        "one-cluster-per-run-instead-of-per-side",
        "Emit one cluster per contiguous run -- the defect that reported 9 candidates "
        "for a two-candidate question, since a value's mentions are rarely adjacent.",
        "  const collected: number[][] = usable.map(() => []);\n"
        "  for (const turn of turns) {\n"
        "    const side = sideForTurn(turn.text, usable, distinctive);\n"
        "    if (side !== -1) collected[side]!.push(turn.index);\n"
        "  }",
        "  const collected: number[][] = usable.map(() => []);\n"
        "  let openSide = -1;\n"
        "  for (const turn of turns) {\n"
        "    const side = sideForTurn(turn.text, usable, distinctive);\n"
        "    if (side === -1) {\n"
        "      openSide = -1;\n"
        "      continue;\n"
        "    }\n"
        "    if (side !== openSide) {\n"
        "      collected.push([]);\n"
        "      usable.push(usable[side]!);\n"
        "      openSide = side;\n"
        "    }\n"
        "    collected[collected.length - 1]!.push(turn.index);\n"
        "  }",
    ),
    (
        "keep-possessive-clitic",
        "Skip the clitic collapse, so \"farmer's\" yields the token \"s\" -- a single "
        "letter present in almost every turn, which makes the side match noise.",
        "    .replace(/['\\u2019](s|t|re|ve|ll|d|m)\\b/g, '$1');",
        "    .replace(/\\u0000/g, '');",
    ),
    (
        "skip-distinctive-narrowing",
        "Ignore the distinctive term and match the whole side, so a token common in "
        "this context can carry a side on its own.",
        "    const required = distinctive?.[i] ?? sides[i]!;",
        "    const required = sides[i]!;",
    ),
    (
        "require-every-token-of-side-literally",
        "Require every token of a side rather than any. This is the defect that "
        "placed the truth in NO cluster on 11 of 17 real questions, because a "
        "paraphrase spreads a value's tokens across turns. It is stated a second "
        "time here against the narrowed path (the narrowed set is usually one "
        "token, so only a test that supplies a MULTI-token distinctive set can see "
        "it -- which is exactly what the side-level mutation above cannot reach).",
        "    if (required.some((term) => hasWord(haystack, foldSuffix(term)))) matched.push(i);",
        "    if (required.every((term) => hasWord(haystack, foldSuffix(term)))) matched.push(i);",
    ),
    (
        "allow-one-sided-clustering",
        "Cluster even when only one side exists, labelling a non-competing question "
        "as if it discriminated.",
        "  if (sides.length < 2) {\n"
        "    // One side means nothing competes, and the annotation would label every turn\n"
        "    // that mentions one value while claiming to discriminate. Decline instead:\n"
        "    // the point of this module is telling TWO candidates apart.\n"
        "    return { clusters: [], annotated: false };\n"
        "  }",
        "  if (sides.length < 1) {\n"
        "    return { clusters: [], annotated: false };\n"
        "  }",
    ),
    (
        "include-assistant-turns",
        "Let an assistant turn become a candidate, so a restated fact counts as "
        "support for the same candidate twice.",
        "  if (role === 'assistant') return -1;\n"
        "  const haystack = foldTokens(content.toLowerCase());\n"
        "  const matched: number[] = [];",
        "  const haystack = foldTokens(content.toLowerCase());\n"
        "  const matched: number[] = [];",
    ),
    (
        "match-substring-not-word-boundary",
        "Match a side term as a substring, so \"road\" is satisfied by \"roadster\".",
        "    if (!CONTENT_TOKEN.test(before) && !CONTENT_TOKEN.test(after)) return true;",
        "    return true;",
    ),
    (
        "drop-the-sibilant-exception",
        "Strip \"-es\" unconditionally, so \"bikes\" folds to \"bik\" while \"bike\" "
        "stays \"bike\" and the two stop matching -- dropping evidence.",
        "  if (\n"
        "    token.length > 4 &&\n"
        "    token.endsWith('es') &&\n"
        "    SIBILANT.some((s) => token.slice(0, -2).endsWith(s))\n"
        "  ) {\n"
        "    return token.slice(0, -2);\n"
        "  }",
        "  if (token.length > 4 && token.endsWith('es')) {\n"
        "    return token.slice(0, -2);\n"
        "  }",
    ),
    (
        "drop-comma-clause-guard",
        "Split on every comma, so a prose answer reads as an enumeration of "
        "candidates it does not contain.",
        "      !CLAUSE_OPENER.test(current);",
        "      true;",
    ),
    (
        "accept-any-comma-as-a-separator",
        "Drop the length bound as well as the clause guard, so every comma splits and "
        "a long prose clause becomes a phantom candidate list.",
        "      current.trim().length <= MAX_VALUE_SPAN_CHARS &&\n"
        "      !CLAUSE_OPENER.test(current);",
        "      true;",
    ),
    (
        "label-before-the-role",
        "Rewrite the labelled line so the label sits between the date and the role "
        "instead of at the end. The reader's parser requires the role to follow the "
        "date, so the turn stops being a turn and merges into its predecessor: the "
        "annotation destroys the structure it exists to clarify. Observable because "
        "the role adjacency is what the reader's pattern consumes.",
        "    return appendLabel(line, id);",
        "    return appendLabel(line.replace(/^(\\[\\d{4}\\/\\d{2}\\/\\d{2}\\])(\\s*(?:user|assistant):)/, '$1 [x]'), id);",
    ),
    (
        "drop-the-turn-count-guard",
        "Trust the newline view of the context instead of the renderer's own turn "
        "split, so a context whose newlines outnumber its turns (one wrapped turn) "
        "is labelled by position and the label lands on the wrong turn. This is the "
        "only positional guard in the renderer, and it is the one that must hold.",
        "  if (lines.length !== turnCount(context)) {",
        "  if (lines.length < 0) {",
    ),
    (
        "label-every-turn-regardless-of-membership",
        "Label every turn instead of only the ones a cluster names, so a context "
        "with one candidate turn gets every turn marked as that candidate.",
        "    const id = membership.get(index);\n"
        "    if (id === undefined) return line;\n"
        "    return appendLabel(line, id);",
        "    const id = membership.get(index) ?? clusters[0]!.id;\n"
        "    return appendLabel(line, id);",
    ),
    (
        "drop-label-idempotence",
        "Append a second label to an already-labelled turn, so a re-render "
        "accumulates labels.",
        "  const marker = ` [${CANDIDATE_RECORD_SCHEMA_KEY}: ${id}]`;\n"
        "  if (line.includes(`[${CANDIDATE_RECORD_SCHEMA_KEY}: ${id}]`)) return line;",
        "  const marker = ` [${CANDIDATE_RECORD_SCHEMA_KEY}: ${id}]`;",
    ),
    (
        "drop-numeric-content-terms",
        "Reject a single-character term even when it is a digit, so a numeric answer "
        "loses its only token.",
        "    if (raw.length < MIN_TERM_LENGTH && !/\\p{N}/u.test(raw)) continue;",
        "    if (raw.length < MIN_TERM_LENGTH) continue;",
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
