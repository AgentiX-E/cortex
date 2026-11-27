"""The second look's census and the one arithmetic the product's bill can still falsify.

`PREREGISTRATION-MULTI-STEP.md` registers five bars, and the only one an artifact can refute
without a comparison is "the stage executed". The arm refuses an impossible pair at dispatch time
(`assertReaderSearchReachesRanking`) and refuses an impossible bill at the end of the run
(`assertReaderSearchReached`), but a run that has *finished* is read from its artifact, and the
artifact is where a reader will get the divisor wrong: the census is accumulated on **one instance
reused across every repetition**, so `attempted: 242` on a two-repetition run is 121 questions.

Two failures are therefore separate and this reader keeps them separate:

* the **floor** -- `indexes >= attempted + queries`, which is "every query the reader wrote was
  ranked". Below it the stage wrote queries the index never saw.
* the **accounting** -- `attempted == queries + refused + empty + unranked`, which is the census
  closing on itself. A census that does not close is a defect in the instrument, not a reading of
  the mechanism, and collapsing the two would report an instrument fault as a null result.

A third state joined them after run `45974552492`: a stage that reached every question and wrote
**no** query at all. Both checks above pass on such a run -- the accounting closes and the floor
is trivially met -- and its `refused: 242` read as a model declining on every question. It was not:
`llmUsage.truncatedCalls` was 242, because the decision call was given 32 tokens under a reader
that thinks before it answers. That state is now its own verdict (`starved`), so the §4.1 stop rule
cannot close an axis on a run in which the mechanism produced nothing to measure.

The tests below are the ways that goes: at the floor, short of the floor, counters that do not
close, a stage that fired and wrote nothing, no census, no divisor, no bill, and a malformed
counter. The last three exist because each of them, coerced, would print a plausible zero -- the
same silent success the four-state classifier in `--reply-repair` exists to make impossible.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'readout-arm-run.py'


def _report(
    counts: object,
    *,
    present: bool = True,
    runs: object = 2,
    indexes: object = 478,
    truncated: object = None,
) -> dict:
    """A report carrying only what this section reads, plus the fields `main` needs."""
    config: dict = {'ask': 'verbatim-acts', 'readerSearch': True}
    if indexes is not None:
        config['selfIndex'] = {'indexes': indexes, 'queries': indexes}
    report: dict = {
        'memoryArmConfig': config,
        'baseline': {'metrics': {'accuracy': 0.4}},
        'feature': {'metrics': {'accuracy': 0.6}},
        'ablation': {'delta': 0.2},
        'questions': [],
    }
    if runs is not None:
        report['runs'] = runs
    if truncated is not None:
        report['llmUsage'] = {'truncatedCalls': truncated}
    if present:
        report['readerSearchCounts'] = counts
    return report


def _run(report: dict, tmp_path: Path) -> subprocess.CompletedProcess[str]:
    path = tmp_path / 'report.json'
    path.write_text(json.dumps(report), encoding='utf-8')
    return subprocess.run(
        [sys.executable, str(TOOL), str(path), '--second-look'],
        capture_output=True,
        text=True,
        check=False,
    )


def _counts(
    attempted: int = 242,
    queries: int = 236,
    refused: int = 6,
    empty: int = 0,
    unranked: int = 0,
    promoted: int = 2,
) -> dict:
    return {
        'attempted': attempted,
        'queries': queries,
        'refused': refused,
        'empty': empty,
        'unranked': unranked,
        'promoted': promoted,
    }


class TestTheFloor:
    def test_a_run_at_the_floor_passes_and_names_its_divisor(self, tmp_path: Path) -> None:
        """478 indexes for 242 reached + 236 written is 121 questions twice over."""
        r = _run(_report(_counts()), tmp_path)
        assert r.returncode == 0, r.stderr
        assert 'second look' in r.stdout
        assert 'repetitions  2' in r.stdout
        # 242 over two repetitions is 121.0, which is the figure the registration's §3 quotes.
        assert '121.0 per repetition' in r.stdout
        assert 'the queries reached a ranking  yes' in r.stdout
        assert 'promoted' in r.stdout

    def test_a_run_below_the_floor_fails_and_names_the_floor(self, tmp_path: Path) -> None:
        """One index per question: 118 queries written and never ranked.

        This is the defect the arm's own receipt refuses, read from a finished artifact -- and it is
        the case the *previous* receipt could not see, because it compared `queries` to `indexes`
        inside one run where the two rise together.
        """
        r = _run(_report(_counts(), indexes=242), tmp_path)
        assert r.returncode == 1
        assert 'floor        attempted + queries = 478' in r.stdout
        assert 'NO' in r.stdout

    def test_a_missing_bill_is_said_rather_than_assumed(self, tmp_path: Path) -> None:
        """A build that reports no index cost cannot be scored on the floor, and says so."""
        r = _run(_report(_counts(), indexes=None), tmp_path)
        assert r.returncode == 0, r.stderr
        assert 'absent' in r.stdout
        assert 'cannot be applied' in r.stdout


class TestTheAccounting:
    def test_counters_that_do_not_close_fail_even_with_a_healthy_bill(self, tmp_path: Path) -> None:
        """242 reached, 100 written, 10 refused: 132 attempts went nowhere.

        A run whose counters do not close is an instrument fault. The bill here is healthy
        (`indexes` at the floor), so the floor alone would pass -- which is why the two checks are
        separate.
        """
        r = _run(
            _report(_counts(queries=100, refused=10), indexes=342),
            tmp_path,
        )
        assert r.returncode == 1
        assert 'accounting' in r.stdout
        assert 'neither wrote a query, were refused, nor came back empty' in r.stdout

    def test_a_stage_that_refused_every_time_still_closes(self, tmp_path: Path) -> None:
        """`queries: 0` with every attempt refused is a finding, not a defect.

        The stage reached 121 questions twice and the model declined all of them: the reach is zero,
        the accounting closes, and the artifact is readable. The registration's §4.1 stop rule reads
        this as "the axis closes", not as "the run failed" -- and it can, because `refused` is the
        counter that says the model answered and the answer was `NONE`.
        """
        r = _run(_report(_counts(queries=0, refused=242, promoted=0), indexes=242), tmp_path)
        assert r.returncode == 0, r.stderr
        assert '0 queries over 242 questions reached' in r.stdout
        assert '242 refused, 0 empty' in r.stdout
        assert 'starved' not in r.stdout


class TestTheBound:
    """The state run `45974552492` was read as a null and was not one."""

    def test_a_starved_stage_is_refused_rather_than_read_as_a_null(self, tmp_path: Path) -> None:
        """242 reached, 0 written, 242 empty -- and the usage block naming the same 242 as cut.

        Every other check passes on this artifact: the accounting closes, and the floor is met by
        the 242 indexes the stage built for the questions it reached. The §4.1 stop rule would then
        close a ¥5.87 axis on a run in which the mechanism never produced a query.
        """
        r = _run(
            _report(_counts(queries=0, refused=0, empty=242, promoted=0), truncated=242),
            tmp_path,
        )
        assert r.returncode == 1
        assert 'starved' in r.stdout
        assert 'not a reading of the mechanism' in r.stdout
        # The cause, printed beside the effect: the census counts the empty replies and the usage
        # block is the only field that says the replies were cut rather than declined.
        assert 'llmUsage.truncatedCalls 242' in r.stdout
        assert 'came back cut, not declined' in r.stdout

    def test_a_single_empty_reply_beside_working_queries_is_not_starvation(
        self, tmp_path: Path
    ) -> None:
        """One cut reply in 121 questions is noise, and the check must not be a hair trigger.

        The census closes (`attempted 242 = 236 + 5 + 1`), the bill is at the floor, and the run
        measured the mechanism on 236 of them. Refusing this would make the guard fire on every
        dispatch that had a single malformed reply, which is how a real signal gets tuned out.
        """
        r = _run(
            _report(_counts(queries=236, refused=5, empty=1), truncated=1),
            tmp_path,
        )
        assert r.returncode == 0, r.stderr
        assert '1.0 per repetition' in r.stdout
        assert 'starved' not in r.stdout
        # The bound is still printed: the reader should see the cut calls even when they are not
        # enough to void the run.
        assert 'llmUsage.truncatedCalls 1' in r.stdout

    def test_a_census_without_a_usage_block_says_the_bound_is_unknown(
        self, tmp_path: Path
    ) -> None:
        """A build that reports no `truncatedCalls` cannot be asked whether the replies were cut.

        Printed rather than assumed zero, on the same rule as the bill: "this build does not report
        it" and "nothing was cut" are different rows, and only the first is what the artifact says.
        """
        r = _run(_report(_counts(queries=0, refused=0, empty=242, promoted=0)), tmp_path)
        assert r.returncode == 1
        assert 'truncatedCalls absent' in r.stdout
        assert 'starved' in r.stdout


class TestWhatItRefusesToScore:
    def test_no_census_is_two_causes_and_the_message_carries_both(self, tmp_path: Path) -> None:
        r = _run(_report(_counts(), present=False), tmp_path)
        assert r.returncode == 2
        assert 'predates the second look' in r.stderr
        assert 'CORTEX_MEMORY_READER_SEARCH=0' in r.stderr

    def test_no_divisor_refuses_rather_than_assuming_one_pass(self, tmp_path: Path) -> None:
        r = _run(_report(_counts(), runs=None), tmp_path)
        assert r.returncode == 2
        assert 'one instance reused' in r.stderr

    def test_a_malformed_counter_is_refused_by_name(self, tmp_path: Path) -> None:
        """A float here is a census nobody wrote, and summing it would be worse than refusing it."""
        r = _run(_report(_counts(promoted=2.5)), tmp_path)
        assert r.returncode == 2
        assert 'readerSearchCounts.promoted' in r.stderr

    def test_a_five_counter_census_predates_the_split_and_is_refused(self, tmp_path: Path) -> None:
        """Every artifact up to `45974552492` carries five counters and one `refused`.

        Reading it with `empty: 0` supplied would publish "no empty replies" for a run whose 242
        refusals *were* 242 cut replies -- the conflation the split exists to end, rebuilt at the
        boundary. The refusal names the field instead.
        """
        legacy = {
            'attempted': 242,
            'queries': 0,
            'refused': 242,
            'unranked': 0,
            'promoted': 0,
        }
        r = _run(_report(legacy), tmp_path)
        assert r.returncode == 2
        assert 'readerSearchCounts.empty' in r.stderr
