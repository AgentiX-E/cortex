#!/usr/bin/env python3
"""How much of the gap between two arms is answer quality, and how much is the scorer.

## The error this tool exists to stop

§13.307.2 read two artifacts of the same dataset and concluded that the strong reader's loss was a
**scorer-contract defect**, on this evidence:

| reading | arm A (`deepseek-flash`) | arm B (`deepseek-v4-pro`) |
| --- | --- | --- |
| marginal `exact` verdicts | 175 | 134 |
| accuracy | 90.60% | 85.80% |

Forty-one exact matches disappeared and twenty-four questions flipped wrong, so the loss was
"obviously" the matcher failing to see the stronger reader's answers. **Both numbers are correct and
the conclusion is wrong**, because a marginal count cannot say what happened to the questions it
counted. Pairing the two artifacts by `questionId` says what happened: of the 53 questions where
arm A matched exactly and arm B did not, **arm B was still scored correct on 47**. The judge rescued
them. The marginal reading had described a migration as a loss.

The real decomposition of the 24-question gap is: **6** questions from that migration, **10** from
one question type (`29` of the dataset's `500`), and the rest genuine answer-quality difference.

## Why the tool refuses rather than reports

It reimplements `metrics.ts`'s four-channel decision, which makes it a second opinion that can be
wrong. So for every verdict that is derivable without a judge -- `structural`, `exact`, `numeric` --
it compares its own verdict with the `correct` the artifact recorded, and **raises** on any
disagreement. A decomposition computed over two graders that disagree is a number about nothing, and
the failure mode without this check is silent: the tool would print a table that looks like the last
one.

The `judge` channel is the one verdict that cannot be re-derived, because it was an LLM's answer.
Its size is therefore reported as `judgeDependence` -- the share of the arm decided by something
this tool cannot verify -- so a decomposition over a mostly-judged arm is read as a statement
about the judge's agreement with the gold rather than about the arm.

## Why the join is on `questionId` and never on position

Recording order is not a property of the arm. Two artifacts of one dataset can be written in
different orders by the same code if the worker pool completes in a different order, and a
positional join would turn a resort into a regression. The id sets must match exactly, and a
subset is refused for the reason `paired` gives.

## Why a preference question is its own row

LongMemEval's preference golds are written as a **description of what a good answer would do** --
`The user would prefer responses that build upon their existing efforts to organize their kitchen`.
The gold is a criterion, not an answer, so it can never be matched exactly and always reaches the
judge. They are 5.8% of the dataset and they were 42% of the M1 gap, which is a ratio no
dataset-level accuracy can show.

## Why a capability row was added, and the reading that forced it

`42533236864` and `43031679630` both read 91.20% on the first repetition, and the pair is
`only A 9 / only B 9` -- a net of zero. That number is the one the arm was judged on, and it is
also the one that hides the mechanism: **inside `KU` the same pair is `only A 4 / only B 5`**, and
the four it lost are two answers that were `current` before the room grew and are `overlap` after
it. So the room bought five questions and sold four, and the dataset-level `+0` cannot tell a
mechanism that did nothing from one that did two things.

The slice is not a second tool: it is the same pairing restricted to `record['capability']`, and
the arithmetic closes over it -- the per-capability columns sum to the matrix above, and the
per-capability nets sum to the overall net. Both are asserted in the tests rather than trusted,
because a table that does not add up is the failure this file's `self-check` exists to refuse.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

CAPABILITIES = ('IE', 'MR', 'KU', 'TR', 'ABS')

#: The opening that makes a gold a criterion rather than an answer. See the module docstring.
PREFERENCE_OPENING = 'The user would prefer'

#: `metrics.ts`'s four doors, in the order the harness tries them.
CHANNELS = ('structural', 'exact', 'numeric', 'judge')


class DecompositionRefused(Exception):
    """The two arms, or an arm and its own artifact, cannot be compared as asked."""


def normalize_answer(value: object) -> str:
    """`normalizeAnswer` in `metrics.ts`: trim, lower, collapse runs of whitespace."""
    return re.sub(r'\s+', ' ', str(value).strip().lower())


def is_preference(gold: object) -> bool:
    """True when the gold describes a property a good answer should have."""
    return isinstance(gold, str) and gold.startswith(PREFERENCE_OPENING)


def is_counting_question(text: object) -> bool:
    """`isCountingQuestion` in `metrics.ts`."""
    pattern = r'\b(how many|how much|number of|count|total)\b'
    return re.search(pattern, str(text), re.IGNORECASE) is not None


def _extract_leading_number(value: object) -> float | None:
    match = re.match(r'^\$?\s*(-?\d[\d,]*(?:\.\d+)?)', str(value).strip())
    return float(match.group(1).replace(',', '')) if match else None


def _stated_numbers(value: object) -> list[float]:
    tokens = re.findall(r'\d[\d,]*(?:\.\d+)?', str(value))
    return [float(token.replace(',', '')) for token in tokens]


def _count_distinct_numbers(value: object) -> int:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return 1
    if not isinstance(value, str):
        return 0
    return len({token.replace(',', '') for token in re.findall(r'\d[\d,]*(?:\.\d+)?', value)})


def _numeric_verdict(question: object, predicted: object, expected: object) -> bool | None:
    """`numericAnswerVerdict`: `None` means "not a counting question, or not decidable here"."""
    if not is_counting_question(question):
        return None
    if _count_distinct_numbers(expected) > 1:
        return None
    if not isinstance(predicted, (str, int, float)) or isinstance(predicted, bool):
        return None
    if not isinstance(expected, (str, int, float)) or isinstance(expected, bool):
        return None
    if _extract_leading_number(predicted) is None or _extract_leading_number(expected) is None:
        return None
    gold = _extract_leading_number(expected)
    return gold in _stated_numbers(predicted)


def channel_of(question: object, answer: object, gold: object) -> tuple[str, bool | None]:
    """Which door the verdict left by, and the verdict when it is derivable without a judge.

    The second element is `None` for the `judge` channel on purpose: that verdict was an LLM's, so
    this function has no opinion and says so rather than inventing one.
    """
    if gold is None:
        return 'structural', answer is None
    if answer is None:
        return 'structural', False
    if normalize_answer(answer) == normalize_answer(gold):
        return 'exact', True
    numeric = _numeric_verdict(question, answer, gold)
    if numeric is not None:
        return 'numeric', numeric
    return 'judge', None


def channel_of_record(record: dict) -> tuple[str, bool | None]:
    """`channel_of` on a per-question record, which is the shape every caller here holds."""
    return channel_of(
        record.get('question'), record.get('answer'), record.get('groundTruth')
    )


def _questions(report: dict) -> list[dict]:
    questions = report.get('questions')
    if not isinstance(questions, list) or not questions:
        raise DecompositionRefused(
            'the artifact carries no per-question records, so nothing can be paired'
        )
    return questions


def reconstruct_channels(report: dict) -> dict:
    """The four-channel split, re-derived, with the self-check that licenses it."""
    questions = _questions(report)
    channels = dict.fromkeys(CHANNELS, 0)
    disagreements: list[str] = []
    correct = 0
    for record in questions:
        channel, verdict = channel_of_record(record)
        channels[channel] += 1
        if record.get('correct'):
            correct += 1
        # The judge's verdict is taken from the artifact; the other three are compared with it.
        if verdict is not None and bool(record.get('correct')) != verdict:
            disagreements.append(str(record.get('questionId')))
    if disagreements:
        raise DecompositionRefused(
            'the re-derived verdict disagrees with the artifact on '
            f'{len(disagreements)} question(s): {", ".join(disagreements[:5])}. Two graders that '
            'disagree about the same answer cannot be decomposed, and a table printed anyway would '
            'look exactly like a correct one.'
        )
    total = len(questions)
    return {
        'channels': channels,
        'count': total,
        'accuracy': correct / total,
        'judgeDependence': channels['judge'] / total,
        'selfCheck': 'agrees',
        'path': str(report.get('_path', '<unnamed>')),
    }


def _matrix(a: dict, b: dict) -> dict:
    both_right = only_a = only_b = both_wrong = 0
    for record in a.values():
        other = b[record['questionId']]
        mine, theirs = bool(record.get('correct')), bool(other.get('correct'))
        if mine and theirs:
            both_right += 1
        elif mine:
            only_a += 1
        elif theirs:
            only_b += 1
        else:
            both_wrong += 1
    return {'bothRight': both_right, 'onlyA': only_a, 'onlyB': only_b, 'bothWrong': both_wrong}


def paired(arm_a: dict, arm_b: dict) -> dict:
    """What moved, question by question, in both directions."""
    a = {record['questionId']: record for record in _questions(arm_a)}
    b = {record['questionId']: record for record in _questions(arm_b)}
    if set(a) != set(b):
        missing = set(a) ^ set(b)
        raise DecompositionRefused(
            'the two arms answered different question sets '
            f'({len(missing)} id(s) on one side only). '
            'A pair is a comparison of two answers to the same question; over different sets it is '
            'a comparison of two datasets.'
        )

    migrated = 0
    rescued = 0
    preference = {'questions': 0, 'onlyA': 0, 'onlyB': 0, 'bothRight': 0, 'bothWrong': 0}
    non_preference = dict.fromkeys(('questions', 'onlyA', 'onlyB', 'bothRight', 'bothWrong'), 0)
    by_capability: dict[str, dict[str, int]] = {}
    for qid, record in a.items():
        other = b[qid]
        channel_a, _ = channel_of_record(record)
        channel_b, _ = channel_of_record(other)
        if channel_a == 'exact' and channel_b != 'exact':
            migrated += 1
            if bool(other.get('correct')):
                rescued += 1
        bucket = preference if is_preference(record.get('groundTruth')) else non_preference
        bucket['questions'] += 1
        # `?` rather than dropping the record: an artifact that stopped recording the capability would
        # otherwise make the columns stop summing to the matrix, which is the one property the table
        # is asserted on.
        capability = str(record.get('capability') or '?')
        counts = by_capability.setdefault(
            capability, dict.fromkeys(('questions', 'onlyA', 'onlyB', 'bothRight', 'bothWrong'), 0)
        )
        counts['questions'] += 1
        mine, theirs = bool(record.get('correct')), bool(other.get('correct'))
        if mine and theirs:
            bucket['bothRight'] += 1
            counts['bothRight'] += 1
        elif mine:
            bucket['onlyA'] += 1
            counts['onlyA'] += 1
        elif theirs:
            bucket['onlyB'] += 1
            counts['onlyB'] += 1
        else:
            bucket['bothWrong'] += 1
            counts['bothWrong'] += 1

    matrix = _matrix(a, b)
    return {
        'matrix': matrix,
        'net': matrix['onlyA'] - matrix['onlyB'],
        'exactMigrated': migrated,
        'exactMigratedStillCorrect': rescued,
        'preference': preference,
        'nonPreference': non_preference,
        'byCapability': by_capability,
        'armA': reconstruct_channels(arm_a),
        'armB': reconstruct_channels(arm_b),
    }


def render(result: dict) -> str:
    """The decomposition as text, naming both inputs so the line can be re-derived."""
    arm_a, arm_b = result['armA'], result['armB']
    matrix = result['matrix']
    lines = [
        f'arm A: {arm_a["path"]}  ({arm_a["accuracy"] * 100:.2f}% over {arm_a["count"]} questions)',
        f'arm B: {arm_b["path"]}  ({arm_b["accuracy"] * 100:.2f}% over {arm_b["count"]} questions)',
        '',
        'self-check: both arms agree with their own artifacts on every derivable verdict',
        f'judge dependence: A {arm_a["judgeDependence"] * 100:.1f}%, '
        f'B {arm_b["judgeDependence"] * 100:.1f}%  (the share this tool cannot verify)',
        '',
        '| | A right | A wrong |',
        '| --- | --- | --- |',
        f'| **B right** | {matrix["bothRight"]} | only B {matrix["onlyB"]} |',
        f'| **B wrong** | only A {matrix["onlyA"]} | {matrix["bothWrong"]} |',
        '',
        f'net (only A - only B): {result["net"]:+d}',
        f'exact migration (A matched, B did not): {result["exactMigrated"]}, '
        f'of which B was still scored correct: {result["exactMigratedStillCorrect"]}',
    ]
    preference = result['preference']
    if preference['questions'] > 0:
        lines += [
            '',
            f'preference questions: {preference["questions"]} '
            f'(only A {preference["onlyA"]}, only B {preference["onlyB"]}, '
            f'both right {preference["bothRight"]}, both wrong {preference["bothWrong"]})',
            'non-preference:    '
            f'{result["nonPreference"]["questions"]} '
            f'(only A {result["nonPreference"]["onlyA"]}, '
            f'only B {result["nonPreference"]["onlyB"]})',
        ]
    for name, arm in (('A', arm_a), ('B', arm_b)):
        channels = arm['channels']
        share = ', '.join(f'{key} {value}' for key, value in channels.items())
        lines.append(f'{name} channels: {share}')
    lines += [
        '',
        '| capability | questions | only A | only B | net | A acc | B acc |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ]
    for capability in _capability_order(result['byCapability']):
        counts = result['byCapability'][capability]
        total = counts['questions']
        a_right = counts['bothRight'] + counts['onlyA']
        b_right = counts['bothRight'] + counts['onlyB']
        lines.append(
            f'| {capability} | {total} | {counts["onlyA"]} | {counts["onlyB"]} | '
            f'{counts["onlyA"] - counts["onlyB"]:+d} | '
            f'{a_right / total * 100:.2f}% | {b_right / total * 100:.2f}% |'
        )
    return '\n'.join(lines)


def _capability_order(by_capability: dict[str, dict[str, int]]) -> list[str]:
    """The five known capabilities in their own order, then anything the artifact invented.

    A fixed order because the table is read as a column across runs: two artifacts printed in
    dictionary order would be comparable only if both happened to be built in the same order, and
    `?` -- the bucket for a record with no capability -- sorts last for the reason it is last.
    """
    known = [name for name in CAPABILITIES if name in by_capability]
    return known + sorted(name for name in by_capability if name not in CAPABILITIES)


def _load(path: pathlib.Path) -> dict:
    report = json.loads(path.read_text())
    report['_path'] = str(path)
    return report


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(
            'usage: arm-delta-decomposition.py <arm-a-report.json> <arm-b-report.json>',
            file=sys.stderr,
        )
        return 1
    try:
        a = _load(pathlib.Path(argv[0]))
        b = _load(pathlib.Path(argv[1]))
        print(render(paired(a, b)))
    except DecompositionRefused as refusal:
        print(f'refused: {refusal}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
