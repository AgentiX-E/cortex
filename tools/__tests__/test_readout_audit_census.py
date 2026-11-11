#!/usr/bin/env python3
"""The audit census has to be checkable against the roster it describes.

## The defect this guards against

§13.260 gave the arm a reader for the product's membership audit: a run-level tally
(`audit.attempted` / `audit.changed`) and a per-question pair on every record. Two fields about one
event can disagree, and a disagreeing pair is the class §13.107 found three times -- a census that
counted consultations where it claimed questions, a reach table that contradicted its own
implementation, a vote tally published on a run that never voted.

The invariant that makes it checkable is an identity inside one artifact: the roster's column must
**sum** to the tally. No control run is needed to decide it, which is the only kind of check `--audit`
is allowed to make.

§13.262 changed that identity's shape. It used to compare the tally against the *number* of records
flagged, and run `42054107910` failed it with `attempted: 469` over `118` flags -- the repetition count,
not a defect: the roster records the first of four passes and the tally counts all four. A flag cannot
satisfy an identity at `runs > 1`; a count can, and a count is what the producer now writes.

## Why the negative cases are the point

A check that passes on a good artifact proves nothing. Each case below breaks exactly one field and
requires the tool to say so and exit non-zero, because the tool gates a dispatch: a check that
printed `FAIL` and exited 0 could not stop one.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'readout-arm-run.py'


def _report(
    *,
    review_pass: str = 'audit',
    audit: dict | None = None,
    counts: list[int] | None = None,
    changes: list[int] | None = None,
    authorization: dict | None = None,
    spec_columns: tuple[int, int, int, int] | None = None,
) -> dict:
    """A run whose every other field is consistent, so the audit check is the only variable.

    The authorization quartet is synthesized for a `spec` run, because the product records it on every such run:
    a fixture that omitted it would be an artifact this build cannot produce, and a gate written against one is a
    gate that fails on the good case. `authorization` and `spec_columns` are the two ways a test breaks exactly
    one number -- the block and the roster respectively -- without breaking the rest of the report.
    """
    ids = ['q1', 'q2', 'q3', 'q4']
    records = []
    report_authorization: dict | None = None
    for index, question_id in enumerate(ids):
        record = {
            'questionId': question_id,
            'capability': 'MR',
            'question': f'How many items {index}?',
            'groundTruth': '3',
            'answer': '3',
            'correct': True,
            'promptChars': 1000,
        }
        if counts is not None:
            record['auditConsultations'] = counts[index]
            record['auditChanges'] = (changes or counts)[index]
        records.append(record)

    if review_pass == 'spec':
        # Derived from the roster and the refusal count so the three identities hold by construction:
        # `evaluated + refused = attempted`, `supporting <= selected <= ledger`, and every column sums to the
        # block. All of it sits on the first record unless a test overrides `spec_columns`, because the check
        # reads sums and not distributions.
        refused_here = (audit or {}).get('refused', 0) or 0
        evaluated = sum(counts or []) - refused_here
        block = {
            'evaluated': evaluated,
            'authorized': evaluated,
            'selected': 2 * evaluated,
            'supportHits': 2 * evaluated,
            'ledgerRows': 4 * evaluated,
            'tokens': evaluated,
        }
        report_authorization = block if authorization is None else authorization
        columns = (evaluated, evaluated, 2 * evaluated, 2 * evaluated) if spec_columns is None else spec_columns
        if evaluated > 0 or spec_columns is not None:
            records[0]['specEvaluations'] = columns[0]
            records[0]['specAuthorizations'] = columns[1]
            records[0]['specSelected'] = columns[2]
            records[0]['specSupportHits'] = columns[3]

    report = {
        'questionCount': len(ids),
        'runs': 1,
        'memoryArmConfig': {
            'ask': 'verbatim',
            'askRoutes': ['multi-session'],
            'renderingRoutes': ['multi-session'],
            'promptContract': 'abstention-evidence-blocks',
            'reviewPass': review_pass,
            'maxPromptChars': 48000,
            'selfConsistency': 'none',
            'queryExpansion': 'none',
        },
        'abstentionReasons': {'empty': 0, 'threshold': 0, 'llm': 0, 'answered': len(ids)},
        'questions': records,
    }
    if audit is not None:
        report['audit'] = (
            {**audit, 'authorization': report_authorization}
            if report_authorization is not None
            else audit
        )
    return report


def _run(tmp_path: Path, report: dict) -> subprocess.CompletedProcess[str]:
    path = tmp_path / 'report.json'
    path.write_text(json.dumps(report), encoding='utf-8')
    return subprocess.run(
        [sys.executable, str(TOOL), '--audit', str(path)],
        capture_output=True,
        text=True,
        check=False,
    )


class TestTheAuditCensusIsCheckedAgainstTheRoster:
    def test_a_consistent_run_passes(self, tmp_path: Path) -> None:
        result = _run(
            tmp_path,
            _report(audit={'attempted': 4, 'changed': 2}, counts=[1, 1, 1, 1], changes=[1, 1, 0, 0]),
        )

        assert result.returncode == 0, result.stdout + result.stderr
        assert 'PASS  audit' in result.stdout
        assert 'the roster sums to 4 consultations and 2 changes over 4 of 4 records' in result.stdout

    def test_the_column_sums_to_the_tally_at_any_repetition_count(self, tmp_path: Path) -> None:
        # The shape `42054107910` produced: two questions answered four times each, so a count of 2 per
        # record and a tally of 8 is consistent -- while a roster of flags would have said 2 and disagreed
        # with a correct tally by the repetition count. Nothing about this test depends on `runs` being 1.
        result = _run(
            tmp_path,
            _report(audit={'attempted': 8, 'changed': 4}, counts=[2, 2, 2, 2], changes=[1, 1, 1, 1]),
        )

        assert result.returncode == 0, result.stdout + result.stderr
        assert 'PASS  audit' in result.stdout

    def test_a_tally_that_disagrees_with_the_roster_fails(self, tmp_path: Path) -> None:
        # The pass says it ran four times; the roster says twice. One of them is not a measurement.
        result = _run(
            tmp_path,
            _report(audit={'attempted': 4, 'changed': 2}, counts=[1, 1, 0, 0], changes=[1, 1, 0, 0]),
        )

        assert result.returncode == 1
        assert 'FAIL  audit' in result.stdout

    def test_a_review_that_moved_more_answers_than_it_was_shown_fails(self, tmp_path: Path) -> None:
        # `changed` is a subset of `attempted` by construction: the pass only moves an answer it read.
        result = _run(
            tmp_path,
            _report(audit={'attempted': 2, 'changed': 5}, counts=[1, 1, 0, 0], changes=[3, 2, 0, 0]),
        )

        assert result.returncode == 1
        assert 'FAIL  audit' in result.stdout

    def test_a_roster_the_check_cannot_sum_over_fails(self, tmp_path: Path) -> None:
        # A sum is only an identity over the whole roster. A producer that wrote the pair on the questions
        # the pass reached and omitted it on the others would sum to the same tally over a smaller
        # denominator and look self-consistent while describing a filtered population.
        report = _report(audit={'attempted': 4, 'changed': 2}, counts=[1, 1, 1, 1], changes=[1, 1, 0, 0])
        del report['questions'][0]['auditConsultations']

        result = _run(tmp_path, report)

        assert result.returncode == 1
        assert 'FAIL  audit' in result.stdout

    def test_a_bare_run_that_publishes_a_zeroed_census_fails(self, tmp_path: Path) -> None:
        # The absence rule: a zeroed tally on a build without the pass claims a mechanism that never ran.
        result = _run(
            tmp_path,
            _report(review_pass='bare', audit={'attempted': 0, 'changed': 0}, counts=[0] * 4),
        )

        assert result.returncode == 1
        assert 'FAIL  audit' in result.stdout

    def test_a_bare_run_with_neither_field_passes(self, tmp_path: Path) -> None:
        result = _run(tmp_path, _report(review_pass='bare'))

        assert result.returncode == 0, result.stdout + result.stderr
        assert 'PASS  audit' in result.stdout


class TestTheTallyCensusIsCheckedByTheSameIdentity:
    """The second pass that publishes this census, and the field only it can have."""

    def test_a_tally_run_passes_when_the_census_carries_its_three_integers(self, tmp_path: Path) -> None:
        result = _run(
            tmp_path,
            _report(
                review_pass='tally',
                audit={'attempted': 4, 'changed': 2, 'refused': 1},
                counts=[1, 0, 2, 1],
                changes=[0, 0, 1, 1],
            ),
        )
        assert result.returncode == 0, result.stdout

    def test_a_tally_run_without_the_refusal_count_fails(self, tmp_path: Path) -> None:
        # `auditCensus()` emits `refused` under exactly one of the two passes, so an artifact that
        # omitted it under `tally` is not this build -- and the omitted field is the only number that
        # separates "the pass never fired" from "every ledger was unreadable".
        result = _run(
            tmp_path,
            _report(
                review_pass='tally',
                audit={'attempted': 4, 'changed': 2},
                counts=[1, 0, 2, 1],
                changes=[0, 0, 1, 1],
            ),
        )
        assert result.returncode != 0
        assert 'FAIL' in result.stdout

    def test_an_audit_run_that_publishes_a_refusal_count_fails(self, tmp_path: Path) -> None:
        # The mirror image: the audit has no refusal state, so printing a zero for it would report a
        # measurement of a branch that pass cannot enter.
        result = _run(
            tmp_path,
            _report(
                review_pass='audit',
                audit={'attempted': 4, 'changed': 2, 'refused': 0},
                counts=[1, 0, 2, 1],
                changes=[0, 0, 1, 1],
            ),
        )
        assert result.returncode != 0
        assert 'FAIL' in result.stdout

    def test_a_refusal_count_above_the_consultations_fails(self, tmp_path: Path) -> None:
        result = _run(
            tmp_path,
            _report(
                review_pass='tally',
                audit={'attempted': 4, 'changed': 2, 'refused': 5},
                counts=[1, 0, 2, 1],
                changes=[0, 0, 1, 1],
            ),
        )
        assert result.returncode != 0
        assert 'FAIL' in result.stdout

    def test_changes_plus_refusals_cannot_exceed_the_consultations(self, tmp_path: Path) -> None:
        # A consultation either produced a total, agreed with the one it was handed, or was refused, so
        # the two outcomes cannot together exceed the population they are outcomes of.
        result = _run(
            tmp_path,
            _report(
                review_pass='tally',
                audit={'attempted': 4, 'changed': 4, 'refused': 3},
                counts=[1, 0, 2, 1],
                changes=[1, 0, 1, 2],
            ),
        )
        assert result.returncode != 0
        assert 'FAIL' in result.stdout


class TestTheSpecificationPassIsCheckedByTheSameIdentity:
    """Three passes publish this census, and the gate has to accept all three or none.

    The membership in `readout-arm-run.py` was a two-element tuple while `audit` and `tally` were the
    only passes that could refuse. Round 62 added a third, and the failure mode of forgetting to widen
    it is not a crash: a *correct* `spec` artifact fails the arm audit and the job goes red for a gate
    its own artifact satisfies -- exactly the defect round 61's dispatch exposed when `tally` was new.
    """

    def test_a_spec_run_passes_when_the_census_carries_its_three_integers(self, tmp_path: Path) -> None:
        result = _run(
            tmp_path,
            _report(
                review_pass='spec',
                audit={'attempted': 3, 'changed': 2, 'refused': 1},
                counts=[1, 1, 1, 0],
                changes=[0, 1, 1, 0],
            ),
        )
        assert result.returncode == 0, result.stdout

    def test_a_spec_run_without_the_refusal_count_fails(self, tmp_path: Path) -> None:
        result = _run(
            tmp_path,
            _report(
                review_pass='spec',
                audit={'attempted': 3, 'changed': 2},
                counts=[1, 1, 1, 0],
                changes=[0, 1, 1, 0],
            ),
        )
        assert result.returncode != 0
        assert 'FAIL' in result.stdout

    def test_spec_changes_plus_refusals_cannot_exceed_the_plans_it_asked_for(self, tmp_path: Path) -> None:
        # A plan either produced an answer, agreed with the one it was handed, or was refused. The
        # identity is the same one the tally pass carries, which is why it is one membership rather than
        # two branches: a second copy of the sums is where the two would eventually disagree.
        result = _run(
            tmp_path,
            _report(
                review_pass='spec',
                audit={'attempted': 3, 'changed': 2, 'refused': 2},
                counts=[1, 1, 1, 0],
                changes=[0, 1, 1, 0],
            ),
        )
        assert result.returncode != 0
        assert 'FAIL' in result.stdout

    def test_every_pass_that_publishes_the_census_is_in_the_membership(self) -> None:
        # Read out of the gate's own source rather than restated here: a fourth pass added to the product
        # has to be added to the membership, and the test that notices is this one.
        source = TOOL.read_text(encoding='utf-8')
        assert "review_pass in ('audit', 'tally', 'spec')" in source
        assert "refusing = review_pass in ('tally', 'spec')" in source


class TestTheAuthorizationIsCheckedAgainstItsOwnIdentities:
    """§13.368's four columns, and the three ways a recorded ratio lies.

    The block is not a verdict — nothing acts on it yet — so what the gate can check is arithmetic: the columns
    must sum to the block, and the block must satisfy `evaluated + refused = attempted` and
    `supporting <= selected <= ledger`. Each case below breaks exactly one, because a check that only ever sees a
    good artifact is a check nobody has tested.
    """

    def test_a_spec_run_with_a_consistent_block_passes(self, tmp_path: Path) -> None:
        result = _run(
            tmp_path,
            _report(
                review_pass='spec',
                audit={'attempted': 3, 'changed': 2, 'refused': 1},
                counts=[1, 1, 1, 0],
                changes=[0, 1, 1, 0],
            ),
        )

        assert result.returncode == 0, result.stdout
        assert 'PASS  spec-authorization' in result.stdout
        # Two substitutions offered, two authorized, four rows selected, four supporting, eight in the ledger.
        assert "'evaluated': 2" in result.stdout

    def test_a_spec_run_without_the_block_fails(self, tmp_path: Path) -> None:
        report = _report(
            review_pass='spec',
            audit={'attempted': 3, 'changed': 2, 'refused': 1},
            counts=[1, 1, 1, 0],
            changes=[0, 1, 1, 0],
        )
        report['audit'].pop('authorization')

        result = _run(tmp_path, report)

        assert result.returncode != 0
        assert 'FAIL  spec-authorization' in result.stdout

    def test_a_roster_that_does_not_sum_to_the_block_fails(self, tmp_path: Path) -> None:
        # The `41773546221` shape one level down: a column that came from a different subset than the total.
        result = _run(
            tmp_path,
            _report(
                review_pass='spec',
                audit={'attempted': 3, 'changed': 2, 'refused': 1},
                counts=[1, 1, 1, 0],
                changes=[0, 1, 1, 0],
                spec_columns=(1, 1, 2, 2),
            ),
        )

        assert result.returncode != 0
        assert 'FAIL  spec-authorization' in result.stdout

    def test_a_block_whose_support_exceeds_its_selection_fails(self, tmp_path: Path) -> None:
        result = _run(
            tmp_path,
            _report(
                review_pass='spec',
                audit={'attempted': 3, 'changed': 2, 'refused': 1},
                counts=[1, 1, 1, 0],
                changes=[0, 1, 1, 0],
                authorization={
                    'evaluated': 2,
                    'authorized': 2,
                    'selected': 2,
                    'supportHits': 3,
                    'ledgerRows': 8,
                    'tokens': 2,
                },
                spec_columns=(2, 2, 2, 3),
            ),
        )

        assert result.returncode != 0
        assert 'FAIL  spec-authorization' in result.stdout

    def test_evaluated_plus_refused_must_equal_the_consultations(self, tmp_path: Path) -> None:
        # The identity that separates "the pass offered no substitution" from "every plan was refused".
        result = _run(
            tmp_path,
            _report(
                review_pass='spec',
                audit={'attempted': 3, 'changed': 2, 'refused': 1},
                counts=[1, 1, 1, 0],
                changes=[0, 1, 1, 0],
                authorization={
                    'evaluated': 1,
                    'authorized': 1,
                    'selected': 2,
                    'supportHits': 2,
                    'ledgerRows': 4,
                    'tokens': 1,
                },
                spec_columns=(1, 1, 2, 2),
            ),
        )

        assert result.returncode != 0
        assert 'FAIL  spec-authorization' in result.stdout

    def test_an_audit_run_carrying_the_block_fails(self, tmp_path: Path) -> None:
        # A pass with no plan cannot authorize anything, so a block under `audit` is the same claim `refused`
        # would be: a measurement of a branch the pass cannot enter.
        result = _run(
            tmp_path,
            _report(
                review_pass='audit',
                audit={
                    'attempted': 4,
                    'changed': 2,
                    'authorization': {
                        'evaluated': 1,
                        'authorized': 1,
                        'selected': 1,
                        'supportHits': 1,
                        'ledgerRows': 1,
                        'tokens': 1,
                    },
                },
                counts=[1, 1, 1, 1],
                changes=[1, 1, 0, 0],
            ),
        )

        assert result.returncode != 0
        assert 'FAIL  spec-authorization' in result.stdout
