"""The reply-contract repair's census, read mechanically rather than by eye.

§13.334 registered four criteria for `E3`, and the one that decides the axis (`E3.1`) is a **pair
of counts**, not a rate:

    the pass fires on 3 to 5 questions per repetition and converts all of them

Three to five questions is `+0.6` to `+1.0` points, which is inside the seventeen-question noise
floor, so the corpus headline cannot confirm or refute this mechanism. The only readable evidence
is `commitment.attempted == commitment.answered` with both per-repetition figures inside the band
-- and that is arithmetic a reader will get wrong in exactly one way: the census is accumulated on
**one instance reused across all repetitions**, so the artifact's totals are `per-repetition x
runs`. Reading `16` against a band of `[3, 5]` would call a working mechanism broken.

`report.runs` exists for this (`§12.5`'s lesson: the divisor is published, not guessed), so this
reader divides by the **configured** run count and prints the divisor it used. When `runs` is
absent it refuses to score rather than assuming one pass -- an artifact with no divisor is an
artifact whose band cannot be applied, which is a different statement from a failed mechanism.

The tests below are the five ways that can go: in band, short of the band, attempted but not
converted, no divisor, and a malformed half. The last one is the one that matters most, because a
coerced zero would read as "the pass never fired" -- the same silent success the four-state
classifier exists to make impossible.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'readout-arm-run.py'


def _report(census: object, runs: object = 4, *, present: bool = True) -> dict:
    """A report carrying only what this section reads, plus the two fields `main` needs."""
    report: dict = {
        'memoryArmConfig': {'ask': 'verbatim-acts', 'replyRepair': 'commitment'},
        'baseline': {'metrics': {'accuracy': 0.4}},
        'feature': {'metrics': {'accuracy': 0.6}},
        'ablation': {'delta': 0.2},
        'questions': [],
    }
    if runs is not None:
        report['runs'] = runs
    if present:
        report['replyRepair'] = census
    return report


def _run(report: dict, tmp_path: Path) -> subprocess.CompletedProcess[str]:
    path = tmp_path / 'report.json'
    path.write_text(json.dumps(report), encoding='utf-8')
    return subprocess.run(
        [sys.executable, str(TOOL), str(path), '--reply-repair'],
        capture_output=True,
        text=True,
        check=False,
    )


def _census(attempted: int, answered: int, shape: tuple[int, int] = (0, 0)) -> dict:
    return {
        'attempted': attempted + shape[0],
        'answered': answered + shape[1],
        'commitment': {'attempted': attempted, 'answered': answered},
        'shape': {'attempted': shape[0], 'answered': shape[1]},
    }


class TestThePairedCount:
    def test_a_converted_census_passes_and_names_the_divisor(self, tmp_path: Path) -> None:
        """16 over four repetitions is 4.0 per repetition: in band, and converted."""
        r = _run(_report(_census(16, 16)), tmp_path)
        assert r.returncode == 0, r.stderr
        assert 'commitment' in r.stdout
        assert '16' in r.stdout
        assert 'repetitions  4' in r.stdout
        assert '4.0' in r.stdout
        assert 'PASS' in r.stdout

    def test_a_band_shortfall_fails_on_the_band_and_not_on_the_conversion(
        self, tmp_path: Path
    ) -> None:
        """8 over four repetitions is 2.0 per repetition: converts everything, fires too rarely.

        This is the falsifier `E3.1` names first -- the predicate or the wiring is wrong -- and it
        has to be distinguishable from the second falsifier, which is a mechanism that fires and
        does not commit. A single "FAIL" would collapse the two diagnoses.
        """
        r = _run(_report(_census(8, 8)), tmp_path)
        assert r.returncode == 1, r.stderr
        assert 'outside' in r.stdout
        assert '2.0' in r.stdout

    def test_an_unconverted_census_fails_on_the_count(self, tmp_path: Path) -> None:
        """20 attempted, 12 answered: in band on frequency, and the commitment rule does not commit."""
        r = _run(_report(_census(20, 12)), tmp_path)
        assert r.returncode == 1, r.stderr
        assert '8' in r.stdout
        assert 'not converted' in r.stdout

    def test_the_shape_half_is_printed_so_a_silent_kind_is_visible(self, tmp_path: Path) -> None:
        """§13.334.3 refused `shape`; printing its `0 / 0` is what shows the refusal held."""
        r = _run(_report(_census(16, 16, shape=(0, 0))), tmp_path)
        assert r.returncode == 0, r.stderr
        assert 'shape' in r.stdout
        assert '0 / 0' in r.stdout


class TestWhatItRefusesToScore:
    def test_no_runs_field_refuses_rather_than_assuming_one_pass(self, tmp_path: Path) -> None:
        """A missing divisor is not one repetition. Guessing it is how `120` got read as `30`."""
        r = _run(_report(_census(16, 16), runs=None), tmp_path)
        assert r.returncode == 2
        assert 'runs' in r.stderr
        assert r.stdout == ''

    def test_zero_runs_is_malformed_rather_than_a_free_division(self, tmp_path: Path) -> None:
        r = _run(_report(_census(16, 16), runs=0), tmp_path)
        assert r.returncode == 2
        assert 'runs' in r.stderr

    def test_an_absent_census_says_the_build_or_the_switch_is_the_reason(
        self, tmp_path: Path
    ) -> None:
        r = _run(_report(None, present=False), tmp_path)
        assert r.returncode == 2
        assert 'replyRepair' in r.stderr

    def test_a_missing_half_discards_the_whole_field(self, tmp_path: Path) -> None:
        """A total without its parts is the shape the census type exists to prevent."""
        census = _census(16, 16)
        del census['shape']
        r = _run(_report(census), tmp_path)
        assert r.returncode == 2
        assert 'replyRepair.shape' in r.stderr

    def test_a_fractional_or_negative_count_is_malformed_rather_than_clamped(
        self, tmp_path: Path
    ) -> None:
        """The only producer increments by one, so anything else is a fault, not a small number."""
        for bad in (1.5, -1, True, '4', None):
            census = _census(16, 16)
            census['commitment']['answered'] = bad
            r = _run(_report(census), tmp_path)
            assert r.returncode == 2, f'{bad!r} was accepted'
            assert 'replyRepair.commitment.answered' in r.stderr
