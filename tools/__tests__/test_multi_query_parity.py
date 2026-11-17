#!/usr/bin/env python3
"""Tests for `tools/multi-query-parity.mjs` -- the product's multi-query against the instrument's.

## The defect this file is written against

The round that moved query fusion into `SearchIndex` (plan §34) makes a claim about two implementations, and a
claim about two implementations is worth exactly as much as the test that compares them. The tool compares them
item by item on one corpus, one query set and one deterministic embedder.

Three things about that comparison can be wrong without any of them looking wrong:

1. **the comparison could be vacuous** -- two sequences that are both empty, or a corpus so small that any fusion
   produces the same order, would agree for reasons unrelated to the mechanism;
2. **the fusion could be ignored** -- if the tool handed the same query to both sides, the comparison would still
   pass and would say nothing about multi-query;
3. **the precondition could be decorative** -- the equality is only a claim about the fusion when every query
   reaches `TOP_K` positive turns; a fixture where that never fails would make the boundary untested.

The faults answer (2) and the thin fixture answers (3). (1) is answered by asserting the reading: eight turns,
three queries, four positions, and a product census that reports the query count it actually issued.

## Why the clean run is executed last in `TestCleanRun`'s sibling order

Each faulted run exits non-zero and prints to stderr; none of them writes a file, because this gate publishes a
verdict rather than a measurement -- the same shape as `coverage-per-file.mjs`. There is therefore nothing for a
fault to leave behind, and the order of these tests does not matter. That is stated rather than relied on: a tool
that later grows an artifact would need the clean run last, the way `test_erasure_census.py` records.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'multi-query-parity.mjs'


def run(fault: str | None = None, fixture: str | None = None) -> subprocess.CompletedProcess[str]:
    environment = dict(os.environ)
    environment.pop('CORTEX_MULTI_QUERY_PARITY_FAULT', None)
    environment.pop('CORTEX_MULTI_QUERY_PARITY_FIXTURE', None)
    if fault is not None:
        environment['CORTEX_MULTI_QUERY_PARITY_FAULT'] = fault
    if fixture is not None:
        environment['CORTEX_MULTI_QUERY_PARITY_FIXTURE'] = fixture
    return subprocess.run(
        ['node', str(TOOL)],
        cwd=REPO,
        capture_output=True,
        text=True,
        env=environment,
        check=False,
    )


def report(result: subprocess.CompletedProcess[str]) -> dict:
    return json.loads(result.stdout)


class TestCleanRun:
    def test_the_product_and_the_instrument_rank_the_same_sequence(self) -> None:
        result = run()
        assert result.returncode == 0, result.stderr
        reading = report(result)
        assert reading['statement'] == 'equal'
        assert reading['firstDivergence'] == -1
        assert reading['product'] == reading['instrument']

    def test_the_comparison_is_not_vacuous(self) -> None:
        # Eight turns and three queries, so the fused order has four slots with something competing for each, and
        # the product's own census says it issued three queries -- not one, and not none.
        reading = report(run())
        assert reading['turns'] == 8
        assert reading['queries'] == 3
        assert reading['topK'] == 4
        assert len(reading['product']) == 4
        assert reading['productQueries'] == 3
        # The channel is the one the tool claims to compare, so a run that silently fell back to lexical would be
        # visible here rather than passing on a lexical equality.
        assert reading['productChannels'] == ['vector']

    def test_the_precondition_holds_on_the_dense_fixture(self) -> None:
        # Every query reaches at least `topK` turns, which is what makes the equality a statement about the
        # fusion. If this ever fails the tool refuses to compare, so a green run and a precondition that nobody
        # checked must not be the same reading.
        reading = report(run())
        assert min(reading['positives']) >= reading['topK']


class TestFaults:
    def test_a_product_that_ignores_the_plan_is_caught(self) -> None:
        # The exact configuration this round removes: a caller who built the index without `queryPlan`. The
        # product then ranks the question alone while the instrument ranks three queries, and the divergence is
        # reported at the first position where the orders disagree.
        result = run(fault='plan-ignored')
        assert result.returncode == 1
        assert 'multi-query parity failed at position' in result.stderr

    def test_an_instrument_given_only_the_question_is_caught(self) -> None:
        # The mirror image, and the one a dispatch can produce without touching either implementation: a caller
        # that collects expansion phrases and passes `[question]` to the retrieval.
        result = run(fault='query-dropped')
        assert result.returncode == 1
        assert 'multi-query parity failed at position' in result.stderr

    def test_a_fusion_by_score_instead_of_rank_is_caught(self) -> None:
        # The alternative every RRF argument in this repository is against: summing similarities, which needs a
        # normaliser per corpus and lets a channel win by reporting larger numbers. A gate that could not tell
        # this from rank fusion would not be a gate about the fusion.
        result = run(fault='score-merge')
        assert result.returncode == 1
        assert 'multi-query parity failed at position' in result.stderr


class TestPrecondition:
    def test_a_corpus_where_the_zero_filter_acts_reports_unmet_rather_than_comparing(self) -> None:
        # The product excludes zero-similarity turns and the instrument keeps them, and a kept one still votes at
        # its rank. So the equality statement has a boundary, and this asserts the boundary has been seen: on the
        # thin fixture `positives` falls below `topK` for every query and the tool reports `unmet` instead of a
        # divergence it would have to call a defect.
        result = run(fixture='thin')
        assert result.returncode == 0, result.stderr
        reading = report(result)
        assert reading['statement'] == 'unmet'
        assert min(reading['positives']) < reading['topK']
        assert reading['fixture'] == 'thin'
