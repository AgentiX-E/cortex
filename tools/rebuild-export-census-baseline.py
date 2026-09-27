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
    "ablation-and-diagnostic-surface": (
        "The ablation and diagnostic instrumentation. Roadmap-adjacent: the audit of "
        "AUDIT-B7-ANNOTATION-PRODUCER.md found that several of these features were built, tested "
        "and never wired, which is why they are orphans. They are recorded rather than deleted "
        "because the roadmap may still wire them; each must be adjudicated by a roadmap item, not "
        "by this ledger."
    ),
    "eval-harness-surface": (
        "Evaluation harness internals. This is the largest bucket and the one most likely to hold "
        "genuine defects: 156 of the repository's 245 exported functions have no non-test caller, "
        "and most of them are here. Some are reached only through indirection the census does not "
        "follow (dynamic property access, options objects passed as data), so both genuine orphans "
        "and false positives are expected. It was not triaged entry by entry; the gate's value is "
        "preventing growth, not certifying this snapshot."
    ),
    "core-llm-node-surface": (
        "Library surface of cortex-core, cortex-llm and cortex-node. An export with no caller in "
        "this repository is either a genuinely unused helper or a deliberate extension point of a "
        "library whose consumers would be external. This repository is private and publishes "
        "nothing, so a consumer outside it does not exist today; `cortex-llm/src/retry.ts` alone "
        "contributes 13, which suggests its helpers are used as building blocks internally rather "
        "than called by name. Not triaged entry by entry."
    ),
}

GROUP_ORDER = [
    "census-tool-public-api",
    "core-llm-node-surface",
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
            "name, several declaration lines, one identity."
        ),
        "totals": {
            "exports": report["totalSymbols"],
            "withCaller": report["totalSymbols"] - report["orphanCount"],
            "orphaned": report["orphanCount"],
        },
        "groups": ledger,
        "knownOrphans": sorted({key(orphan) for orphan in orphans}),
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
