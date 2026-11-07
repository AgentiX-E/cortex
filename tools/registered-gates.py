#!/usr/bin/env python3
"""Evaluate a registration's gate table against the artifacts it was written for.

    python3 tools/registered-gates.py tools/gates/13.262.7.json \\
        --treatment run-42130772725/report.json \\
        --reference run-42013256884/report.json \\
        --prior     run-42054107910/report.json

## Why the gates are a file rather than a paragraph

§13.262.7 registered eight thresholds *before* the dispatch that they judge, and the whole value of
that ordering is that the thresholds cannot be adjusted once the number exists. A table read by hand
does not preserve it: the reader holds the number and the threshold in the same head, and the project
has measured what that costs. §13.262.1's gate 6 read `FAIL` on run `42054107910` because the check
compared a flag count against a tally accumulated over four repetitions -- the identity was right and
the *check* was wrong, and nobody could tell from the prose. The same class appears at §13.69, where
the registration and the dispatch each believed their own copy of an adopted value.

So the table lives here as data (`tools/gates/<section>.json`), one entry per registered row, and
this tool decides each row from the artifact bytes. Two properties follow:

- each gate's verdict is an exit code rather than an opinion, which is what lets CI or a reader
  disagree with the author about a run instead of about the meaning of a sentence;
- the registration cannot drift from the evaluation, because
  `tools/__tests__/test_registered_gates.py` parses §13.262.7's table out of the document and
  requires every number in the spec to appear in the row it belongs to. That test fails for an edit
  to either side unless both move.

## Why `UNEVALUABLE` fails the run

A gate whose field is absent is not a gate that passed. §13.11.2 fixed this rule for artifact
fields -- a missing measurement is not a zero one -- and §13.262.4 paid for it a second time: a
field name (`carriesBareLadder`) was read as if it were a population, so `audit` runs silently
reported that they carried no bare ladder when they did. A run that does not report
`bareRetry.attempted` therefore cannot demonstrate that the ladder came back, and answering
`PASS` for it would publish the absence of evidence as evidence.

## Why the delta is paired

Two accuracies computed on two populations are not a difference. Every delta here is computed on the
**intersection** of the two artifacts' question ids, and the excluded count is printed beside it, so
a control that measured 480 of the treatment's 500 questions cannot silently contribute a delta over
480 while the verdict reads as if it covered 500. The McNemar test is then run on the same
intersection, which makes the point estimate and the p-value statements about one population.

## What this tool does not do

It does not decide whether the registration was *right*, and it does not add a gate. A check stricter
than the registered one would be a threshold written after the number, which is the defect the spec
file exists to prevent -- so anything the artifact makes visible but the registration did not ask
about is printed as an `observation` and left out of the verdict.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

PASS = 'PASS'
FAIL = 'FAIL'
UNEVALUABLE = 'UNEVALUABLE'

# Points, not fractions: §13.262.7 registers `Δ ≥ +10` and `no loss ≥ 3 points`, so the threshold
# and the measurement are compared in the unit the registration wrote them in. Converting either
# side at print time would put a rounding step between a number and the bar it is held to.
_EPSILON = 1e-9


def _readout():  # noqa: ANN202 - the module, loaded by path
    """`tools/readout-arm-run.py` as a module, for `exact_sign_test`.

    One implementation rather than a second copy: the binomial test decides every direction this
    project reports, and two copies would be two answers on the same data the first time one of
    them was edited -- §13.69's defect, one file over.
    """
    path = ROOT / 'tools' / 'readout-arm-run.py'
    spec = importlib.util.spec_from_file_location('readout_arm_run', path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load(path: Path) -> dict:
    """The artifact, or a refusal. A gate cannot be read from a file that is not a report."""
    report = json.loads(Path(path).read_text())
    if not isinstance(report, dict):
        raise SystemExit(f'{path} is not a JSON object, so it is not a report')
    return report


def _dotted(report: dict, field: str) -> object:
    """The value at `a.b.c`, or `None` when any step is absent.

    `None` rather than a raised error: absence is a verdict here (`UNEVALUABLE`), not a crash, and
    the distinction between "the run did not report it" and "the tool could not be run" is what a
    reader needs when the report is missing a block.
    """
    node: object = report
    for part in field.split('.'):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def _questions(report: dict) -> list[dict]:
    questions = report.get('questions')
    return [q for q in questions if isinstance(q, dict)] if isinstance(questions, list) else []


def _by_id(report: dict, capability: str | None = None) -> dict[str, dict]:
    """Question records keyed by id, optionally restricted to one capability."""
    records: dict[str, dict] = {}
    for question in _questions(report):
        if capability is not None and question.get('capability') != capability:
            continue
        identifier = question.get('questionId')
        if isinstance(identifier, str):
            records[identifier] = question
    return records


def _correct(record: dict) -> bool:
    return record.get('correct') is True


def _capabilities(report: dict) -> list[str]:
    """The capabilities the artifact actually measured, read from its records.

    From the records rather than from `feature.metrics.perCapability`, because the summary block is a
    second copy of the population: a capability that vanished from the roster would still be listed
    there if the writer had not been updated, and the non-loss gate would then read a delta over zero
    questions. Deriving it from the records makes the gate's population the one the deltas are
    computed on.
    """
    return sorted({q.get('capability') for q in _questions(report) if isinstance(q.get('capability'), str)})


def _points(count: int, total: int) -> float:
    return 100.0 * count / total if total else 0.0


def _paired(treatment: dict, control: dict, capability: str) -> tuple[list[str], int, int, int, int]:
    """The shared ids and the four counts every paired reading needs.

    Returns `(shared, treatment_correct, control_correct, wins, losses)` where a win is a question
    the control got wrong and the treatment got right. Questions present in one artifact only are
    excluded by construction and counted by the caller, never assumed away.
    """
    after = _by_id(treatment, capability)
    before = _by_id(control, capability)
    shared = sorted(set(after) & set(before))
    treatment_correct = sum(1 for key in shared if _correct(after[key]))
    control_correct = sum(1 for key in shared if _correct(before[key]))
    wins = sum(1 for key in shared if _correct(after[key]) and not _correct(before[key]))
    losses = sum(1 for key in shared if not _correct(after[key]) and _correct(before[key]))
    return shared, treatment_correct, control_correct, wins, losses


def _delta_line(
    capability: str | None,
    shared: list[str],
    treatment_correct: int,
    control_correct: int,
    wins: int,
    losses: int,
    p_value: float,
) -> str:
    total = len(shared)
    after = _points(treatment_correct, total)
    before = _points(control_correct, total)
    return (
        f'`{capability or "ALL"}` {before:.2f}% \u2192 {after:.2f}% '
        f'({after - before:+.2f} over {total}; {wins} won, {losses} lost; p = {p_value:.4g})'
    )


def gate_capability_delta(gate: dict, treatment: dict, controls: dict[str, dict], alpha: float) -> dict:
    # Absent means every shared question, which is the one reading a **reader** experiment needs:
    # a different model is claimed to answer better overall, and a per-capability gate cannot say
    # that without five of them agreeing by construction. Stated as an absent key rather than a
    # sentinel value, because a sentinel would be a capability name no artifact carries and the
    # next reader would have to learn it from the implementation.
    capability = gate.get('capability')
    control = controls[gate['control']]
    shared, after_correct, before_correct, wins, losses = _paired(treatment, control, capability)
    if not shared:
        return _result(gate, UNEVALUABLE, 'no question id is shared with the control')
    p_value = _readout().exact_sign_test(wins, losses)
    delta = _points(after_correct - before_correct, len(shared))
    at_least = float(gate['at_least_points'])
    meets_delta = delta >= at_least - _EPSILON
    meets_significance = (not gate.get('requires_nonsignificance', False)) or p_value >= alpha
    verdict = PASS if meets_delta and meets_significance else FAIL
    reading = _delta_line(capability, shared, after_correct, before_correct, wins, losses, p_value)
    if gate.get('requires_nonsignificance', False) and meets_delta and p_value < alpha:
        reading += f' \u2014 significant at \u03b1 = {alpha}: the pass is decided, not neutral'
    return _result(gate, verdict, reading, {'delta_points': delta, 'p_value': p_value, 'wins': wins, 'losses': losses, 'shared': len(shared)})


def gate_capability_nonloss(gate: dict, treatment: dict, controls: dict[str, dict], alpha: float) -> dict:
    """Every capability the control measured, except the one gates 1 and 2 own, loses under the bar.

    The population is the **control's** capabilities, not the treatment's: a capability the
    treatment stopped reporting is a loss of the whole capability, and taking the list from the
    treatment would silently drop it from the gate instead.
    """
    control = controls[gate['control']]
    excluding = set(gate.get('excluding', []))
    candidates = [cap for cap in _capabilities(control) if cap not in excluding]
    if not candidates:
        return _result(gate, UNEVALUABLE, 'the control artifact names no capability to hold')
    max_loss = float(gate['max_loss_points'])
    lines: list[str] = []
    worst: float | None = None
    missing: list[str] = []
    failed = False
    for capability in candidates:
        shared, after_correct, before_correct, wins, losses = _paired(treatment, control, capability)
        if not shared:
            missing.append(capability)
            continue
        p_value = _readout().exact_sign_test(wins, losses)
        delta = _points(after_correct - before_correct, len(shared))
        worst = delta if worst is None else min(worst, delta)
        if delta < -max_loss - _EPSILON:
            failed = True
        lines.append(_delta_line(capability, shared, after_correct, before_correct, wins, losses, p_value))
    if missing:
        return _result(gate, UNEVALUABLE, 'no shared question for ' + ', '.join(missing))
    reading = '; '.join(lines) + f' \u2014 worst {worst:+.2f} points (bar: no loss \u2265 {max_loss:g})'
    return _result(gate, FAIL if failed else PASS, reading, {'worst_points': worst})


def gate_field_at_least(gate: dict, treatment: dict, controls: dict[str, dict], alpha: float) -> dict:
    value = _dotted(treatment, gate['field'])
    bar = float(gate['at_least'])
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return _result(gate, UNEVALUABLE, f'`{gate["field"]}` is absent or not a number')
    verdict = PASS if float(value) >= bar - _EPSILON else FAIL
    return _result(gate, verdict, f'`{gate["field"]}` = {value:g} (bar: \u2265 {bar:g})', {'value': value})


def gate_field_at_most(gate: dict, treatment: dict, controls: dict[str, dict], alpha: float) -> dict:
    value = _dotted(treatment, gate['field'])
    bar = float(gate['at_most'])
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return _result(gate, UNEVALUABLE, f'`{gate["field"]}` is absent or not a number')
    verdict = PASS if float(value) <= bar + _EPSILON else FAIL
    return _result(gate, verdict, f'`{gate["field"]}` = {value:g} (bar: \u2264 {bar:g})', {'value': value})


def gate_audit_identity(gate: dict, treatment: dict, controls: dict[str, dict], alpha: float) -> dict:
    """The roster's column against the run-level tally, and the changed count's own bounds.

    The column is required on **every** record. A record without it is not a zero: at `runs > 1` the
    roster records each question once and the tally counts every repetition, so a partially written
    column would sum to something smaller than the tally and the identity would report a defect in
    the mechanism when the defect was in the writer. §13.262.5 is that failure.
    """
    consultations_field = gate['consultations_field']
    changes_field = gate['changes_field']
    records = _questions(treatment)
    if not records:
        return _result(gate, UNEVALUABLE, 'the artifact carries no question records')
    absent = [q.get('questionId') for q in records if not isinstance(q.get(consultations_field), int)]
    if absent:
        sample = ', '.join(str(i) for i in absent[:5])
        return _result(
            gate,
            UNEVALUABLE,
            f'`{consultations_field}` is missing on {len(absent)} of {len(records)} records ({sample})',
        )
    tally = _dotted(treatment, gate['tally_field'])
    changed = _dotted(treatment, gate['changed_tally_field'])
    if not isinstance(tally, int) or not isinstance(changed, int):
        return _result(gate, UNEVALUABLE, f'`{gate["tally_field"]}` or `{gate["changed_tally_field"]}` is absent')
    column = sum(int(q[consultations_field]) for q in records)
    changes = sum(int(q.get(changes_field) or 0) for q in records)
    within_bounds = 0 <= changed <= tally
    verdict = PASS if column == tally and within_bounds else FAIL
    reading = (
        f'column sums to {column} against a tally of {tally} '
        f'({len(records)} records, \u00d7{tally // column if column else 0} repetitions); '
        f'0 \u2264 {changed} \u2264 {tally}'
    )
    # Printed, not gated: the registration asked for the consultations column and the changed
    # count's bounds. A changes column that does not sum to `changed` is worth seeing and is not a
    # threshold written before the run, so it does not enter the verdict.
    observation = f'changes column sums to {changes} against a tally of {changed}'
    return _result(gate, verdict, reading, {'column': column, 'tally': tally, 'changes': changes}, observation)


def gate_sides_within_total(gate: dict, treatment: dict, controls: dict[str, dict], alpha: float) -> dict:
    sides = _dotted(treatment, gate['sides_field'])
    total = _dotted(treatment, gate['total_field'])
    if not isinstance(sides, dict) or not isinstance(total, int):
        return _result(gate, UNEVALUABLE, f'`{gate["sides_field"]}` or `{gate["total_field"]}` is absent')
    readings: list[str] = []
    failed = False
    for name in sorted(sides):
        calls = _dotted(sides, f'{name}.calls')
        if not isinstance(calls, int):
            return _result(gate, UNEVALUABLE, f'`{name}` carries no call count')
        if calls > total:
            failed = True
        readings.append(f'{name} {calls:,} of {total:,}')
    return _result(
        gate,
        FAIL if failed else PASS,
        '; '.join(readings) + f' (bar: each side \u2264 {total:,})',
        {'total': total},
    )


def gate_digest_agreement(gate: dict, treatment: dict, controls: dict[str, dict], alpha: float) -> dict:
    """Every question's delivery digest against the control's, on the shared population.

    A record without a digest is excluded rather than counted as a disagreement: §13.262.5's
    `_digest` rule, and the reason the field exists -- a record cannot testify about bytes it did not
    fingerprint. The denominator is then compared with the registered one, because `480/480` is not
    the registered `500/500` and a run that measured fewer questions cannot claim it.

    ## `excluding`: the reach gate

    Without it the gate can only ask "did any prompt change", which is what a treatment is *for* on
    its own route. §13.279's gate 5 asks the other question -- did the treatment leak -- by naming
    the capability it is supposed to move and requiring agreement on the rest; the denominator is
    then the excluded population (379 of 500 for a multi-session treatment), so a run that agreed on
    fewer questions because the others vanished cannot claim the reach.
    """
    control = controls[gate['control']]
    field = gate['field']
    after = _by_id(treatment)
    before = _by_id(control)
    excluded = set(gate.get('excluding', ()))
    shared = [
        key
        for key in sorted(set(after) & set(before))
        if before[key].get('capability') not in excluded
    ]
    compared = [
        key
        for key in shared
        if isinstance(after[key].get(field), str) and isinstance(before[key].get(field), str)
    ]
    agree = sum(1 for key in compared if after[key][field] == before[key][field])
    expected = int(gate['denominator'])
    if len(compared) != expected:
        return _result(
            gate,
            UNEVALUABLE,
            f'{len(compared)} of {expected} questions carry a digest on both sides, '
            f'so agreement cannot be stated as {expected}/{expected}',
        )
    verdict = PASS if agree == expected else FAIL
    return _result(gate, verdict, f'{agree}/{expected} agree', {'agree': agree, 'compared': len(compared)})


def gate_digest_disagreement(gate: dict, treatment: dict, controls: dict[str, dict], alpha: float) -> dict:
    """At least N questions' delivery digests differ from the control's, inside one capability.

    The mirror of `digest_agreement`, and it exists because "the treatment reached the product" and
    "the treatment did nothing" are the same artifact otherwise. §13.286.2 is the case: a value the
    arm parsed, projected into the artifact's configuration line and never forwarded. Every downstream
    gate read `PASS` on that run -- no capability lost, the digests agreed with the control, the call
    count was under the bar -- and the agreement was the defect, because agreement was what a run that
    administered nothing produces. §13.267.3 named the shape: a table of gates is only as strong as
    the one that can tell a null result from a missing treatment.

    Scoped to one capability on purpose. A unit that changes `MR` and leaves the other four byte
    identical is what the arm's reach claims, and the pair (this gate on `MR`, `digest_agreement`
    with `excluding: [MR]` over the rest) is a two-sided statement: the treatment arrived where it
    was registered *and* nowhere else. Either one alone is satisfiable by a run that did nothing.

    Refused rather than failed when either artifact lacks the field, for `digest_agreement`'s reason:
    a record cannot testify about bytes it did not fingerprint, and counting it as a disagreement
    would let a missing field manufacture the arrival.
    """
    control_report = controls.get(gate['control'])
    if control_report is None:
        return _result(gate, UNEVALUABLE, f'the `{gate["control"]}` artifact was not supplied')
    field = gate['field']
    capability = gate['capability']
    bar = int(gate['at_least'])
    after = _by_id(treatment)
    before = _by_id(control_report)
    shared = [
        key
        for key in sorted(set(after) & set(before))
        if before[key].get('capability') == capability and after[key].get('capability') == capability
    ]
    compared = [
        key
        for key in shared
        if isinstance(after[key].get(field), str) and isinstance(before[key].get(field), str)
    ]
    if not compared:
        return _result(gate, UNEVALUABLE, f'no `{capability}` question carries a `{field}` on both sides')
    differ = sum(1 for key in compared if after[key][field] != before[key][field])
    verdict = PASS if differ >= bar else FAIL
    return _result(
        gate,
        verdict,
        f'`{capability}`: {differ} of {len(compared)} deliveries differ from the control (bar: \u2265 {bar})',
        {'differ': differ, 'compared': len(compared)},
    )


def gate_field_equals(gate: dict, treatment: dict, controls: dict[str, dict], alpha: float) -> dict:
    """One field of the artifact against an expected value, for the "the dispatch took" check.

    A run whose configuration never moved measures nothing, and every other gate in the table would
    read `PASS` on it: no capability lost, the call count is under the bar, the digests agree. The
    cheapest way to publish a null result as a confirmation is to lose the departure between the
    dispatch and the runner, so the departure itself is a gate -- §13.69's shape, where the
    registration and the dispatch each carried their own copy of an adopted value.
    """
    value = _dotted(treatment, gate['field'])
    if value is None:
        return _result(gate, UNEVALUABLE, f'`{gate["field"]}` is absent')
    expected = gate['equals']
    verdict = PASS if value == expected else FAIL
    return _result(gate, verdict, f'`{gate["field"]}` = {value!r} (registered: {expected!r})', {'value': value})


def gate_coverage_gain(gate: dict, treatment: dict, controls: dict[str, dict], alpha: float) -> dict:
    """How many more questions the retrieval could reach, on the pairs the control also graded.

    The quantity is the count of records whose `goldOverlap` satisfies `reaches`, i.e. whose gold
    turns were all available to the mechanism. It is the leading indicator of a retrieval-width
    experiment: widening the pool changes this count before it changes an accuracy, so a null
    accuracy result still says whether the mechanism fired.

    Refused rather than passed when either artifact lacks the block. A record without `goldOverlap`
    cannot testify about reach, and counting it as unreached would let a missing field manufacture
    the gain the gate is looking for -- §13.11.2's rule.
    """
    capability = gate.get('capability')
    reaches = gate['reaches']
    bar = int(gate['at_least_gain'])
    control_report = controls.get(gate.get('control', 'reference'))
    if control_report is None:
        return _result(gate, UNEVALUABLE, 'the control artifact was not supplied')

    def count(report: dict) -> tuple[int, int]:
        total = 0
        reached = 0
        for record in report.get('questions') or []:
            if capability is not None and record.get('capability') != capability:
                continue
            overlap = record.get('goldOverlap')
            if not isinstance(overlap, dict):
                continue
            total += 1
            carried = overlap.get(reaches['numerator'])
            target = overlap.get(reaches['denominator'])
            if not isinstance(carried, int) or not isinstance(target, int):
                continue
            if carried >= target and target > 0:
                reached += 1
        return reached, total

    gained, graded = count(treatment)
    before, before_graded = count(control_report)
    if graded == 0 or before_graded == 0:
        return _result(gate, UNEVALUABLE, f'no `goldOverlap` block on the {capability or "whole"} population')
    delta = gained - before
    verdict = PASS if delta >= bar else FAIL
    reading = (
        f'{gained}/{graded} reach every gold turn, against {before}/{before_graded} '
        f'({delta:+d}; bar: \u2265 {bar:+d})'
    )
    return _result(gate, verdict, reading, {'gain': delta, 'treatment': gained, 'control': before})


def gate_artifact_audit(gate: dict, treatment: dict, controls: dict[str, dict], alpha: float) -> dict:
    """The artifact's own internal-consistency audit, as a registered condition.

    `tools/readout-arm-run.py --audit` already refuses a self-inconsistent artifact, and until now
    that refusal was a step in the benchmark workflow rather than a gate in any registration: a
    readout could be produced from an artifact the audit had rejected, because the two ran in
    different jobs and only one of them gated. `42161343457` is the case -- the audit failed the run
    on `reviewPass: bare` publishing a zeroed census, and the seven gates §13.266 registered were
    nonetheless all evaluable, six of them passing, on that same artifact.

    So the audit becomes a gate of its own kind. It reads the same implementation rather than a
    second copy of the twelve checks, for the reason `_readout` exists: two copies are two answers
    the first time one is edited.
    """
    text, code = _readout().audit_section(treatment, _questions(treatment))
    failed: list[str] = []
    for line in text.splitlines():
        cells = line.split()
        if len(cells) >= 2 and cells[0] == 'FAIL':
            failed.append(cells[1])
    passed = code == 0 and not failed
    reading = (
        'every artifact check passes'
        if passed
        else 'failed: ' + ', '.join(failed) if failed else f'the audit exited {code}'
    )
    return _result(gate, PASS if passed else FAIL, reading, {'failed': failed, 'exit': code})


def gate_coverage_monotone(gate: dict, treatment: dict, controls: dict[str, dict], alpha: float) -> dict:
    """No question carries fewer gold turns than the control carried for it.

    §13.283's safety claim, stated per question rather than as a mean. The argument for the treatment
    is that a cheaper per-item rendering admits a weakly longer prefix of one order, so the delivered
    set *contains* the control's: not "coverage rises on average" but "no question can lose a gold
    turn". A mean would pass on a run that improved fifty questions and damaged twenty, which for a
    resource change like this is the one outcome that would make the gain unattributable.

    Refused rather than passed when either side lacks the block, for `coverage_gain`'s reason: a
    record that cannot testify about coverage must not be counted as having kept it.
    """
    control_report = controls.get(gate['control'])
    if control_report is None:
        return _result(gate, UNEVALUABLE, f'the `{gate["control"]}` artifact was not supplied')
    reaches = gate['reaches']
    numerator, denominator = reaches['numerator'], reaches['denominator']

    def carried_by_question(report: dict) -> dict[str, tuple[int, int]]:
        counted: dict[str, tuple[int, int]] = {}
        for record in report.get('questions') or []:
            overlap = record.get('goldOverlap')
            identifier = record.get('questionId')
            if not isinstance(overlap, dict) or not isinstance(identifier, str):
                continue
            carried, total = overlap.get(numerator), overlap.get(denominator)
            if isinstance(carried, int) and isinstance(total, int):
                counted[identifier] = (carried, total)
        return counted

    after = carried_by_question(treatment)
    before = carried_by_question(control_report)
    shared = sorted(set(after) & set(before))
    if not shared:
        return _result(gate, UNEVALUABLE, 'the two artifacts share no question with a `goldOverlap` block')
    offenders = [identifier for identifier in shared if after[identifier][0] < before[identifier][0]]
    lost = sum(before[i][0] - after[i][0] for i in offenders)
    reading = (
        f'{len(shared) - len(offenders)} of {len(shared)} questions carry at least as many gold turns '
        f'as the control'
        + ('' if not offenders else f'; {len(offenders)} carry fewer, {lost} turn(s) in total, first: ' + ', '.join(offenders[:3]))
    )
    return _result(
        gate,
        PASS if not offenders else FAIL,
        reading,
        {'shared': len(shared), 'offenders': len(offenders), 'turns_lost': lost},
    )


#: The per-turn source marker `sourced` renders: a bracketed identifier, then the space that follows it.
#:
#: Written as the exact shape rather than as "a bracket holding long hex" so the count is a count of
#: what the renderer emits. A looser pattern would also match a dataset's own bracketed text and the
#: gate would then read a treatment that removed the marker as one that had not.
SOURCE_MARKER = re.compile(r'\[[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\] ')


def gate_source_marker_absence(gate: dict, treatment: dict, controls: dict[str, dict], alpha: float) -> dict:
    """No delivered prompt carries a per-turn source id.

    §13.283's treatment is the withholding of a 38-character marker, and every other gate in that
    table can be satisfied by a run that changed nothing: the contract name is a config field, and a
    capability that moved says nothing about *which bytes* moved. This reads the bytes.

    It is the same class of gate §13.279's seventh was -- a statement about prompts rather than about
    scores -- one level more specific: there the claim was that 379 prompts were unchanged, here it
    is that all 500 lost one token type. A run that named the contract and rendered anyway fails
    here and nowhere else.

    Absent or empty prompt text is `UNEVALUABLE` rather than a pass, because a prompt the artifact
    did not keep is a prompt this gate cannot read, and "0 markers in 0 prompts" is exactly the shape
    that would otherwise read as success.
    """
    node = _dotted(treatment, gate['prompt_field'])
    if not isinstance(node, list) or not node:
        return _result(
            gate,
            UNEVALUABLE,
            f'`{gate["prompt_field"]}` is absent or empty, so there is no prompt to read',
        )
    texts = [text for text in node if isinstance(text, str)]
    occurrences = sum(len(SOURCE_MARKER.findall(text)) for text in texts)
    faded = sum(1 for text in texts if SOURCE_MARKER.search(text))
    limit = int(gate['at_most'])
    reading = (
        f'{faded} of {len(texts)} prompt(s) carry a source id, {occurrences:,} marker(s) in total; '
        f'the bar is at most {limit}'
    )
    return _result(
        gate,
        PASS if occurrences <= limit else FAIL,
        reading,
        {'prompts': len(texts), 'with_marker': faded, 'markers': occurrences, 'at_most': limit},
    )


def gate_gold_text_complete(gate: dict, treatment: dict, controls: dict[str, dict], alpha: float) -> dict:
    """Every record that names gold carries the text of every gold turn, indexed with the rest.

    §13.267.5 found that the restore counterfactual was blocked by one missing field, and §13.268.7
    found the same absence turning a room calculation into "every question is reachable", because a
    sum over an absent list is zero. The unit tests pin the field on the producer; this pins it on the
    artifact, which is the object the two instruments actually read.

    Absent is legitimate and required on a record whose `goldOverlap` names no gold -- the block's own
    rule -- so the population is the records with `total > 0`, and the denominator is printed. A
    record with `total > 0` and no list is the case this exists for: it is indistinguishable from a
    question whose gold text happens to be empty, which no dataset produces.
    """
    records = _questions(treatment)
    if not records:
        return _result(gate, UNEVALUABLE, 'the artifact carries no question records')
    named = [record for record in records if isinstance(record.get('goldOverlap'), dict)]
    if not named:
        return _result(gate, UNEVALUABLE, 'no record carries a `goldOverlap` block')
    expected = [record for record in named if (record['goldOverlap'].get('total') or 0) > 0]
    if not expected:
        return _result(gate, UNEVALUABLE, 'no record names any gold turn, so there is no text to carry')
    offenders: list[str] = []
    for record in expected:
        block = record['goldOverlap']
        total = block.get('total')
        turns = block.get('goldTurns')
        if not isinstance(turns, list) or len(turns) != total:
            got = len(turns) if isinstance(turns, list) else 'absent'
            offenders.append(f'{record.get("questionId")}: {got} against {total}')
        elif not all(isinstance(turn, str) for turn in turns):
            offenders.append(f'{record.get("questionId")}: a turn is not text')
    total_gold = sum(len(record['goldOverlap']['goldTurns']) for record in expected if isinstance(record['goldOverlap'].get('goldTurns'), list))
    reading = (
        f'{len(expected) - len(offenders)} of {len(expected)} records carry the text of every gold '
        f'turn ({total_gold:,} turn(s) recorded)'
        + ('' if not offenders else '; first: ' + '; '.join(offenders[:3]))
    )
    return _result(
        gate,
        PASS if not offenders else FAIL,
        reading,
        {'records': len(expected), 'offending': len(offenders)},
    )


KINDS = {
    'capability_delta': gate_capability_delta,
    'capability_nonloss': gate_capability_nonloss,
    'field_at_least': gate_field_at_least,
    'field_at_most': gate_field_at_most,
    'audit_identity': gate_audit_identity,
    'sides_within_total': gate_sides_within_total,
    'digest_agreement': gate_digest_agreement,
    'field_equals': gate_field_equals,
    'digest_disagreement': gate_digest_disagreement,
    'coverage_gain': gate_coverage_gain,
    'artifact_audit': gate_artifact_audit,
    'gold_text_complete': gate_gold_text_complete,
    'source_marker_absence': gate_source_marker_absence,
    'coverage_monotone': gate_coverage_monotone,
}

#: The keys every gate of a kind carries, and the keys a gate may additionally carry.
#:
#: §13.268. `tools/gates/13.266.json` was written with `at_most_loss_points` where the implementation
#: and its sibling table both say `max_loss_points`, and nothing noticed until the artifact arrived and
#: `gate_capability_nonloss` raised `KeyError` halfway through a seven-gate readout. A registration is
#: data, and data that a reader can only fail on is data nobody validated: the table could equally have
#: said `at_most_loss_point` and produced the same crash, or a key the kind ignores and produced no
#: crash at all while the bar it meant to set was never applied.
#:
#: The schema is stated here, beside `KINDS`, so a new kind cannot be added without one -- the test
#: holds `KINDS` and `GATE_SCHEMA` to the same key set, which is the assertion that makes the pairing
#: structural rather than remembered.
GATE_SCHEMA: dict[str, tuple[frozenset[str], frozenset[str]]] = {
    'capability_delta': (
        frozenset({'control', 'at_least_points'}),
        frozenset({'capability', 'requires_nonsignificance'}),
    ),
    'capability_nonloss': (frozenset({'control', 'max_loss_points'}), frozenset({'excluding'})),
    'field_at_least': (frozenset({'field', 'at_least'}), frozenset()),
    'field_at_most': (frozenset({'field', 'at_most'}), frozenset()),
    'audit_identity': (
        frozenset({'consultations_field', 'changes_field', 'tally_field', 'changed_tally_field'}),
        frozenset(),
    ),
    'sides_within_total': (frozenset({'sides_field', 'total_field'}), frozenset()),
    'digest_agreement': (
        frozenset({'control', 'field', 'denominator'}),
        frozenset({'excluding'}),
    ),
    'field_equals': (frozenset({'field', 'equals'}), frozenset()),
    'digest_disagreement': (frozenset({'field', 'control', 'capability', 'at_least'}), frozenset()),
    'coverage_gain': (frozenset({'reaches', 'at_least_gain'}), frozenset({'capability', 'control'})),
    'artifact_audit': (frozenset(), frozenset()),
    'gold_text_complete': (frozenset(), frozenset()),
    'source_marker_absence': (frozenset({'prompt_field', 'at_most'}), frozenset()),
    'coverage_monotone': (frozenset({'control', 'reaches'}), frozenset()),
}

#: Keys a gate carries whatever its kind: the three the report prints, plus the two documentation
#: cells the consistency test compares against the registration's table, plus the free-form note.
GATE_COMMON = frozenset({'id', 'kind', 'quantity', 'threshold', 'numbers', 'asks', 'observation'})


def validate_spec(spec: dict) -> list[str]:
    """Every way a gate table can be malformed, as prose. Empty means it is well formed.

    Returns rather than raises so the loader can name the file and the test can assert on the text.
    A missing required key and an unknown key are both reported, because the first is the defect this
    exists for and the second is the same defect arriving silently: a typo that happens to be ignored
    by the kind sets no bar, and no reading would ever show it.
    """
    problems: list[str] = []
    gates = spec.get('gates')
    if not isinstance(gates, list) or not gates:
        return ['no `gates` list']
    seen: set[int] = set()
    for position, gate in enumerate(gates, start=1):
        if not isinstance(gate, dict):
            problems.append(f'gate at position {position} is not an object')
            continue
        identifier = gate.get('id', position)
        if gate.get('id') in seen:
            problems.append(f'gate {identifier} repeats an id already used')
        seen.add(gate.get('id'))
        kind = gate.get('kind')
        if kind not in KINDS:
            problems.append(f'gate {identifier} names an unknown kind {kind!r}; known: {", ".join(sorted(KINDS))}')
            continue
        required, optional = GATE_SCHEMA[kind]
        allowed = required | optional | GATE_COMMON
        missing = sorted(required - gate.keys())
        if missing:
            problems.append(f'gate {identifier} ({kind}) is missing {", ".join(missing)}')
        unknown = sorted(gate.keys() - allowed)
        if unknown:
            problems.append(
                f'gate {identifier} ({kind}) carries {", ".join(unknown)}, which no reader of that kind '
                f'reads; a bar spelled this way sets nothing'
            )
    return problems


def _result(gate: dict, verdict: str, reading: str, detail: dict | None = None, observation: str | None = None) -> dict:
    return {
        'id': gate['id'],
        'kind': gate['kind'],
        'quantity': gate['quantity'],
        'threshold': gate['threshold'],
        'verdict': verdict,
        'reading': reading,
        'detail': detail or {},
        'observation': observation,
    }


def evaluate(spec: dict, treatment: dict, controls: dict[str, dict], alpha: float = 0.05) -> list[dict]:
    results: list[dict] = []
    for gate in spec['gates']:
        kind = gate['kind']
        if kind not in KINDS:
            raise SystemExit(f'gate {gate["id"]} names an unknown kind {kind!r}')
        needed = gate.get('control')
        if needed is not None and needed not in controls:
            results.append(_result(gate, UNEVALUABLE, f'the `{needed}` control artifact was not supplied'))
            continue
        results.append(KINDS[kind](gate, treatment, controls, alpha))
    return results


def render(spec: dict, results: list[dict], sources: dict[str, str]) -> str:
    lines = [f'{spec["registration"]} \u2014 {spec["title"]}', '']
    lines.append(f'  {"treatment":9s} {"":12s} {sources["treatment"]}')
    # Every declared control is named, including the ones this invocation did not supply: a reader
    # decides whether to trust a `PASS` from the header, and `prior: not supplied` beside gate 2's
    # `UNEVALUABLE` says which artifact is missing rather than leaving it to be worked out.
    for name in sorted(spec.get('controls', {})):
        declared = spec['controls'][name]
        path = sources.get(name, '-- not supplied --')
        lines.append(f'  {name:9s} run {declared["run"]:<8d} {path}')
    lines.append('')
    lines.append('| # | quantity | reading | verdict |')
    lines.append('| --- | --- | --- | --- |')
    for result in results:
        reading = result['reading']
        lines.append(f'| {result["id"]} | {result["quantity"]} | {reading} | **{result["verdict"]}** |')
    observations = [r for r in results if r['observation']]
    if observations:
        lines.append('')
        lines.append('Observations (not verdicts \u2014 the registration did not gate them):')
        for result in observations:
            lines.append(f'  {result["id"]}: {result["observation"]}')
    lines.append('')
    verdicts = [r['verdict'] for r in results]
    failed = [r['id'] for r in results if r['verdict'] == FAIL]
    unknown = [r['id'] for r in results if r['verdict'] == UNEVALUABLE]
    if not failed and not unknown:
        lines.append(f'all {len(verdicts)} gates pass')
    else:
        if failed:
            lines.append(f'FAILED: gates {", ".join(str(i) for i in failed)}')
        if unknown:
            lines.append(f'UNEVALUABLE: gates {", ".join(str(i) for i in unknown)} \u2014 an absent field is not a pass')
    return '\n'.join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('spec', type=Path, help='a registration gate table, e.g. tools/gates/13.262.7.json')
    parser.add_argument('--treatment', type=Path, required=True, help='the artifact the gates judge')
    parser.add_argument('--reference', type=Path, help='the reference control artifact')
    parser.add_argument('--prior', type=Path, help='the prior control artifact')
    parser.add_argument('--alpha', type=float, default=0.05, help='significance level for a gate that asks for one')
    parser.add_argument('--json', action='store_true', help='print the verdicts as JSON instead of a table')
    arguments = parser.parse_args(argv)

    spec = json.loads(arguments.spec.read_text())
    # Before any artifact is loaded: a malformed table must fail as a malformed table, not as a
    # `KeyError` from whichever gate happened to be reached first (§13.268).
    problems = validate_spec(spec)
    if problems:
        for problem in problems:
            print(f'{arguments.spec}: {problem}', file=sys.stderr)
        return 2
    supplied = {'reference': arguments.reference, 'prior': arguments.prior}
    controls = {name: load(path) for name, path in supplied.items() if path is not None}
    sources = {name: str(path) for name, path in supplied.items() if path is not None}
    treatment = load(arguments.treatment)

    results = evaluate(spec, treatment, controls, arguments.alpha)
    if arguments.json:
        print(json.dumps({'registration': spec['registration'], 'results': results}, indent=2))
    else:
        print(render(spec, results, {'treatment': str(arguments.treatment), **sources}))

    return 0 if all(r['verdict'] == PASS for r in results) else 1


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
