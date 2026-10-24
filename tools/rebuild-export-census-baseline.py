#!/usr/bin/env python3
"""Generates tools/export-census-baseline.json from a fresh census run.

Run after any change that legitimately adds or removes exports, then review the
diff: an entry disappearing is good news, an entry appearing needs a reason.
"""
import json
import subprocess
import sys
from collections import defaultdict

RATIONALE = {
    "census-tool-public-api": (
        "The census module's own exports. Three of them (`censusPackage`, `buildCensusReport`, "
        "`listOrphans`) are called by tools/export-census.mjs and so are already counted. The rest "
        "are internal seams extracted for direct unit testing: `extractExportedSymbols`, "
        "`countCallers`, `identifierPattern`, `isTestFile` and friends exist so a test can drive "
        "one rule in isolation instead of round-tripping through the CLI. They are exported "
        "because TypeScript has no package-private visibility. This is the one place where an "
        "orphan is a deliberate design choice rather than debt, and it is recorded as debt anyway "
        "so the number stays honest."
    ),
    "browser-storage-surface": (
        "The browser storage surface added in implementation step 3: `openBrowserStorage`, "
        "`openOpfsStorage`, `IdbStorage`, the tier and refusal types, and the error classes that "
        "tell a caller which tier it got and why. Every one of these is called -- by the browser, "
        "from an application, not from TypeScript in this repository: the only exerciser here is "
        "`test/browser/probe.mjs`, which drives the **built** package in a real Chromium, and the "
        "census counts non-test callers by design. So the orphan count for this group measures the "
        "absence of a shipped application, not the absence of a caller, and the evidence for "
        "`openOpfsStorage` in particular is 24 named assertions plus a digest that survives a "
        "browser restart. Two of these ARE reachable from `src/index.ts`'s subpaths and are how a "
        "consumer's bundler finds them; if this package ever ships an application of its own, this "
        "group should shrink to nothing and that shrinkage is the signal to look for."
    ),
    "ablation-and-diagnostic-surface": (
        "The ablation and diagnostic instrumentation. Roadmap-adjacent: the audit of "
        "AUDIT-B7-ANNOTATION-PRODUCER.md found that several of these features were built, tested "
        "and never wired, which is why they are orphans. They are recorded rather than deleted "
        "because the roadmap may still wire them; each must be adjudicated by a roadmap item, not "
        "by this ledger."
    ),
    "eval-harness-surface": (
        "Evaluation harness internals. This is the largest bucket and the one most likely to hold "
        "genuine defects: most of the repository's orphaned exports are here. Some are reached only "
        "through indirection the census does not follow (dynamic property access, options objects "
        "passed as data). Triaged entry by entry: 221 of 277 were referenced inside their own "
        "declaring file and NOT ONE was unreferenced everywhere, so this bucket contains no dead "
        "code and its members are unnecessary `export` keywords, not deletions. The gate's value is "
        "preventing growth, not certifying this snapshot. `PositionEffect` (step 20) joins for the "
        "same reason as the other shapes: `positionEffect` returns it and `tools/a3-review.mjs` "
        "prints it, but a type named only in a signature has no caller to count. It is recorded "
        "rather than inlined because the return shape is the thing being asserted in its six tests."
    ),
    "core-llm-node-surface": (
        "Library surface of cortex-core, cortex-ai and cortex-storage. An export with no caller in "
        "this repository is either a genuinely unused helper or a deliberate extension point of a "
        "library whose consumers would be external. This repository is private and publishes "
        "nothing, so a consumer outside it does not exist today; `cortex-ai/src/retry.ts` alone "
        "contributes 13, which suggests its helpers are used as building blocks internally rather "
        "than called by name. THE THREE ENTRIES OF cortex-ai ARE ONE LIBRARY WITH THREE "
        "DEPENDENCY PROFILES: `.` (remote providers, needs only fetch), `./local` "
        "(transformers.js, an optional peer) and `./web` (the browser's built-in model). Almost "
        "every export in this group is part of that surface and is called by a consumer, not by "
        "this repository -- the repository ships no application. Two of them are worth naming "
        "because they look like internal helpers and are not: `createFeatureExtractor` and "
        "`createRerankClassifier` are the loading layer that pins `dtype` and reads raw logits, and "
        "`test/parity/run.mjs` drives both against real weights. ONE GROUP IS NOT DEBT: the federation surface added in "
        "implementation step 2 (`FederatedStorage`, `ReadSideAssembler`, `ScopeViolation`, "
        "`FederationError`, `scopeOf` and their types) is the code the remaining steps wire "
        "up -- the read-side assembler builds the evidence window at step 3 and the card "
        "queue calls it at step 6. It shows as orphaned because the repository has no caller "
        "YET; it is recorded rather than deleted because deleting it would delete the next "
        "step. If those steps are abandoned, this paragraph is the first thing to remove. "
        "THE SAME APPLIES TO THE TRIAGE SURFACE from implementation steps 5 and 6 "
        "(`TriageWriter`, `CardQueue`, `RULE_TABLE`, `classify`, `destinationOf`, "
        "`assertRuleTable`, `TriageError`, `RuleTableError` and their types): it is the write "
        "side of the boundary and the queue that fills the shared store, called internally and "
        "by the four test files that measure the sixty labelled utterances, the card lifecycle "
        "and the output guard. `OutputGuard` (step 7) is the same table read in the other "
        "direction -- what may be said rather than what may be stored -- and it is called by a "
        "product that does not exist in this repository yet. THE PROPOSAL LAYER (step 9: "
        "`TriageProposer`, `groundedIn`, `buildProposerPrompt`, `PROPOSER_PROMPT_VERSION`, "
        "`MAX_FACTS`, `MAX_FACT_CHARS` and their types) is the same kind of entry: its only "
        "in-repository callers are the proposer\u2019s own gates and the card queue\u2019s "
        "`attach`, and the thing that will call it in production is an application that does "
        "not exist here. It is exported so the four gates can be driven from a test one at a "
        "time and so a caller can build the same prompt it will validate against -- "
        "`buildProposerPrompt` is exported for exactly that reason, and a card renderer needs "
        "`MAX_FACTS` to say \"3 of 8\" without inventing a second constant. " 
        "THE ECHO SURFACE (step 11) is three entries and one removal worth naming: "
        "`hashWindow` is called by `EchoCorpus.contains` in its own file and by the corpus "
        "tests, so it is a test seam in the same sense as `clampAwayFromZero`; "
        "`DEFAULT_ECHO_WIDTH` and `EchoCorpusStats` are a constant and the shape `stats` "
        "returns, with no caller yet. And `OutputGuard` LEFT this ledger, which is the "
        "honest record of what happened in this step: the guard finally has a caller, and "
        "that caller is `packages/cortex-core/test/echo/run.mjs` -- a measurement script, "
        "not a product. It is the first time the output side has been driven from outside "
        "a test file, and it is still not a shipped path. "
        "THE PROFILE SURFACE (step 14) is eight entries with one caller between them: "
        "`resolveLlmProfile`, `describeProfile`, `readApiKey` and `PROFILE_ENV` are called by "
        "the two tools, and the five types (`LlmProfile`, `LocalProfile`, `RemoteProfile`, "
        "`ProfileRequest`, `ProfileEnv`), `DEFAULT_LOCAL_MODEL` and `DEFAULT_WEIGHT_HOST` are "
        "named in those tools' signatures and docs but not called. That is the honest shape of "
        "a configuration module: the values exist so that a failure message and a document can "
        "cite the same string, and nothing in the library decides anything with them. "
        "`cortex-ai: CrossEncoderRerankerOptions` LEFT this ledger for a dull reason worth one "
        "line: it moved to `rerank/cross-encoder.ts`, and the census resolves a re-exported type "
        "to its declaration site, which is now reached from `./local` -- the same file, a "
        "different path, so it counts as used. Not a change in behaviour. "
        "THE REVIEW PAGE (step 16) adds one entry with a caller -- `renderA3ReviewPage`, "
        "called by `tools/a3-review-page.mjs` -- and five that exist for the test suite: "
        "`planReview` and `resumeKey` are called inside their own file and by the tests, so "
        "they are test seams in the sense this ledger already uses for `hashWindow`; the four "
        "types (`ReviewCard`, `ReviewPageInput`, `ReviewPair`, `ReviewPlan`) are the shapes "
        "those signatures use. `trialLine` was written, exported, and then removed: its only "
        "caller was a test, and a one-line wrapper around JSON.stringify does not earn an "
        "export -- the test stringifies the trial itself and asserts the same thing. "
        "Three more joined when the command line moved out of the tool and into this "
        "package: `parseReviewPageArgs`, `readReviewCards` and `resolveOutPath` are called "
        "by `tools/a3-review-page.mjs`, so they have a caller and are not in this ledger "
        "at all -- they are named here only because the move is the interesting part. The "
        "first version of that logic lived in the tool, whose test ran before `pnpm build` "
        "and therefore failed on every clean checkout. A tool that needs `dist` cannot be "
        "tested by the step that runs before `dist` exists. "
        "THE ABSTENTION GATE (step 23) adds four entries. `planAbstentionRecovery` and "
        "`buildRecoveryPrompt` have their caller in `memory.ts`; `asksForCount` is called by "
        "`buildRecoveryPrompt` and by its tests, and `declinedItems` by `planAbstentionRecovery` "
        "and by its tests, so both are test seams in the sense this ledger already uses for "
        "`hashWindow`. `DECLINE_TOKEN` is exported because a test couples it to `ABSTAIN_TOKEN` "
        "across a layer that cannot share a constant, and `RecoveryPlan` is a shape named only in "
        "a signature. None of them is a deletion candidate: the module exists so that the "
        "decision \"is this decline honest\" is one function called from one place, rather than a "
        "regex written twice. "
        "THE GROUNDING CHANGE (step 21) adds four entries and gives the others callers. "
        "`contentGrounded` is called by `TriageProposer.filter` and by `CardQueue.attach`, and "
        "`distillationOf` by `tools/a3-review.mjs`; `isVerbatimRun` and `looksTemporal` are called "
        "inside `grounding.ts` and by its tests, so they are test seams in the sense this ledger "
        "already uses for `hashWindow`. The two types are shapes named only in signatures. They are "
        "exported rather than inlined because the reading and the gate must call the same functions: "
        "a reading that re-implemented \"is this a verbatim run\" would produce a number about a "
        "different question than the one the product asks. "
        "THE CLAIMS GATE (step 18) adds ONE entry and gives the other two callers: `claimsIn` is "
        "called by `CardQueue.open`, which is the path that decides whether a turn becomes a "
        "question at all; `splitSentences` is called by `test/card-volume/run.mjs`, the same way "
        "`OutputGuard` left this ledger when `test/echo/run.mjs` started driving it; `isClaim` is "
        "called only inside `claims.ts` and by `claims.test.ts`, so it lands here as a test seam in "
        "the sense this ledger already uses for `hashWindow`. The three exist as a module rather "
        "than as private helpers because the reading, the tests and the queue must call the same "
        "predicate: a reading that re-implemented the gate would measure a different gate. "
        "NOT triaged entry by entry, with one exception recorded here so the "
        "next reader does not have to re-derive it: `cortex-core: clampAwayFromZero` and "
        "`cortex-core: degenerateDfPValue` are TEST SEAMS. Both are called from `betaContinuedFraction` "
        "and `welchTTest` in their own file, so they are live code; the `export` keyword exists only "
        "so `src/__tests__/stats-degenerate.test.ts` can drive the degenerate branches directly. That "
        "matters because the census excludes test files from the caller count by design, so a "
        "test-facing export is reported as an orphan no matter how well covered it is -- the "
        "`referenced-locally` class it lands in does not distinguish a test caller from an in-file "
        "one. They were extracted from six inline guards that carried `c8 ignore next` while still "
        "counting against the 95% floor, and neither `c8 ignore` nor `v8 ignore` was honoured by "
        "`@vitest/coverage-v8`, so extraction was the only way to keep the protection AND earn the "
        "coverage honestly."
    ),
}

