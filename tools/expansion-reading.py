#!/usr/bin/env python3
"""Read the query-expansion dispatch against its control, and say which criteria are readable.

## Why this is a tool and not a paragraph

`docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md` §13.377.4 fixed five criteria before the run:
`E1` the mechanism (MR majority-vote >= 107 of 121), `E2` the bill (<= 8,600 prompt tokens per
question), `E3` the floor (no capability more than 2 questions below the control), `E4` the receipt
(`selfIndex.queries > selfIndex.indexes` on the treatment side, `refused <= 12`) and `E5` the control
side is the control.

Two of those are arithmetic over one artifact and three are comparisons across two, and every one of
them can be **unreadable** rather than failed -- a question that was never judged, a side that reports
no index census, a pair whose question sets differ. The distinction matters more than the verdicts:
`fail` is a reading about the mechanism, `unread` is a reading about the dispatch, and the earlier
attempt at this experiment (`44159514514`) produced only the second kind. A prose summary cannot keep
those apart, and the campaign has already published one number attached to the wrong row because a
reading was taken from an artifact whose population had moved.

## The one estimator this file insists on, and a retraction

The estimator is the **four-repetition mean with an exact sign-flip over per-question count differences**.
That is the campaign's registered accuracy source (`accuracySource: 'repetition-mean'`, asserted in
`acceptance.ts`'s `CATEGORY_ATTEST`) and the instrument `efficiency-frontier.ts` documents at length: a
`series` collapsed to `discordant` "throws away the repetitions -- that is how `MR` read 2 won to 9 lost,
p = 0.0654 on repetition 0 and 16 won to 5 lost, p = 0.0039 on the four-repetition means, the same 121
questions and opposite verdicts."

Until round 145 this file read `questions[].correct` instead, and its docstring justified that in writing:
the field was "the campaign's majority verdict (>= 3 of 4 repetitions)", and the masks were refused because
"a recomputation over them on `S16` returns 101 of 121 where the artifact's own verdicts return 102". Both
statements are false as stated, and the `S18` artifacts are the proof: the field agrees with **repetition
0** on 121 of 121 questions in both arms and with the majority on 117 of 121. The 101-versus-102 gap was
majority-vote against first-repetition all along, and the reading this campaign published as "`MR` +4,
p = 0.2891" was one repetition's delta reported as the campaign's. On the registered estimator it is
**+1.75 questions, 8 won to 5 lost, p = 0.3901**.

The field is still read, because the retraction has to be shown rather than asserted, and `field_identity`
now proves on every artifact which statistic it reproduces instead of a docstring claiming one.

## What it refuses

- a pair whose question sets differ, because a paired comparison over two populations is not one;
- a treatment artifact that does not say `queryExpansion: llm`, because the reading would be about
  the control under the treatment's name -- the defect §13.377.1 found in the first place;
- an `E4` or `E5` verdict computed from a missing census, printed as `unread` and never as a pass.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

# The registered control's own numbers, as the criteria were written against them.
# `S16` = run `44017278305`, the artifact this campaign's 91.25% / 7,448 / 84.30% come from.
CONTROL = {
    'perCapability': {'IE': 137, 'ABS': 30, 'MR': 102, 'TR': 120, 'KU': 67},
    'mr': 102,
    'mrPopulation': 121,
    'promptTokensPerQuestion': 7447.783,
}

# §13.377.4, fixed before the run and not moved after it.
E1_MIN_MR = 107
# `§13.377.9`'s `E1'`: the same question asked of the pair rather than of a remembered number. The absolute
# bar was written against `S16`'s control (102); a pair that measures its own control cannot use that number,
# because the control moves with the code -- `S18`'s control is 99, three lower, on the same 121 questions.
E1_RELATIVE_GAIN = 5
# `§13.377.11`'s `E2'`. The absolute ceiling is a file-level number and a capability-scoped run costs what that
# capability costs; the ratio is the same question at the right scale.
E2_MAX_RATIO = 1.15
E2_MAX_TOKENS = 8600.0
E3_MAX_DROP = 2
E4_MAX_REFUSED = 12


class Unreadable(Exception):
    """The artifact cannot answer the criterion. Not the same as a failure."""


def load(path: Path) -> dict:
    with path.open(encoding='utf-8') as handle:
        return json.load(handle)


def by_question(document: dict) -> dict[str, dict]:
    """Questions keyed by id, refusing a roster with duplicates.

    A duplicated id would make the paired comparison silently take one of the two records, and which
    one is an implementation detail of the last write rather than a property of the run.
    """
    out: dict[str, dict] = {}
    for record in document.get('questions', []):
        key = record.get('questionId')
        if key is None:
            raise Unreadable('a question record carries no `questionId`, so nothing can be paired')
        if key in out:
            raise Unreadable(f'`{key}` appears twice in one artifact, so its verdict is ambiguous')
        out[key] = record
    return out


def paired(control: dict, treatment: dict) -> tuple[list[str], list[str]]:
    """The question ids both sides answered, refusing a pair whose rosters differ."""
    left = by_question(control)
    right = by_question(treatment)
    if set(left) != set(right):
        missing = sorted(set(left) - set(right))[:3]
        extra = sorted(set(right) - set(left))[:3]
        raise Unreadable(
            'the two artifacts did not answer the same questions: missing '
            f'{missing or "none"} on the treatment side, extra {extra or "none"}. A paired comparison '
            'over two populations is not a paired comparison.'
        )
    # The treatment's order, because that is the run whose reading is being taken; the pairing itself is
    # by id, so the order only decides how ties in a listing are printed.
    return list(right), list(left)


def exact_mcnemar(b: int, c: int) -> float:
    """Two-sided exact McNemar over the discordant pairs, `b` and `c`.

    Exact rather than the chi-square approximation for the reason the campaign's `stats.ts` gives: at
    `b + c` in the teens the approximation's error is the same size as the effect being read.
    """
    total = b + c
    if total == 0:
        return 1.0
    tail = sum(math.comb(total, k) for k in range(0, min(b, c) + 1))
    return min(1.0, 2 * tail / (2**total))


SIGN_FLIP_EXACT_LIMIT = 40


def sign_flip_exact(differences: list[int]) -> float:
    """Two-sided exact sign-flip `p` over per-question integer differences.

    Ported from `packages/cortex-eval/src/paired-test.ts` rather than re-derived, because two instruments
    that disagree are worse than one that is slightly conservative: the same limit of forty pairs and the
    same normal tail above it, so this tool and `signFlipExact` return the same number on the same vector.

    The input is the **difference in repetition counts** (`correctA - correctB`, an integer in
    `[-runs, runs]`), not a mean. A common scale factor cancels out of the sign-flip distribution, and the
    integer form keeps the folded weights exact.
    """
    for difference in differences:
        if not isinstance(difference, int):
            raise Unreadable(
                f'sign-flip needs integer per-question differences, got {difference!r}; pass the repetition '
                'count difference, not the mean'
            )
    non_zero = [difference for difference in differences if difference != 0]
    if not non_zero:
        return 1.0
    observed = sum(non_zero)
    if len(non_zero) > SIGN_FLIP_EXACT_LIMIT:
        variance = sum(difference * difference for difference in non_zero)
        if variance == 0:
            return 1.0
        z = abs(observed) / math.sqrt(variance)
        return min(1.0, math.erfc(z / math.sqrt(2)))
    distribution: dict[int, int] = {0: 1}
    for difference in non_zero:
        nxt: dict[int, int] = {}
        for total, weight in distribution.items():
            nxt[total + difference] = nxt.get(total + difference, 0) + weight
            nxt[total - difference] = nxt.get(total - difference, 0) + weight
        distribution = nxt
    limit = abs(observed)
    tail = sum(weight for total, weight in distribution.items() if abs(total) >= limit)
    return min(1.0, tail / (2 ** len(non_zero)))


def correctness_masks(document: dict, side: str) -> list[str] | None:
    """The per-repetition correctness bitstrings for one side, or `None` when the artifact has none.

    `None` is a legitimate shape and not a defect: `report.ts` omits the masks at one repetition, because
    at one repetition they would be a second copy of the per-question verdicts. What is a defect is a mask
    whose length disagrees with the roster — that is a mask from a different run.
    """
    ablation = document.get('ablation') or {}
    masks = ablation.get(f'{side}CorrectByRun')
    if masks is None:
        return None
    if not isinstance(masks, list) or any(not isinstance(mask, str) for mask in masks):
        raise Unreadable(f'`ablation.{side}CorrectByRun` is not a list of bitstrings')
    roster = len(document.get('questions') or [])
    for index, mask in enumerate(masks):
        if len(mask) != roster:
            raise Unreadable(
                f'`ablation.{side}CorrectByRun[{index}]` is {len(mask)} characters against a roster of '
                f'{roster}: a mask that does not cover the roster is a mask from a different run'
            )
    return masks


def field_identity(document: dict, masks: list[str]) -> dict:
    """What `questions[].correct` actually is, proved against the masks rather than assumed.

    This function exists because the tool's own docstring said something false for a whole campaign: it
    described `questions[].correct` as "the campaign's majority verdict (>= 3 of 4 repetitions)" and
    refused the masks as a second estimator. On `S18`'s artifacts the field agrees with **repetition 0**
    on 121 of 121 questions in both arms and with the majority on 117 of 121 -- so it is the first
    repetition, and the reading published as "`MR` +4" was one repetition's delta presented as the
    campaign's.

    The field's meaning is therefore printed next to every reading instead of being trusted: `agreesWith`
    says which statistic reproduces it, and a pair of artifacts where no candidate does is a pair whose
    estimator nobody knows.
    """
    records = document.get('questions') or []
    runs = len(masks)
    roster = len(records)
    total = [sum(1 for mask in masks if mask[index] == '1') for index in range(roster)]
    first = sum(1 for index, record in enumerate(records) if (record.get('correct') is True) == (masks[0][index] == '1'))
    majority = sum(
        1
        for index, record in enumerate(records)
        if (record.get('correct') is True) == (total[index] * 2 > runs)
    )
    any_run = sum(
        1
        for index, record in enumerate(records)
        if (record.get('correct') is True) == (total[index] > 0)
    )
    if runs == 1 or first == roster:
        agrees_with = 'repetition-0'
    elif majority == roster:
        agrees_with = 'majority'
    elif any_run == roster:
        agrees_with = 'any-repetition'
    else:
        agrees_with = 'none'
    return {
        'agreesWith': agrees_with,
        'repetition0': f'{first}/{roster}',
        'majority': f'{majority}/{roster}',
        'anyRepetition': f'{any_run}/{roster}',
        'runs': runs,
    }


def capability_means(document: dict, masks: list[str]) -> dict[str, float]:
    """Correct answers per capability, averaged over repetitions, from the masks.

    The floor criterion is read on the same estimator as the delta. Reading `E1` on four-repetition means
    and `E3` on repetition 0 would let one criterion see a movement the other cannot, and the two are
    reported side by side.
    """
    records = document.get('questions') or []
    runs = len(masks)
    totals: dict[str, int] = {}
    for position, record in enumerate(records):
        capability = record.get('capability')
        totals[capability] = totals.get(capability, 0) + sum(1 for mask in masks if mask[position] == '1')
    return {capability: total / runs for capability, total in totals.items()}


def capability_counts(records: dict[str, dict], ids: list[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    specs = set()
    for key in ids:
        record = records[key]
        capability = record.get('capability')
        if capability is None:
            raise Unreadable(f'`{key}` carries no `capability`, so the floor criterion has no cells')
        specs.add(capability)
        if record.get('correct') is True:
            counts[capability] = counts.get(capability, 0) + 1
    for capability in specs:
        counts.setdefault(capability, 0)
    return counts


def population(records: dict[str, dict], ids: list[str]) -> dict[str, int]:
    sizes: dict[str, int] = {}
    for key in ids:
        capability = records[key]['capability']
        sizes[capability] = sizes.get(capability, 0) + 1
    return sizes


def prompt_identity(control: dict, treatment: dict, ids: list[str], skip: str) -> dict:
    """Which prompts moved outside the route the treatment is confined to.

    `E3` is a leak test before it is a floor test: the expansion is routed by
    `expandMultiSessionQueries`'s own rule, so every non-`MR` prompt must be the control's bytes. A
    digest that moved there is a second mechanism, and a delta in that capability is then not the
    expansion's.
    """
    moved = []
    for key in ids:
        left = control[key]
        right = treatment[key]
        if left.get('capability') == skip:
            continue
        if left.get('promptDigest') != right.get('promptDigest'):
            # Whether the *evidence* moved with the prompt is the question a reader asks next: the same
            # delivered bytes under a different digest is a renderer change, and different bytes is a
            # retrieval change. Recorded per question rather than inferred afterwards, because the two
            # point at different mechanisms and `S17` turned out to be the first case on every one of its
            # fifty moved prompts.
            moved.append(
                {
                    'questionId': key,
                    'capability': left.get('capability'),
                    'route': left.get('route'),
                    'controlChars': left.get('promptChars'),
                    'treatmentChars': right.get('promptChars'),
                    'evidenceSame': (
                        left.get('evidenceChars') == right.get('evidenceChars')
                        and left.get('evidenceTurns') == right.get('evidenceTurns')
                    ),
                }
            )
    routes = {}
    for row in moved:
        routes[str(row.get('route'))] = routes.get(str(row.get('route')), 0) + 1
    return {
        'moved': moved,
        'checked': len(ids) - population(control, ids).get(skip, 0),
        'byRoute': routes,
        'evidenceSame': sum(1 for row in moved if row['evidenceSame']),
    }


def configuration_surfaces(control: dict, treatment: dict) -> dict:
    """Which configuration surfaces one artifact has and the other does not.

    A paired reading assumes two dispatches ran the same code with one flag between them. §13.377.4 fixed the
    *flag table* and never said the two arms had to share a tree, so nothing checked the stronger claim --
    and it is checkable, because `memoryArmConfig` is projected from the code that produced the artifact. A
    key one side renders and the other does not is a feature that landed between the two dispatches.

    This is a diagnostic and not a criterion: `E3`'s verdict is decided by the prompts, which are the
    observation. What this adds is the mechanism, so the next dispatch can be shaped before it is paid for.
    """
    left = control.get('memoryArmConfig') or {}
    right = treatment.get('memoryArmConfig') or {}
    # `queryExpansion` is the declared departure and `queryExpansionCounts` is its own counter; both are
    # expected to be absent on a control that did not expand. Everything else is undeclared by definition.
    expected = {'queryExpansion', 'queryExpansionCounts'}
    surfaces = sorted(key for key in right if key not in left and key not in expected)
    dropped = sorted(key for key in left if key not in right)
    left_index = left.get('selfIndex') or {}
    right_index = right.get('selfIndex') or {}
    census = sorted(key for key in set(left_index) | set(right_index) if (key in left_index) != (key in right_index))
    return {
        'undeclaredOnControl': surfaces,
        'absentOnTreatment': dropped,
        'censusFieldsOneSide': census,
    }


def gold_account(control: dict, treatment: dict) -> dict:
    """What each arm's artifact can say about the ranking that produced its evidence.

    `goldOverlap.carried < total` supports two different claims: a gold turn the ranking **never
    surfaced**, and one it surfaced and the room **cut**. Only the first is a fact about ranking, and
    the two license opposite next increments -- a ranking change versus a wider room.

    Three sources, in order of authority:

    1. `memoryArmConfig.goldAccount` -- written by the arm since round 146, and derived there from
       `buildsProductIndex`, so it cannot disagree with the wiring.
    2. The same derivation applied here, for every artifact written **before** that field existed.
       `self-index` is the signal that builds the ranking inside the product, and it has been the
       registered arm since `S9`, so most of this campaign's artifacts are in that class -- including
       `S18`'s pair, which is why the reading has to reach back rather than forward.
    3. `unrecorded` when the artifact carries neither field, which cannot be read as either claim.

    `source` says which of the three answered, because "the artifact stated this" and "this file
    derived it from the signal" are different warrants for the same word.
    """
    sources = {}
    for label, artifact in (('control', control), ('treatment', treatment)):
        block = artifact.get('memoryArmConfig') or {}
        recorded = block.get('goldAccount')
        if recorded:
            sources[label] = {'value': recorded, 'source': 'recorded'}
            continue
        signal = block.get('relevanceSignal')
        if signal is None:
            sources[label] = {'value': 'unrecorded', 'source': 'absent'}
        elif signal == 'self-index':
            sources[label] = {'value': 'product-unreported', 'source': 'derived'}
        elif signal == 'none':
            sources[label] = {'value': 'none', 'source': 'derived'}
        else:
            sources[label] = {'value': 'ranked', 'source': 'derived'}
    return {
        'control': sources['control']['value'],
        'treatment': sources['treatment']['value'],
        'source': {label: entry['source'] for label, entry in sources.items()},
        'readable': all(entry['value'] == 'ranked' for entry in sources.values()),
    }


def revision_verdict(control: dict, treatment: dict) -> tuple[str, str]:
    """`E0`: whether the two artifacts name the same commit, which every other criterion rests on.

    `S17` was read against `S16` and the pair turned out to be four merged features apart, which is
    the reason its `E3` failed: fifty of 379 non-target prompts moved with identical evidence bytes,
    a renderer change with no retrieval change behind it. No artifact carried the revision that made
    it, so the finding came from the prompts rather than from the pair -- which is reading the
    symptom to infer the cause, and it worked because the symptom was loud.

    `§13.377.9` therefore makes tree equality the precondition and `AblationReport.revision` the
    field that carries it. Three states, and the third is why this returns `unread` rather than
    `fail`: every artifact produced before the field existed has no revision, and calling those
    "different" would rewrite four generations of published deltas while calling them "the same"
    would be the defect this campaign is written against.
    """
    left = control.get('revision') or None
    right = treatment.get('revision') or None
    if not left and not right:
        return 'unread', (
            'neither artifact carries `revision`, so the pair is one flag apart only if the two '
            'dispatches happened to be -- which is what `S17` assumed and what cost it its `E3`'
        )
    if not left or not right:
        missing = 'control' if not left else 'treatment'
        return 'unread', (
            f'the {missing} artifact carries no `revision`; the side that has one says '
            f'`{(left or right).get("sha", "?")[:12]}`'
        )
    if left.get('sha') != right.get('sha'):
        return 'fail', (
            f'control ran `{left.get("sha", "?")[:12]}` and treatment ran '
            f'`{right.get("sha", "?")[:12]}` -- two revisions, so any delta is a difference of '
            'code versions and not of the declared flag'
        )
    run = right.get('runId')
    return 'pass', (
        f'both artifacts name `{left.get("sha", "")[:12]}`'
        + (f' (treatment run {run})' if run else '')
    )


def receipt(treatment: dict) -> dict:
    """The product's own census: how many queries its index issued against how many it built."""
    config = treatment.get('memoryArmConfig') or {}
    index = config.get('selfIndex') or {}
    counts = config.get('queryExpansionCounts')
    queries = index.get('queries')
    indexes = index.get('indexes')
    out = {
        'declared': config.get('queryExpansion'),
        'queries': queries,
        'indexes': indexes,
        'phrases': None if counts is None else counts.get('phrases'),
        'expandedQuestions': None if counts is None else counts.get('questions'),
        # `refused`, not `empty`. The first version of this line read a field name the artifact does not
        # have, so the number came back `None`, `(None or 0) <= 12` held, and `E4`'s refusal clause was never
        # read at all -- a criterion that could not fail. `MemoryArmConfig.queryExpansionCounts` declares
        # `{questions, phrases, refused}` and `report.ts` writes exactly that.
        'refused': None if counts is None else counts.get('refused'),
    }
    return out


