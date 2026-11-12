#!/usr/bin/env python3
"""Project an arm artifact's `memoryArmConfig` onto the dispatch table's input names.

## The defect this file exists for, which is the third instance of one class

`test_preregistration_config.py` compares `docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md` §10.3 with
`tools/dispatch-cortex-memory-ab.py`'s `INPUTS`. Both are files a maintainer edits by hand, so the
check has one blind spot that no amount of care in either file can close: **both can be stale
together, and then they agree with each other and disagree with every run.**

§10.3's own `ask` bullet names that blind spot and was written because of it:

> §13.193 called `41185512391` "the registered, `operands`" in one table while §10.3 said
> `enumerated` in another. Nothing failed, because `test_preregistration_config.py` compares §10.3
> with the dispatch table and **both** said `enumerated` — the disagreement was between the
> documents and the runs, which no check could see.

That paragraph was written three concepts ago. The value is now `verbatim` in §10.3 and `verbatim`
in `INPUTS`, while every 500-question run from `42337560027` onwards sends `ask: verbatim-acts`,
which §13.318 adopted as the shipping configuration. The room has the same shape: §10.3 and the
table both say `48000` and the runs send `multi-session:48460`. So the class the bullet describes
has recurred **inside the bullet that describes it**, and §13.320 had to say so in prose — "the
inputs are the dispatch table as that commit held it, with the two values the baseline artifact
records and the table now does not" — because no mechanism could.

A third copy of the numbers would not fix this. What fixes it is a third column that is not a
document: the `memoryArmConfig` a real artifact carries. `readout-arm-run.py --registration` has
compared an artifact against the table since that section, but it needs an 87 MB artifact, so it
runs when somebody remembers and never in CI. This tool records the projection of one artifact into
`tools/arm-config-baseline.json` — small, reviewable, and checkable without the artifact — and
`--check` re-runs the comparison in the gate.

## The partition, which is the part that keeps it honest

Every field of `memoryArmConfig` must be classified, and `--record` refuses an artifact carrying a
field it has no class for. The two classes are:

- `PROJECTED` — the field is the artifact's record of a dispatch input, so it can be compared
  against the table. `render` says how to spell the artifact's shape as the input's string.
- `UNPROJECTED` — the field is not a dispatch input, and the entry says why. The reasons are of
  three kinds and the distinction matters: `derived` (computed from a projected field, so comparing
  it would compare the same number twice and report a second violation for one defect), `constant`
  (fixed by the workflow or a module default, so there is no second copy to disagree with), and
  `identity` (the value is resolved at run time from the environment the artifact cannot see).

The partition is asserted in both directions by `tools/__tests__/test_arm_config_baseline.py`.
Without the reverse direction a new arm option would land in the artifact, be silently absent from
both classes, and the projection would keep passing over a field nobody had decided about — which
is how the `ask` above got there.

## What this does not claim

It does not say the recorded configuration is *correct*. The baseline is a record of what one run
applied, not an argument that the values are good; `adoptedBy` names the section that makes that
argument, and a test only asserts that the section exists.

Usage:

    python3 tools/arm-config-record.py --record path/to/report.json
    python3 tools/arm-config-record.py --check
    python3 tools/arm-config-record.py --check --baseline other.json --dispatch other.py
"""

from __future__ import annotations

import argparse
import ast
import functools
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "tools" / "arm-config-baseline.json"
DISPATCH = ROOT / "tools" / "dispatch-cortex-memory-ab.py"
PREREGISTRATION = ROOT / "docs" / "PREREGISTRATION-CORTEX-MEMORY-ARM.md"


