#!/usr/bin/env python3
"""Classify a restore counterfactual against the gates §13.267 registered before the harness existed.

## What this reads, and what it refuses to infer

Four files: the restore run's artifact, the source run's artifact, the plan both share, and the
decorator's ledger. Every number below is a subtraction of two recorded quantities, and the one thing
this tool will not do is fill a gap with a default.

That is not fastidiousness. This campaign has now been bitten four times by an absent list read as a
list of zeros -- §13.268.7, the first draft of `gold-room.py`, the `gold-room` scope defect, and
`restore-population.py`'s own missing-text refusal. Each time the output was well formed, the numbers
were plausible, and the error was in the direction that makes an experiment look clean. So: no report,
no verdict; no ledger, no verdict; a config that moved, no verdict.

## The two outcomes, and why each side is a majority of four

The source run answered every question four times, and its `questions[].correct` field is **one** of
those passes -- `ablation.featureCorrectByRun` is the whole set. A population split on a single pass
would put questions into the failure stratum on a draw, and the restore side would then be compared
against a coin flip.

So both sides are read the same way: **a question is correct when at least three of its four passes
were**. That is the arm's own scale, applied to both halves of the comparison, and it is stated here
because a threshold chosen after the replies arrive is a threshold chosen by them.

`recordedOutcome` in the plan is the single-pass field `restore-population.py` read when it chose the
population. Disagreements between it and the four-pass majority are **counted and reported**, not
silently reconciled: a large count would mean the population itself was drawn on a single pass, which
is a fact about the instrument that the classification cannot repair.

## The gates

| # | quantity | threshold | why |
| --- | --- | ---: | --- |
| 1 | failures that are correct under restore | **>= 4 of the failures** | a third of the population, the smallest share worth a mechanism (§13.267.3) |
| 2 | controls that are wrong under restore | **<= 1** | restoring evidence must not be able to break an answer that was right |
| 3 | `residual` share among restored-correct errors | reported | a share quoted without a regime is not comparable (§13.267.3) |
| 4 | prompts that grew by more than the restored text | **0** | the intervention is the restored text and nothing else |
| 5 | reader calls for the whole counterfactual | **<= 400** | amended in §13.274.1: the registered 120 assumed a single side |
| 6 | `memoryArmConfig` fields that differ from the source run | **0** | this is a counterfactual of one configuration, not of a similar one |
| 7 | plan entries the run never asked | **0** | an unasked question is not a null result |
| 8 | calls that matched no planned question | **0** | those answers are not part of the intervention and cannot be told apart from ones that are |

Gate 6 is the one that makes the duplication in the workflow safe. The restore job writes the arm's
configuration out by hand rather than translating the source artifact's `memoryArmConfig` back into
variables, because a generated mapping is a second source of truth nobody reviews. A duplicated value
that is checked is a checkpoint; one that is generated is a liability. This gate is the check.

## What it does not do

It does not decide whether the axis is worth pursuing. Gate 1 says whether the missing evidence
converts; the choice between BFR's completion loop and a set-level selector is registered against
these numbers in §13.274.2 and is not this tool's to make.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# The registered thresholds, as data rather than as literals inside the comparisons, so the verdict
# table cannot disagree with the code that computes it.
GATE_RECOVERED_MIN = 4
GATE_BROKEN_MAX = 1
GATE_CALLS_MAX = 400
GATE_CONFIG_DRIFT_MAX = 0
GATE_UNASKED_MAX = 0
GATE_UNMATCHED_MAX = 0
GATE_GROWTH_VIOLATIONS_MAX = 0

REQUIRED_SOURCE_FIELDS = ('memoryArmConfig', 'questions', 'ablation')


def load(path: Path) -> dict:
    with path.open() as handle:
        return json.load(handle)


def refuse(reason: str) -> None:
    print(f'restore classification refused: {reason}', file=sys.stderr)
    raise SystemExit(2)


def passes(artifact: dict) -> dict[str, int]:
    """`questionId -> index` and the per-pass correctness bits, aligned.

    `featureCorrectByRun` is a list of equal-length bitstrings in the dataset's order, and
    `questions[]` is in the same order. The alignment is asserted rather than trusted: a report whose
    two blocks described different question sets would produce a classification of 22 questions with
    the answers of 22 others.
    """
    runs = artifact.get('ablation', {}).get('featureCorrectByRun')
    questions = artifact.get('questions')
    if not isinstance(runs, list) or not runs:
        refuse('the artifact carries no `ablation.featureCorrectByRun`, so no pass is readable')
    if not isinstance(questions, list) or not questions:
        refuse('the artifact carries no `questions` block')
    for index, bits in enumerate(runs):
        if not isinstance(bits, str) or len(bits) != len(questions):
            refuse(
                f'`featureCorrectByRun[{index}]` covers {len(bits) if isinstance(bits, str) else "?"} '
                f'question(s) while `questions` holds {len(questions)}; the two blocks do not '
                'describe one run'
            )
    return {'runs': runs, 'questions': questions}


def majority(bits: str) -> bool:
    """Three of four, and majority for any other repetition count.

    Written as a comparison against half rather than against `0.75`, so a run with three repetitions
    still means "most of them" instead of silently requiring an unreachable share.
    """
    ones = bits.count('1')
    return ones * 2 > len(bits)


def per_question_majority(runs: list[str]) -> list[bool]:
    width = len(runs[0]) if runs else 0
    return [majority(''.join(run[index] for run in runs)) for index in range(width)]


def config_drift(source: dict, restore: dict) -> list[tuple[str, object, object]]:
    """Fields whose value moved between the source run and this one, by name.

    Compared on the union of both keys. A field that this run added is a departure; a field it
    dropped is a departure; a field whose value changed is a departure. The reverse rule -- comparing
    only the keys the source named -- would let the restore run introduce a treatment the source never
    had and still pass.
    """
    left = source.get('memoryArmConfig') or {}
    right = restore.get('memoryArmConfig') or {}
    drift: list[tuple[str, object, object]] = []
    for key in sorted(set(left) | set(right)):
        if left.get(key) != right.get(key):
            drift.append((key, left.get(key), right.get(key)))
    return drift


def classify(restore: dict, source: dict, plan: dict, ledger: dict) -> dict:
    restore_passes = passes(restore)
    source_passes = passes(source)
    source_index = {row.get('questionId'): index for index, row in enumerate(source_passes['questions'])}
    restore_index = {
        row.get('questionId'): index for index, row in enumerate(restore_passes['questions'])
    }

    source_majority = per_question_majority(source_passes['runs'])
    restore_majority = per_question_majority(restore_passes['runs'])

    ledger_by_id = {entry['questionId']: entry for entry in ledger.get('entries') or []}

    rows = []
    disagreement = 0
    unasked = 0
    growth_violations = 0
    for entry in plan['entries']:
        identifier = entry['questionId']
        if identifier not in source_index:
            refuse(f'{identifier} is in the plan but not in the source artifact')
        if identifier not in restore_index:
            # The run refused to drop it (`restrictDatasetToPlan`), so reaching here means the two
            # artifacts disagree about the dataset. A classification over 21 of 22 questions would be
            # a number nobody could correct downstream.
            refuse(f'{identifier} is in the plan but not in the restore artifact')
        recorded = entry['recordedOutcome'] == 'correct'
        observed = source_majority[source_index[identifier]]
        if recorded != observed:
            disagreement += 1
        restored = restore_majority[restore_index[identifier]]
        paid = ledger_by_id.get(identifier)
        if paid is None or paid.get('calls', 0) == 0:
            unasked += 1
        else:
            # Every call for one question grows by the same block, so the ledger's total growth is
            # `calls * block length`. Anything else means a prompt was altered by something other
            # than the intervention, which would be a different experiment wearing this one's name.
            expected = paid['calls'] * paid['restoredChars']
            if paid.get('grewBy') != expected:
                growth_violations += 1
        rows.append(
            {
                'questionId': identifier,
                'recorded': entry['recordedOutcome'],
                'observed': 'correct' if observed else 'incorrect',
                'restored': 'correct' if restored else 'incorrect',
                'calls': (paid or {}).get('calls'),
                'restoredChars': (paid or {}).get('restoredChars'),
            }
        )

    failures = [row for row in rows if row['recorded'] == 'incorrect']
    controls = [row for row in rows if row['recorded'] == 'correct']
    recovered = [row for row in failures if row['restored'] == 'correct']
    still_wrong = [row for row in failures if row['restored'] == 'incorrect']
    broken = [row for row in controls if row['restored'] == 'incorrect']

    return {
        'rows': rows,
        'failures': failures,
        'controls': controls,
        'recovered': recovered,
        'residual': still_wrong,
        'broken': broken,
        'recordedDisagreements': disagreement,
        'unasked': unasked,
        'growthViolations': growth_violations,
        'configDrift': config_drift(source, restore),
        'calls': ledger.get('calls'),
        'unmatchedCalls': ledger.get('unmatchedCalls'),
        'recoveredShare': (len(recovered) / len(failures) if failures else None),
    }


def verdicts(result: dict) -> list[tuple[str, str, str, str, bool]]:
    """`(gate, reading, threshold, passed)` -- the table the preregistration promised.

    Rendered rather than only evaluated: a reader has to be able to check the arithmetic against the
    thresholds without reading this file, which is the same rule `registered-gates.py` follows.
    """
    failures = len(result['failures'])
    return [
        (
            '1',
            'failures correct under restore',
            f'{len(result["recovered"])} of {failures}',
            f'>= {GATE_RECOVERED_MIN}',
            len(result['recovered']) >= GATE_RECOVERED_MIN,
        ),
        (
            '2',
            'controls wrong under restore',
            f'{len(result["broken"])} of {len(result["controls"])}',
            f'<= {GATE_BROKEN_MAX}',
            len(result['broken']) <= GATE_BROKEN_MAX,
        ),
        (
            '3',
            'residual share among the failures',
            'n/a' if result['recoveredShare'] is None else f'{1 - result["recoveredShare"]:.2f}',
            'reported',
            True,
        ),
        (
            '4',
            'prompts grown by other than the restored text',
            str(result['growthViolations']),
            f'<= {GATE_GROWTH_VIOLATIONS_MAX}',
            result['growthViolations'] <= GATE_GROWTH_VIOLATIONS_MAX,
        ),
        (
            '5',
            'reader calls',
            str(result['calls']),
            f'<= {GATE_CALLS_MAX}',
            isinstance(result['calls'], int) and result['calls'] <= GATE_CALLS_MAX,
        ),
        (
            '6',
            '`memoryArmConfig` fields that moved',
            str(len(result['configDrift'])),
            f'<= {GATE_CONFIG_DRIFT_MAX}',
            len(result['configDrift']) <= GATE_CONFIG_DRIFT_MAX,
        ),
        (
            '7',
            'planned questions never asked',
            str(result['unasked']),
            f'<= {GATE_UNASKED_MAX}',
            result['unasked'] <= GATE_UNASKED_MAX,
        ),
        (
            '8',
            'calls matching no planned question',
            str(result['unmatchedCalls']),
            f'== {GATE_UNMATCHED_MAX}',
            result['unmatchedCalls'] == GATE_UNMATCHED_MAX,
        ),
    ]


def render(
    result: dict,
    rows_table: list[tuple[str, str, str, str, bool]],
    plan: dict,
    restore: dict,
) -> str:
    lines = ['# Restore counterfactual', '']
    lines.append(f'Source: `{plan["source"]}`; restore run: `{restore.get("generatedAt", "n/a")}`')
    lines.append('')
    lines.append('| # | quantity | reading | threshold | verdict |')
    lines.append('| --- | --- | --- | --- | --- |')
    for number, name, reading, threshold, passed in rows_table:
        lines.append(
            f'| {number} | {name} | {reading} | {threshold} | **{"PASS" if passed else "FAIL"}** |'
        )
    lines.append('')
    lines.append('## Per question')
    lines.append('')
    lines.append('| question | recorded | observed (4 passes) | restored | calls | chars |')
    lines.append('| --- | --- | --- | --- | --- | --- |')
    for row in result['rows']:
        calls = 'n/a' if row['calls'] is None else str(row['calls'])
        chars = 'n/a' if row['restoredChars'] is None else f'{row["restoredChars"]:,}'
        lines.append(
            f'| `{row["questionId"]}` | {row["recorded"]} | {row["observed"]} | '
            f'{row["restored"]} | {calls} | {chars} |'
        )
    lines.append('')
    if result['recordedDisagreements']:
        lines.append(
            f'**{result["recordedDisagreements"]} question(s) disagree between the plan\'s single-pass '
            '`recordedOutcome` and the four-pass majority.** The population was drawn on the field '
            '`restore-population.py` read; a large count here means it was drawn on one pass and the '
            'strata are softer than the registration assumed.'
        )
        lines.append('')
    if result['configDrift']:
        lines.append('## Configuration drift, which is why this run cannot be classified as one')
        lines.append('')
        lines.append('| field | source | restore |')
        lines.append('| --- | --- | --- |')
        for field, left, right in result['configDrift']:
            lines.append(f'| `{field}` | `{json.dumps(left)}` | `{json.dumps(right)}` |')
        lines.append('')
    passed = all(row[4] for row in rows_table)
    failed = ', '.join(row[0] for row in rows_table if not row[4])
    lines.append(f'**{"ALL GATES PASS" if passed else f"GATES FAILED: {failed}"}**')
    lines.append('')
    return '\n'.join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--restore', type=Path, required=True, help="the counterfactual run's report")
    parser.add_argument('--source', type=Path, required=True, help="the run it restores evidence from")
    parser.add_argument('--plan', type=Path, required=True, help='the plan both runs share')
    parser.add_argument('--ledger', type=Path, required=True, help="the decorator's record")
    parser.add_argument('--out', type=Path, default=None, help='write the verdict here as markdown')
    arguments = parser.parse_args(argv)

    restore = load(arguments.restore)
    source = load(arguments.source)
    plan = load(arguments.plan)
    ledger = load(arguments.ledger)

    for name, block in (('source', source), ('restore', restore)):
        for field in REQUIRED_SOURCE_FIELDS:
            if field not in block:
                refuse(f'the {name} artifact carries no `{field}` block, so nothing here is comparable')

    result = classify(restore, source, plan, ledger)
    table = verdicts(result)
    text = render(result, table, plan, restore)
    if arguments.out is not None:
        arguments.out.write_text(text)
    print(text)
    return 0 if all(row[4] for row in table) else 1


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