def bill(document: dict) -> float:
    efficiency = document.get('costEfficiency') or {}
    value = efficiency.get('promptTokensPerQuestion')
    if value is None:
        raise Unreadable('the artifact carries no `costEfficiency.promptTokensPerQuestion`')
    return float(value)


def repetition_counts(document: dict, masks: list[str], run: int | None = None) -> dict[str, int]:
    """Correct repetitions per question, keyed by id, from the masks joined to the roster by position.

    The join is positional and that is the one assumption here, so it is checked rather than trusted:
    `field_identity` proves that position `i` of mask 0 is the same question as `questions[i]`, by
    reproducing the `correct` field on every question. `run` restricts the count to one repetition, which
    is how the retracted statistic is rebuilt from the same bytes instead of from a remembered number.
    """
    records = document.get('questions') or []
    chosen = masks if run is None else [masks[run]]
    return {
        record['questionId']: sum(1 for mask in chosen if mask[position] == '1')
        for position, record in enumerate(records)
    }


def repetition_reading(control: dict, treatment: dict, mr_ids: list[str]) -> dict:
    """The `MR` delta on the four-repetition mean, with the first repetition kept beside it.

    Three shapes, and the third is why this returns rather than raises:

    - both artifacts carry masks: the mean delta, the paired exact sign-flip `p` over per-question count
      differences, and the same pair recomputed on repetition 0 for the retraction;
    - neither carries masks (one repetition): the per-question verdicts are the reading, and the estimator
      says so;
    - one carries masks and the other does not: `unread`. Two artifacts measured a different number of
      times are a different experiment, and averaging one of them is arithmetic over incomparable things.
    """
    masks_control = correctness_masks(control, 'feature')
    masks_treatment = correctness_masks(treatment, 'feature')
    if (masks_control is None) != (masks_treatment is None):
        side = 'control' if masks_control is None else 'treatment'
        raise Unreadable(
            f'the {side} artifact carries no `ablation.featureCorrectByRun`, so the pair was measured a '
            'different number of times on each side'
        )
    if masks_control is None:
        left = by_question(control)
        right = by_question(treatment)
        won = sum(
            1 for key in mr_ids if right[key].get('correct') is True and left[key].get('correct') is not True
        )
        lost = sum(
            1 for key in mr_ids if left[key].get('correct') is True and right[key].get('correct') is not True
        )
        control_count = sum(1 for key in mr_ids if left[key].get('correct') is True)
        treatment_count = sum(1 for key in mr_ids if right[key].get('correct') is True)
        return {
            'estimator': 'per-question verdict (the artifacts carry no repetition masks)',
            'runs': 1,
            'control': float(control_count),
            'treatment': float(treatment_count),
            'delta': float(treatment_count - control_count),
            'won': won,
            'lost': lost,
            'ties': len(mr_ids) - won - lost,
            'pValue': round(exact_mcnemar(lost, won), 6),
            # Equal to the reading above by construction, and filled rather than `None` so a caller reads
            # one shape: `estimator` is what says the two numbers are the same measurement.
            'firstRepetition': {
                'control': control_count,
                'treatment': treatment_count,
                'delta': treatment_count - control_count,
                'won': won,
                'lost': lost,
                'mcnemarP': round(exact_mcnemar(lost, won), 6),
            },
            'fieldIdentity': {'control': None, 'treatment': None},
        }
    if len(masks_control) != len(masks_treatment):
        raise Unreadable(
            f'the artifacts ran {len(masks_control)} and {len(masks_treatment)} repetitions; a mean over a '
            'different number of repetitions on each side is not the same measurement'
        )
    runs = len(masks_control)
    total_control = repetition_counts(control, masks_control)
    total_treatment = repetition_counts(treatment, masks_treatment)
    first_control = repetition_counts(control, masks_control, run=0)
    first_treatment = repetition_counts(treatment, masks_treatment, run=0)

    differences = [total_treatment[key] - total_control[key] for key in mr_ids]
    first_differences = [first_treatment[key] - first_control[key] for key in mr_ids]
    control_mean = sum(total_control[key] for key in mr_ids) / runs
    treatment_mean = sum(total_treatment[key] for key in mr_ids) / runs
    first_control_count = sum(first_control[key] for key in mr_ids)
    first_treatment_count = sum(first_treatment[key] for key in mr_ids)
    return {
        'estimator': f'{runs}-repetition mean, exact sign-flip over per-question count differences',
        'runs': runs,
        'control': control_mean,
        'treatment': treatment_mean,
        'delta': treatment_mean - control_mean,
        'won': sum(1 for difference in differences if difference > 0),
        'lost': sum(1 for difference in differences if difference < 0),
        'ties': sum(1 for difference in differences if difference == 0),
        'pValue': round(sign_flip_exact(differences), 6),
        'firstRepetition': {
            'control': first_control_count,
            'treatment': first_treatment_count,
            'delta': first_treatment_count - first_control_count,
            'won': sum(1 for difference in first_differences if difference > 0),
            'lost': sum(1 for difference in first_differences if difference < 0),
            'mcnemarP': round(
                exact_mcnemar(
                    sum(1 for difference in first_differences if difference < 0),
                    sum(1 for difference in first_differences if difference > 0),
                ),
                6,
            ),
        },
        'fieldIdentity': {
            'control': field_identity(control, masks_control),
            'treatment': field_identity(treatment, masks_treatment),
        },
    }


