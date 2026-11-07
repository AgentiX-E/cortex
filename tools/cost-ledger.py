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


def cap_reading(report: dict, per_call: float) -> dict | None:
    """Whether the delivered context is the window or a selection from it, or `None` if uncapped.

    `None` when the artifact does not record `memoryArmConfig.maxPromptChars`, which is not the same as
    a run that was not capped: absence is reported as absence.
    """
    config = report.get('memoryArmConfig')
    cap = _positive_int(config.get('maxPromptChars')) if isinstance(config, dict) else None
    if cap is None:
        return None
    implied = cap / per_call
    low, high = CAP_DENSITY_BAND
    return {
        'maxPromptChars': cap,
        'impliedCharsPerToken': round(implied, 2),
        'reading': 'at-cap' if low <= implied <= high else 'below-cap',
        'band': f'{low}-{high} characters per token, English prose',
        'status': 'inferred',
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
    if cap is not None:
        lines += [
            '',
            f"  maxPromptChars (cap)      {cap['maxPromptChars']:>12,}",
            f"  implied chars per token   {cap['impliedCharsPerToken']:>12.2f}",
            f"  window fill               {cap['reading']:>12}  (inferred, band {cap['band']})",
        ]
    lines += ['', f"  comparable to              {result['comparableTo']}"]
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
