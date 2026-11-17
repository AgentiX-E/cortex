"""The query-expansion receipt, read from the artifact rather than from the configuration.

§13.97 registered `queryExpansion=llm` as "one model call per multi-session question before the
relevance index is built, and that question is retrieved against `[question, ...phrases]`". What the
registration did **not** say is which route the phrases take to the ranking, and for four rounds the
answer was "the harness's", because `RelevanceCase.queries` is what the instrument's indexes read.
The registered arm since `S9` is `relevanceSignal=self-index`, which builds its index inside the
product and reads `SearchIndexOptions.queryPlan` instead -- a route that did not exist. A dispatch of
`expansion=llm` beside it would have written phrases, counted them in `queryExpansionCounts`, and
answered from the bare question, and every field of that artifact would have agreed with itself.

So the receipt this reader wants is a **pair of numbers the product wrote**, not a restatement of the
configuration: `selfIndex.queries` against `selfIndex.indexes`. One query per retrieval is the
control; more is the plan having acted. `produced` (from `queryExpansionCounts.phrases`) is the
third number, and it is what separates a treatment that never ran from one whose model returned
nothing: `phrases == 0` is a model problem that the accuracy is meant to measure, while
`queries == indexes` with phrases in hand is a wiring problem no accuracy can reveal.

The four cases below are the shapes that has to distinguish, and the two middle ones are the reason
it prints rather than a reason it refuses:

  * phrases and more queries than indexes -> the treatment ran;
  * phrases and one query per index -> the treatment did not reach the ranking;
  * no phrases at all -> the model produced nothing, which is a reading and not a defect;
  * no product index at all -> the phrases travelled through `RelevanceCase.queries`, which this
    field cannot see, so the check must be silent rather than pass.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'readout-arm-run.py'


def _config(*, phrases: int, queries: int, indexes: int) -> dict:
    """A configuration carrying only what the `plan-reach` check reads."""
    return {
        'ask': 'verbatim-acts',
        'relevanceSignal': 'self-index',
        'selfIndex': {
            'indexes': indexes,
            'turns': 5_000,
            'embedCalls': 300,
            'embedTexts': 6_000,
            'memoHits': 4_000,
            'reuse': True,
            'rerankCalls': 0,
            'rerankDegraded': 0,
            'embedDegraded': 0,
            'queries': queries,
        },
        'queryExpansion': 'llm',
        'queryExpansionCounts': {
            'questions': 121,
            'phrases': phrases,
            'refused': 2,
        },
    }


def _run(config: dict, tmp_path: Path) -> subprocess.CompletedProcess[str]:
    report = {
        'memoryArmConfig': config,
        'baseline': {'metrics': {'accuracy': 0.4}},
        'feature': {'metrics': {'accuracy': 0.6}},
        'ablation': {'delta': 0.2},
        # One MR record rather than an empty roster: the section returns early when the roster is
        # absent, which is a property of the loader rather than of this check, and a fixture that
        # tripped it would be testing that the audit never runs.
        'questions': [
            {
                'id': 'q1',
                'capability': 'MR',
                'question': 'how many projects did I lead',
                'baseline': {'correct': False},
                'feature': {'correct': True},
            }
        ],
        'runs': 4,
        'questionCount': 1,
    }
    path = tmp_path / 'report.json'
    path.write_text(json.dumps(report), encoding='utf-8')
    return subprocess.run(
        [sys.executable, str(TOOL), str(path), '--audit'],
        capture_output=True,
        text=True,
        check=False,
    )


def _line(stdout: str, name: str) -> str:
    for line in stdout.splitlines():
        if line.strip().startswith(('PASS', 'FAIL', 'SKIP')) and line.split()[1] == name:
            return line
    return ''


class TestTheReceipt:
    def test_more_queries_than_retrievals_passes_and_prints_both_numbers(
        self, tmp_path: Path
    ) -> None:
        """The shape a working dispatch produces: 121 retrievals issuing 400 queries."""
        r = _run(_config(phrases=480, queries=400, indexes=121), tmp_path)
        line = _line(r.stdout, 'plan-reach')
        assert line.startswith('  PASS'), r.stdout
        assert '480' in line
        assert '400' in line
        assert '121' in line

    def test_one_query_per_retrieval_fails_and_names_the_route(self, tmp_path: Path) -> None:
        """The four-round defect: the phrases were produced and the index never asked for them.

        The detail has to name `queryPlan`, because the next reader of this line is the person
        deciding whether the dispatch was wrong or the code was -- and those have opposite repairs.
        """
        r = _run(_config(phrases=480, queries=121, indexes=121), tmp_path)
        line = _line(r.stdout, 'plan-reach')
        assert line.startswith('  FAIL'), r.stdout
        assert 'queryPlan' in line
        assert 'belongs to the bare question' in line
        assert r.returncode == 1

    def test_no_phrases_is_a_reading_rather_than_a_wiring_defect(self, tmp_path: Path) -> None:
        """Every question refused: one query each, and the accuracy is the control's own."""
        r = _run(_config(phrases=0, queries=121, indexes=121), tmp_path)
        line = _line(r.stdout, 'plan-reach')
        assert line.startswith('  PASS'), r.stdout
        assert '0' in line

    def test_an_instrument_built_index_is_silent_rather_than_passing(self, tmp_path: Path) -> None:
        """`retrieval*` signals build the index in the harness: the phrases are invisible here.

        A check that passed on this artifact would be claiming a receipt it cannot take, and the
        section's whole contract is that a check is an invariant of a legitimate run.
        """
        config = _config(phrases=480, queries=121, indexes=121)
        del config['selfIndex']
        config['relevanceSignal'] = 'retrieval-hybrid'
        r = _run(config, tmp_path)
        assert _line(r.stdout, 'plan-reach') == ''

    def test_a_self_index_run_with_no_bill_fails_rather_than_going_quiet(
        self, tmp_path: Path
    ) -> None:
        """The other side of the same gate: `self-index` promises a bill, and its absence is a defect.

        `indexCostAcross` publishes nothing only when the product built no index, so a `self-index`
        run with counts and no `selfIndex` block is a run whose ranking did not happen -- and silence
        there would read as "the check does not apply" when the truth is "there was nothing to check".
        """
        config = _config(phrases=480, queries=121, indexes=121)
        del config['selfIndex']
        r = _run(config, tmp_path)
        line = _line(r.stdout, 'plan-reach')
        assert line.startswith('  FAIL'), r.stdout
        assert 'None queries for None index(es)' in line

    def test_a_control_run_prints_nothing(self, tmp_path: Path) -> None:
        """No counts block, no receipt: the control has no expansion to have reached anything."""
        config = _config(phrases=480, queries=400, indexes=121)
        del config['queryExpansionCounts']
        config['queryExpansion'] = 'none'
        r = _run(config, tmp_path)
        assert _line(r.stdout, 'plan-reach') == ''
