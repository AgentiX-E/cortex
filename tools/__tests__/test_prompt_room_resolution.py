"""Tests for the room resolution both cost instruments share, and for the default they mirror.

## The defect this file is about

`42355323615` was dispatched with `cortex_memory_max_prompt_chars=multi-session:48460`. That syntax
sets a route map, so the artifact recorded `{maxPromptCharsByRoute: {multi-session: 48460}}` and no
`maxPromptChars`. `cap_reading` read the scalar field only, found nothing, returned `None`, and
`tools/cost-ledger.py` rendered the run as having **no room** -- on a run that had delivered 47,830 of
48,460 characters, i.e. 98.7% of the window, in the row whose entire purpose is to say whether the
window filled.

The same artifact was the subject of `13.298.3`, where a gate reported `declared but unchanged:
['cortex_memory_max_prompt_chars'] -- the departure names a field this run did not move`. One root
cause, two instruments, both blind in the same direction: **a quantity with two spellings where only
one is read.** So the resolution moved into one function and both instruments call it, and the tests
below pin all three spellings plus the absence of all three.

## Why a mirror test and not a shared constant

`cortex-eval` cannot import from `cortex-memory` -- the dependency runs the other way, which is the
reason `TURN_CAP_ROUTES` is duplicated too. A copy is fine as long as something fails when it drifts.
Two things fail here: the mirror comparison, and a scan for present-tense claims that the default is
24,000, which is what four docstrings in this repository still said eighteen months of sections after
§13.82 raised it to 48,000.
"""

from __future__ import annotations

import pathlib
import re
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from importlib import import_module

ledger_tool = import_module('cost-ledger')

REPO = pathlib.Path(__file__).resolve().parents[2]


def report(config: dict) -> dict:
    """The minimum `cap_reading` reads: the config block and a per-call token count."""
    return {'memoryArmConfig': config}


def test_the_resolved_field_wins_over_the_two_request_fields() -> None:
    # §13.299's field is the room the prompt was assembled under. When it is present the two request
    # fields are history, and a reader that preferred them would be reconstructing what the artifact
    # already states.
    resolved, source = ledger_tool.prompt_rooms(
        report(
            {
                'effectivePromptChars': {'multi-session': 48_460, 'temporal': 48_000},
                'maxPromptChars': 96_000,
                'maxPromptCharsByRoute': {'multi-session': 1},
            }
        )
    )
    assert source == 'effectivePromptChars'
    assert resolved == {'multi-session': 48_460, 'temporal': 48_000}


def test_a_scalar_is_one_room_for_every_route() -> None:
    resolved, source = ledger_tool.prompt_rooms(report({'maxPromptChars': 96_000}))
    assert source == 'maxPromptChars'
    assert resolved == {'*': 96_000}


def test_a_route_map_is_read_as_a_map_and_not_discarded() -> None:
    """The `42355323615` shape: the map is the only field, and it used to read as no room at all."""
    payload = report({'maxPromptCharsByRoute': {'multi-session': 48_460}})
    assert ledger_tool.prompt_rooms(payload) == ({'multi-session': 48_460}, 'maxPromptCharsByRoute')

    cap = ledger_tool.cap_reading(payload, per_call=11_721)
    assert cap is not None, 'a capped run must not read as uncapped'
    assert cap['reading'] == 'at-cap'
    assert cap['roomSource'] == 'maxPromptCharsByRoute'


def test_an_unresolved_map_is_a_ceiling_and_says_so() -> None:
    # The routes the map does not name took the product default, which this artifact does not
    # record. Reading the fill at the widest named room is a ceiling on it -- conservative in the
    # only direction that matters, because `below-cap` there is below it everywhere.
    cap = ledger_tool.cap_reading(report({'maxPromptCharsByRoute': {'a': 48_000, 'b': 52_000}}), per_call=11_000)
    assert cap is not None
    assert 'caveat' in cap
    assert 'ceiling' in cap['caveat']
    assert cap['maxRoom'] == 52_000


def test_a_resolved_artifact_carries_no_caveat() -> None:
    cap = ledger_tool.cap_reading(
        report({'effectivePromptChars': {'multi-session': 48_460, 'flat': 48_000}}),
        per_call=11_721,
    )
    assert cap is not None
    assert 'caveat' not in cap
    # The narrowest room is the test: filling it fills every route, which is the one-sided statement
    # a redistribution allows.
    assert cap['minRoom'] == 48_000
    assert cap['impliedCharsPerToken'] == pytest.approx(round(48_000 / 11_721, 2))


def test_no_field_at_all_is_absence_reported_as_absence() -> None:
    assert ledger_tool.prompt_rooms(report({})) is None
    assert ledger_tool.cap_reading(report({}), per_call=11_721) is None
    rendered = ledger_tool.render(
        {
            'primary': 'perCall',
            'readings': {'perCall': 1.0, 'perQuestionPerRun': 1.0, 'perQuestion': 1.0},
            'inputs': {'promptTokens': 1, 'calls': 1, 'questionCount': 1, 'runs': 1},
            'retries': 0,
            'comparableTo': 'prompt tokens delivered for one question, one repetition',
            'cap': None,
        }
    )
    assert 'no room recorded' in rendered
    assert 'not the same as a run that carried none' in rendered


