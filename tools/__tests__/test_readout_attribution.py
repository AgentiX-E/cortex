"""The attribution readout: a flip on unchanged bytes is not the treatment's.

§13.257's dispatch changed the prompt on 128 of 500 questions and the all-question paired
test read `5 wins to 18 losses, p = 0.0106`. Thirteen of those 23 discordant pairs were on
questions whose prompt digest had not moved -- and a flip on identical bytes cannot be
caused by a change. The untouched population's own split was `2-11, p = 0.0225`, which is
more extreme than the treatment's attributable component.

So this file tests three things, in that order:

1. the split is by the digest and by nothing else, with an absent digest kept out of both
   sides rather than folded into either;
2. the exact binomial p-value is exact (a normal approximation answers a different number
   on the same data, and the difference lands where the decision is);
3. the self-check fires -- a gold turn cannot enter or leave without the prompt changing,
   so a non-zero delta on the untouched population is a defect in the instrument, not a
   finding about the mechanism.

The tool is invoked as a subprocess, like `test_readout_arm_run.py` does, because
`readout-arm-run.py`'s hyphen makes it unimportable by name and a second copy of these
functions in the test would be a second definition of the thing under test.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'readout-arm-run.py'


def _record(
    identifier: str,
    *,
    correct: bool,
    digest: str | None,
    capability: str = 'MR',
    gold: int = 0,
) -> dict:
    """One question as the artifact writes it, with only the fields this readout reads."""
    record = {
        'questionId': identifier,
        'capability': capability,
        'correct': correct,
        'goldOverlap': {'carried': gold, 'total': gold},
    }
    if digest is not None:
        record['promptDigest'] = digest
    return record


def _report(records: list[dict], spread: dict | None = None) -> dict:
    """A report holding a roster, and the four-pass spread when a case needs it."""
    ablation: dict = {}
    if spread is not None:
        ablation['featureByCapability'] = spread
    return {'questions': records, 'ablation': ablation}


def _rows(stdout: str) -> dict[str, list[str]]:
    """The population table as tokens per row, so a test does not encode column padding.

    Asserting on the padded string would make every test fail on a width change that alters
    nothing a reader of the readout cares about.
    """
    rows: dict[str, list[str]] = {}
    for line in stdout.splitlines():
        tokens = line.split()
        if tokens and tokens[0] in {'identical', 'changed', 'unpaired'}:
            rows[tokens[0]] = tokens[1:]
    return rows


def _run(tmp_path: Path, control: dict, treatment: dict) -> subprocess.CompletedProcess:
    before = tmp_path / 'control.json'
    after = tmp_path / 'treatment.json'
    before.write_text(json.dumps(control), encoding='utf-8')
    after.write_text(json.dumps(treatment), encoding='utf-8')
    return subprocess.run(
        [sys.executable, str(TOOL), str(after), '--attribution', str(before)],
        capture_output=True,
        text=True,
        check=False,
    )


class TestTheSplit:
    def test_the_two_populations_are_counted_by_the_digest(self, tmp_path: Path) -> None:
        control = _report(
            [
                _record('a', correct=True, digest='same'),
                _record('b', correct=True, digest='same'),
                _record('c', correct=True, digest='before'),
                _record('d', correct=True, digest='before'),
            ]
        )
        treatment = _report(
            [
                _record('a', correct=False, digest='same'),
                _record('b', correct=True, digest='same'),
                _record('c', correct=False, digest='after'),
                _record('d', correct=False, digest='after'),
            ]
        )
        r = _run(tmp_path, control, treatment)
        assert r.returncode == 0, r.stderr
        assert 'identical prompt 2' in r.stdout
        assert 'changed prompt 2' in r.stdout
        rows = _rows(r.stdout)
        # `n, up, down, tie, flip, p, gold` -- `a` is the untouched loss, `c` and `d` the
        # attributable ones.
        assert rows['identical'][:4] == ['2', '0', '1', '1']
        assert rows['changed'][:4] == ['2', '0', '2', '0']

    def test_an_absent_digest_is_its_own_bucket(self, tmp_path: Path) -> None:
        """An artifact that predates the field cannot testify about the bytes it sent.

        Counting it as unchanged would inflate the noise control with questions that were
        never compared, and counting it as changed would inflate the treatment. Neither is
        what "the digest is missing" means.
        """
        control = _report([_record('a', correct=True, digest='same'), _record('b', correct=True, digest=None)])
        treatment = _report([_record('a', correct=True, digest='same'), _record('b', correct=False, digest='x')])
        r = _run(tmp_path, control, treatment)
        assert r.returncode == 0, r.stderr
        assert 'no digest on one side 1' in r.stdout

    def test_the_attributable_delta_is_the_changed_population_only(self, tmp_path: Path) -> None:
        control = _report([_record(f'i{n}', correct=True, digest='same') for n in range(8)] + [
            _record('c1', correct=True, digest='a'),
            _record('c2', correct=True, digest='a'),
        ])
        treatment = _report(
            [_record(f'i{n}', correct=True, digest='same') for n in range(8)]
            + [_record('c1', correct=False, digest='b'), _record('c2', correct=True, digest='b')]
        )
        r = _run(tmp_path, control, treatment)
        assert r.returncode == 0, r.stderr
        # One loss out of ten paired questions, and the untouched row does not enter it.
        assert 'attributable delta -1 question(s) of 10 = -10.00 points' in r.stdout


class TestTheSignTest:
    def test_it_is_exact(self, tmp_path: Path) -> None:
        """One up and nine down: `2 * (C(10,0) + C(10,1)) / 2**10 = 0.0215`.

        A normal approximation on ten pairs answers `0.0073`, and the difference is exactly
        where the decision sits -- which is why the tool computes the binomial.
        """
        control = _report(
            [_record(f'c{n}', correct=n < 9, digest='a') for n in range(10)]  # c9 wrong
        )
        treatment = _report(
            [_record(f'c{n}', correct=n == 9, digest='b') for n in range(10)]  # nine down, one up
        )
        r = _run(tmp_path, control, treatment)
        assert r.returncode == 0, r.stderr
        assert _rows(r.stdout)['changed'][:2] == ['10', '1']
        assert '0.0215' in r.stdout

    def test_no_flips_is_not_evidence_of_a_direction(self, tmp_path: Path) -> None:
        """`1.0000` rather than `0.0000`.

        A zero here would let every run without a single flip clear any significance bar --
        the same defect as reporting a missing measurement as a measured zero.
        """
        control = _report([_record('a', correct=True, digest='a')])
        treatment = _report([_record('a', correct=True, digest='b')])
        r = _run(tmp_path, control, treatment)
        assert r.returncode == 0, r.stderr
        assert '1.0000' in r.stdout


class TestTheSelfCheck:
    def test_gold_moving_without_the_prompt_changing_fails_the_readout(self, tmp_path: Path) -> None:
        """A delivered turn cannot enter or leave on a prompt that did not change.

        If it does, either the digest or the pairing key is wrong, and the split printed
        beside it means nothing. The tool therefore refuses to return zero.
        """
        control = _report([_record('a', correct=True, digest='same', gold=1)])
        treatment = _report([_record('a', correct=True, digest='same', gold=2)])
        r = _run(tmp_path, control, treatment)
        assert r.returncode == 1, r.stdout
        assert 'FAIL' in r.stdout
        assert 'prompt did not change' in r.stdout

    def test_gold_moving_on_a_changed_prompt_is_the_expected_case(self, tmp_path: Path) -> None:
        control = _report([_record('a', correct=True, digest='a', gold=1)])
        treatment = _report([_record('a', correct=True, digest='b', gold=3)])
        r = _run(tmp_path, control, treatment)
        assert r.returncode == 0, r.stdout
        assert 'FAIL' not in r.stdout


class TestTheSpread:
    def test_the_four_pass_spread_is_printed_beside_the_mean(self, tmp_path: Path) -> None:
        """The number that made §13.257.5 readable: the mean can agree while the spread does not.

        `92/94.75/99` against `91/94.75/97` is a zero average delta and a seven-question
        spread, against a gate width of five.
        """
        control = _report(
            [_record('a', correct=True, digest='a')],
            spread={'MR': {'min': 92, 'avg': 94.75, 'max': 99}},
        )
        treatment = _report(
            [_record('a', correct=True, digest='a')],
            spread={'MR': {'min': 91, 'avg': 94.75, 'max': 97}},
        )
        r = _run(tmp_path, control, treatment)
        assert r.returncode == 0, r.stderr
        assert '92 / 94.75 / 99' in r.stdout
        assert '+0.00' in r.stdout
        # max - min, taken from whichever side is wider: 99 - 92.
        assert '      7' in r.stdout

    def test_a_report_without_the_spread_still_attributes(self, tmp_path: Path) -> None:
        control = _report([_record('a', correct=True, digest='a')])
        treatment = _report([_record('a', correct=False, digest='b')])
        r = _run(tmp_path, control, treatment)
        assert r.returncode == 0, r.stderr
        assert 'four passes' not in r.stdout


class TestTheRefusals:
    def test_two_rosters_naming_different_questions_raises(self, tmp_path: Path) -> None:
        """A missing id counted as a flip would inflate the treatment population."""
        control = _report([_record('a', correct=True, digest='a')])
        treatment = _report([_record('b', correct=True, digest='b')])
        r = _run(tmp_path, control, treatment)
        assert r.returncode == 2, r.stdout
        assert 'do not name the same questions' in r.stderr

    def test_a_report_with_no_roster_raises(self, tmp_path: Path) -> None:
        r = _run(tmp_path, {'ablation': {}}, _report([_record('a', correct=True, digest='a')]))
        assert r.returncode == 2, r.stdout
        assert 'no per-question roster' in r.stderr
