"""Tests for `tools/token-basis.py`, the gate that keeps a cost ratio on one denominator.

Every cost claim this repository made about a competitor until round 59 divided two numbers that
counted different things: this arm's **whole prompt** by their **retrieved evidence**. The table in
`MEASURE-COST-LEVER.md` §6 is the surviving example -- 10,105 against 7,740 called 1.31x, where the
numerator includes instructions, a session header and the question and the denominator does not.

Prose could not hold that correction, because prose has no arithmetic in it to re-run. So the tests
below pin the four properties that make the tool a gate rather than a table:

  - **the partition is arithmetic, not a reading.** `evidenceTokens` is derived from three
    committed primitives, so `--check` can re-derive it without the artifact, and a hand edit of the
    derived field fails. This is the whole reason the reading is a projection rather than a copy.
  - **a ratio is formed on one basis.** The row's own `basis` decides which of this arm's two
    numbers is the numerator, and the per-correct-answer axis applies the accuracy multiplier to
    both sides. A test that only checked a single happy path would pass a tool that used the prompt
    count for everything, which is exactly the published defect.
  - **an undeclared dialect is refused or marked, never defaulted.** A cost without `basis` is a
    guess about what somebody else counted, and a median against a mean is a caveat. The ledger
    already refuses a number without a `source`; this extends the same rule to the two fields a
    ratio needs.
  - **a document that quotes a number has to match the record.** The marker convention is
    `docs-crosscheck.mjs`'s, reused because the alternative -- re-reading a table by eye -- is what
    produced the error.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys

from importlib import import_module

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

basis = import_module('token-basis')

REPO = pathlib.Path(__file__).resolve().parents[2]


def artifact(questions, tokens=1000.0, accuracy=0.9):
    return {
        'run': '42424242424',
        'generatedAt': '2026-11-10T00:00:00.000Z',
        'questionCount': len(questions),
        'runs': 4,
        'dataset': 'longmemeval',
        'datasetFingerprint': 'abc',
        'memoryArmConfig': {'configurationFingerprint': 'sha256:deadbeef'},
        'costEfficiency': {'promptTokensPerQuestion': tokens, 'accuracy': accuracy},
        'questions': questions,
    }


def question(evidence, delivered):
    return {'promptChars': evidence, 'deliveredPromptChars': delivered}


def ledger(costs):
    return {'entries': [{'system': 'A', 'score': 90.0, 'kind': 'self', 'source': 'x', 'cost': costs}]}


def cost(identifier, tokens, **rest):
    payload = {
        'id': identifier,
        'tokens': tokens,
        'basis': 'context',
        'statistic': 'mean',
        'source': 'vendor page',
    }
    payload.update(rest)
    return payload


class TestThePartition:
    def test_splits_the_bill_into_the_part_a_competitor_also_counts(self):
        # Two questions, 900 of 1000 characters of evidence each: the split is proportional, and the
        # proportion is 90% -- so a 1,000-token run is 900 evidence and 100 overhead.
        part = basis.partition(artifact([question(900, 1000), question(900, 1000)]))

        assert part == {
            'questions': 2,
            'meanEvidenceChars': 900.0,
            'meanPromptChars': 1000.0,
            'charsPerToken': 1.0,
            'promptTokens': 1000.0,
            'evidenceTokens': 900.0,
            'overheadTokens': 100.0,
            'evidenceShare': 0.9,
            'accuracy': 0.9,
        }

    def test_the_two_parts_add_back_to_the_bill(self):
        # A reader who sums the split has to get the number they started with; a rounding that lost
        # a token would make every downstream ratio slightly wrong in a way nobody would notice.
        part = basis.partition(artifact([question(34447, 35447), question(34447, 35447)], tokens=9200.5205))

        assert round(part['evidenceTokens'] + part['overheadTokens'], 4) == part['promptTokens']

    def test_refuses_an_artifact_with_no_questions(self):
        with_exception = None
        try:
            basis.partition({**artifact([]), 'questions': []})
        except basis.Refused as refusal:
            with_exception = str(refusal)

        assert with_exception is not None
        assert 'no questions' in with_exception

    def test_refuses_evidence_longer_than_the_prompt_that_carries_it(self):
        # `question-record.ts` states the ordering and this is the one defect that would make the
        # overhead negative: a tool that divided by a bad record would publish a number rather than
        # refusing, which is the failure mode worth a test.
        with_exception = None
        try:
            basis.partition(artifact([question(1001, 1000)]))
        except basis.Refused as refusal:
            with_exception = str(refusal)

        assert with_exception is not None
        assert 'cannot be a subset' in with_exception

    def test_refuses_a_record_with_no_token_count(self):
        broken = artifact([question(900, 1000)])
        del broken['costEfficiency']

        with_exception = None
        try:
            basis.partition(broken)
        except basis.Refused as refusal:
            with_exception = str(refusal)

        assert with_exception is not None
        assert 'no costEfficiency' in with_exception

    def test_refuses_a_token_count_that_is_not_positive(self):
        for tokens in (0, -1, '9200', None, float('nan')):
            with_exception = None
            try:
                basis.partition(artifact([question(900, 1000)], tokens=tokens))
            except basis.Refused as refusal:
                with_exception = str(refusal)
            assert with_exception is not None, tokens

    def test_refuses_a_character_count_that_is_not_a_whole_number(self):
        # A float here is a build that changed the field's meaning, and a string is a build that
        # serialised it as text -- both would silently produce a quotient from `float('34447')`.
        for payload in ({'promptChars': 900.5, 'deliveredPromptChars': 1000}, {'promptChars': '900', 'deliveredPromptChars': 1000}):
            with_exception = None
            try:
                basis.partition(artifact([payload]))
            except basis.Refused as refusal:
                with_exception = str(refusal)
            assert with_exception is not None, payload

    def test_refuses_a_question_that_is_not_a_record(self):
        with_exception = None
        try:
            basis.partition(artifact(['900']))
        except basis.Refused as refusal:
            with_exception = str(refusal)

        assert with_exception is not None
        assert 'not a record' in with_exception


class TestTheLedgerCosts:
    def test_reads_the_six_declared_fields(self):
        rows = basis.costRows(ledger([cost('one-context', 7000, tokenizer='o200k')]))

        assert rows == [
            {
                'id': 'one-context',
                'system': 'A',
                'score': 90.0,
                'tokens': 7000.0,
                'basis': 'context',
                'statistic': 'mean',
                'tokenizer': 'o200k',
                'kind': 'self',
                'source': 'vendor page',
            }
        ]

    def test_a_cost_block_overrides_the_entries_kind(self):
        # The Synap all-in row is this repository's recomputation riding on an entry that is the
        # vendor's self-report, so the provenance has to be able to differ inside one entry.
        rows = basis.costRows(ledger([cost('one-allin', 13400, basis='prompt', kind='ours')]))

        assert rows[0]['kind'] == 'ours'

    def test_refuses_a_cost_with_no_basis(self):
        payload = cost('one-context', 7000)
        del payload['basis']

        with_exception = None
        try:
            basis.costRows(ledger([payload]))
        except basis.Refused as refusal:
            with_exception = str(refusal)

        assert with_exception is not None
        assert 'basis' in with_exception

    def test_refuses_a_basis_that_is_neither_of_the_two(self):
        with_exception = None
        try:
            basis.costRows(ledger([cost('one-context', 7000, basis='tokens')]))
        except basis.Refused as refusal:
            with_exception = str(refusal)

        assert with_exception is not None
        assert 'not one of' in with_exception

    def test_refuses_a_statistic_that_is_neither_mean_nor_median(self):
        with_exception = None
        try:
            basis.costRows(ledger([cost('one-context', 7000, statistic='average')]))
        except basis.Refused as refusal:
            with_exception = str(refusal)

        assert with_exception is not None
        assert 'statistic' in with_exception

    def test_refuses_a_cost_with_no_source(self):
        with_exception = None
        try:
            basis.costRows(ledger([cost('one-context', 7000, source='  ')]))
        except basis.Refused as refusal:
            with_exception = str(refusal)

        assert with_exception is not None
        assert 'no source' in with_exception

    def test_refuses_two_costs_under_one_id(self):
        # A marker addresses an id, so a duplicate would resolve to whichever came first and the
        # document would quote one of two figures without saying which.
        with_exception = None
        try:
            basis.costRows(ledger([cost('one-context', 7000), cost('one-context', 8000)]))
        except basis.Refused as refusal:
            with_exception = str(refusal)

        assert with_exception is not None
        assert 'used twice' in with_exception

    def test_refuses_an_id_that_a_marker_could_not_address(self):
        with_exception = None
        try:
            basis.costRows(ledger([cost('One Context', 7000)]))
        except basis.Refused as refusal:
            with_exception = str(refusal)

        assert with_exception is not None
        assert 'not a slug' in with_exception

    def test_refuses_a_ledger_with_no_cost_at_all(self):
        # The state of this file before round 59: 52 entries, every one of them an accuracy, none of
        # them a token count. A check that passed on that would be checking nothing.
        with_exception = None
        try:
            basis.costRows({'entries': [{'system': 'A', 'score': 90.0}]})
        except basis.Refused as refusal:
            with_exception = str(refusal)

        assert with_exception is not None
        assert 'no cost at all' in with_exception


class TestTheRatio:
    def test_a_context_row_divides_the_evidence_and_a_prompt_row_the_whole_prompt(self):
        # The published defect, as a test: one arm, two rows, two bases, and the numerator changes
        # while the denominator does not. A tool that used `promptTokens` for both would read 1.14x
        # and 1.00x here instead of 1.12x and 1.00x -- close enough to look right, which is why the
        # expectation is exact.
        part = basis.partition(artifact([question(900, 1000)], tokens=1000.0))

        rows = basis.comparison(
            part,
            basis.costRows(
                ledger(
                    [
                        cost('theirs-context', 800),
                        cost('theirs-allin', 1000, basis='prompt'),
                    ]
                )
            ),
        )

        by_id = {row['id']: row for row in rows}
        assert by_id['theirs-context']['ourTokens'] == 900.0
        assert by_id['theirs-context']['ratio'] == 1.125
        assert by_id['theirs-allin']['ourTokens'] == 1000.0
        assert by_id['theirs-allin']['ratio'] == 1.0

    def test_the_per_correct_answer_axis_uses_one_basis_for_both_sides(self):
        # The mixed version of this is what `MEASURE-COST-LEVER.md` §6 published: our all-in count
        # per correct answer over their content-only count per correct answer. Applying the accuracy
        # multiplier to one side only is the same defect as dividing two bases, and it is invisible
        # in the number because both sides look like "tokens per correct answer".
        part = basis.partition(artifact([question(900, 1000)], tokens=1000.0, accuracy=0.5))

        rows = basis.comparison(part, basis.costRows(ledger([cost('theirs-context', 800)])))

        assert rows[0]['theirTokensPerCorrect'] == round(800 / 0.9, 3)
        assert rows[0]['ourTokensPerCorrect'] == round(900 / 0.5, 3)
        assert rows[0]['ratioPerCorrect'] == round((900 / 0.5) / (800 / 0.9), 4)

    def test_a_median_against_a_mean_is_marked_rather_than_dropped(self):
        part = basis.partition(artifact([question(900, 1000)]))
        rows = basis.comparison(part, basis.costRows(ledger([cost('theirs-median', 800, statistic='median')])))

        assert any('median' in caveat for caveat in rows[0]['caveats'])
        assert 'ratio' in rows[0]

    def test_a_stated_tokenizer_that_is_not_the_readers_is_marked(self):
        part = basis.partition(artifact([question(900, 1000)]))
        rows = basis.comparison(part, basis.costRows(ledger([cost('theirs-o200k', 800, tokenizer='o200k')])))

        assert any('o200k' in caveat for caveat in rows[0]['caveats'])

    def test_the_readers_own_tokenizer_is_not_a_caveat(self):
        part = basis.partition(artifact([question(900, 1000)]))
        rows = basis.comparison(
            part, basis.costRows(ledger([cost('theirs-same', 800, tokenizer=basis.READER_TOKENIZER)]))
        )

        assert rows[0]['caveats'] == []

    def test_an_undeclared_tokenizer_is_a_caveat_rather_than_a_default(self):
        part = basis.partition(artifact([question(900, 1000)]))
        rows = basis.comparison(part, basis.costRows(ledger([cost('theirs-silent', 800)])))

        assert any('no tokenizer' in caveat for caveat in rows[0]['caveats'])

    def test_a_row_with_no_accuracy_carries_no_per_correct_ratio(self):
        # The ledger has entries whose `score` is a string or absent; inventing a denominator from
        # one of those is how a table acquires a column that is silently blank in two rows.
        part = basis.partition(artifact([question(900, 1000)]))
        rows = basis.comparison(
            part,
            basis.costRows({'entries': [{'system': 'A', 'harness': 'x', 'cost': [cost('one', 800)]}]}),
        )

        assert 'ratioPerCorrect' not in rows[0]
        assert rows[0]['ratio'] == 1.125


class TestTheCommittedReading:
    def test_the_partition_round_trips_from_the_committed_primitives(self):
        # `--check` has no artifact, so the arithmetic has to close over the three primitives the
        # reading commits. A round trip that is off in the last place would fire the gate on every
        # green run, and a gate that fires on green runs gets deleted.
        part = basis.partition(artifact([question(34447, 35447)], tokens=9200.5205))

        assert basis.partition_from(part) == part

    def test_a_hand_edited_derived_field_is_caught(self):
        part = basis.partition(artifact([question(900, 1000)]))
        edited = {**part, 'evidenceTokens': 950.0}

        assert basis.partition_from(edited)['evidenceTokens'] == 900.0

    def test_the_reading_names_the_run_and_the_configuration_it_came_from(self):
        # A cost figure measured on a configuration the arm no longer runs is a record of what that
        # configuration cost. `MEASURE-CONFIGURATION-IDENTITY.md` is the whole argument for carrying
        # the fingerprint here rather than trusting the reader to remember.
        identity = basis.identityOf(artifact([question(900, 1000)]))

        assert identity['run'] == '42424242424'
        assert identity['configurationFingerprint'] == 'sha256:deadbeef'
        assert identity['questionCount'] == 1

    def test_an_artifact_without_a_run_id_needs_one_as_an_argument(self):
        broken = artifact([question(900, 1000)])
        del broken['run']

        with_exception = None
        try:
            basis.identityOf(broken)
        except basis.Refused as refusal:
            with_exception = str(refusal)

        assert with_exception is not None
        assert '--run' in with_exception
        assert basis.identityOf(broken, '42999999999')['run'] == '42999999999'


class TestTheDocumentMarkers:
    def reading(self):
        part = basis.partition(artifact([question(900, 1000)], tokens=1000.0, accuracy=0.9))
        rows = basis.comparison(part, basis.costRows(ledger([cost('theirs-context', 800)])))
        return basis.reading(basis.identityOf(artifact([question(900, 1000)])), part, rows)

    def test_a_marker_that_agrees_is_not_a_defect(self):
        defects = basis.claimDefects({'doc.md': 'ratio <!-- token-ratio:theirs-context -->1.12x'}, self.reading())

        assert defects == []

    def test_a_marker_that_disagrees_names_both_numbers(self):
        defects = basis.claimDefects({'doc.md': 'ratio <!-- token-ratio:theirs-context -->1.31x'}, self.reading())

        assert len(defects) == 1
        assert '1.31x' in defects[0]
        assert '1.12x' in defects[0]

    def test_the_per_correct_axis_has_its_own_key(self):
        # One document may quote both axes for one competitor, and a single key would make the second
        # quote fail against the first value. `@correct` is the axis, not a different competitor.
        reading = self.reading()
        row = reading['rows'][0]

        assert basis.claimDefects(
            {'doc.md': f'<!-- token-ratio:theirs-context -->{row["ratio"]:.2f}x'}, reading
        ) == []
        assert basis.claimDefects(
            {'doc.md': f'<!-- token-ratio:theirs-context@correct -->{row["ratioPerCorrect"]:.2f}x'},
            reading,
        ) == []

    def test_a_per_correct_marker_on_a_row_with_no_score_is_a_defect(self):
        part = basis.partition(artifact([question(900, 1000)], tokens=1000.0))
        rows = basis.comparison(
            part, basis.costRows({'entries': [{'system': 'A', 'cost': [cost('one', 800)]}]})
        )
        reading = basis.reading(basis.identityOf(artifact([question(900, 1000)])), part, rows)

        defects = basis.claimDefects({'doc.md': '<!-- token-ratio:one@correct -->1.12x'}, reading)

        assert len(defects) == 1
        assert 'carries no score' in defects[0]

    def test_a_marker_that_names_nothing_in_the_ledger_is_a_defect(self):
        # The failure this catches: a document quoting a competitor row that was renamed or removed,
        # which reads as a supported claim because the number is there and only the id is stale.
        defects = basis.claimDefects({'doc.md': '<!-- token-ratio:who-knows -->1.00x'}, self.reading())

        assert len(defects) == 1
        assert 'names no cost row' in defects[0]

    def test_a_figure_marker_checks_this_arms_own_count(self):
        # Ours is not a ledger row, so it needs its own key: `cortex/context` and `cortex/prompt`.
        defects = basis.claimDefects(
            {'doc.md': 'evidence <!-- token-figure:cortex/context -->900; prompt <!-- token-figure:cortex/prompt -->1,000'},
            self.reading(),
        )

        assert defects == []

    def test_a_figure_marker_that_disagrees_is_a_defect(self):
        defects = basis.claimDefects({'doc.md': '<!-- token-figure:cortex/context -->8,941'}, self.reading())

        assert len(defects) == 1
        assert '900' in defects[0]

    def test_a_ratio_marker_for_this_arm_is_refused(self):
        # Our own figure has no counterpart to divide, so a ratio keyed to it is a document that has
        # confused the two sides of its own comparison.
        with_exception = None
        try:
            basis.claimDefects({'doc.md': '<!-- token-ratio:cortex/prompt -->1.00x'}, self.reading())
        except basis.Refused as refusal:
            with_exception = str(refusal)

        assert with_exception is not None
        assert 'this arm rather than a competitor' in with_exception

    def test_the_committed_reading_and_the_documents_agree(self):
        # The gate itself, as a test: `--check` over the real reading and the real documents. If this
        # fails, a document quotes a number the records no longer produce.
        result = subprocess.run(
            [sys.executable, str(REPO / 'tools' / 'token-basis.py'), '--check'],
            capture_output=True,
            text=True,
            cwd=REPO,
        )

        assert result.returncode == 0, result.stderr
        assert 'documents agree' in result.stdout

    def test_the_ledger_refuses_a_cost_that_predates_the_basis(self):
        # The real ledger, not a fixture: every committed cost block must declare its dialect. This
        # is the assertion that keeps a future entry from being quoted before anybody decided what
        # it counts, which is how the mixed ratios got in.
        real = json.loads((REPO / 'tools' / 'competitor-ledger.json').read_text(encoding='utf-8'))
        rows = basis.costRows(real)

        assert rows
        assert all(row['basis'] in basis.BASES for row in rows)
        assert all(row['statistic'] in basis.STATISTICS for row in rows)