GROUP_ORDER = [
    "census-tool-public-api",
    "core-llm-node-surface",
    "browser-storage-surface",
    "ablation-and-diagnostic-surface",
    "eval-harness-surface",
]

ABLATION_KEYS = (
    "ablation",
    "b7-cohort",
    "candidate-discrimination",
    "candidate-context",
    "variance",
    "recall-curve",
    "retrieval-attribution",
    "failure-census",
    "tr-failure-class",
    "retrieval-diagnostics",
    "temporal-engine",
)


def category(orphan: str) -> str:
    _, rest = orphan.split(": ", 1)
    path = rest.split("(")[1].split(":")[0]
    if "export-census.ts" in path:
        return "census-tool-public-api"
    if "cortex-storage/src/browser/" in path:
        return "browser-storage-surface"
    if "cortex-eval" in path:
        if any(key in path for key in ABLATION_KEYS):
            return "ablation-and-diagnostic-surface"
        return "eval-harness-surface"
    return "core-llm-node-surface"


def key(orphan: str) -> str:
    """The stable identity of an orphan: `pkg: name`, without the line number.

    Line numbers are excluded on purpose. Deleting an unrelated line above a
    declaration shifts every line number below it, which would make the whole
    baseline look stale and force a rewrite of this file for a change that
    removed no orphan. The first version of this ledger stored full
    `pkg: name (file:line)` strings and broke exactly that way when seven dead
    lines were removed from export-census.ts. Identity is the package and the
    name; the location is metadata.
    """
    pkg, rest = orphan.split(": ", 1)
    name = rest.split(" (")[0]
    return f"{pkg}: {name}"


