#!/usr/bin/env python3
"""Defect-injection harness for the B7 annotation WIRING layer.

Why a fourth harness, and why the other three cannot see these defects.

The three existing harnesses cover, in order: the clustering and rendering
arithmetic (`inject-candidate-context.py`), how the option reaches those
(`inject-b7-wiring.py`), and the channel-C side derivation
(`inject-retrieval-candidate-sides.py`). All three can be green while B7 does
nothing, because none of them can see whether the ANNOTATED STRING is the one
that reaches the model.

That is this file's subject, and it is where the feature has now failed twice:

  1. `discriminateContext` and `renderDiscriminatedContext` had no production
     caller at all. Every mutation in the other harnesses passes when a function
     is correct and nothing calls it.
  2. Once a caller existed, the TRACE still reported the raw `retrieved` rather
     than the annotated context. The prompt the model received WAS annotated, so
     the feature worked, but every observation of it -- including the A/B's own
     `onDecision` trace -- could not see the labels. A measurement instrument
     blind to the thing it measures is the same defect as a broken feature, and
     it is invisible to any test that asserts on the producer's return value.

Defect 2 is why this harness asserts through `runNaturalLanguageBenchmark` and
`onDecision` rather than at the seam: the observable has to be the one an A/B
would actually read.

Every mutation states the defect and the tests it should break. A mutation that
leaves the suite green means the suite does not test that link, which is the
finding -- not a pass. The file is restored byte-for-byte after each mutation and
the restore is verified by md5.
"""

from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

SRC = Path("/workspace/cortex/packages/cortex-eval/src/natural-language-memory.ts")
PKG = SRC.parent.parent
TESTS = [
    "src/__tests__/b7-main-path-wiring.test.ts",
    "src/__tests__/natural-language-memory.test.ts",
]

MUTATIONS = [
    (
        "trace-the-raw-context-instead-of-the-annotated-one",
        "Emit the raw `retrieved` in the decision trace instead of the annotated "
        "context. THIS IS THE DEFECT THAT PROMPTED THIS HARNESS: the prompt the "
        "model received carried the labels, so the feature worked, but every "
        "observation of it -- including the A/B's own `onDecision` trace -- "
        "reported an unannotated context. The run then concluded the producer was "
        "unreachable when it had been reached all along.",
        "    this.emitTrace(question, top1Score, false, 'answered', {\n"
        "      retrieved: context,\n"
        "      llmRaw: raw,\n"
        "      answer: parsed,",
        "    this.emitTrace(question, top1Score, false, 'answered', {\n"
        "      retrieved,\n"
        "      llmRaw: raw,\n"
        "      answer: parsed,",
    ),
    (
        "trace-the-raw-context-on-the-parse-failure-path",
        "The same defect on the other two emits. Kept separate because the parse-"
        "failure arm only fires when the parser rejects the answer, so a suite that "
        "stubs a parseable answer exercises the path above and never this one -- "
        "which is the reason to state it as its own mutation rather than assume one "
        "anchor covers all three.",
        "      this.emitTrace(question, top1Score, true, 'llm', {\n"
        "        retrieved: context,\n"
        "        llmRaw: raw,",
        "      this.emitTrace(question, top1Score, true, 'llm', {\n"
        "        retrieved,\n"
        "        llmRaw: raw,",
    ),
    (
        "drop-the-turns-at-the-main-call-site",
        "Pass no turns on the main `answer` path, so the annotation has nothing to "
        "cluster and declines. The producer is still correct and still called; it "
        "is simply given nothing. Measured: the trace then carries no labels, so "
        "the feature goes inert exactly as it did when it had no caller at all -- "
        "and nothing crashes, nothing warns, and the A/B reports two identical "
        "arms.",
        "      parseQaAnswer,\n"
        "      expansionQueries,\n"
        "      this.options.abstainThreshold,\n"
        "      undefined,\n"
        "      true,\n"
        "      hits,\n"
        "    );\n"
        "  }\n"
        "\n"
        "  /**\n"
        "   * Temporal-reasoning answering for single-session questions.",
        "      parseQaAnswer,\n"
        "      expansionQueries,\n"
        "      this.options.abstainThreshold,\n"
        "      undefined,\n"
        "      true,\n"
        "    );\n"
        "  }\n"
        "\n"
        "  /**\n"
        "   * Temporal-reasoning answering for single-session questions.",
    ),
    (
        "hard-disable-the-producer",
        "Make the annotation unconditional return, so `retrievalSides` is accepted "
        "and ignored. The option is then a declared-but-dead switch of exactly the "
        "kind the earlier wiring defect produced, and the A/B reports two "
        "byte-identical arms.",
        "    if (this.options.retrievalSides !== true || turns === undefined || turns.length === 0) {\n"
        "      return retrieved;\n"
        "    }",
        "    if (this.options.retrievalSides !== true || turns === undefined || turns.length === 0) {\n"
        "      return retrieved;\n"
        "    }\n"
        "    return retrieved;",
    ),
    (
        "couple-the-labels-to-the-instruction",
        "Gate the labels on `candidateDiscrimination` as well, so labels can only "
        "appear alongside the instruction. The standalone-labels ablation then "
        "cannot be run, and its arm silently becomes a second control.",
        "    if (this.options.retrievalSides !== true || turns === undefined || turns.length === 0) {",
        "    if (\n"
        "      this.options.retrievalSides !== true ||\n"
        "      this.options.candidateDiscrimination !== true ||\n"
        "      turns === undefined ||\n"
        "      turns.length === 0\n"
        "    ) {",
    ),
    (
        "skip-the-two-side-check",
        "Annotate whenever the producer returns anything, including a single side. "
        "`discriminateContext` would still decline, so the observable is unchanged "
        "-- an equivalent-by-construction guard. Recorded rather than tested.",
        "    if (sides.length < 2) return retrieved;\n",
        "",
        False,
    ),
    (
        "cluster-without-the-override",
        "Call `discriminateContext` without passing the derived sides, so it falls "
        "back to deriving them from a ground truth the caller deliberately did not "
        "supply. Measured: it yields one side from the question alone, so "
        "`annotated` is false and the context is returned unchanged -- channel B "
        "by another name.",
        "    const { clusters } = discriminateContext(turns, { question: '', sidesOverride: sides });",
        "    const { clusters } = discriminateContext(turns, { question: '' });",
    ),
    (
        "render-against-the-annotated-string",
        "Feed the renderer a second annotated pass instead of the raw context. The "
        "renderer is idempotent per label, but the SECOND pass clusters the "
        "already-labelled text, whose labels change the content terms -- so the "
        "sides move and the labels land on different turns. Observable, and the "
        "test that sees it is the one asserting the labels are drawn from the "
        "retrieval rather than from the previous render.",
        "    return renderDiscriminatedContext(retrieved, clusters, { question: '' });",
        "    return renderDiscriminatedContext(this.annotateWithCandidateSides(retrieved, turns), clusters, { question: '' });",
    ),
]


def md5(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def run_tests() -> tuple[bool, str]:
    proc = subprocess.run(
        ["pnpm", "exec", "vitest", "run", *TESTS],
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
