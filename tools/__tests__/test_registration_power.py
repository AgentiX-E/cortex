#!/usr/bin/env python3
"""The threshold calculator's arithmetic, pinned by hand.

## Why a tool this small gets a test

Because it exists to stop three registrations in a row from writing a number nobody
derived. A calculator that silently drifts would let the fourth do the same thing
while citing it -- and the drift would be invisible, since its output is a plausible
band either way.

The values below are computed by hand rather than by the tool:

    72 questions, 0.8611 ->  sd = 100 * sqrt(0.8611 * 0.1389 / 72) = 4.0758pp
    150 questions, 0.88   ->  sd = 100 * sqrt(0.88 * 0.12 / 150)   = 2.6521pp
    30 questions, 0.9667  ->  sd = 100 * sqrt(0.9667 * 0.0333 / 30) = 3.2755pp

## What it deliberately does not check

Whether a *particular* registration used the right multiple. That is the
pre-registration's job; asserting a number here would make the test fail for a
legitimate experiment rather than for a defect.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys

TOOL = pathlib.Path(__file__).resolve().parents[1] / 'registration-power.mjs'


def run(*args: object) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['node', str(TOOL), *[str(a) for a in args]],
        capture_output=True,
        text=True,
        check=False,
    )


def test_sd_matches_hand_arithmetic_for_the_control_bands():
    """The four capabilities §13.21 named, at the proportions that run observed."""
    cases = [
        (72, 0.8611, 4.08),
        (150, 0.88, 2.65),
        (30, 0.9667, 3.28),
        (127, 0.4882, 4.44),
        (121, 0.4463, 4.52),
    ]
    for n, p, expected in cases:
        result = run(n, p, 1.5)
        assert result.returncode == 0, result.stderr
        assert f'binomial sd             = {expected:.2f}pp' in result.stdout, result.stdout


def test_band_is_the_multiple_of_the_sd():
    result = run(72, 0.8611, 1.5)
    assert '+/-6.11pp' in result.stdout, result.stdout
    # 1.5 * 4.08 = 6.11 and 1.0 * 4.08 = 4.08, so the multiple is the only difference.
    assert '+/-4.08pp' in run(72, 0.8611, 1.0).stdout


def test_flags_a_two_question_band_as_underpowered_where_it_is():
    """The §13.21 defect, reproduced as a property of the tool.

    P2'' registered `within 3pp` for a capability whose one-question granularity is
    1.39pp, so the band was 2.78pp wide against a 4.08pp noise floor. The tool must
    say so, because that is the only way the next registration can tell.
    """
    underpowered = run(72, 0.8611, 1.5).stdout
    assert 'UNDERPOWERED' in underpowered
    assert 'NOTE: a two-question band on this capability is narrower than one sd.' in underpowered

    # And the opposite case is not flagged: on 30 questions one question is 3.33pp, so a
    # two-question band is wider than the 3.28pp floor and the flag would be a false alarm.
    detectable = run(30, 0.9667, 1.5).stdout
    assert 'detectable' in detectable
    assert 'NOTE: a two-question band' not in detectable


def test_rejects_inputs_that_would_produce_a_silent_number():
    for args in [(0, 0.5, 1.5), (72, 0, 1.5), (72, 1, 1.5), (72, 0.5, 0), ('x', 0.5, 1.5)]:
        result = run(*args)
        assert result.returncode == 2, f'{args} produced exit {result.returncode}'
        assert 'registration-power:' in result.stderr


def test_a_fractional_n_is_rejected_rather_than_truncated():
    """`n` is a question count, and 72.5 is not one."""
    result = run(72.5, 0.5)
    assert result.returncode == 2
    assert 'n must be a positive integer' in result.stderr


def test_the_default_multiple_is_stated_in_the_usage_line():
    """The tool's own default has to match the one §13.22 registers at, or the citation
    in the pre-registration would describe a different band from the one it computed."""
    result = run(150, 0.88)
    assert result.returncode == 0
    assert '+/-3.98pp' in result.stdout
    assert 'band at 1.5 sd' in result.stdout


def test_the_module_is_importable_so_the_arithmetic_can_be_reused():
    """The three functions are exported for a caller that wants the numbers, not the
    text -- a registration quoting a band should be able to compute it rather than
    transcribe it."""
    script = (
        "import { sdPoints, granularityPoints, bandPoints, isUnderpowered } from "
        + json.dumps(str(TOOL))
        + "; console.log(JSON.stringify([granularityPoints(72), sdPoints(72, 0.8611), "
        + "bandPoints(72, 0.8611), isUnderpowered(72, 0.8611, 2.78)]));"
    )
    result = subprocess.run(
        ['node', '--input-type=module', '-e', script], capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr
    granularity, sd, band, underpowered = json.loads(result.stdout)
    assert round(granularity, 4) == 1.3889
    assert round(sd, 4) == 4.0758
    assert round(band, 4) == 6.1137
    assert underpowered is True
    assert sys.version_info.major == 3