def _number(value: object) -> str:
    """An artifact number as the dispatch spells it.

    Integral floats become integers, because the table writes `'0'` and the artifact records
    `0` and a comparison between `"0"` and `"0.0"` would be a defect report about formatting.
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


RENDERERS = {
    "number": _number,
    "text": lambda value: str(value),
    "csv": lambda value: ",".join(str(item) for item in value),
    # `DEEPSEEK_THINKING` separates routes with `+` and not `,` -- `readThinkingReach` refuses a
    # comma by name, because a comma-separated reach would be silently one route called
    # "multi-session,temporal". The renderer follows the input's grammar, not this file's taste.
    "plus": lambda value: "+".join(str(item) for item in value),
    # A per-route room is carried by one input as `route:chars` pairs. Sorted, because the
    # artifact's object has no order and a pair-order difference is not a configuration difference.
    "route_rooms": lambda value: ",".join(
        f"{route}:{_number(chars)}" for route, chars in sorted(value.items())
    ),
    # `reader` is one artifact object covering four inputs. Resolved by the reader below.
    "reader_thinking": lambda value: (
        "+".join(str(item) for item in value.get("thinkingRoutes") or [])
        if value.get("thinking") == "enabled"
        else str(value.get("thinking"))
    ),
    "rerank": lambda value: str(value.get("provider")),
    # §14.126's plan is one artifact object carried by one input, in the grammar `readWidthPlan`
    # accepts. Rendered in a fixed key order because the artifact's object has no order and a
    # key-order difference is not a configuration difference -- the same reason `route_rooms`
    # sorts.
    "width_plan": lambda value: ",".join(
        f"{key}={_number(value[field])}"
        for key, field in (("coverage", "coverage"), ("floor", "floorChars"), ("margin", "renderMargin"))
    ),
}

# `artifact field -> (dispatch input, renderer)`. Every entry here is a value the table can send,
# which is what makes the comparison possible at all.
PROJECTED: dict[str, tuple[str, str]] = {
    "retrievalThreshold": ("cortex_memory_retrieval_threshold", "number"),
    "sourceTrust": ("cortex_memory_source_trust", "number"),
    "promptContract": ("cortex_memory_prompt_contract", "text"),
    "ask": ("cortex_memory_ask", "text"),
    "reviewPass": ("cortex_memory_review_pass", "text"),
    "queryExpansion": ("cortex_memory_query_expansion", "text"),
    "selfConsistency": ("cortex_memory_self_consistency", "text"),
    "relevanceSignal": ("cortex_memory_relevance", "text"),
    "relevanceTopK": ("cortex_memory_relevance_top_k", "number"),
    "relevanceUnits": ("cortex_memory_relevance_units", "text"),
    "maxTurnChars": ("cortex_memory_max_turn_chars", "number"),
    "maxPromptCharsByRoute": ("cortex_memory_max_prompt_chars", "route_rooms"),
    # The third shape of the same input (§14.126): the workflow is at 24 of GitHub's 25 dispatch inputs and
    # the suite forbids the ceiling, so a plan rides the budget's value the way the marker rides the cap's.
    # `=` is the discriminator, which is why the two renderers cannot produce each other's output.
    "widthPlan": ("cortex_memory_max_prompt_chars", "width_plan"),
    "maxTurnCharsRoutes": ("cortex_memory_max_turn_chars_routes", "csv"),
    "evidenceRoles": ("cortex_memory_evidence_roles", "csv"),
    "evidenceRolesRoutes": ("cortex_memory_evidence_roles_routes", "csv"),
    "rerank": ("cortex_memory_rerank", "rerank"),
    "reader": ("model", "text"),
}

# The report-level fields that stand in for the inputs `memoryArmConfig` does not carry.
# `ablation_runs` is the repetition count, which the artifact records as an integer and the table as
# `'4'`, so the two are the same number in different spellings. `limit` is deliberately NOT here:
# see `UNPROJECTED`.
REPORT_LEVEL: dict[str, tuple[str, str]] = {
    "runs": ("ablation_runs", "number"),
}

# `artifact field -> (kind, why)`. `kind` is one of `derived`, `constant`, `identity`, `condition` --
# the last one also being derived from `conditions()` below rather than restated here.
UNPROJECTED: dict[str, tuple[str, str]] = {
    "threshold": (
        "constant",
        "fixed at 0 by the workflow since §13.101.3 -- admission-wide-open is the premise of every "
        "experiment on this arm rather than a variable within it, so there is no second copy to "
        "disagree with",
    ),
    "sessionBudget": (
        "constant",
        "`null` is unbounded, and the product default is unbounded; no dispatch input sets it",
    ),
    "confidenceSignal": (
        "constant",
        "`DEFAULT_CONFIDENCE_SIGNAL` in bench-memory-arm.ts, no dispatch input",
    ),
    "renderingRoutes": ("derived", "`RENDERING_BY_CONTRACT[promptContract]`"),
    "promptAssembly": ("derived", "`ASSEMBLY_BY_CONTRACT[promptContract]`"),
    "assemblyRoutes": ("derived", "`ASSEMBLY_ROUTES_BY_CONTRACT[promptContract]`"),
    "reviewBareDecline": ("derived", "`carriesBareLadder(reviewPass)`"),
    "askRoutes": ("derived", "`ASK_ROUTES[ask]`"),
    "anchors": (
        "constant",
        "the anchor restoration's count/radius/decay belong to the `retrieval-anchored` signal "
        "itself (§13.260.7) and no input carries them",
    ),
    "turnCutMarker": (
        "constant",
        "`DEFAULT_TURN_CUT_MARKER`; the non-default spelling rides the `maxTurnChars` grammar as "
        "`400:ellipsis` (§13.188), so this field is a projection of `maxTurnChars`",
    ),
    "embedding": (
        "identity",
        "provider and model resolve from the embedding environment at run time (`EMBEDDING_*`); "
        "the artifact records what was reached, and no §10.3 concept names it",
    ),
    # The three below were carried by `42533236864` and by no baseline before it, so `--record`
    # refused the artifact instead of writing a projection that stepped over them -- which is the
    # reverse direction doing its job. Each is classified rather than skipped for that reason.
    "effectivePromptChars": (
        "derived",
        "`#promptCharsFor`'s three-term expression (§13.299): the map for the routes it names, the "
        "product default for the rest. It is the field that says what a prompt was actually capped "
        "at, and comparing it would report a second violation for one defect",
    ),
    "evidenceSource": (
        "condition",
        "see `conditions()`: `corpus` on every benchmark dispatch, and the ablation's other source "
        "(`oracle`) is a different experiment rather than a value of this one",
    ),
    "judge": (
        "identity",
        "the grading model resolves from the judging environment at run time and no §10.3 concept "
        "names it; the artifact records what was used",
    ),
}


@functools.lru_cache(maxsize=1)
def _readout():  # noqa: ANN202 - imported by path, like every other cross-tool import here
    """`readout-arm-run.py`, which owns the condition vocabulary this module classifies against.

    Cached because `classification()` is called once per artifact field from `--record`'s refusal and
    again from every diagnosis line, and re-executing a 5,000-line module per field would be a parser
    benchmark. The single module object is also what makes the vocabulary injectable: a test can add
    a name to `REGISTERED_CONDITIONS` and watch the partition widen without editing this file, which is
    the property the classification claims.
    """
    spec = importlib.util.spec_from_file_location("readout_arm_run", ROOT / "tools" / "readout-arm-run.py")
    if spec is None or spec.loader is None:  # pragma: no cover - a missing file is a broken checkout
        raise SystemExit("cannot load tools/readout-arm-run.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def conditions() -> dict[str, tuple[str, object]]:
    """`{artifact field: registered value}` for the arm's **conditions**.

    A condition is the fourth class, and the one that produced a refusal nobody could read. It is a
    field the artifact carries, the dispatch table cannot send (`INPUTS` has 22 names and none of
    them is `conflicts`), and the workflow decides per run through the environment -- so neither
    `PROJECTED` (map it to an input name) nor `constant` (there is a second copy to disagree with)
    describes it. `readout-arm-run.py --registration` already compares them, with the rule that an
    artifact omitting one predates the field and **reads as the registered value**.

    That table is the single source of this vocabulary on purpose. `conflicts` (§13.352) and
    `replyRepair` (§13.334) landed in `memoryArmConfig` by design -- the writer spells both on every
    run from the change that introduced them -- and this module's hand-written partition did not know
    them, so `--record` refused every later artifact, the attestation's fingerprint moved on an arm
    that had not moved, and `differences()` named nothing because neither field is in `PROJECTED`.
    A refusal with an empty diagnosis is worse than no gate: it sends the reader to diff two JSON
    files and calls that a decision. Deriving the class from the table that compares the fields makes
    the partition total by construction for this family.
    """
    return {
        path.split(".")[0]: registered
        for path, registered in _readout().REGISTERED_CONDITIONS.values()
    }


def classification(field: str) -> str | None:
    """`projected`, the field's `UNPROJECTED` kind, `condition`, or `None` for undecided.

    One function rather than three set lookups at each call site: `--record`'s refusal, the
    attestation's diagnosis and the tests all have to agree about what "classified" means, and they
    stop agreeing the moment the definition is restated.
    """
    if field in PROJECTED:
        return "projected"
    if field in UNPROJECTED:
        return UNPROJECTED[field][0]
    if field in conditions():
        return "condition"
    return None

# Inputs in the table that the projection deliberately has no entry for. Kept as a mapping with a
# reason rather than as a silent skip, because the reverse direction of the comparison is what
# catches a projection that has quietly stopped covering a value.
#
# `cortex_memory` is the arm's switch, not a configuration value: it says whether the arm runs at
# all, and every `§10.3` concept describes what it runs as.
#
# `limit` is §10.3's `0`, which means the whole 500-question set, against the artifact's
# **resolved count** (`questionCount: 500`). `'0'` and `'500'` are the same measurement in two
# spellings, and a string comparison between them would report a defect on every green run -- the
# kind of false positive that gets a gate deleted. The registered value is pinned against the table
# by `test_preregistration_config.py`, and the resolved count rides in the baseline's own
# `questionCount`, so a baseline recorded from a 60-question smoke run is visible to a reader
# without being an error.
TABLE_ONLY: dict[str, str] = {
    "cortex_memory": "the arm's switch, not a configuration value",
    "limit": "`0` is the whole set; the artifact records the resolved count",
    # `registration-preflight.py` exempts this one for the same reason and says so: it selects which
    # questions *run* rather than how the arm behaves on them, so a 121-question `MR` dispatch and a
    # 500-question one are two samples of one configuration. Comparing it would report the sample as a
    # configuration difference, and §13.336's adoption is the case that made that expensive: the
    # projection has no entry for it, so every artifact recorded after the adoption would have been
    # reported as a departure on an input nobody had moved.
    "capability": "a run-level population selector, not a configuration value",
}


# Projected inputs the table deliberately does **not** send, because the value is fixed outside the
# dispatch. The mirror image of `TABLE_ONLY`: there the table has a key the artifact does not, here the
# artifact has a value the table does not. Both need a reason and both need the check in the other
# direction, or an exemption outlives the thing it exempts and nothing notices.
FIXED: dict[str, str] = {
    "temperature": (
        "fixed at 0 by the reader the arm builds (`temperature: 0` is the pre-registered value and "
        "§10.3 states it as a property of the arm); no dispatch input carries it, and the artifact "
        "records the value that was resolved"
    ),
}


def project(report: dict) -> dict[str, str]:
    """The `{input name: value}` a dispatch table would have to send to reproduce this artifact."""
    config = report["memoryArmConfig"]
    projected: dict[str, str] = {}
    for field, (input_name, renderer) in PROJECTED.items():
        if field not in config:
            continue
        value = config[field]
        if field == "reader":
            projected[input_name] = RENDERERS["text"](value.get("model"))
        else:
            projected[input_name] = RENDERERS[renderer](value)
    for field, (input_name, renderer) in REPORT_LEVEL.items():
        if field in report:
            projected[input_name] = RENDERERS[renderer](report[field])
    if "reader" in config:
        projected["temperature"] = RENDERERS["number"](config["reader"].get("temperature"))
        projected["thinking"] = RENDERERS["reader_thinking"](config["reader"])
    return projected


def canonical(config: object) -> str:
    """The artifact's configuration as one string, with no formatting left to disagree about.

    Sorted keys because the artifact's objects have no order and a key-order difference is not a
    configuration difference; no whitespace because indentation is not one either; `ensure_ascii` off
    because a product name is UTF-8 and escaping it would be a difference a reader cannot see.

    `efficiency-frontier.mjs` reimplements this in nine lines, because the shipping arm's fingerprint
    is written by the JavaScript tool from the artifact it loaded. `tools/__tests__/test_registration_attest.py`
    pins the two to the same output on a shared fixture: a fingerprint two languages compute
    differently would be a gate that fires on every green run, which is how a gate gets deleted.
    """
    return json.dumps(config, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def fingerprint(config: object) -> str:
    """`sha256:<hex>` over `canonical(config)`.

    The prefix is not decoration. `datasetFingerprint` in the artifacts uses the same spelling, so a
    reader who sees one without the other can tell the algorithm is stated rather than implied.

    What this identifies is the **configuration**, not the dispatch. Two runs of the same
    configuration share a fingerprint and that is the point: §13.336 adopted a configuration, and the
    claim an acceptance row needs to be able to check is "this reading is of the configuration we
    register", which survives a re-dispatch and does not survive an adoption.
    """
    return "sha256:" + hashlib.sha256(canonical(config).encode("utf-8")).hexdigest()


def unclassified(config: dict) -> list[str]:
    """The artifact fields no class covers, which is what `--record` refuses to write.

    `reader` is one field carrying four inputs, so its three other halves are named here rather
    than given classes of their own: `temperature` and `thinking` are projected out of it by
    `project()`, and `providerId`/`baseUrl`/`endpoint` are the identity the transport resolved.
    """
    return sorted(field for field in config if classification(field) is None)


def dispatched(path: Path = DISPATCH) -> dict[str, str]:
    """`INPUTS`, parsed rather than imported: importing runs `token()` and needs `.git/config`."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if [t.id for t in node.targets if isinstance(t, ast.Name)] != ["INPUTS"]:
            continue
        mapping = node.value
        if not isinstance(mapping, ast.Dict):
            raise AssertionError("INPUTS is not a dict literal")
        return {
            k.value: v.value
            for k, v in zip(mapping.keys, mapping.values)
            if isinstance(k, ast.Constant) and isinstance(v, ast.Constant)
        }
    raise AssertionError(f"{path} has no INPUTS assignment")


