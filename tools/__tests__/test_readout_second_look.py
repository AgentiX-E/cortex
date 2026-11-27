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
* the **accounting** -- `attempted == queries + refused + unranked`, which is the census closing on
  itself. A census that does not close is a defect in the instrument, not a reading of the
  mechanism, and collapsing the two would report an instrument fault as a null result.

The tests below are the seven ways that goes: at the floor, short of the floor, counters that do
not close, no census, no divisor, no bill, and a malformed counter. The last three exist because
each of them, coerced, would print a plausible zero -- the same silent success the four-state
classifier in `--reply-repair` exists to make impossible.
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
    unranked: int = 0,
    promoted: int = 2,
) -> dict:
    return {
        'attempted': attempted,
        'queries': queries,
        'refused': refused,
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
        assert 'neither wrote a query nor were refused' in r.stdout

    def test_a_stage_that_refused_every_time_still_closes(self, tmp_path: Path) -> None:
        """`queries: 0` with every attempt refused is a finding, not a defect.

        The stage reached 121 questions twice and the model declined all of them: the reach is zero,
        the accounting closes, and the artifact is readable. The registration's §4.1 stop rule reads
        this as "the axis closes", not as "the run failed".
        """
        r = _run(_report(_counts(queries=0, refused=242, promoted=0), indexes=242), tmp_path)
        assert r.returncode == 0, r.stderr
        assert '0 queries over 242 questions reached' in r.stdout
        assert '242 refused' in r.stdout


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
