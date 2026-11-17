#!/usr/bin/env python3
"""The readings for the arms that are defined by an absent mechanism.

## The two rows this writes, and why they are one tool

| row | the mechanism that is absent | the number it prices |
| --- | --- | --- |
| `S11` | the ranking (`relevanceSignal: none`) | what a bare install scores |
| `S14` | the vector channel (`indexEmbedding: none`) | what a deployment with no embedding provider scores |

Both rows ask the same question in different places: *this capability is documented as optional, so
what does the product score without it?* The refusals are therefore identical -- an arm, a population,
a registration, a declaration -- and the only thing that differs is which values the arm must hold and
what the number is read against. Two files would be two copies of the refusals, and the second copy is
the one that would be wrong.

The file was called `no-ranking-ledger.py` while `S11` was the only row of this shape. The name became
false the round `S14` was registered, and a false name is worse than a long one: it invites the next
reader to conclude that the lexical-index reading lives somewhere else.

## What it reads, and why it recomputes instead of quoting

`overall.accuracy` is the **mean of the per-repetition accuracies**, computed from
`ablation.featureCorrectByRun` and not from `feature.metrics.accuracy`. Two reasons, and the second is
the one that bites:

- the row's dataset says "four repetitions", and a metric computed over four passes is not the same
  object as the first pass's verdict;
- `questions[].correct` is a **one-repetition** reading. A file built from it would agree with the
  four-repetition figure until the two diverged, which is exactly when a reader would need them to
  agree.

## The paired block, and why a second artifact is an argument

`--control-artifact` pairs this run against another artifact of the same population, question by
question, and writes the four cells (`both`, `onlyTreatment`, `onlyControl`, `neither`) plus an exact
McNemar p. That is the difference between *"85.75% against 91.40%"* -- two means taken in different
weeks -- and *"of 500 questions, N answered by one arm and not the other"*, which is a measurement of
the mechanism rather than of the sample.

The pairing is on `questionId`, and it refuses three shapes: a control with a different dataset
fingerprint (a different population cannot be paired), a control with a different roster (the same
fingerprint and a different question list is a broken artifact), and a control whose repetition count
differs (two means over different numbers of passes are not the same statistic).

The p-value is computed here rather than quoted, and the implementation is checked against an
artifact's own `ablation.mcnemarPValue` in `test_arm_reading_ledger.py`: that field is the same
statistic over the same bits, computed by `cortex-eval`'s `exactMcNemar`, so agreement is evidence that
this is the same test rather than a second one.

## The five refusals

1. **`--write` without `--run`.** An evidence file that does not name its run is a number nobody can
   re-derive.
2. **An artifact of a configuration nobody registers.** The attestation is `registration-attest.py`'s,
   the same one `cost-ledger.py` uses, so a file cannot describe a configuration the project does not
   ship.
3. **An arm that is not the row's arm.** Each row names the values its arm must hold -- `S11` requires
   `relevanceSignal: none`, `S14` requires `self-index` **and** `indexEmbedding: none`. An artifact from
   the other arm is a real measurement of a different product, and its number looks entirely plausible
   under the wrong row.
4. **A population that is not the registered instrument.** 500 questions and four repetitions, because
   each row's threshold is expressed on them. Neither row has a screening tier: the criterion reads
   `overall.accuracy` with no switch, so a smaller run has nowhere honest to go and is refused rather
   than written under a label the row would still read.
5. **A departure the artifact does not declare.** `S11`'s arm **is** a departure on `relevanceSignal`
   and `S14`'s is a departure on both `cortex_memory_relevance` and `indexEmbedding`, so a tool that
   only accepted exact matches would accept nothing either row can produce. The declaration is an
   argument (`--departs`), it must name exactly the fields that moved, and it is written into the file
   so a reader can see which fields the number was bought at.

Usage:
  python3 tools/arm-reading-ledger.py <artifact> --row S11 --run <id> --departs cortex_memory_relevance \\
      --write ../cortex-docs/evidence/longmemeval/no-ranking.json
  python3 tools/arm-reading-ledger.py <artifact> --row S14 --run <id> \\
      --departs cortex_memory_relevance,indexEmbedding --control-artifact <s9.json> \\
      --write ../cortex-docs/evidence/longmemeval/lexical-index.json
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from importlib import import_module
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
registration = import_module('registration-attest')

REGISTRATION = Path(__file__).resolve().parent / 'arm-config-baseline.json'

# The registered instrument, from `acceptance.ts`: 500 questions, four repetitions, one dispatch. Named
# as constants rather than as flags because each row's threshold is expressed on them and a
# `--questions 200` that wrote a passing file would be the row passing on a different instrument.
QUESTIONS = 500
REPETITIONS = 4


@dataclass(frozen=True)
class Row:
    """One row of the acceptance matrix, described by the arm it is about.

    `requires` is the arm, as dotted paths into `memoryArmConfig` paired with the value each must hold.
    It began as two named fields -- `signal` and `index_embedding` -- with a docstring arguing that a
    predicate would be "a place for a later reader to disagree with the matrix". The argument was right
    and the shape was wrong: `S15` is the same `relevanceSignal` and the same `indexEmbedding` as `S9`
    and differs only in the room table, so a row that can name two fields would have accepted `S9`'s
    artifact and published 91.40% under a cell that read 89.40%. A mapping of paths is still data and
    not a predicate -- there is nothing to evaluate, only equality to check -- and it is the smallest
    shape that can say which field makes a row's arm *that* arm.
    """

    id: str
    floor: float
    requires: tuple[tuple[str, object], ...]
    comment: str
    reading: str
    # What the row's number *is*. `ratio` rows read `overall.accuracy` and their floor is a share of the
    # population; `count` rows read `paired.deltaQuestions` and their floor is a count of questions.
    # Added when `S16` arrived, because a row whose number is a pair cannot be rendered against a
    # threshold on a level: `0.904 >= -5` is a comparison between two different units that happens to
    # return a bool. The default is the older shape, so three rows kept their behaviour without a line.
    unit: str = 'ratio'


# The six routes `TurnCapRoute` names. Written out rather than imported because this file reads Python
# and the route table is a TypeScript mapping; the check that keeps the two equal is
# `test_the_room_row_names_every_route_the_product_has`, which reads the TS source and compares the sets.
ROUTES = ('abstention', 'assistant', 'flat', 'knowledge-update', 'multi-session', 'temporal')

# One sentence per field a row can be pinned to, so that a refusal states what the two values *mean*
# and not only that they differ. The table is per field rather than per row because the meaning of
# `injected` does not depend on which row is reading it, and a per-row copy would be four copies of one
# fact -- the shape that let `S14`'s message name a semantic difference the generic loop could not.
FIELD_NOTES = {
    'relevanceSignal': (
        '`none` is a bare install where nothing ranks, `self-index` is the product ranking its own '
        'index, and `retrieval-anchored` is the harness ranking before the product sees the corpus'
    ),
    'indexEmbedding': (
        '`injected` is the deployment every published figure came from; `none` is a caller with no '
        'embedding provider'
    ),
    'maxPromptCharsByRoute': (
        'the room table is how many characters each route may spend, so two rows that differ only here '
        'are two different budgets priced against the same reader'
    ),
}

ROWS: dict[str, Row] = {
    'S11': Row(
        id='S11',
        # 0.88 is S1's threshold minus the 3.0 points `S9` registered as the most ranking this project
        # may give up. `S11` inherits that tolerance rather than inventing a second one.
        floor=0.88,
        requires=(('relevanceSignal', 'none'), ('indexEmbedding', 'injected')),
        comment=(
            'S11. The construction a caller gets without choosing one: `relevanceSignal: none`, so the '
            'budget spends the arrival-order prefix and nothing ranks. One dispatch, four repetitions, '
            'the same reader, judge and prompt as S1. The row asks whether a bare install is shippable '
            "at 88.0%, which is S1 minus S9's registered tolerance."
        ),
        reading='the arm where nothing ranks',
    ),
    'S14': Row(
        id='S14',
        # The same 0.88 and the same derivation as `S11`, deliberately not a second tolerance: the
        # question is identical in shape -- how much accuracy does one absent mechanism cost -- so two
        # thresholds would let the project answer it two ways.
        floor=0.88,
        requires=(('relevanceSignal', 'self-index'), ('indexEmbedding', 'none')),
        comment=(
            'S14. The retrieval index with its vector channel withheld: `relevanceSignal: self-index` so '
            'the index exists and is used, `indexEmbedding: none` so it is lexical only. This is the '
            'deployment of a caller with no embedding provider -- the configuration `index` without '
            '`embed` documents. One dispatch, four repetitions, the same reader, judge and prompt as S1 '
            'and S9, paired against S9 question by question.'
        ),
        reading='the arm where the index has no vector channel',
    ),
    'S15': Row(
        id='S15',
        # S1's own threshold, not S1's minus a tolerance: the question is whether *the room* costs
        # anything, and the arm that answers it is the registered one at a smaller room. Allowing three
        # points of slack here would answer "does the room matter" with "not much", which is a different
        # question and a weaker one than the row asks.
        floor=0.91,
        # The room is the whole row. Every route pinned rather than a floor, because a floor would let
        # `S9`'s artifact (two routes at 48,000) satisfy a row whose subject is that they are not.
        requires=(
            ('relevanceSignal', 'self-index'),
            ('indexEmbedding', 'injected'),
            ('maxPromptCharsByRoute', {route: 24000 for route in ROUTES}),
        ),
        comment=(
            'S15. The registered arm with every route\'s room cut to 24,000 characters -- the cell the '
            'manual\'s cheapest tier is priced at. Same reader, judge, prompt and relevance signal as '
            '`S9`; the only fields that moved are two entries of the room table. Paired against `S9` '
            'question by question, and read per route as well as overall, because a total over six '
            'routes cannot say which one paid.'
        ),
        reading='the arm where every route has a 24,000 character room',
    ),
    'S16': Row(
        id='S16',
        # A count, and the least acceptable one. `-5` is not a new tolerance: it is `S10`'s convention
        # ("a question is a point") applied to an arm whose noise floor was measured rather than
        # assumed -- two dispatches of one configuration differed by 1 question on 252 untouched
        # questions, and this population is twice that.
        floor=-5,
        unit='count',
        # One route given its width back, five left at the cut. Written out per route for the reason
        # `S15`'s table is: `S15`'s artifact and the registered arm differ from this one by exactly one
        # entry each, so a row that named only `multi-session` would accept both of them.
        requires=(
            ('relevanceSignal', 'self-index'),
            ('indexEmbedding', 'injected'),
            (
                'maxPromptCharsByRoute',
                {route: (48460 if route == 'multi-session' else 24000) for route in ROUTES},
            ),
        ),
        comment=(
            'S16. The middle of the room curve: `multi-session` back at 48,460, the other five routes at '
            '24,000. `S15` priced the cut and put the whole of it on one route, so this arm is the '
            'cheapest table that is expected to keep the registered accuracy -- and its number is the '
            '*pair*, because "same score for 17% fewer tokens" is a claim about two arms and a level '
            'cannot state it. Paired against `S9` question by question.'
        ),
        reading='the arm where only the multi-session route keeps its width',
    ),
}



def row_of(name: str) -> Row:
    row = ROWS.get(name)
    if row is None:
        raise SystemExit(
            f'refusing: --row {name!r} is not a row this file writes. Known: {sorted(ROWS)}. A row is '
            'named rather than inferred from the artifact, because the same artifact can satisfy two '
            'rows and only one of them is the question that was asked.'
        )
    return row


def accuracy(report: dict) -> dict:
    """The mean of the per-repetition accuracies, and the numbers it was computed from."""
    questions = [row['questionId'] for row in report.get('questions') or []]
    # `.get` at both levels, because this tool is also pointed at partial artifacts -- a smoke report, a
    # hand-built fixture -- and a `KeyError` there is a crash where the honest answer is a refusal. The
    # distinction matters: a traceback reads as "the tool is broken", a refusal reads as "this artifact
    # cannot answer this row", and only one of those is true.
    vectors = (report.get('ablation') or {}).get('featureCorrectByRun')
    if not isinstance(vectors, list) or not vectors:
        raise SystemExit(
            'refusing: the artifact carries no `ablation.featureCorrectByRun`, so the accuracy cannot be '
            'recomputed and `questions[].correct` would be a one-repetition reading of a four-repetition run'
        )
    for index, bits in enumerate(vectors):
        if not isinstance(bits, str) or len(bits) != len(questions):
            raise SystemExit(
                f'refusing: repetition {index} carries {len(bits) if isinstance(bits, str) else "no"} '
                f'verdicts for {len(questions)} questions, so the vector is not aligned with the roster'
            )
    per_run = [sum(1 for bit in bits if bit == '1') / len(questions) for bits in vectors]
    return {
        'accuracy': sum(per_run) / len(per_run),
        'accuracyPerRun': per_run,
        'questions': len(questions),
        'runs': len(vectors),
        'accuracySource': 'recomputed from ablation.featureCorrectByRun; not questions[].correct',
    }


def majority(report: dict) -> dict[str, bool]:
    """One verdict per question across the repetitions, which is what a pair compares.

    The majority rather than the first repetition: two runs of one configuration disagree on a
    measurable share of questions between repetitions, so pairing first repetitions would report noise
    as a treatment effect. A tie is a loss, which is the conservative direction -- a question answered
    correctly in half the passes cannot be quoted as correct.
    """
    questions = report.get('questions') or []
    vectors = (report.get('ablation') or {}).get('featureCorrectByRun') or []
    verdicts: dict[str, bool] = {}
    for index, entry in enumerate(questions):
        yes = sum(1 for bits in vectors if bits[index] == '1')
        verdicts[str(entry['questionId'])] = yes * 2 > len(vectors)
    return verdicts


def exact_mcnemar(only_control: int, only_treatment: int) -> float:
    """Two-sided exact McNemar on the discordant pairs, the statistic `cortex-eval` computes.

    `exactMcNemar` in `packages/cortex-eval/src/a3.ts` is `min(1, 2 * binomialCdf(min(b, c), n, 0.5))`.
    Computed here with integer binomial coefficients rather than a log-space CDF: `n` is at most the
    question count, so the sum is exact and the only rounding is the final division. An `n` of zero
    returns 1, not 0 -- an undefined statistic reported as a small number is how a null result becomes
    a finding.
    """
    total = only_control + only_treatment
    if total == 0:
        return 1.0
    tail = min(only_control, only_treatment)
    numerator = sum(_choose(total, k) for k in range(tail + 1))
    return min(1.0, 2 * numerator / (1 << total))


_FACTORIALS = [1]
for _value in range(1, QUESTIONS * REPETITIONS + 1):
    _FACTORIALS.append(_FACTORIALS[-1] * _value)


def _choose(n: int, k: int) -> int:
    return _FACTORIALS[n] // (_FACTORIALS[k] * _FACTORIALS[n - k])


def paired(treatment: dict, control: dict, control_run: str | None = None) -> dict:
    """The four cells, the delta in questions and points, and the exact p.

    Three refusals, and each is a way two artifacts can look comparable without being comparable: a
    different corpus, a different roster, a different number of repetitions. All three would produce a
    p-value that is a real number about the wrong comparison.
    """
    if treatment.get('datasetFingerprint') != control.get('datasetFingerprint'):
        raise SystemExit(
            'refusing: the two artifacts graded different corpora '
            f"({treatment.get('datasetFingerprint')} against {control.get('datasetFingerprint')}), so "
            'there is no pair to take'
        )
    mine = majority(treatment)
    theirs = majority(control)
    if set(mine) != set(theirs):
        raise SystemExit(
            f'refusing: the two artifacts share {len(set(mine) & set(theirs))} question ids and differ '
            f'on {len(set(mine) ^ set(theirs))}. The same corpus fingerprint with a different roster is '
            'a broken artifact, not a population to pair'
        )
    arm_runs = len((treatment.get('ablation') or {}).get('featureCorrectByRun') or [])
    control_runs = len((control.get('ablation') or {}).get('featureCorrectByRun') or [])
    if arm_runs != control_runs:
        raise SystemExit(
            f'refusing: {arm_runs} repetitions in this artifact against {control_runs} in the '
            'control. Two means over different numbers of passes are not the same statistic, and '
            'the delta would be read as an effect'
        )
    both = sum(1 for key in mine if mine[key] and theirs[key])
    only_treatment = sum(1 for key in mine if mine[key] and not theirs[key])
    only_control = sum(1 for key in mine if not mine[key] and theirs[key])
    neither = sum(1 for key in mine if not mine[key] and not theirs[key])
    total = len(mine)
    return {
        'byCapability': capability_deltas(treatment, control),
        'byRoute': route_deltas(treatment, control),
        'control': {
            'run': control_run if control_run is not None else control.get('run'),
            'accuracy': accuracy(control)['accuracy'],
            'relevanceSignal': (control.get('memoryArmConfig') or {}).get('relevanceSignal'),
            # Absence reads as `injected` here for the reason `arm_refusal` states: an artifact that
            # predates the field was produced by the arm that embeds, and `S9` is one.
            'indexEmbedding': (control.get('memoryArmConfig') or {}).get('indexEmbedding', 'injected'),
        },
        'cells': {
            'both': both,
            'onlyTreatment': only_treatment,
            'onlyControl': only_control,
            'neither': neither,
        },
        'deltaQuestions': only_treatment - only_control,
        'deltaPoints': (only_treatment - only_control) / total * 100 if total else 0.0,
        'mcnemarP': exact_mcnemar(only_control, only_treatment),
        'questions': total,
        'pairing': 'majority verdict per question across the repetitions',
    }


def capability_deltas(treatment: dict, control: dict) -> dict[str, dict]:
    """Where the difference lands per capability -- what the mechanism *does*."""
    return grouped_deltas(treatment, control, 'capability')


def route_deltas(treatment: dict, control: dict) -> dict[str, dict]:
    """Where the difference lands per prompt route, and how much room each one spent.

    The capability split says which population paid; the route split says *which budget* paid, and the
    two are not the same question. `MR` and `TR` are both aggregations and both lost turns at 24,000,
    but they are assembled by different routes (`multi-session` and `temporal`), and a run that halves
    both rooms and loses on one of them is a statement about routes rather than about aggregations.

    The delivered characters are the room's own witness: a route whose accuracy did not move and whose
    delivered characters did not move is a route the run never touched, so reading its delta as noise is
    correct rather than generous.
    """
    return grouped_deltas(treatment, control, 'route')


def grouped_deltas(treatment: dict, control: dict, field: str) -> dict[str, dict]:
    """Where the difference lands, capability by capability.

    A single delta says a mechanism is worth N points; it does not say what the mechanism *does*. The
    split is what turns "the embedder is worth 5.60 points" into a statement that can be acted on -- if
    the loss is concentrated in the populations that require finding a turn rather than in the ones that
    require reasoning over turns already found, then the channel is a retrieval mechanism and its absence
    is a recall problem, which has a different repair than a reasoning problem does.

    Majority verdicts, the same aggregation the pair uses, so the two readings cannot disagree about a
    question. A capability present on one side only is reported with `None` rather than zero: a zero
    would read as "every question failed".

    The roster and the correctness are counted from different files on purpose. `total` comes from the
    treatment alone, because a capability's denominator is a property of the population -- summing it over
    both artifacts is how the first version of this function reported `ABS 60 questions` for a 30-question
    population, an error that reads as a larger population rather than as a defect.
    """
    mine = majority(treatment)
    theirs = majority(control)
    totals: dict[str, dict[str, float]] = {}
    for entry in treatment.get('questions') or []:
        name = str(entry.get(field))
        totals.setdefault(
            name,
            {
                'total': 0,
                'correctTreatment': 0,
                'correctControl': 0,
                'charsTreatment': 0,
                'charsControl': 0,
                'charsCounted': 0,
            },
        )['total'] += 1
    for entry in treatment.get('questions') or []:
        name = str(entry.get(field))
        totals[name]['correctTreatment'] += 1 if mine.get(str(entry['questionId'])) else 0
        # Counted only when the control also carries the field, checked below: a mean over the questions
        # that happen to have it is a mean over a different population, and a mean over substituted zeros
        # would read as a route that delivered nothing -- `absent != zero`, in the one field the room is
        # read from.
        if 'deliveredPromptChars' in entry:
            totals[name]['charsTreatment'] += entry['deliveredPromptChars']
    for entry in control.get('questions') or []:
        name = str(entry.get(field))
        if name not in totals:
            # A capability the treatment's roster does not carry cannot be compared, and inventing a
            # denominator for it would print a delta over a population that is not the same population.
            continue
        totals[name]['correctControl'] += 1 if theirs.get(str(entry['questionId'])) else 0
        if 'deliveredPromptChars' in entry:
            totals[name]['charsControl'] += entry['deliveredPromptChars']
            totals[name]['charsCounted'] += 1
    out: dict[str, dict] = {}
    for name, block in sorted(totals.items()):
        total = int(block['total'])
        arm = block['correctTreatment'] / total if total else 0.0
        other = block['correctControl'] / total if total else 0.0
        out[name] = {
            'questions': total,
            'treatment': arm,
            'control': other,
            'deltaPoints': (arm - other) * 100,
        }
        if total and block['charsCounted'] == total:
            out[name]['deliveredCharsPerQuestion'] = {
                'treatment': block['charsTreatment'] / total,
                'control': block['charsControl'] / total,
            }
    return out


def fingerprint(report: dict) -> str:
    """The attestation's own hash, not a second spelling of it.

    `capability-ledger.py` writes this field from `registration.fingerprint`, so a local implementation
    would be a second hash of one configuration -- and the two would agree until the canonicalisation
    changed, at which point every evidence file would disagree with the attestation and nothing would
    say which of them was right.
    """
    return registration.fingerprint(report.get('memoryArmConfig'))


def ledger(
    report: dict,
    run: str | None,
    declared: list[str],
    row: Row,
    control: dict | None,
    control_run: str | None = None,
) -> dict:
    arm = report.get('memoryArmConfig', {})
    overall = accuracy(report)
    result = {
        '$comment': row.comment,
        'row': row.id,
        'run': run,
        # Always present, and the reason is the one every always-present field in this campaign has: a
        # file that omitted it would make "no departure" and "written before the field existed" the same
        # bytes, and both rows exist precisely because fields *did* move.
        'declaredDepartures': list(declared),
        'arm': {
            # Two spellings of the same fact: older artifacts carry a top-level `kind`, newer ones
            # name the arm under `feature.name`. A `null` here is a hole, not a reading -- `S11`'s
            # committed file has one, written before this fallback existed.
            'name': report.get('kind') or (report.get('feature') or {}).get('name'),
            'relevanceSignal': arm.get('relevanceSignal'),
            # Carried rather than assumed: `S11` and `S14` differ only here, and a reader who has the
            # file without this line cannot tell which of the two arms produced the number.
            'indexEmbedding': arm.get('indexEmbedding', 'injected'),
            'reader': (arm.get('reader') or {}).get('model'),
            'judge': (arm.get('judge') or {}).get('model'),
            'maxTurnChars': arm.get('maxTurnChars'),
            # The room table, because `S15` is distinguished from `S9` by nothing else. A file that
            # recorded only the signal and the embedding would describe both rows equally well, and the
            # attestation that catches a re-pointed file has to be able to name the field that moved.
            'maxPromptCharsByRoute': arm.get('maxPromptCharsByRoute'),
            'turnCutMarker': arm.get('turnCutMarker'),
            'promptContract': arm.get('promptContract'),
        },
        'dataset': {
            'name': report.get('dataset'),
            'fingerprint': report.get('datasetFingerprint'),
            'questions': overall['questions'],
            'repetitions': overall['runs'],
        },
        'overall': overall,
        'configurationFingerprint': fingerprint(report),
        # `registered` is a claim the strict path has verified; a departure is a different claim and gets
        # a different word, because the two files are read by the same criterion and only one of them is
        # the configuration the project ships.
        'tier': 'declared-departure' if declared else 'registered',
    }
    if control is not None:
        result['paired'] = paired(report, control, control_run)
    return result


def render(result: dict) -> str:
    overall = result['overall']
    arm = result['arm']
    row = row_of(str(result['row']))
    floor = row.floor
    lines = [
        f"{result['row']}  run {result['run']}",
        f"  arm: relevanceSignal={arm['relevanceSignal']}  indexEmbedding={arm['indexEmbedding']}  "
        f"reader={arm['reader']}  judge={arm['judge']}",
        f"  population: {overall['questions']} questions x {overall['runs']} repetitions",
        '  per run: ' + ', '.join(f'{value * 100:.2f}%' for value in overall['accuracyPerRun']),
        # A count row's floor is a count, so printing it beside a share would be a threshold formatted
        # in a unit the row does not read. The level is still printed -- it is the number a reader wants
        # first -- but the parenthetical says which figure the row actually decides on.
        f"  overall: {overall['accuracy'] * 100:.2f}%  "
        + (
            f'({result["row"]} reads the pair, not this figure)'
            if row.unit == 'count'
            else f"({result['row']} floor {floor * 100:.1f}%)"
        ),
    ]
    pair = result.get('paired')
    if pair is not None:
        cells = pair['cells']
        lines.append(
            f"  paired against run {pair['control']['run']} "
            f"({pair['control']['accuracy'] * 100:.2f}%): both {cells['both']}, "
            f"only this arm {cells['onlyTreatment']}, only control {cells['onlyControl']}, "
            f"neither {cells['neither']}"
        )
        lines.append(
            f"  delta: {pair['deltaQuestions']:+d} questions ({pair['deltaPoints']:+.2f} points)  "
            f'exact McNemar p={pair["mcnemarP"]:.3g}'
        )
        for name, block in sorted(pair.get('byCapability', {}).items()):
            lines.append(
                f"    {name:<6} {block['questions']:>4} questions  "
                f"{block['treatment'] * 100:6.2f}% against {block['control'] * 100:6.2f}%  "
                f"{block['deltaPoints']:+6.2f} points"
            )
        for name, block in sorted(pair.get('byRoute', {}).items()):
            chars = block.get('deliveredCharsPerQuestion')
            spent = (
                f"  chars {chars['treatment']:>7.0f} against {chars['control']:>7.0f}"
                if chars is not None
                else ''
            )
            lines.append(
                f"    {name:<17} {block['questions']:>4} questions  "
                f"{block['treatment'] * 100:6.2f}% against {block['control'] * 100:6.2f}%  "
                f"{block['deltaPoints']:+6.2f} points{spent}"
            )
    lines.append('  declared: ' + (', '.join(result['declaredDepartures']) or 'none'))
    # The floor comes from the row, not from a literal. It was a literal -- `88.0%` -- for as long as
    # both rows happened to share that threshold, so the printed sentence and the verdict agreed with
    # `S11` and `S14` and with nothing else. `S15`'s floor is 0.91, and a row that prints another row's
    # threshold beside its own number is the same defect as a baseline that names a run it did not read.
    #
    # The branch on `unit` is the same defect one level down: a count row's verdict is read off the pair,
    # and a renderer that compared `0.904 >= -5` would print `pass` for every possible count row -- a
    # verdict that cannot be wrong is not a verdict.
    if row.unit == 'count':
        if pair is None:
            lines.append(
                f"  verdict: unread  (no pair, and {row.id}'s number is the pair it reads against the "
                'registered arm)'
            )
        else:
            delta = pair['deltaQuestions']
            lines.append(
                f"  verdict: {'pass' if delta >= floor else 'miss'}  ({delta:+d} questions against "
                f'{row.id} allows {floor:+.0f})'
            )
    else:
        lines.append(f"  verdict: {'pass' if overall['accuracy'] >= floor else 'miss'}")
    return '\n'.join(lines)


def _at(arm: dict, path: str) -> tuple[bool, object]:
    """The value at a dotted path, and whether the path exists at all.

    The flag is not pedantry. `indexEmbedding` is read as `injected` when absent, because an artifact
    written before the field existed *is* the injected arm -- and `maxPromptCharsByRoute` must not read
    as anything when absent, because an artifact with no room table ran whatever scalar it recorded and
    is not a room row's arm. A single sentinel cannot express both, so absence is reported and each
    row's requirement decides what it means.
    """
    node: object = arm
    for part in path.split('.'):
        if not isinstance(node, dict) or part not in node:
            return False, None
        node = node[part]
    return True, node


def arm_refusal(report: dict, row: Row) -> str | None:
    """Why this artifact is not the row's arm, or `None`.

    The message names the row's own content rather than the field: a reader who gets
    *"`relevanceSignal` is `self-index`"* has to look up why that matters, and a reader who gets
    *"`S11` is the arm where nothing ranks"* does not.

    Every path in `row.requires` is checked, and the first mismatch is refused. `indexEmbedding` is the
    one path with an absence rule -- an artifact that predates the field was produced by the arm that
    embeds, which is what `toMemoryArmConfig` writes -- and it is written here rather than in the table
    because it is a fact about that field, not about any row.
    """
    arm = report.get('memoryArmConfig') or {}
    for path, expected in row.requires:
        present, actual = _at(arm, path)
        if path == 'indexEmbedding' and not present:
            actual, present = 'injected', True
        if not present:
            # Absence and an explicit `null` are two different facts and get two different sentences: the
            # first says the run cannot be shown to have held the arm, the second says the run recorded an
            # arm that is not one. Collapsing them into `reads None` is how an unrecorded arm passed for
            # a recorded one in this project once already.
            return (
                f'refusing: the artifact records no `{path}` and {row.id} is {row.reading}. An absent '
                'field is not a value: the run cannot be shown to have held the row\'s arm, and writing '
                f'this file would publish a number under an arm nothing recorded. {FIELD_NOTES.get(path, "")}'
            ).rstrip()
        if actual != expected:
            return (
                f"refusing: the artifact's `{path}` reads {actual!r} and {row.id} requires "
                f'{expected!r}. {row.id} is {row.reading}; writing this file would publish a real '
                'measurement of the wrong product under this row, and nothing in the number would look '
                f'wrong. {FIELD_NOTES.get(path, "")}'
            ).rstrip()
    # A run whose embedder failed mid-way is neither arm. `SearchIndex.onEmbedFailure: 'lexical'` scores
    # such a retrieval the way this product scores when there is no embedder at all -- which is what
    # keeps a long benchmark alive (run `43866639154` died at 86% of its third repetition with 432 graded
    # answers in memory) and what makes the artifact a MIXTURE: some questions ranked over two channels
    # and the rest over one. Its accuracy is therefore between the arm and `S14`'s measured fallback, and
    # no deployment produced it.
    #
    # Absence reads as zero, and that is the true reading rather than a lenient one: the field arrives
    # with the policy, so a build without the policy cannot degrade a retrieval. Every artifact written
    # before it existed -- `S9`, `S14` -- is a pure arm.
    self_index = arm.get('selfIndex')
    degraded = 0 if self_index is None else (self_index or {}).get('embedDegraded', 0)
    if isinstance(degraded, bool) or not isinstance(degraded, int) or degraded < 0:
        return (
            f"refusing: `selfIndex.embedDegraded` reads {degraded!r}, which is not a count. The field is "
            'absent or a non-negative integer, and a corrupt one cannot be read as "no degradations" -- '
            'that is the reading an unreadable block must never be allowed to impersonate'
        )
    if degraded > 0:
        return (
            f"refusing: `selfIndex.embedDegraded` reads {degraded}, so {degraded} retrieval(s) fell "
            f'back to lexical scoring while the rest used the vector channel. That is a mixture of {row.id} '
            f'and the lexical index `S14` priced, not {row.id} itself: the accuracy this file would '
            'publish belongs to no configuration any deployment can run, and the provider failure that '
            'caused it is the run\'s finding rather than its reading'
        )
    return None


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path, help='a benchmark-cortex-memory-ablation-report.json')
    parser.add_argument('--row', required=True, help=f'a row this file writes: {sorted(ROWS)}')
    parser.add_argument('--json', action='store_true', help='print the reading as JSON')
    parser.add_argument('--write', type=Path, help='write the evidence file to this path')
    parser.add_argument('--run', help='the workflow run id this report came from')
    parser.add_argument('--baseline', type=Path, default=REGISTRATION, help='the registration record')
    parser.add_argument(
        '--control-artifact',
        type=Path,
        help=(
            'a second artifact of the same population, to pair this one against. Without it the file '
            'carries one mean per repetition and no statement about the mechanism'
        ),
    )
    parser.add_argument(
        '--control-run',
        help=(
            'the workflow run id the control artifact came from. A raw report does not carry its own '
            'run id, and a paired block whose control is `None` is a comparison nobody can re-derive'
        ),
    )
    parser.add_argument(
        '--departs',
        default='',
        metavar='FIELDS',
        help=(
            'comma-separated dispatch inputs this artifact moved away from the registration, so its '
            'evidence may be written; every difference must be named here and every name here must be a '
            'difference. Empty means the artifact claims to be the registration, which is the strict '
            'default'
        ),
    )
    args = parser.parse_args(argv)

    row = row_of(args.row)
    if args.write is not None and not args.run:
        raise SystemExit('--write requires --run: an evidence file must name the run it came from')

    report = json.loads(args.report.read_text())
    refusal = arm_refusal(report, row)
    if refusal is not None:
        raise SystemExit(refusal)

    overall = accuracy(report)
    if args.write is not None:
        if row.unit == 'count' and args.control_artifact is None:
            raise SystemExit(
                f"refusing: {row.id}'s number is `paired.deltaQuestions`, and this invocation passes no "
                '`--control-artifact`. The file would carry the one thing that can be computed without '
                'one -- the level -- under a row that reads the pair, and the criterion would find no '
                'key: the row would read `unrun` with a paid artifact sitting on disk beside it. A count '
                'row cannot be written from one artifact, because its subject is the difference between '
                'two.'
            )
        if overall['questions'] != QUESTIONS or overall['runs'] != REPETITIONS:
            reads = 'paired.deltaQuestions' if row.unit == 'count' else 'overall.accuracy'
            raise SystemExit(
                f"refusing: the run graded {overall['questions']} questions over {overall['runs']} "
                f'repetitions and {row.id} is registered on {QUESTIONS} x {REPETITIONS}. There is no '
                f'screening tier in this file -- the criterion reads `{reads}` with no switch '
                '-- so a smaller run would pass the row on an instrument the threshold was not written '
                'for.'
            )
        baseline = json.loads(args.baseline.read_text(encoding='utf-8'))
        declared = [name.strip() for name in args.departs.split(',') if name.strip()]
        if not declared:
            registration_reading = registration.attestation(report, baseline)
            if not registration_reading['matched']:
                raise SystemExit(registration.refusal(registration_reading, args.baseline))
        else:
            reading = registration.declared_attestation(report, baseline, declared)
            if not reading['accepted']:
                raise SystemExit(registration.declaration_refusal(reading, args.baseline))

    declared = [name.strip() for name in args.departs.split(',') if name.strip()]
    control = json.loads(args.control_artifact.read_text()) if args.control_artifact else None
    result = ledger(report, args.run, declared, row, control, args.control_run)
    if args.write is not None:
        args.write.parent.mkdir(parents=True, exist_ok=True)
        args.write.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2) if args.json else render(result))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