def record(
    report: dict,
    *,
    run: str,
    commit: str,
    adopted_by: str,
    why: str,
) -> dict:
    """The baseline file's body: provenance, the configuration, and the projection."""
    unknown = unclassified(report["memoryArmConfig"])
    if unknown:
        raise SystemExit(
            f"the artifact carries {unknown}, which no class covers. Add each one to PROJECTED "
            "(it is a dispatch input) or to UNPROJECTED with the reason it is not (it is derived, "
            "constant, or resolved at run time), and say which in the same change. A field that "
            "is in neither is a configuration value the gate passes over without deciding."
        )
    return {
        "run": run,
        "commit": commit,
        "adoptedBy": adopted_by,
        "why": why,
        "generatedAt": report["generatedAt"],
        "dataset": report["dataset"],
        "datasetFingerprint": report["datasetFingerprint"],
        "questionCount": report["questionCount"],
        "runs": report["runs"],
        "memoryArmConfig": report["memoryArmConfig"],
        # The whole configuration as one value, so a reader that cannot run this projection -- a
        # criterion in `acceptance.ts`, the shipping block in `efficiency-frontier.mjs` -- can still
        # ask the only question an attestation is allowed to ask. `dispatch` stays beside it because
        # a hash is undiagnosable and this file is the one place a difference can be named.
        "memoryArmConfigFingerprint": fingerprint(report["memoryArmConfig"]),
        "passShape": report.get("passShape"),
        "dispatch": project(report),
    }


