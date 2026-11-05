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
    capability: str,
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
        f'`{capability}` {before:.2f}% \u2192 {after:.2f}% '
        f'({after - before:+.2f} over {total}; {wins} won, {losses} lost; p = {p_value:.4g})'
    )


def gate_capability_delta(gate: dict, treatment: dict, controls: dict[str, dict], alpha: float) -> dict:
    capability = gate['capability']
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
    """
    control = controls[gate['control']]
    field = gate['field']
    after = _by_id(treatment)
    before = _by_id(control)
    shared = sorted(set(after) & set(before))
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


KINDS = {
    'capability_delta': gate_capability_delta,
    'capability_nonloss': gate_capability_nonloss,
    'field_at_least': gate_field_at_least,
    'field_at_most': gate_field_at_most,
    'audit_identity': gate_audit_identity,
    'sides_within_total': gate_sides_within_total,
    'digest_agreement': gate_digest_agreement,
}


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