def read(control: dict, treatment: dict) -> dict:
    ids, control_ids = paired(control, treatment)
    left = by_question(control)
    right = by_question(treatment)

    declared = (treatment.get('memoryArmConfig') or {}).get('queryExpansion')
    if declared != 'llm':
        raise Unreadable(
            f"the treatment artifact says `queryExpansion: {declared!r}`, so any delta in it is not the "
            'expansion. §13.377.1 is the record of what that costs: a control reading published under '
            "the treatment's name."
        )

    sizes = population(right, ids)
    control_counts = capability_counts(left, control_ids)
    treatment_counts = capability_counts(right, ids)
    if sizes != population(left, control_ids):
        raise Unreadable('the two artifacts have different per-capability populations')

    # Paired on the **four-repetition mean**, which is the campaign's registered accuracy source
    # (`accuracySource: 'repetition-mean'`, asserted in `acceptance.ts`'s `CATEGORY_ATTEST`) and the
    # estimator `efficiency-frontier.ts` documents at length: collapsing a `series` to `discordant`
    # "throws away the repetitions -- that is how `MR` read 2 won to 9 lost, p = 0.0654 on repetition 0 and
    # 16 won to 5 lost, p = 0.0039 on the four-repetition means, the same 121 questions and opposite
    # verdicts."
    #
    # The first-repetition pair is still computed, because it is what the campaign published before this
    # round and a retraction has to show the number it retracts. It is reported as
    # `firstRepetition` and never as the delta.
    first_b = first_c = 0
    first_b_mr = first_c_mr = 0
    for key in ids:
        was = left[key].get('correct') is True
        now = right[key].get('correct') is True
        in_target = right[key].get('capability') == 'MR'
        if was and not now:
            first_b += 1
            first_b_mr += 1 if in_target else 0
        elif now and not was:
            first_c += 1
            first_c_mr += 1 if in_target else 0

    mr_size = sizes.get('MR')
    if mr_size is None or control_counts.get('MR') is None or treatment_counts.get('MR') is None:
        raise Unreadable('the pair has no `MR` cell, which is the population the mechanism targets')

    mr_ids = [key for key in ids if right[key].get('capability') == 'MR']
    repetition = repetition_reading(control, treatment, mr_ids)
    mr_control = repetition['control']
    mr_treatment = repetition['treatment']

    floor = []
    e3_ok = True
    # The floor on the same estimator as the delta, for the reason `capability_means` gives.
    masks_control = correctness_masks(control, 'feature')
    masks_treatment = correctness_masks(treatment, 'feature')
    if masks_control is not None and masks_treatment is not None and len(masks_control) == len(masks_treatment):
        means_control = capability_means(control, masks_control)
        means_treatment = capability_means(treatment, masks_treatment)
        floor_estimator = f'{len(masks_control)}-repetition mean'
    else:
        means_control = {capability: float(count) for capability, count in control_counts.items()}
        means_treatment = {capability: float(count) for capability, count in treatment_counts.items()}
        floor_estimator = 'per-question verdict'
    for capability in sorted(sizes):
        now = means_treatment.get(capability, 0.0)
        was = means_control.get(capability, 0.0)
        delta = now - was
        below = delta < -E3_MAX_DROP
        e3_ok = e3_ok and not below
        floor.append(
            {'capability': capability, 'population': sizes[capability], 'control': was,
             'treatment': now, 'delta': delta, 'belowFloor': below}
        )

    identity = prompt_identity(left, right, ids, skip='MR')
    # A leak and a moved baseline are the same observation until the size is read. The treatment is
    # confined to `MR` by `expandMultiSessionQueries`'s own routing rule, so a handful of moved digests
    # outside it is a leak into another capability; most of them is the two dispatches not sharing a
    # prompt baseline at all, and then the floor deltas are unattributable rather than leaky. The line is
    # at half because the two cases are an order of magnitude apart in practice -- a leak moves the cells
    # a mechanism reached, a drifted table moves every cell.
    drifted = identity['checked'] > 0 and len(identity['moved']) * 2 > identity['checked']
    landed = receipt(treatment)
    treatment_bill = bill(treatment)
    control_bill = bill(control)
    bill_ratio = treatment_bill / control_bill if control_bill else None

    e1 = mr_treatment - mr_control
    e1_pass = mr_treatment >= E1_MIN_MR
    mcnemar_all = exact_mcnemar(first_b, first_c)
    e2_pass = treatment_bill <= E2_MAX_TOKENS
    leak = len(identity['moved'])
    e3_pass = e3_ok and leak == 0
    surfaces = configuration_surfaces(control, treatment)
    e0, e0_detail = revision_verdict(control, treatment)

    if landed['queries'] is None or landed['indexes'] is None:
        e4 = 'unread'
        e5 = 'unread'
        # Both details are written on the unreadable path as well: the renderer prints every criterion,
        # and a branch that leaves one undefined turns "this criterion cannot be read" into
        # `UnboundLocalError` -- the tool failing where it was supposed to report. Found by the tests for
        # the very case it was supposed to handle, not by reading it.
        e4_detail = 'the artifact carries no `selfIndex.queries`/`indexes` pair'
        e5_detail = 'the artifact carries no `selfIndex.queries`/`indexes` pair, on either side'
    else:
        if landed['refused'] is None:
            # The refusal limit is one of `E4`'s two clauses, so a run that never recorded it cannot pass
            # the criterion -- `(None or 0) <= 12` is how a missing field became a satisfied threshold.
            e4 = 'unread'
            e4_detail = (
                f"queries {landed['queries']} vs indexes {landed['indexes']}, but the artifact carries no "
                '`queryExpansionCounts.refused`, so the refusal limit cannot be read'
            )
        else:
            e4 = 'pass' if (landed['queries'] > landed['indexes']
                            and landed['refused'] <= E4_MAX_REFUSED) else 'fail'
            e4_detail = (f"queries {landed['queries']} vs indexes {landed['indexes']}, "
                         f"refused {landed['refused']}")
        # E5 reads the control side. The registered control is a system that builds no product index --
        # `relevanceSignal` is `self-index` on the arm and the paired baseline does not rank with it -- so
        # a control artifact with no census is the registered shape rather than a missing reading, and the
        # criterion is `unread` with that reason stated instead of being scored as a pass.
        control_index = (control.get('memoryArmConfig') or {}).get('selfIndex') or {}
        if control_index.get('queries') is None:
            e5 = 'unread'
            e5_detail = (
                'the control carries a census but no `queries` field' if control_index
                else 'the control side reports no self-index census'
            ) + ', so `queries == indexes` cannot be read. A census field on one side only is also what '
            e5_detail += (
                'a pair of two different code versions looks like: the counter was merged between the two '
                'dispatches, and `S17` read exactly that'
            )
        else:
            e5 = 'pass' if control_index.get('queries') == control_index.get('indexes') else 'fail'
            e5_detail = f"control queries {control_index.get('queries')} vs indexes {control_index.get('indexes')}"

    return {
        'population': sizes,
        'mr': {
            'population': mr_size,
            **repetition,
            'threshold': E1_MIN_MR,
            'controlRate': round(mr_control / mr_size, 4),
            'treatmentRate': round(mr_treatment / mr_size, 4),
            'discordantAll': {'fixed': first_c, 'broken': first_b},
            'mcnemarAllP': round(mcnemar_all, 6),
        },
        'floor': floor,
        'floorEstimator': floor_estimator,
        'goldAccount': gold_account(control, treatment),
        'promptIdentity': identity,
        'configuration': surfaces,
        'bill': {
            'control': round(control_bill, 3),
            'treatment': round(treatment_bill, 3),
            'ceiling': E2_MAX_TOKENS,
            'ratio': round(treatment_bill / control_bill, 4) if control_bill else None,
        },
        'receipt': landed,
        'revision': {
            'control': (control.get('revision') or None),
            'treatment': (treatment.get('revision') or None),
            'comparable': e0 == 'pass',
        },
        'criteria': {
            'E0': {
                'verdict': e0,
                'measured': e0_detail,
                'threshold': 'both artifacts name the same commit',
            },
            'E1': {'verdict': 'pass' if e1_pass else 'fail', 'measured': f'{mr_treatment:.2f} of {mr_size}',
                   'threshold': f'>= {E1_MIN_MR}'},
            'E1\'': {
                'verdict': 'pass' if mr_treatment >= mr_control + E1_RELATIVE_GAIN else 'fail',
                'measured': f'{mr_treatment:.2f} against this pair\'s own control {mr_control:.2f}',
                'threshold': f'>= control + {E1_RELATIVE_GAIN}',
            },
            'E2': {'verdict': 'pass' if e2_pass else 'fail',
                   'measured': f'{treatment_bill:.1f} tokens per question',
                   'threshold': f'<= {E2_MAX_TOKENS:.0f}'},
            'E2\'': {
                'verdict': 'pass' if (bill_ratio is not None and bill_ratio <= E2_MAX_RATIO) else (
                    'unread' if bill_ratio is None else 'fail'),
                'measured': (f'{bill_ratio:.3f}x the control\'s {control_bill:.1f}'
                             if bill_ratio is not None else 'the control carries no bill to divide by'),
                'threshold': f'<= {E2_MAX_RATIO:.2f}x the control',
            },
            'E3': {
                'verdict': 'unread' if drifted else ('pass' if e3_pass else 'fail'),
                'measured': (
                    f'{leak} of {identity["checked"]} non-MR prompts moved '
                    f'({", ".join(f"{name} {count}" for name, count in sorted(identity["byRoute"].items()))}'
                    f'; evidence identical on {identity["evidenceSame"]} of {leak}), '
                    f'{sum(1 for row in floor if row["belowFloor"])} capability(ies) below floor'
                    + (' -- the two dispatches do not share a prompt baseline, so a floor delta is not '
                       'attributable to the expansion' if drifted else '')
                ),
                'threshold': '0 moved, no capability more than 2 below',
            },
            'E4': {'verdict': e4, 'measured': e4_detail,
                   'threshold': f'queries > indexes, refused <= {E4_MAX_REFUSED}'},
            'E5': {'verdict': e5, 'measured': e5_detail, 'threshold': 'control queries == indexes'},
        },
    }