def differences(baseline: dict, table: dict[str, str]) -> list[str]:
    """Every input whose recorded value and dispatched value disagree, in either direction."""
    recorded = baseline["dispatch"]
    found: list[str] = []
    # `TABLE_ONLY` is unioned in rather than iterated separately: an exempted key is in neither
    # side of the comparison, so a loop over the two sides alone would stop checking the exemption
    # the moment the table dropped the key it explains, and report nothing.
    for name in sorted(set(recorded) | set(table) | set(TABLE_ONLY)):
        if name in TABLE_ONLY:
            # Asserted in the other direction instead: the table must still send it, or the reason
            # above has outlived the key it describes.
            if name not in table:
                found.append(
                    f"{name}: TABLE_ONLY explains why the projection skips it, and the table no "
                    "longer sends it, so the explanation has outlived its subject"
                )
            continue
        if name in FIXED:
            # Asserted in the other direction, like `TABLE_ONLY`: an exemption whose subject the table
            # has since started sending is an exemption that has outlived its reason.
            if name in table:
                found.append(
                    f"{name}: FIXED says no dispatch input carries it and the table now sends "
                    f"{table[name]!r}, so the exemption has outlived its subject"
                )
            continue
        if name not in table:
            found.append(
                f"{name}: the run applied {recorded[name]!r} and the dispatch sends no such key, "
                "so a dispatch from this table cannot reproduce the baseline"
            )
        elif name not in recorded:
            found.append(
                f"{name}: the dispatch sends {table[name]!r} and the baseline's projection has no "
                "entry for it, which means the projection lost a value it claims to cover"
            )
        elif recorded[name] != table[name]:
            found.append(
                f"{name}: the run applied {recorded[name]!r} and the dispatch sends "
                f"{table[name]!r}. Both documents can be stale together -- that is the defect "
                "this file was written for -- so the artifact is the tiebreak. Amend the table to "
                "the value that ran, or record a new baseline from a run that names the change."
            )
    return found