def main() -> int:
    # The census output is large; capture it through a file rather than a pipe,
    # which truncates at the OS buffer size and produced a JSON parse error.
    with open("/tmp/export-census-raw.json", "w") as sink:
        subprocess.run(
            ["node", "tools/export-census.mjs", "--json"],
            stdout=sink,
            check=True,
            cwd="/workspace/cortex",
        )
    with open("/tmp/export-census-raw.json") as source:
        payload = json.load(source)
    orphans = sorted(payload["orphans"], key=key)
    report = payload["report"]
    unreferenced = {key(orphan) for orphan in payload["unreferenced"]}

    groups = defaultdict(list)
    for orphan in orphans:
        groups[category(orphan)].append(orphan)

    ledger = [
        {
            "category": name,
            "count": len(groups[name]),
            "rationale": RATIONALE[name],
            "declarationSites": sorted(groups[name]),
        }
        for name in GROUP_ORDER
        if name in groups
    ]

    document = {
        "note": (
            "Debt ledger for `node tools/export-census.mjs --check`. Records the exports that had "
            "no non-test caller when the gate was introduced. This is NOT an allowlist of "
            "acceptable orphans: it is a snapshot of an unresolved backlog. The gate fails on any "
            "orphan ABSENT from this file, so its only job is to stop new ones appearing silently. "
            "Removing an entry requires deleting the export or giving it a caller; adding one "
            "requires a reason recorded here. "
            "`knownOrphans` holds `pkg: name` keys WITHOUT line numbers, because a line number "
            "changes when any unrelated line above it moves; this is the list the checker consults. "
            "`locations` maps each key to every file:line that declares it. "
            "`groups` carries the rationale, and its `declarationSites` are counted per site, so "
            "their total exceeds `knownOrphans.length` by the number of TypeScript overloads: one "
            "name, several declaration lines, one identity. "
            "`totals.referencedLocally` and `totals.unreferenced` split the orphan count by "
            "whether the declaring file still mentions the symbol. They sum to `totals.orphaned`. "
            "`orphanClass` maps each key to its class: `referenced-locally` means the symbol has a "
            "live call site and only the `export` keyword is unnecessary, `unreferenced` means "
            "nothing mentions it anywhere and it is a dead-code candidate. "
            "The ledger was rebuilt once to correct the caller matcher, and the size of that "
            "correction is the reason it is recorded here. The matcher used to test a symbol's "
            "name against each file's raw text, so a name written in a comment counted as a call: "
            "`referencedLocally`/`unreferenced` moved 185/48 from 196/16 and 21 exports entered "
            "the list the moment comments stopped counting. Every one of the 21 had ONLY comment "
            "matches outside its declaring file -- verified by diffing raw-text matches against "
            "comment-stripped matches for each. The worst part of the old behaviour was its "
            "direction: documenting a symbol silently retired its finding, so the report looked "
            "cleanest on the code someone had taken most trouble to explain. `stripComments` in "
            "`export-census.ts` now blanks comments before matching while copying string and "
            "template literals through verbatim, because template literals hold real calls "
            "(`hashText` is called six times that way)."
        ),
        "totals": {
            "exports": report["totalSymbols"],
            "withCaller": report["totalSymbols"] - report["orphanCount"],
            "orphaned": report["orphanCount"],
            "referencedLocally": report["referencedLocallyCount"],
            "unreferenced": report["unreferencedCount"],
        },
        "groups": ledger,
        "knownOrphans": sorted({key(orphan) for orphan in orphans}),
        "orphanClass": {
            name: ("unreferenced" if name in unreferenced else "referenced-locally")
            for name in sorted({key(orphan) for orphan in orphans})
        },
        "locations": _locations(orphans),
    }

    with open("/workspace/cortex/tools/export-census-baseline.json", "w") as handle:
        json.dump(document, handle, indent=2)
        handle.write("\n")
    print(
        f"wrote {len(document['knownOrphans'])} known orphans in {len(ledger)} groups "
        f"({len(orphans)} declaration sites: a TypeScript overload declares one symbol "
        f"on several lines)"
    )
    return 0


def _locations(orphans):
    """Maps each identity to EVERY file:line that declares it, sorted.

    A list rather than a single string because one name can be declared more than
    once: `classifyTrFailure` in tr-failure-class.ts has two overload signatures
    plus the implementation, i.e. three declaration sites and one identity. A
    scalar map would silently keep one and drop two.
    """
    result = defaultdict(list)
    for orphan in orphans:
        result[key(orphan)].append(orphan.split(" (", 1)[1].rstrip(")"))
    return {name: sorted(sites) for name, sites in sorted(result.items())}


if __name__ == "__main__":
    sys.exit(main())