def render(reading: dict) -> str:
    mr = reading['mr']
    first = mr['firstRepetition'] or {}
    bill_row = reading['bill']
    lines = [
        '## Query expansion on the product ranking (S17)',
        '',
        '| | control | treatment | delta |',
        '| --- | ---: | ---: | ---: |',
        f"| `MR`, mean of {mr['runs']} repetition(s) | {mr['control']:.2f} of {mr['population']} "
        f"({mr['controlRate'] * 100:.2f}%) | {mr['treatment']:.2f} of {mr['population']} "
        f"({mr['treatmentRate'] * 100:.2f}%) | **{mr['delta']:+.2f}** |",
        f"| `MR`, repetition 0 only | {first.get('control', '--')} of {mr['population']} | "
        f"{first.get('treatment', '--')} of {mr['population']} | "
        f"{('%+d' % first['delta']) if 'delta' in first else '--'} |",
        f"| prompt tokens per question | {bill_row['control']:.1f} | {bill_row['treatment']:.1f} | "
        f"{bill_row['ratio']:.3f}x |",
        '',
        f"Estimator: {mr['estimator']}.",
    ]
    identity_fields = mr.get('fieldIdentity') or {}
    if identity_fields.get('control') and identity_fields.get('treatment'):
        left = identity_fields['control']
        right = identity_fields['treatment']
        lines.append(
            f"`questions[].correct` reproduces the **{left['agreesWith']}** statistic on the control "
            f"({left['repetition0']} against repetition 0, {left['majority']} against the majority) and the "
            f"**{right['agreesWith']}** on the treatment ({right['repetition0']}, {right['majority']}). "
            'The field is proved against the masks on every artifact rather than assumed: this file called '
            'it the majority for a whole campaign and it was the first repetition.'
        )
    if mr['pValue'] is not None:
        lines.append(
            f"Paired on `MR`: {mr['won']} won, {mr['lost']} lost, {mr['ties']} ties, exact sign-flip "
            f"p = {mr['pValue']:.4f}."
        )
    if first and mr['runs'] > 1:
        lines.append(
            f"The same pair on repetition 0 alone: {first['won']} won, {first['lost']} lost, delta "
            f"{first['delta']:+d}, exact McNemar p = {first['mcnemarP']:.4f}. That was the campaign's "
            'published reading until round 145; it is one repetition, and `efficiency-frontier.ts` records '
            'the same collapse reversing an `MR` verdict.'
        )
    lines.extend([
        f"The same pair over all capabilities, repetition 0: fixed "
        f"{mr['discordantAll']['fixed']}, broken {mr['discordantAll']['broken']}, p = "
        f"{mr['mcnemarAllP']:.4f} -- those flips outside `MR` are `E3`'s observation, not `E1`'s evidence.",
        '',
        f"| capability | population | control | treatment | delta ({reading['floorEstimator']}) |",
        '| --- | ---: | ---: | ---: | ---: |',
    ])
    for row in reading['floor']:
        marker = ' **below floor**' if row['belowFloor'] else ''
        lines.append(
            f"| {row['capability']} | {row['population']} | {row['control']:.2f} | "
            f"{row['treatment']:.2f} | {row['delta']:+.2f}{marker} |"
        )
    identity = reading['promptIdentity']
    lines.append('')
    account = reading['goldAccount']
    derived = 'derived' in account['source'].values()
    if not account['readable']:
        # Printed unconditionally beside the capability table, because that table is where a reader
        # would otherwise turn `carried < total` into the word "retrieval".
        lines.append(
            f"Gold account: **{account['treatment']}** (control {account['control']}) -- the ranking was "
            'built inside the product, so a gold turn the ranking never surfaced and one the room cut '
            'are the same row. `goldOverlap.carried / total` in these artifacts is a delivery count and '
            'not a retrieval verdict'
            + (
                ', and the classification is derived from `relevanceSignal` because these artifacts '
                'predate the field that states it.'
                if derived
                else '.'
            )
        )
    else:
        lines.append(f"Gold account: `{account['treatment']}` -- the pool is on the record.")
    lines.append('')
    lines.append(
        f"Prompt identity outside `MR`: {len(identity['moved'])} of {identity['checked']} digests moved"
        + (
            ' ('
            + ', '.join(f'{name} {count}' for name, count in sorted(identity['byRoute'].items()))
            + f'; evidence bytes identical on {identity["evidenceSame"]} of {len(identity["moved"])}'
            + ')'
            if identity['moved']
            else ''
        )
        + '.'
    )
    for moved in identity['moved'][:5]:
        lines.append(
            f"  - `{moved['questionId']}` ({moved['capability']}): "
            f"{moved['controlChars']} -> {moved['treatmentChars']} chars"
        )
    configuration = reading['configuration']
    lines.append('')
    lines.append(
        'Configuration surfaces the control does not carry: '
        + (', '.join(f'`{name}`' for name in configuration['undeclaredOnControl']) or 'none')
        + '; census fields on one side only: '
        + (', '.join(f'`{name}`' for name in configuration['censusFieldsOneSide']) or 'none')
        + '.'
    )
    lines.append('')
    lines.append('| criterion | verdict | measured | threshold |')
    lines.append('| --- | --- | --- | --- |')
    for name in ('E0', 'E1', "E1'", 'E2', "E2'", 'E3', 'E4', 'E5'):
        row = reading['criteria'][name]
        lines.append(f"| `{name}` | **{row['verdict']}** | {row['measured']} | {row['threshold']} |")
    if reading['criteria']['E0']['verdict'] != 'pass':
        lines.append('')
        lines.append(
            '**The delta above is not attributable to the declared flag.** `E0` is the precondition '
            'every other criterion rests on and it did not pass: two artifacts from two revisions '
            'differ by everything that changed between them, and a delta over that pair is a '
            'difference of code versions.'
        )
    return '\n'.join(lines) + '\n'


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--control', type=Path, required=True)
    parser.add_argument('--treatment', type=Path, required=True)
    parser.add_argument('--json', action='store_true', help='print the reading as JSON')
    parser.add_argument(
        '--check',
        action='store_true',
        help='exit 1 when a criterion is unreadable; a failed criterion is a reading and exits 0',
    )
    parser.add_argument(
        '--selftest',
        action='store_true',
        help="print the control's MR count from `questions[].correct` beside its repetition mean, so the "
             'two statistics are visible at once',
    )
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)

    try:
        control = load(args.control)
        treatment = load(args.treatment)
        if args.selftest:
            # Two numbers rather than one, because one is what this file used to report and the other is
            # what the campaign's registered accuracy source says. A selftest that printed only the field
            # would certify the statistics that is wrong.
            control_ids = list(by_question(control))
            counts = capability_counts(by_question(control), control_ids)
            measured = counts.get('MR')
            masks = correctness_masks(control, 'feature')
            print(f"control `questions[].correct` on MR: {measured} "
                  f"(published {CONTROL['mr']} of {CONTROL['mrPopulation']})")
            if masks is not None:
                means = capability_means(control, masks)
                print(f"control MR repetition mean ({len(masks)} runs): {means.get('MR', 0.0):.2f} of "
                      f"{CONTROL['mrPopulation']}")
                identity = field_identity(control, masks)
                print(f"`questions[].correct` is the {identity['agreesWith']} statistic "
                      f"(repetition 0 {identity['repetition0']}, majority {identity['majority']})")
            if measured != CONTROL['mr']:
                print('selftest FAILED: this artifact is not the control the criteria were written against',
                      file=sys.stderr)
                return 1
        reading = read(control, treatment)
    except (Unreadable, OSError) as error:
        print(f'unreadable: {error}', file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(reading, indent=2, ensure_ascii=False))
    else:
        print(render(reading))

    unreadable = [name for name, row in reading['criteria'].items() if row['verdict'] == 'unread']
    if args.check and unreadable:
        print(f'unreadable criteria: {", ".join(unreadable)}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