def provenance_gaps(baseline: dict, document: Path = PREREGISTRATION) -> list[str]:
    """The record's own claims that cannot be checked from the record alone."""
    gaps: list[str] = []
    for key in ("run", "commit", "adoptedBy", "why", "datasetFingerprint", "generatedAt"):
        if not baseline.get(key):
            gaps.append(f"{key} is empty, so the baseline cannot be traced to a run")
    source = document.read_text(encoding="utf-8")
    if baseline.get("adoptedBy") and baseline["adoptedBy"] not in source:
        gaps.append(
            f"{baseline['adoptedBy']} does not appear in {document.name}, so the section that "
            "adopted this configuration has been renumbered or removed"
        )
    return gaps

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record", metavar="REPORT", help="write the baseline from this artifact")
    parser.add_argument("--run", default="", help="the run id the recorded artifact came from")
    parser.add_argument("--commit", default="", help="the head_sha the recorded run executed")
    parser.add_argument("--adopted-by", default="", help="the section that adopted the values")
    parser.add_argument("--why", default="", help="one sentence: why this run is the baseline")
    parser.add_argument("--check", action="store_true", help="compare the baseline with the table")
    parser.add_argument("--baseline", type=Path, default=BASELINE)
    parser.add_argument("--dispatch", type=Path, default=DISPATCH)
    args = parser.parse_args(argv)

    if args.record:
        report = json.loads(Path(args.record).read_text(encoding="utf-8"))
        body = record(
            report,
            run=args.run,
            commit=args.commit,
            adopted_by=args.adopted_by,
            why=args.why,
        )
        args.baseline.write_text(json.dumps(body, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"recorded {len(body['dispatch'])} input(s) from run {body['run'] or '<unnamed>'}")
        return 0

    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    gaps = provenance_gaps(baseline)
    found = differences(baseline, dispatched(args.dispatch))
    for line in gaps + found:
        print(f"  {line}")
    if not gaps and not found:
        print(
            f"ok: {len(baseline['dispatch'])} input(s) recorded from run {baseline['run']} "
            "agree with the dispatch table"
        )
        return 0
    print(
        f"FAILED: {len(gaps)} provenance gap(s), {len(found)} disagreement(s) between the run "
        "that adopted the configuration and the table that is supposed to reproduce it"
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
