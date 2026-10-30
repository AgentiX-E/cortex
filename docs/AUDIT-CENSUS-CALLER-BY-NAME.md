# AUDIT — The Census Counts Callers by Name, So a Name Is a Caller

**Status:** found by a failing test while adding an unrelated tool, local repair shipped (a rename plus a
guard), the instrument repair registered as **P1-census** and not performed here.
**Found by:** `13.154` — the run-identity gate, which needed an error class and picked a noun that
`cortex-storage` had already exported.

---

## 1. What happened, exactly

`tools/run-identity.mjs` was written with a private error class named `Refusal`, thrown wherever the tool
declines to certify. It imports nothing from any package; its only import is `node:child_process` and
`node:fs`.

`cortex-storage` exports a `Refusal` of its own. The export census counts a **caller** as a whole-word
occurrence of the symbol's name in any repository file that is not a test, not a barrel and not the
declaring file. So the file's existence was enough:

```
before the tool        394 recorded orphans   (the baseline as committed in 508fc62)
after the tool         393 observed orphans   export-census-gate.test.ts FAILED
                       the missing one:  cortex-storage: Refusal
```

No import was added. No line of `cortex-storage` changed. A symbol left the orphan ledger.

The baseline's previous edit is the useful comparison, because it is the same kind of commit and the
opposite kind of evidence. `508fc62` added `tools/recovery-reach.mjs` and the ledger went from 395 orphaned
to 394: `cortex-memory: asksForCount` left, because the new tool **imports** it — `recovery-reach.mjs` has
to count the abstention-recovery population with the same predicate the pass uses, so the tool calls it.
That retirement is a fact about the code, and the baseline's rationale carries the sentence. The retirement
below is a fact about a spelling.

The test that caught it is the one that compares the observed list against the committed baseline
*exactly*, in the direction that is easy to forget: it fails both when an orphan appears and when one
disappears. `tools/export-census.mjs --check` does **not** catch it, because `--check` is written against
new orphans only — a shrinking ledger is exactly what a successful cleanup looks like.

## 2. Why the census matches by name, stated so the repair does not undo it

The wide scope is measured, not assumed. Scoping the caller search to the declaring package reports **314
orphans out of 435 exports**; searching the whole repository reports **196**. The difference of 118 is
cross-package use, which a per-package census cannot see and therefore calls dead. A gate that is 27% false
positives is turned off inside a week, and a turned-off gate is not a conservative choice.

Parsing imports would remove the false positives the name match creates without giving up the cross-package
reach. It was not done, and the docblock in `countCallers` says so: *"This deliberately does not parse
imports, and it does not distinguish a call from any other mention."* The accepted trade-off in that
docblock is about a **published** package's public API reading as an orphan. The defect below is the same
trade-off seen from the other side, and it was not written down until it fired.

## 3. The defect

> A file outside a package is a caller of that package until proven otherwise, and the proof is an import.

Three ways the current rule produces a caller that is not one:

1. **A different symbol with the same name.** `Refusal` here is an `Error` subclass in a readout tool;
   `cortex-storage`'s is a storage-layer refusal. Neither knows the other exists. This is the case that
   fired.
2. **A string, a key, or a log line.** The rule counts a mention inside a string literal or a template
   literal as a call, deliberately, so that a symbol used only in a message is not called dead. A name in
   a JSON payload or a printed table therefore counts.
3. **A bench or tool file that will never run in production.** `bench/run.ts` is counted as a caller
   because it is a benchmark entry point and that is correct for it; the same extension admits every file
   in `tools/`.

The direction of the error is what makes it serious. An orphan that is *hidden* is a symbol that stays in
the tree, which costs bytes and one line of ledger. An orphan that is *retired by accident* is a symbol
that leaves the ledger and is now, as far as every later reading is concerned, used — the one direction the
campaign's coverage rules exist to prevent, and the one that no `--check` reports.

## 4. The local repair, and why a rename is not gaming the metric

The class is now `IdentityRefusal`. Whole-word matching has an identifier boundary before `Refusal` only
when the preceding character is not an identifier character; `y` is one, so `IdentityRefusal` does not
match the orphan's pattern. Measured both ways before the guard was relied on:

| code text | recorded orphan `Refusal` |
| --- | --- |
| `class IdentityRefusal extends Error {}` | not flagged |
| `class Refusal extends Error {}` | **flagged** |

Renaming is the opposite of gaming here: leaving the shorter name keeps an orphan out of the report
without any evidence that the symbol is used. The census is more accurate after the rename than before it,
and the count returns to 394.

Two supporting changes:

1. The class docblock records **why** the name is not cosmetic, so the next reader who shortens it meets
   the reason rather than a rule.
2. `tools/__tests__/test_run_identity.py` extracts every recorded orphan name from
   `tools/export-census-baseline.json` and fails if one appears as **code** in the tool. It strips comment
   lines first, because a docblock that explains a collision has to be able to name the symbol it warns
   about — the same reason the census blanks comments before matching.

## 5. The instrument repair, registered rather than slipped in

Import-aware caller detection, registered as **P1-census**. It is not done here for a measured reason: the
caller set is what the baseline of 394 entries was built from, so changing the rule re-derives every entry
at once. The 118 cross-package uses must survive the change, which means the rule cannot simply be "the
file imports the package" — `cortex-eval` imports `BruteForceVectorIndex` through `@agentix-e/cortex-core`
and a barrel hop, so the import graph has to be followed through `index.ts` files, which the census
currently refuses to treat as callers at all.

Its bar, registered so it can fail:

1. The ledger still reads **394 minus the genuinely dead**, and no entry is removed without naming the
   import that now accounts for it.
2. The 118 cross-package uses stay counted. An import-aware rule that loses them re-creates the 27%
   false-positive gate this scope was chosen to avoid.
3. A fixture pair: one file that mentions a symbol's name in prose, in a string and in a differently
   prefixed identifier — each must **not** count — beside one file that imports it through a barrel, which
   must.

## 6. What this does not claim

It does not claim the orphan ledger was wrong before this round. Every entry in it was produced by the
documented rule and the rule is exact for what it measures. What was wrong is the inference from that
ledger to "these symbols are unused", and the inference only breaks when a file with a colliding name is
added — which is why it survived 71 steps and was found by a tool that reports on something else entirely.

Until P1-census lands, treat the orphan count as an **under-estimate** that any new bench or tool file can
move, and treat a ledger that shrank without a diff in the owning package as the thing to explain.
