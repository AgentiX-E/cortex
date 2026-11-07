#!/usr/bin/env python3
"""What one question costs the reader, in the unit the bill is written in.

## Why this is a tool and not a division

`llmUsage.promptTokens` is in every artifact and it answers no acceptance question on its own. Three
different readings can be computed from it and all three are defensible:

| reading | arithmetic | what it answers |
| --- | --- | --- |
| per call | `promptTokens / calls` | how big is one context the model was handed |
| per question per run | `promptTokens / (questionCount x runs)` | what one question costs, retries and all |
| per question | `promptTokens / questionCount` | the same, summed over every repetition |

On `42310779222` those are **11,690 / 12,105 / 48,420** -- a 4.1x spread between the smallest and the
largest, from one number and three defensible divisions. An acceptance row that names a threshold without
naming the division is a row two readers can disagree about while both are right, which is why
`acceptance.ts`'s `C1` sat `unrun` rather than carrying a hand-typed figure.

**`perQuestionPerRun` is primary**, because the row's unit is a question and the published competitor rows
`C1` is measured against are written per question (Zep "about 4.4K context tokens per question", Mem0
"about 6.8K tokens per question", Maximem "about 7.4K memory tokens per question"). The third reading,
`perQuestion`, divides by the questions but not by the repetitions, so it is the total a four-pass
evaluation spends: quoting it against a competitor's per-question figure would overstate our cost by the
repetition count, which is a property of the harness rather than of the product.

`perCall` is kept and printed because it is the one number in this file that is *not* per question: it is
the size of a single delivered context, and it is the figure a reader reaches for when asking "how big is
the prompt". The two differ by the retries, and on `42310779222` that is 3.5% -- 2,071 calls for 2,000
question-runs, 71 of them retries. Per question is the primary because a retried call is a cost of
answering that question, not a separate question.

## Why the feature side, and never the whole block

`llmUsage` totals both arms. The baseline arm is `reference-pipeline`, a different system with a smaller
window, so a total would report a number that belongs to neither. `usageBySide.feature` is the arm under
test and is what every reading here uses. When the block is absent the tool refuses rather than falling
back to the total, because a fallback would silently answer a question about two systems.

## Why the character cap is reported beside the token count

A per-call reading that sits at the arm's own `maxPromptChars` is a reading of the cap, not of the
selection: it says the delivery filled the window, and it will not move when retrieval improves. That is
the difference between "our contexts are large because we retrieve a lot" and "our contexts are large
because the window is set to 48,000 characters", and only the second one is cheap to change. The tool
therefore reports the cap and the implied density -- `maxPromptChars / perCall`, which lands at ~4.1
characters per token on English prose when the arm is filling its window. The reading is labelled
`inferred`, because the band it is compared against is a property of the language and not of the run.

## Why a fourth number exists beside the three readings, and is not one of them

`AlphaDiana` (`arXiv:2610.20675`) measured a thing this ledger could not express: when accuracy falls,
**output tokens per correct answer rise even though output per execution falls**. A run that spends less
per question and answers fewer of them right is not cheaper per useful answer, and "we cut 25% of the
tokens" is a claim about the bill only if the accuracy held.

So the ledger also reports **prompt tokens per correct answer** = `perQuestionPerRun / accuracy`. It is
kept out of `readings` on purpose: `readings` is three divisions of one number, and this is a ratio of
two measurements -- folding it in would change the spread between readings, which is the number that
justifies the primary. It is also the only figure here that a *lower* accuracy can make worse, which is
why it is printed with the accuracy it was divided by rather than on its own.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Characters per token for English prose, the band inside which "the prompt filled its character cap"
# is a fair inference. Stated rather than assumed silently: a non-English dataset would sit above it
# and the tool would report `below-cap` for a prompt that is in fact full.
CAP_DENSITY_BAND = (3.5, 4.7)


def _positive_int(value: object) -> int | None:
    """A count that must be above zero, or `None`. `True` is not a count, though Python says it is."""
    if isinstance(value, bool):
        return None
    return value if isinstance(value, int) and value > 0 else None


def _non_negative_int(value: object) -> int | None:
    """A count that may legitimately be zero -- a cache that never hit -- or `None` if absent."""
    if isinstance(value, bool):
        return None
    return value if isinstance(value, int) and value >= 0 else None


ROOM_FIELDS = ('effectivePromptChars', 'maxPromptChars', 'maxPromptCharsByRoute')


def prompt_rooms(report: dict) -> tuple[dict[str, int], str] | None:
    """The room each route assembled under, and the field that supplied it.

    Three fields can name a room and they are not alternative spellings of one another:

    - `effectivePromptChars` (§13.299) is the resolved room, per route, always present on artifacts
      written after it existed. It is authoritative and it is the only one that survives the default
      moving -- `DEFAULT_MAX_PROMPT_CHARS` was 24,000 until §13.82 and 48,000 after.
    - `maxPromptChars` is the scalar a dispatch asked for, absent when the run took the default.
    - `maxPromptCharsByRoute` is the redistribution, and a run that set *only* this left every other
      route on the default. `42355323615` is that run: `{multi-session: 48460}` and no scalar, so the
      first version of this function read a run that delivered 47,830 of 48,460 characters as
      **uncapped** -- a silent false negative on the row whose purpose is to say whether the window
      filled.

    So the fallback chain is not a convenience, it is the repair: the per-route map is read as a map
    rather than discarded, and the field that supplied each room is reported so a reader can tell a
    resolved artifact from an inferred one.
    """
    config = report.get('memoryArmConfig')
    if not isinstance(config, dict):
        return None

    effective = config.get('effectivePromptChars')
    if isinstance(effective, dict):
        rooms = {str(route): _positive_int(width) for route, width in effective.items()}
        if rooms and all(width is not None for width in rooms.values()):
            return {route: int(width) for route, width in rooms.items()}, 'effectivePromptChars'

    scalar = _positive_int(config.get('maxPromptChars'))
    if scalar is not None:
        return {'*': scalar}, 'maxPromptChars'

    by_route = config.get('maxPromptCharsByRoute')
    if isinstance(by_route, dict):
        rooms = {str(route): _positive_int(width) for route, width in by_route.items()}
        if rooms and all(width is not None for width in rooms.values()):
            return {route: int(width) for route, width in rooms.items()}, 'maxPromptCharsByRoute'

    return None


def cap_reading(report: dict, per_call: float) -> dict | None:
    """Whether the delivered context is the window or a selection from it, or `None` if unrecorded.

    `None` when no field in the artifact names a room, which is not the same as a run that was not
    capped: absence is reported as absence.

    ## Why the narrowest room is the test, and the widest is printed beside it

    A redistribution gives each route a different room while `per_call` is one mean over all of them,
    so "the window filled" is only well defined one-sidedly: if the delivery fills the **narrowest**
    room, it filled every route. Testing against the mean would let a run that deepened one route and
    starved another read `at-cap`; testing against the widest would let the reverse pass. Both numbers
    are printed because the gap between them is the redistribution, which is a fact about the run.
    """
    resolved = prompt_rooms(report)
    if resolved is None:
        return None
    rooms, source = resolved
    narrowest = min(rooms.values())
    widest = max(rooms.values())
    # A route map names only the routes it moved. The rest took the product default, and the default
    # has changed once, so an artifact with a map and no `effectivePromptChars` does not say what the
    # unnamed routes used. Reading the fill at the *widest* named room is then a ceiling on it rather
    # than a measurement -- conservative in the only direction that matters here, because a run that
    # is `below-cap` at the widest room is below it everywhere.
    resolved_artifact = source == 'effectivePromptChars' or source == 'maxPromptChars'
    test_room = narrowest if resolved_artifact else widest
    implied = test_room / per_call
    low, high = CAP_DENSITY_BAND
    reading = {
        'maxPromptChars': widest,
        'minRoom': narrowest,
        'maxRoom': widest,
        'rooms': rooms if source == 'effectivePromptChars' else {source: rooms},
        'roomSource': source,
        'impliedCharsPerToken': round(implied, 2),
        'reading': 'at-cap' if low <= implied <= high else 'below-cap',
        'band': f'{low}-{high} characters per token, English prose',
        'status': 'inferred',
    }
    if not resolved_artifact:
        reading['caveat'] = (
            'the routes this map does not name took the product default, which the artifact does '
            'not record; the fill is computed at the widest named room and is therefore a ceiling '
            'on it rather than a measurement. Artifacts written after §13.299 carry '
            '`effectivePromptChars` and do not have this limitation.'
        )
    return reading


def _split_closes(report: dict) -> bool:
    """Can the artifact prove its two per-arm tallies came from one ledger?

    §13.308's second instance. `usageBySide` is two independently accumulated tallies, and when
    they claim more prompt tokens than the run reported, `residualUsage` refuses to name a residual
    and `report.ts` renders `SPLIT UNAVAILABLE` rather than a per-arm column. A ratio computed from
    that column inherits the doubt, and an absent ratio reads as "not measured" while a wrong one
    reads as a measurement.

    One-sided on purpose. An artifact with no total, a total that is not an integer, or a side block
    with no token count cannot prove anything either way, and refusing those would convict a report
    for the absence of a witness.
    """
    total = report.get('llmUsage')
    side = report.get('usageBySide')
    if not isinstance(total, dict) or not isinstance(side, dict):
        return True
    whole = total.get('promptTokens')
    if isinstance(whole, bool) or not isinstance(whole, int):
        return True
    parts = 0
    for name in ('baseline', 'feature'):
        block = side.get(name)
        if not isinstance(block, dict):
            continue
        part = block.get('promptTokens')
        if isinstance(part, bool) or not isinstance(part, int):
            continue
        parts += part
    return parts <= whole


def _authored_efficiency(report: dict) -> dict | None:
    """Adopt the reading the run itself wrote, when it wrote one this tool can divide by.

    §13.308. A run knows both inputs at the moment it writes its artifact, so recomputing its
    ratio can only agree with it or be wrong. The shape check is not ceremony: `costEfficiency` is
    a field a future build can get wrong, and adopting a percentage or a string because it happens
    to be present would make this tool's refusals depend on another repository's type discipline.
    """
    authored = report.get('costEfficiency')
    if not isinstance(authored, dict):
        return None
    if authored.get('state') != 'measured':
        return None
    ratio = authored.get('perCorrectAnswerPromptTokens')
    accuracy = authored.get('accuracy')
    if isinstance(ratio, bool) or not isinstance(ratio, (int, float)) or ratio <= 0:
        return None
    if isinstance(accuracy, bool) or not isinstance(accuracy, (int, float)):
        return None
    if not 0 < accuracy <= 1:
        return None
    correct = authored.get('correct')
    return {
        'state': 'measured',
        'accuracy': float(accuracy),
        'correct': correct if isinstance(correct, int) and not isinstance(correct, bool) else None,
        'perCorrectAnswerPromptTokens': float(ratio),
        'accuracySource': 'artifact',
    }


def _denominator(report: dict, metrics: dict) -> tuple[object, str]:
    """The population the numerator came from, and the name of that population.

    §13.308. `perQuestionPerRun` sums the prompt tokens of **every repetition** and divides by
    `questionCount x runs`, so the divisor has to describe the same repetitions. `feature.metrics`
    is one of them -- `report.ts` renders it as *"accuracy (first repetition)"* for the reason
    §13.122 records -- and `ablation.featureAggregate.avg` is the mean over all of them. On the
    §13.305 pair the first is 91.40% against a 91.95% mean on one arm and 90.80% against 90.75% on
    the other, so the shipped division moved 0.60% of cost onto the arm whose first repetition
    happened to be its worst. Repetition order is arbitrary; the error's sign was too.

    A spread value that is `0`, a boolean or out of range is not a denominator, and the fallback is
    named rather than silent so the rendered line says which population was used.
    """
    ablation = report.get('ablation')
    spread = ablation.get('featureAggregate') if isinstance(ablation, dict) else None
    average = spread.get('avg') if isinstance(spread, dict) else None
    if not isinstance(average, bool) and isinstance(average, (int, float)) and 0 < average <= 1:
        return float(average), 'all-runs'
    return metrics.get('accuracy'), 'first-repetition'


def efficiency(report: dict, per_question_per_run: float) -> dict:
    """Prompt tokens per correct answer, or why that ratio cannot be stated.

    Three states rather than one number with a fallback, for the reason every refusal in this file
    exists: an artifact written before the arm's metrics block was recorded cannot answer the
    question, and a `0` accuracy makes the ratio infinite -- an arm that answered nothing right has
    no cost per right answer, which is a finding and not a price.

    The accuracy is returned beside the ratio because the ratio is a function of it: comparing two
    runs' cost-per-correct-answer without their accuracies is comparing two products of two numbers.
    `accuracySource` names the population beside the number, because `all-runs` and
    `first-repetition` coincide on a one-repetition arm and differ on a four-repetition one -- and a
    reader comparing two artifacts is entitled to know which one it is holding.
    """
    authored = _authored_efficiency(report)
    if not _split_closes(report):
        return {
            'state': 'absent',
            'note': (
                'the side split does not close: baseline + feature claim more prompt tokens than '
                '`llmUsage` reported, so the two tallies did not come from one ledger and no '
                'per-arm column can be divided'
            ),
        }
    if authored is not None:
        return authored
    feature = report.get('feature')
    metrics = feature.get('metrics') if isinstance(feature, dict) else None
    if not isinstance(metrics, dict):
        return {
            'state': 'absent',
            'note': 'the artifact carries no `feature.metrics`, so no correct-answer count exists',
        }
    accuracy, accuracy_source = _denominator(report, metrics)
    # `True` is an `int` in Python: a boolean accuracy would price a run at exactly its per-question
    # cost and look like a perfect ratio, so it is refused by type rather than by value.
    if isinstance(accuracy, bool) or not isinstance(accuracy, (int, float)):
        return {
            'state': 'absent',
            'note': '`feature.metrics.accuracy` is missing or not a number',
        }
    if not 0 <= accuracy <= 1:
        return {
            'state': 'absent',
            'note': f'`feature.metrics.accuracy`={accuracy!r} is not a fraction in [0, 1]',
        }
    correct = metrics.get('correct')
    correct_count = correct if isinstance(correct, int) and not isinstance(correct, bool) else None
    # §13.308's third field, and the same rule as the first two: `correct` is one repetition's
    # count, so it cannot sit in the same parenthesis as an all-runs mean. Real artifact
    # `42387911305` would print `(454 correct, all-runs)` against 90.75% while 454/500 is 90.80% --
    # two populations in one bracket, and the quotient describes no run.
    if accuracy_source == 'all-runs':
        correct_count = None
    if accuracy == 0:
        return {
            'state': 'undefined',
            'accuracy': 0.0,
            'accuracySource': accuracy_source,
            'correct': correct_count,
            'note': 'no correct answers, so tokens per correct answer is infinite rather than large',
        }
    return {
        'state': 'measured',
        'accuracy': float(accuracy),
        'accuracySource': accuracy_source,
        'correct': correct_count,
        'perCorrectAnswerPromptTokens': per_question_per_run / float(accuracy),
    }


def ledger(report: dict) -> dict:
    """The three readings, or a refusal naming what the artifact did not carry."""
    side = report.get('usageBySide')
    if not isinstance(side, dict) or not isinstance(side.get('feature'), dict):
        raise SystemExit(
            'the artifact carries no `usageBySide.feature` block, so there is no arm to price. '
            'Falling back to `llmUsage` would total both arms, and the baseline is a different system.'
        )
    feature = side['feature']
    prompt_tokens = _positive_int(feature.get('promptTokens'))
    calls = _positive_int(feature.get('calls'))
    questions = _positive_int(report.get('questionCount'))
    runs = _positive_int(report.get('runs'))
    if prompt_tokens is None or calls is None:
        raise SystemExit(
            '`usageBySide.feature` carries no positive `promptTokens`/`calls`; the run either made no '
            'calls or was written before the split existed'
        )
    if questions is None or runs is None:
        raise SystemExit(
            'the artifact carries no positive `questionCount`/`runs`; the per-question readings are '
            'undefined and the per-call one alone would hide that'
        )

    readings = {
        'perCall': prompt_tokens / calls,
        'perQuestionPerRun': prompt_tokens / (questions * runs),
        'perQuestion': prompt_tokens / questions,
    }
    cache_hit = feature.get('cacheHitPromptTokens')
    return {
        'primary': 'perQuestionPerRun',
        'readings': readings,
        'inputs': {
            'promptTokens': prompt_tokens,
            'calls': calls,
            'questionCount': questions,
            'runs': runs,
            'cacheHitPromptTokens': _non_negative_int(cache_hit),
        },
        'retries': calls - questions * runs,
        # Named so a reader comparing 11,690 against Zep's 4.4K knows whether the two numbers are the
        # same shape: they are not, and 3.5% of the difference is our retries.
        'comparableTo': 'prompt tokens delivered for one question, one repetition',
        'cap': cap_reading(report, readings['perCall']),
        # Not one of `readings`: those are three divisions of one number, and this is a ratio of two
        # measurements. Folding it in would move the spread that justifies the primary.
        'efficiency': efficiency(report, readings['perQuestionPerRun']),
    }


def render(result: dict) -> str:
    readings = result['readings']
    inputs = result['inputs']
    lines = [
        f"primary: {result['primary']} = {readings[result['primary']]:,.0f} prompt tokens",
        '',
        f"  feature promptTokens      {inputs['promptTokens']:>12,}",
        f"  calls                     {inputs['calls']:>12,}",
        f"  questions x runs          {inputs['questionCount'] * inputs['runs']:>12,}",
        f"  retries (calls - q x r)   {result['retries']:>12,}",
        '',
        f"  per call (one context)    {readings['perCall']:>12,.0f}",
        f"  per question per run      {readings['perQuestionPerRun']:>12,.0f}",
        f"  per question (all runs)   {readings['perQuestion']:>12,.0f}",
    ]
    spread = max(readings.values()) / min(readings.values())
    lines.append(f"  spread between readings   {spread:>12.2f}x")
    cap = result['cap']
    if cap is None:
        lines += [
            '',
            '  no room recorded           (the artifact names no budget on any field;',
            '                              this is not the same as a run that carried none)',
        ]
    else:
        basis = 'narrowest' if 'caveat' not in cap else 'widest named'
        room = cap['minRoom'] if basis == 'narrowest' else cap['maxRoom']
        lines += [
            '',
            f"  room ({basis} route)".ljust(27) + f"{room:>12,}   from {cap['roomSource']}",
        ]
        if cap['minRoom'] != cap['maxRoom']:
            lines += [
                f"  room (widest route)       {cap['maxRoom']:>12,}   redistribution",
            ]
        lines += [
            f"  implied chars per token   {cap['impliedCharsPerToken']:>12.2f}   at the {basis} room",
            f"  window fill               {cap['reading']:>12}  (inferred, band {cap['band']})",
        ]
        if 'caveat' in cap:
            lines += ['', f"  ceiling, not measurement: {cap['caveat']}"]
    lines += ['', f"  comparable to              {result['comparableTo']}"]
    efficiency_block = result.get('efficiency')
    if isinstance(efficiency_block, dict):
        lines.append('')
        if efficiency_block['state'] == 'measured':
            correct = efficiency_block.get('correct')
            source = efficiency_block.get('accuracySource', 'unknown')
            if correct is not None:
                population = f'{correct} correct'
            elif source == 'all-runs':
                population = 'no count, the mean spans runs'
            else:
                population = 'n/a correct'
            lines += [
                f"  per correct answer        {efficiency_block['perCorrectAnswerPromptTokens']:>12,.0f}"
                '   prompt tokens',
                f"  at accuracy               {efficiency_block['accuracy'] * 100:>11.2f}%"
                f"   ({population}, {source})",
            ]
        else:
            lines.append(
                f"  per correct answer        {'not stated':>12}   ({efficiency_block['state']}: "
                f"{efficiency_block['note']})"
            )
    return '\n'.join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path, help='a benchmark-cortex-memory-ablation-report.json')
    parser.add_argument('--json', action='store_true', help='print the readings as JSON')
    parser.add_argument('--write', type=Path, help='write the JSON ledger to this path')
    parser.add_argument('--run', help='the workflow run id this report came from')
    args = parser.parse_args(argv)

    if args.write is not None and not args.run:
        # An evidence file that does not name its run is a number nobody can re-derive, and the whole
        # point of writing one is that a reader can go back to the artifact it came from.
        raise SystemExit('--write requires --run: an evidence file must name the run it came from')

    result = ledger(json.loads(args.report.read_text()))
    result['run'] = args.run
    if args.write is not None:
        args.write.parent.mkdir(parents=True, exist_ok=True)
        args.write.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2) if args.json else render(result))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