@pytest.mark.parametrize('width', [0, -1, True, '48000', None])
def test_a_room_that_is_not_a_positive_integer_falls_through(width: object) -> None:
    # A zero width is not a room and a boolean is not a count; `True` in particular is an `int` and
    # would price the room at one character without raising anything.
    assert ledger_tool.prompt_rooms(report({'maxPromptChars': width})) is None


def test_the_mirrored_default_matches_the_product() -> None:
    product = (REPO / 'packages' / 'cortex-memory' / 'src' / 'prompt.ts').read_text()
    arm = (REPO / 'packages' / 'cortex-eval' / 'src' / 'turn-cap-routes.ts').read_text()

    product_match = re.search(r'export const DEFAULT_MAX_PROMPT_CHARS = ([\d_]+);', product)
    arm_match = re.search(r'export const PROMPT_ROOM_DEFAULT = ([\d_]+);', arm)
    assert product_match is not None, 'the product constant moved or was renamed'
    assert arm_match is not None, 'the mirrored constant moved or was renamed'
    assert int(product_match.group(1).replace('_', '')) == int(arm_match.group(1).replace('_', '')), (
        'the arm mirrors a default the product no longer uses, so every artifact that took the '
        'default would be read at the wrong room'
    )


def test_no_source_file_still_calls_the_default_24_000() -> None:
    """The stale claim, which is the half of the defect a constant comparison cannot catch.

    §13.82 raised `DEFAULT_MAX_PROMPT_CHARS` from 24,000 to 48,000. Four docstrings kept saying
    24,000, including the one on the field that records the room -- so a human reading the artifact
    and a tool reading it were wrong in the same direction, and neither contradicted the other.
    Historical mentions are legitimate and are not matched: the pattern is the present-tense claim.
    """
    stale = re.compile(r"(product's 24,000|the product default \(24,000\)|default \(24,000\))")
    offenders: list[str] = []
    for path in (REPO / 'packages').rglob('src/**/*.ts'):
        text = path.read_text()
        for number, line in enumerate(text.splitlines(), start=1):
            if stale.search(line):
                offenders.append(f'{path.relative_to(REPO)}:{number}: {line.strip()}')
    assert offenders == [], 'a comment claims the product default is 24,000:\n' + '\n'.join(offenders)


def test_a_redistribution_withholds_the_fill_reading() -> None:
    """`43264749133`'s room set: the quotient cannot answer the fill question, so it does not claim to.

    The reading was `below-cap` at 3.29, and the same artifact measured 99.0% median utilisation against
    those rooms. The quotient is `narrowest_room / mean_tokens`, and on a redistribution the mean spans
    routes whose rooms are twice the narrowest -- so a delivery that filled every route scores
    `4.15 * 24_000 / 30_971 = 3.22` and lands outside the band with nothing unspent.
    """
    cap = ledger_tool.cap_reading(
        report(
            {
                'effectivePromptChars': {
                    'multi-session': 48_460,
                    'temporal': 48_000,
                    'flat': 24_000,
                    'knowledge-update': 24_000,
                    'abstention': 24_000,
                    'assistant': 24_000,
                }
            }
        ),
        per_call=7_286,
    )
    assert cap is not None
    assert cap['reading'] == 'indeterminate'
    assert 'reason' in cap and 'scaled' in cap['reason']
    # The numbers stay printed: withholding the verdict is not withholding the evidence.
    assert cap['impliedCharsPerToken'] == pytest.approx(round(24_000 / 7_286, 2))
    assert cap['minRoom'] == 24_000 and cap['maxRoom'] == 48_460


def test_a_high_quotient_on_a_redistribution_is_withheld_too() -> None:
    # The bias is not one-sided: a large quotient says the mean prompt is small, which is equally
    # consistent with every route sitting under its own room. Only the band test on equal rooms means
    # anything, so both directions are withheld together.
    cap = ledger_tool.cap_reading(
        report({'effectivePromptChars': {'mr': 48_460, 'flat': 24_000}}),
        per_call=3_000,
    )
    assert cap is not None
    assert cap['impliedCharsPerToken'] == pytest.approx(8.0)
    assert cap['reading'] == 'indeterminate'


def test_rooms_within_the_band_width_keep_the_reading() -> None:
    # 48,460 against 48,000 is a 1% spread, which cannot move a full delivery out of a band that is itself
    # 15% wide. The threshold is `low / midpoint`, so a run this close is still answered rather than refused.
    cap = ledger_tool.cap_reading(
        report({'effectivePromptChars': {'multi-session': 48_460, 'temporal': 48_000}}),
        per_call=11_721,
    )
    assert cap is not None
    assert cap['reading'] == 'at-cap'
    assert 'reason' not in cap
