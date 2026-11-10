#!/usr/bin/env python3
"""The evidence budget per question, in tokens, read from the per-question records.

## Why this is a separate instrument from `cost-ledger.py`

`cost-ledger.py` answers "what does one question cost the reader" and it answers it from
`usageBySide.feature.promptTokens`, which is a total. `C2` asks a different question -- *how much of
that prompt was evidence* -- and no total can answer it, because a total over calls does not separate
the instruction block from the turns it was spent on. That is why `C2` sat `unrun` with a reason
naming this gap rather than a typed estimate.

The artifact does carry the separation, per question: `promptChars` is the evidence the prompt carried
after `fitToBudget` cut it, and `deliveredPromptChars` is the whole assembled prompt. The difference
between them is the instruction block, the question line, the note and the per-turn header. So the
median evidence figure is a *reading* once a tool takes the median, and a hand-computed median would
be the defect `C1` was written to avoid.

## Why the density is measured here and assumed only once

The records are in characters and the bill is in tokens. `13.293.2` established the factor as 4.11
characters per token from `48000 / 11690`, i.e. from *the cap* and *the per-call reading* -- which is
a ratio of two means over different populations, so it is an inference and not a measurement. This
tool measures it instead, from the same artifact: mean delivered characters per call over mean
delivered tokens per call. On `42355323615` that is 4.08, and the two agree to 0.7%, which is the
cross-check that makes the 4.11 usable.

The one assumption that remains is that a call's characters and a call's tokens describe the same
population. A retry re-sends the same prompt and so enters both means identically; a run whose
`questions[]` covered one repetition while `promptTokens` covered four would enter them at 4:1 and
land outside the band, which is refused rather than divided (see `PUBLISHED_DENSITY_BAND`).

## Why the quantisation is reported

The room is spent in whole turns: `fitToBudget` hands the remainder to `chooseEvidence`, which adds a
turn or does not. So a 460-character increase in the room does not buy 460 characters of evidence --
it buys as many turns as fit, and the marginal turn is worth a whole turn's characters. That is why
`13.298`'s room-rental dispatch was worth reading as a mechanism and not as arithmetic, and why the
number this tool prints is `medianCharsPerEvidenceTurn` rather than a slack figure alone.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from importlib import import_module
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Reused rather than re-implemented. The three-field room resolution (resolved, scalar, route map)
# is exactly the logic a second copy would drift from, and the artifact this tool was written against
# is the one that made the drift expensive.
ledger_tool = import_module('cost-ledger')

# The registration gate; see `cost-ledger.py` for why it is at the write boundary.
registration = import_module('registration-attest')

# The band a measured characters-per-token ratio has to land inside before it is used to convert
# anything. English prose sits near 4; code and tables sit lower; a CJK dataset would sit much lower.
# Outside this range the likelier explanation is that the two sides describe different populations --
# one repetition of characters against four repetitions of tokens is 0.98, which is what a first
# attempt at this tool computed before the denominators were written down.
PUBLISHED_DENSITY_BAND = (2.5, 6.0)


def _positive_int(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def _numbers(questions: list[dict], key: str) -> tuple[list[float], int]:
    """The present values under `key`, and how many records were missing it."""
    values: list[float] = []
    missing = 0
    for question in questions:
        value = question.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            values.append(float(value))
        else:
            missing += 1
    return values, missing


def density(report: dict, mean_delivered_chars: float) -> dict:
    """Measured characters per delivered token, with the refusal that makes it usable.

    Both sides are per call: the character side is the mean of `deliveredPromptChars` over the
    questions, and the token side is `promptTokens / calls`. A retry re-sends the same prompt, so it
    enters both means identically and does not bias the ratio -- which is why the retry share is
    printed beside it rather than divided out.
    """
    side = report.get('usageBySide')
    if not isinstance(side, dict) or not isinstance(side.get('feature'), dict):
        raise SystemExit(
            'the artifact carries no `usageBySide.feature` block, so there is no arm to price. '
            'Falling back to `llmUsage` would total both arms, and the baseline is a different system.'
        )
    feature = side['feature']
    prompt_tokens = _positive_int(feature.get('promptTokens'))
    calls = _positive_int(feature.get('calls'))
    if prompt_tokens is None or calls is None:
        raise SystemExit('`usageBySide.feature` carries no positive `promptTokens`/`calls`.')
    expected_calls = int(report['questionCount']) * int(report['runs'])
    if calls < expected_calls:
        raise SystemExit(
            f'`usageBySide.feature.calls` is {calls} and `questionCount x runs` is {expected_calls}. '
            'A run cannot make fewer calls than it has question-runs, so one of the two is wrong and '
            'the per-call reading divides by whichever it is.'
        )
    tokens_per_call = prompt_tokens / calls
    ratio = mean_delivered_chars / tokens_per_call
    low, high = PUBLISHED_DENSITY_BAND
    if not low <= ratio <= high:
        raise SystemExit(
            f'measured {ratio:.2f} characters per token, outside the {low}-{high} band. That ratio '
            'is the conversion this tool applies to every reading below, so a value outside the '
            'band means the character side and the token side describe different populations -- a '
            'one-repetition `questions[]` divided into a four-repetition `promptTokens` reads 0.98. '
            'Refusing rather than dividing, because a converted median that is 4x wrong is worse '
            'than no median.'
        )
    return {
        'charsPerToken': round(ratio, 2),
        'charsPerCall': round(mean_delivered_chars, 1),
        'tokensPerCall': round(tokens_per_call, 1),
        'retryShare': round((calls - expected_calls) / calls, 4),
        'band': f'{low}-{high} characters per token',
        'status': 'measured',
    }


def budget(report: dict) -> dict:
    """Every reading, or a refusal naming what the artifact did not carry."""
    questions = report.get('questions')
    if not isinstance(questions, list) or not questions:
        raise SystemExit(
            'the artifact carries no `questions[]`, so it has no per-question records. The median '
            'is a property of those records; a total cannot substitute, which is the gap this '
            'instrument exists to close.'
        )
    question_count = _positive_int(report.get('questionCount'))
    runs = _positive_int(report.get('runs'))
    if question_count is None or runs is None:
        raise SystemExit('the artifact carries no positive `questionCount`/`runs`.')
    if question_count != len(questions):
        raise SystemExit(
            f'`questionCount` is {question_count} and `questions[]` holds {len(questions)} records. '
            'A truncated record set under-reads the median in whichever direction the missing '
            'questions lean, so this is refused rather than reported with a caveat.'
        )

    evidence, missing_evidence = _numbers(questions, 'promptChars')
    delivered, missing_delivered = _numbers(questions, 'deliveredPromptChars')
    if missing_evidence or missing_delivered:
        raise SystemExit(
            f'{missing_evidence} records carry no `promptChars` and {missing_delivered} carry no '
            '`deliveredPromptChars`. The evidence reading is `promptChars` (the delivered evidence) '
            'and the instruction share is the difference between the two, so neither can be '
            'reconstructed from the total.'
        )

    measured = density(report, statistics.fmean(delivered))
    factor = measured['charsPerToken']

    evidence_median = statistics.median(evidence)
    delivered_median = statistics.median(delivered)
    # Ratio of medians and median of ratios are different statistics and only one of them is the
    # instruction share of a typical question. Both are printed because the difference is itself a
    # reading: a wide gap means the share moves with the question rather than being a constant.
    share_of_medians = 1 - evidence_median / delivered_median
    shares = [1 - e / d for e, d in zip(evidence, delivered) if d > 0]

    turns, _ = _numbers(questions, 'evidenceTurns')
    chars_per_turn = statistics.median(e / t for e, t in zip(evidence, turns) if t > 0) if turns else None

    # Grouped by capability, because the per-turn width cap reaches two routes out of six
    # (`maxTurnCharsRoutes`), and the two sets leave different amounts of room unspent. The grouping
    # is not a route mapping -- the product owns that -- it is the finest split the records support,
    # printed so the reader can see that the slack is not uniform across the questions.
    slack_by_capability: dict[str, dict] = {}
    for question in questions:
        delivered_chars = question.get('deliveredPromptChars')
        capability = question.get('capability')
        if not isinstance(delivered_chars, (int, float)) or not isinstance(capability, str):
            continue
        slack_by_capability.setdefault(capability, {'slack': []})['slack'].append(delivered_chars)

    resolved = ledger_tool.prompt_rooms(report)
    cap: dict | None = None
    if resolved is not None:
        rooms, source = resolved
        narrowest, widest = min(rooms.values()), max(rooms.values())
        cap = {
            'rooms': rooms,
            'roomSource': source,
            'minRoom': narrowest,
            'maxRoom': widest,
            'medianUtilisation': round(delivered_median / narrowest, 4),
            'medianUnspentChars': round(narrowest - delivered_median, 1),
            'resolved': source == 'effectivePromptChars',
            # The room `fitToBudget` leaves after the last turn it admitted. `chooseEvidence` takes
            # the **largest prefix of the relevance order that fits**, so a turn larger than the
            # remaining room ends the selection rather than being skipped past -- and the room it
            # would have used is lost. Reported because it is the one part of the budget that is
            # neither spent nor available, and because it is not uniform: on `42355323615` it reads
            # 126 characters a question on `multi-session` (where the per-turn width is capped at
            # 400) against 1,247 on `IE` (where it is not), and 11,533 at the worst question.
            'unspentByCapability': {
                capability: {
                    'n': len(bucket['slack']),
                    'medianUnspentChars': round(narrowest - statistics.median(bucket['slack']), 0),
                    'maxUnspentChars': round(narrowest - min(bucket['slack']), 0),
                }
                for capability, bucket in sorted(slack_by_capability.items())
            },
        }

    readings = {
        'medianEvidenceChars': round(evidence_median, 1),
        'medianEvidenceTokensPerQuestion': round(evidence_median / factor, 0),
        'medianPromptChars': round(delivered_median, 1),
        'medianPromptTokensPerQuestion': round(delivered_median / factor, 0),
        'instructionShareOfMedian': round(share_of_medians, 4),
        'medianInstructionShare': round(statistics.median(shares), 4),
    }
    quantisation: dict | None = None
    if chars_per_turn is not None:
        quantisation = {
            'medianCharsPerEvidenceTurn': round(chars_per_turn, 1),
            'turnsPerThousandChars': round(1000 / chars_per_turn, 2),
            'evidenceTurnsMedian': statistics.median(turns),
        }
    return {
        'units': {
            'evidence': 'characters of evidence the prompt carried after `fitToBudget`',
            'prompt': 'characters of the whole assembled prompt',
            'required': 'tokens per question, one repetition',
        },
        'density': measured,
        'readings': readings,
        'cap': cap,
        'quantisation': quantisation,
    }


def ratio_to_reference(arm: dict, reference: dict) -> dict:
    """The `C2` quantity: this arm's median evidence tokens over the reference's.

    An unpaired artifact is its own reference and the ratio is 1.0 by construction. That is a
    **denominator**, not a result, and it is written down as `paired: false` so no reader can mistake
    one for the other -- the numerator arm is a dispatch, and until it lands the row has a baseline
    and no gain.
    """
    numerator = arm['readings']['medianEvidenceTokensPerQuestion']
    denominator = reference['readings']['medianEvidenceTokensPerQuestion']
    return {
        'ratio': round(numerator / denominator, 4) if denominator else None,
        'numeratorEvidenceTokens': numerator,
        'referenceEvidenceTokens': denominator,
        'paired': reference is not arm,
    }


def render(result: dict) -> str:
    readings = result['readings']
    measured = result['density']
    lines = [
        f"median evidence            {readings['medianEvidenceChars']:>12,.0f} chars"
        f" = {readings['medianEvidenceTokensPerQuestion']:>9,.0f} tokens / question",
        f"median whole prompt        {readings['medianPromptChars']:>12,.0f} chars"
        f" = {readings['medianPromptTokensPerQuestion']:>9,.0f} tokens / question",
        '',
        f"  measured density         {measured['charsPerToken']:>12.2f} chars/token  "
        f"({measured['charsPerCall']:,.0f} chars over {measured['tokensPerCall']:,.0f} tokens, per call)",
        f"  retry share of calls     {measured['retryShare'] * 100:>12.2f}%",
        f"  instruction share        {readings['medianInstructionShare'] * 100:>12.2f}%"
        f"  (of the median question; {readings['instructionShareOfMedian'] * 100:.2f}% ratio-of-medians)",
    ]
    cap = result['cap']
    if cap is None:
        lines += ['', '  no room recorded on any field of the artifact']
    else:
        lines += [
            '',
            f"  room                     {cap['minRoom']:>12,}   from {cap['roomSource']}"
            + ('' if cap['resolved'] else '  (a ceiling: unnamed routes took an unrecorded default)'),
            f"  median utilisation       {cap['medianUtilisation'] * 100:>12.2f}%",
            f"  median unspent room      {cap['medianUnspentChars']:>12,.0f} chars",
        ]
        for capability, bucket in cap['unspentByCapability'].items():
            lines.append(
                f"    unspent on {capability:<6s}      {bucket['medianUnspentChars']:>10,.0f} median"
                f"  ({bucket['maxUnspentChars']:,.0f} worst of {bucket['n']})"
            )
    quantisation = result['quantisation']
    if quantisation is not None:
        lines += [
            '',
            f"  chars per evidence turn  {quantisation['medianCharsPerEvidenceTurn']:>12,.0f}"
            f"   ({quantisation['evidenceTurnsMedian']:,.0f} turns in the median prompt)",
            f"  turns per 1k chars       {quantisation['turnsPerThousandChars']:>12.2f}",
        ]
    ratio = result['ratio']
    lines += [
        '',
        f"  C2 ratio to reference    {ratio['ratio']:>12.4f}"
        + ('' if ratio['paired'] else '   (unpaired: this artifact is its own reference)'),
    ]
    return '\n'.join(lines)


REGISTRATION = Path(__file__).resolve().parent / 'arm-config-baseline.json'


def require_registered(report: dict, baseline: Path = REGISTRATION) -> None:
    """Refuse to write an evidence file from an artifact of a configuration nobody registers.

    The defect this closes is §2.2's, one axis further: §13.336 adopted a room map, moved §10.3, the
    dispatch table and `arm-config-baseline.json`, and left four generated evidence files naming the
    run of the map it replaced. `C1` published a bill 24.2% above the registered configuration's and
    `S1`-`S5` a 0.90-point-higher accuracy, and no check could see it because every one of those files
    was a well-formed record of a real run.

    The refusal is unconditional and has no override. An artifact that is not the registered
    configuration is still readable -- `--json` prints the ledger from any artifact, which is what the
    experiment reports do -- and it simply may not become the file a criterion reads.
    """
    reading = registration.attestation(report, json.loads(baseline.read_text(encoding='utf-8')))
    if not reading['matched']:
        raise SystemExit(registration.refusal(reading, baseline))


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path, help='a benchmark-cortex-memory-ablation-report.json')
    parser.add_argument('--reference', type=Path, help='the artifact to divide by, for the C2 ratio')
    parser.add_argument('--json', action='store_true', help='print the readings as JSON')
    parser.add_argument('--write', type=Path, help='write the JSON readings to this path')
    parser.add_argument('--run', help='the workflow run id this report came from')
    parser.add_argument('--baseline', type=Path, default=REGISTRATION, help='the registration record')
    args = parser.parse_args(argv)

    if args.write is not None and not args.run:
        raise SystemExit('--write requires --run: an evidence file must name the run it came from')

    report = json.loads(args.report.read_text())
    if args.write is not None:
        require_registered(report, args.baseline)
    result = budget(report)
    if args.reference is None:
        result['ratio'] = ratio_to_reference(result, result)
        result['reference'] = None
    else:
        reference = budget(json.loads(args.reference.read_text()))
        result['ratio'] = ratio_to_reference(result, reference)
        result['reference'] = str(args.reference)
    result['run'] = args.run
    if args.write is not None:
        args.write.parent.mkdir(parents=True, exist_ok=True)
        args.write.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2) if args.json else render(result))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
