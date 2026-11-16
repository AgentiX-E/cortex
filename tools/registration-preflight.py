#!/usr/bin/env python3
"""Refuse a dispatch that has already departed from the registration, before it spends.

## The run this file is written against

`41751619617` was dispatched with a budget map and nothing else filled in. It ran for
**87 minutes**, produced a complete 500-question artifact, and reported **85.00%**. Six
fields had moved away from the registration without anyone choosing them:

| field | registered | ran |
| --- | --- | --- |
| `ask` | `operands+operand-gap` | `route` |
| `relevance` | `retrieval-hybrid` | `retrieval` |
| `promptContract` | `abstention-evidence-blocks` | `abstention` |
| `maxTurnChars` | `400` | absent |
| `maxTurnCharsRoutes` | `multi-session,temporal` | all six |
| `evidenceRolesRoutes` | `multi-session,temporal` | all six |

`readout-arm-run.py --registration` read all six off the artifact and said so in the
clearest terms it has -- *"the run is an experiment that has not said so"* -- at 02:32,
after the money was spent. The gate was right and it was late. This script is the same
question asked at 01:05, and the answer costs nothing.

The reading is the reason this matters more than the wall clock: **85.00% against a
registered 90.15%** is a five-point regression that no mechanism in the dispatch was
supposed to cause, so an unwary reader would have concluded that a *redistribution* of
the character room costs five points. What actually moved was `relevance` losing its
hybrid channel and `maxTurnChars` losing its cap -- neither of which the dispatch named.

## Why the event payload and not the environment

The workflow deliberately does not copy the product's defaults into its own fallbacks:
`CORTEX_MEMORY_ASK` and its siblings are forwarded blank on purpose, so that the default
lives in exactly one place. The cost of that decision is that the environment cannot
distinguish *"the dispatcher asked for the product default"* from *"the dispatcher did not
ask at all"*, and the second is the defect. The payload keeps the difference: a key that
is absent was never asked for.

Reading the payload also catches the two inputs whose workflow fallback is **not** blank --
`limit` falls back to `60` and `thinking` to `disabled` -- which an environment read would
report as the dispatched value and therefore pass.

## What it does not do

It does not read the artifact. There are two gates because there are two questions:

| gate | question | when | reads |
| --- | --- | --- | --- |
| this file | what was **asked for** | before the run | `GITHUB_EVENT_PATH` |
| `--registration` | what **ran** | after the run | the artifact |

A run that changes a value inside the harness passes this one and is still caught there.
Neither substitutes for the other, and neither is allowed to be silent about which one it
answered.

## The declared departures list

`CORTEX_DECLARED_DEPARTURES` is written by `dispatch-cortex-memory-ab.py` for exactly the
departures it is making. A departure that is not on that list fails this gate, and so does a
listed key that resolves to nothing -- the second because a declaration that describes an
intention rather than a dispatch is the same class of defect as the missing one.

## The third category, and the run that found it

Two kinds of declaration are legal and this gate can see only one of them.

* A **dispatch input** that moved is visible in the payload, and that is what `departures()`
  reads.
* A **condition** -- `conflicts`, `indexEmbedding`, `supersededRendering` and the rest of
  `readout-arm-run.py`'s `REGISTERED_CONDITIONS` -- travels by a repository variable and is
  recorded by the arm on every artifact. The payload never mentions it, so this gate cannot
  say whether it moved, and it must not pretend to.

Run `43829744532` is why the distinction is now enforced rather than noted. It declared
`indexEmbedding`, and this gate printed *"declared but unchanged: indexEmbedding -- the
declaration names a field this dispatch did not move"* and then said `match`. The sentence
was false: the dispatch had moved the field, through a channel this file does not read.
Eighty-seven minutes and a complete artifact later, `readout-arm-run.py --registration`
resolved the same name to nothing -- because *that* table had no seat for it either -- and
refused the run. Two gates, each certain the other had looked.

So a declaration is now sorted into three buckets, not two:

| the declared name | this gate | the artifact gate |
| --- | --- | --- |
| a dispatch input that moved | confirmed departure | compares it against §10.3 |
| a registered condition | reported as carried to the artifact | compares it against §10.3 |
| neither | **refused here**, before the money | would refuse it after |

The third row is the one worth the price of admission: it costs nothing to refuse a name no
gate can resolve, and it costs a run to discover it at the end.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent

# The dispatcher's table is the registration's mirror; `test_preregistration_config.py`
# asserts that equality against §10.3 by reading the document, so importing it here is
# reading the registration rather than reading a fourth copy of it.
DISPATCH = TOOLS / "dispatch-cortex-memory-ab.py"

# The artifact gate's condition table, read rather than copied. A second copy of "which names can
# be resolved" would be a second thing to forget, which is the defect this file is being taught to
# refuse: the two gates must agree about the vocabulary, and the only way to keep two lists in
# agreement is to have one list.
READOUT = TOOLS / "readout-arm-run.py"


def _load(path: Path, name: str):  # noqa: ANN202 - a module loaded by path
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:  # pragma: no cover - import machinery
        raise SystemExit(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def conditions(path: Path = READOUT) -> frozenset[str]:
    """The names `readout-arm-run.py --registration` can resolve a declaration against.

    Imported from the artifact gate's own table so that the two gates cannot disagree about what a
    declaration may name. The import costs the whole module's load, which is milliseconds and happens
    once per dispatch.
    """
    return frozenset(_load(path, "readout_arm_run").REGISTERED_CONDITIONS)


def registration(path: Path = DISPATCH) -> dict[str, str]:
    """The values the pre-registration fixed, from the table the dispatcher sends."""
    module = _load(path, "dispatch_cortex_memory_ab")
    return {str(key): str(value) for key, value in module.INPUTS.items()}


def asked_inputs(event_path: Path) -> dict[str, str]:
    """What the dispatch asked for, as GitHub recorded it.

    A key whose value is the empty string is *asked for nothing*, which is the same state
    as absent: the workflow forwards it blank and the product fills in its own default. Both
    are reported as `absent` rather than as a value, because the distinction between them
    is not observable downstream and pretending otherwise would make the gate's message
    depend on which client produced the dispatch.
    """
    payload = json.loads(event_path.read_text())
    raw = payload.get("inputs") or {}
    return {str(key): value for key, value in raw.items()}


def departures(asked: dict[str, object], registered: dict[str, str]) -> dict[str, str | None]:
    """Registered keys whose asked value is either missing or different.

    `None` means nothing was asked; a string means something else was asked. The two are
    kept apart because they have different repairs -- fill the input in, or stop overriding
    it -- and a single "departed" flag would leave a reader to guess which.
    """
    out: dict[str, str | None] = {}
    for key, value in registered.items():
        if key not in asked:
            out[key] = None
            continue
        got = asked[key]
        if got is None or str(got).strip() == "":
            out[key] = None
            continue
        if str(got).strip() != value.strip():
            out[key] = str(got).strip()
    return out


def parse_declared(raw: str | None) -> list[str]:
    """The declared departure list, from the repository variable or a flag.

    Accepts the two shapes the variable has carried: a JSON array and a comma separated
    list. Refusing either shape would make the gate's own input the reason a run failed,
    which is a different defect from the one it is here to catch.
    """
    if not raw:
        return []
    text = raw.strip()
    if not text:
        return []
    if text.startswith("["):
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return [part.strip() for part in text.split(",") if part.strip()]
        if isinstance(parsed, list):
            return [str(item).strip() for item in parsed if str(item).strip()]
        return []
    return [part.strip() for part in text.split(",") if part.strip()]


def render(
    asked: dict[str, object],
    registered: dict[str, str],
    moved: dict[str, str | None],
    declared: list[str],
    carried: frozenset[str] = frozenset(),
) -> tuple[list[str], bool]:
    """The block a reader opens, and whether the dispatch may proceed.

    `carried` is the set of names that reach the artifact through a channel this gate does not
    read. They are neither confirmed nor denied here: the artifact gate compares them against the
    registration, and claiming in this file that one ``did not move`` would be a statement about a
    payload that never held it.
    """
    undeclared = sorted(key for key in moved if key not in declared)
    idle = sorted(key for key in declared if key not in moved and key not in carried and key in registered)
    delegations = sorted(key for key in declared if key not in moved and key in carried)
    # A name that is neither a dispatch input nor a condition is a declaration no gate can read.
    # Refusing it here costs nothing and refusing it at the artifact gate costs the run, which is
    # exactly what `43829744532` paid: the free gate said `match` and the paid gate said `refused`.
    unresolvable = sorted(
        key
        for key in declared
        if key not in moved and key not in carried and key not in registered
    )
    lines = [
        f"registration preflight: {DISPATCH.name} INPUTS",
        f"  asked {len(asked)} field(s), {len(registered)} registered, "
        f"{len(moved)} departed, {len(declared)} declared {declared}",
    ]
    for key in sorted(moved):
        value = moved[key]
        if value is None:
            lines.append(
                f'    ABSENT    {key}: registered "{registered[key]}", nothing asked'
            )
        else:
            lines.append(f'    DEPARTED  {key}: "{registered[key]}" (registered) -> "{value}" (asked)')
    for key in delegations:
        lines.append(
            f"  carried to the artifact: {key} -- a repository variable carries it and this gate "
            "does not read that channel, so whether it moved is `readout-arm-run.py "
            "--registration`'s question rather than this one's"
        )
    for key in idle:
        lines.append(
            f"  declared but unchanged: {key} -- the declaration names a field this "
            "dispatch did not move, so the record describes an intention rather than "
            "what was asked"
        )
    if unresolvable:
        lines.append(
            f"  verdict: {len(unresolvable)} declared name(s) cannot be resolved by either gate: "
            f"{unresolvable}"
        )
        lines.append(
            "  no dispatch input sends them and `readout-arm-run.py --registration` has no condition "
            "under those names, so the declaration is a sentence nothing will read -- and the gate "
            "that reads the artifact will refuse the run after it has spent. Name the artifact's "
            "field, or register the condition in `REGISTERED_CONDITIONS`"
        )
        return lines, False
    if undeclared:
        lines.append(
            f"  verdict: {len(moved)} field(s) departed and {len(undeclared)} "
            f"{'was' if len(undeclared) == 1 else 'were'} not declared: {undeclared}"
        )
        lines.append(
            "  a dispatch that names a budget map and nothing else is not the registered "
            "arm. Fill every input in through `tools/dispatch-cortex-memory-ab.py`, or "
            "declare each departure in the `CORTEX_DECLARED_DEPARTURES` repository variable"
        )
        return lines, False
    if moved:
        lines.append(f"  verdict: {len(moved)} declared departure(s), nothing undeclared -- match")
    else:
        lines.append("  verdict: this dispatch is the registered configuration, field for field")
    return lines, True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--event",
        default=os.environ.get("GITHUB_EVENT_PATH"),
        help="the event payload GitHub wrote for this dispatch (default: GITHUB_EVENT_PATH)",
    )
    parser.add_argument(
        "--declared",
        default=os.environ.get("CORTEX_DECLARED_DEPARTURES"),
        help="declared departures (default: CORTEX_DECLARED_DEPARTURES)",
    )
    parser.add_argument(
        "--inputs",
        nargs="*",
        default=None,
        metavar="KEY=VALUE",
        help="ask for these inputs instead of reading the payload, for a rehearsal",
    )
    args = parser.parse_args(argv)

    registered = registration()
    if args.inputs is not None:
        asked: dict[str, str] = {}
        for item in args.inputs:
            key, _, value = item.partition("=")
            asked[key.strip()] = value
    else:
        if not args.event:
            print(
                "::error::no event payload: this gate cannot tell what the dispatch asked for, "
                "so it cannot pass it",
                file=sys.stderr,
            )
            return 1
        asked = asked_inputs(Path(args.event))

    moved = departures(asked, registered)
    declared = parse_declared(args.declared)
    lines, ok = render(asked, registered, moved, declared, conditions())
    print("\n".join(lines))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
