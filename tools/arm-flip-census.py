#!/usr/bin/env python3
"""Report how much of a paired difference is noise, before anyone reads the difference.

    python3 tools/arm-flip-census.py --treatment A.json --control B.json \\
        [--partition 'auditConsultations>0'] [--capability MR] [--relations] [--json]

## The gap this closes

Two runs of the same arm disagree on roughly 3 per cent of questions, and until now every reading in
this campaign compared a treatment against a control with no estimate of that number. It showed up
three times in one dispatch: §13.262 read `MR` at **-15.70** and attributed it to the audit prompt,
§13.263's gates 1 and 3 then read **-0.83** and **-4.17** on the repaired code and called both a
failure, and only when the individual flips were opened did it turn out that **all three** `KU`
losses were questions the audit never consulted (`auditConsultations = 0`) whose answers were
`25:50`, `Friday` and `3 weeks` against a gold of `4 weeks`.

A gate of "no capability may lose 3 points" cannot be evaluated on a capability that has three
discordant pairs, because three discordant pairs is the smallest number that can produce a
significant net at all. This tool prints that number.

## Three readings, and what each one is for

**`flips`** — every question whose verdict differs between the two artifacts, split into `repaired`
(control wrong, treatment right) and `broken` (control right, treatment wrong). The net is their
difference, and the p-value is the exact two-sided binomial on the split, not a normal approximation
(§13.257's reason, carried by `exact_sign_test`).

**`resolution`** — the smallest net, in questions, that the observed discordance could have called
significant. It is computed by scanning the net upwards through the exact test rather than by a
formula, so it is the actual resolution of this data and not an asymptotic claim about it. A `FAIL`
at a net below the resolution is a reading of the noise, whatever the mechanism did.

**`floor`** — the flip rate on the population the mechanism **cannot** have touched, which is the
best available estimate of the arm's own run-to-run disagreement. It is not a control group: the
population is chosen after seeing the treatment record, and selection can correlate with stability.
The tool says so beside the number instead of letting the number speak alone.

## The partition is post hoc, and that is printed

`--partition 'field>0'` splits the shared questions by a record field. For the audit dispatch that
field is `auditConsultations`, which yields the only comparison this campaign has between questions
a mechanism acted on and questions it did not. It is a **post-hoc** split: nothing registered it
before the run. So the risk ratio carries a warning and the interval is Wilson's, which behaves at
the small counts this instrument is usually asked about.

## What it cannot do

It cannot tell a mechanism's effect from a prompt's effect when both moved at once. A flip census is
an accounting of disagreement, not a causal claim; the pairing has to be established elsewhere — for
the audit dispatch it was 22 identical inputs with `cortex_memory_review_pass` the only declared
departure.

## `--relations`: what a flipped answer has to do with its gold, and why that is not a diagnosis

A flip count says two configurations disagreed about a question. It does not say whether the side that
lost produced something unrelated to the gold or something that contains it, and the two need different
work: an answer that contains the gold but was graded wrong is a scoring or verbosity question, while an
answer with no relation to the gold is a reading question. `--relations` classifies the **losing** side of
every flip — treatment's answer when the treatment broke, control's when it repaired — against the
question's gold, into `empty`, `equal`, `numeric`, `answer-in-gold`, `gold-in-answer` and `disjoint`.

Three limits are stated rather than fixed:

- the classifier reads the **gold**, so it cannot be a runtime rule. It is a post-hoc description of a
  pair of artifacts, and it exists to stop a round from narrating a cause it did not measure;
- `equal` should be empty. A graded-wrong record whose answer equals the gold is a scorer defect, and
  printing the count is the cheapest way for that defect to be seen rather than argued about;
- `numeric` is checked before containment because `2` is contained in `2023/05/30` and the containment
  test would otherwise report a date match as a partial success. It is the same boundary rule
  `tr-failure-class.ts` uses.

## `--relations` also prints prompt identity, which is the admissibility of the pair

A paired delta between two artifacts is a reader comparison only if the reader was sent the same bytes.
`promptDigest` answers that directly: `identical`, `differ`, or `missing` per question. The census prints
the three counts beside the delta, because a delta whose identity is 0 of 500 is not a smaller
measurement of the same thing — it is a different experiment wearing the same column headings.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ALPHA = 0.05


def _readout():  # noqa: ANN202 - the module, loaded by path
    """`tools/readout-arm-run.py` as a module, for `exact_sign_test`.

    One exact binomial in the repository. Two implementations of "is this split lopsided" would
    drift, and the drift would land on the decision boundary where the tool is read.
    """
    path = ROOT / 'tools' / 'readout-arm-run.py'
    spec = importlib.util.spec_from_file_location('readout_arm_run', path)
    if spec is None or spec.loader is None:
        raise ImportError(f'cannot load {path}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def wilson(successes: int, total: int, z: float = 1.96) -> tuple[float, float] | None:
    """Wilson's interval, or `None` for an empty population.

    Wald's interval is the usual choice and it is wrong exactly here: at 12 flips in 381 questions
    it is fine, at 0 in 3 it reports a zero-width interval around zero and reads as certainty. Wilson
    stays inside `[0, 1]` and widens when the count is small, which is the regime this tool lives in.
    """
    if total <= 0:
        return None
    p = successes / total
    denominator = 1 + z * z / total
    centre = (p + z * z / (2 * total)) / denominator
    spread = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
    return (max(0.0, centre - spread), min(1.0, centre + spread))


def min_detectable_net(discordant: int, alpha: float = ALPHA) -> int | None:
    """The smallest net the exact test could call significant, given this many discordant pairs.

    Scanned rather than approximated: the exact test is discrete, so the resolution is a step
    function of `discordant`, and the steps are wide enough at these counts (three pairs resolve to
    four questions, thirteen to eight) that a formula would report the wrong side of a decision.
    A net must share the parity of the discordant count, since it is a difference of two counts.
    """
    if discordant <= 0:
        return None
    readout = _readout()
    for net in range(discordant % 2, discordant + 1, 2):
        wins = (discordant + net) // 2
        losses = discordant - wins
        if readout.exact_sign_test(wins, losses) < alpha:
            return net
    return None


def power_net(discordant: int, z_alpha: float = 1.96, z_power: float = 0.84) -> float | None:
    """The net the same test reaches with 80 per cent power, by the normal approximation.

    Deliberately labelled differently from `min_detectable_net`: that one is exact and answers "what
    would this data have been able to call significant at all", this one answers "what would it have
    found with four times in five", and the second is an approximation even though the first is not.
    """
    if discordant <= 0:
        return None
    return (z_alpha + z_power) * math.sqrt(discordant)


def _records(report: dict) -> dict[str, dict]:
    questions = report.get('questions')
    if not isinstance(questions, list):
        return {}
    return {q['questionId']: q for q in questions if isinstance(q, dict) and 'questionId' in q}


def _verdict(record: dict) -> bool | None:
    """`True`/`False` for a graded record, `None` when the record did not grade.

    `None` is a population of its own. A question the control graded and the treatment did not is
    not a flip in either direction, and folding it into "broken" would charge a mechanism for a
    missing measurement — §13.11.2's rule applied to the verdict instead of to a field.
    """
    value = record.get('correct')
    return value if isinstance(value, bool) else None


def compare(treatment: dict, control: dict, ids: list[str]) -> dict:
    """Repaired/broken/net/p over an explicit id list, so every caller shares one definition."""
    ungraded = [i for i in ids if _verdict(treatment[i]) is None or _verdict(control[i]) is None]
    graded = [i for i in ids if i not in set(ungraded)]
    repaired = [i for i in graded if _verdict(treatment[i]) is True and _verdict(control[i]) is False]
    broken = [i for i in graded if _verdict(control[i]) is True and _verdict(treatment[i]) is False]
    discordant = len(repaired) + len(broken)
    return {
        'n': len(ids) - len(ungraded),
        'repaired': len(repaired),
        'broken': len(broken),
        'net': len(repaired) - len(broken),
        'discordant': discordant,
        'p_value': _readout().exact_sign_test(len(repaired), len(broken)),
        'resolution': min_detectable_net(discordant),
        'power_net': power_net(discordant),
        'ungraded': len(ungraded),
        'repaired_ids': sorted(repaired),
        'broken_ids': sorted(broken),
    }


def _capability(record: dict) -> str | None:
    value = record.get('capability')
    return value if isinstance(value, str) and value else None


def parse_partition(expression: str) -> tuple[str, str, object]:
    """`'field>0'` / `'field=0'` / `'field>=1'` into `(field, operator, value)`.

    Three operators and no expression language: the partitions this instrument is asked for are all
    "did the mechanism act on this record", and a general evaluator would invite a split that was not
    registered. A value that parses as an integer becomes one, so the comparison is numeric rather
    than lexicographic (`'10' < '9'` is the kind of silence a string compare hides).
    """
    for operator in ('>=', '<=', '==', '=', '>', '<'):
        if operator in expression:
            field, _, raw = expression.partition(operator)
            field = field.strip()
            raw = raw.strip()
            if not field or not raw:
                break
            try:
                value: object = int(raw)
            except ValueError:
                value = raw
            return field, '=' if operator == '==' else operator, value
    raise ValueError(f'cannot read partition {expression!r}; expected field<op>value')


def _satisfies(record: dict, field: str, operator: str, value: object) -> bool | None:
    """`True`/`False`, or `None` when the record does not carry the field.

    An absent field is not `False`. `auditConsultations` is absent from every artifact produced before
    §13.262's counted columns, and answering "did not act" for those would put the whole pre-mechanism
    population on the untreated side of a comparison about the mechanism.
    """
    if field not in record or record[field] is None:
        return None
    left = record[field]
    if operator == '>':
        return left > value
    if operator == '<':
        return left < value
    if operator == '>=':
        return left >= value
    if operator == '<=':
        return left <= value
    return left == value


def partition(
    treatment: dict, control: dict, ids: list[str], expression: str
) -> dict[str, dict]:
    """Both sides of a field predicate, each read the same way."""
    field, operator, value = parse_partition(expression)
    sides: dict[str, list[str]] = {'acted': [], 'untouched': []}
    missing = 0
    for identifier in ids:
        hit = _satisfies(treatment[identifier], field, operator, value)
        if hit is None:
            missing += 1
            continue
        sides['acted' if hit else 'untouched'].append(identifier)
    read = {name: compare(treatment, control, group) for name, group in sides.items()}
    for name, group in read.items():
        group['flip_rate'] = group['discordant'] / group['n'] if group['n'] else None
        group['flip_interval'] = wilson(group['discordant'], group['n'])
    read['missing_field'] = missing
    read['expression'] = expression
    acted, untouched = read['acted'], read['untouched']
    if acted['flip_rate'] is not None and untouched['flip_rate']:
        read['risk_ratio'] = acted['flip_rate'] / untouched['flip_rate']
    else:
        read['risk_ratio'] = None
    return read


RELATION_CLASSES = (
    'empty',
    'equal',
    'numeric',
    'answer-in-gold',
    'gold-in-answer',
    'disjoint',
)

_WHITESPACE = re.compile(r'\s+')
_NUMBER = re.compile(r'^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$')


def normalise(text: object) -> str:
    """Case-folded, whitespace-collapsed, punctuation-trimmed.

    The trimming is deliberately narrow: a trailing full stop is the one difference between an answer
    and its gold that no reader can be asked to avoid, and it is the difference a `disjoint` verdict
    would otherwise invent.
    """
    if not isinstance(text, str):
        return ''
    return _WHITESPACE.sub(' ', text).strip().strip('.').strip().lower()


def _contains(text: str, part: str) -> bool:
    """Is `part` in `text`, with a digit boundary when `part` is a number.

    The boundary is the whole reason this is not `in`. An answer of `2` is a substring of the date
    `2023/05/30` and of the count `20`, so a plain containment test reports the most common TR answer
    as "contained in the gold" and quietly converts a wrong answer into a partial success. `tr-failure-class.ts`
    carries the same rule for the same reason, and this is its Python half.
    """
    if not part:
        return False
    if _NUMBER.match(part):
        return re.search(r'(?<![\d.])' + re.escape(part) + r'(?![\d.])', text) is not None
    return part in text


def classify_answer(answer: object, gold: object) -> str:
    """Which of {@link RELATION_CLASSES} the answer bears to the gold.

    Order is the definition, not a convenience: `empty` before `equal` (an absent answer is not a
    quote of an absent gold), `numeric` before containment (a number against a number is a
    disagreement about a value, not a partial quote), and containment only with digit boundaries.
    """
    text = normalise(answer)
    target = normalise(gold)
    if not text:
        return 'empty'
    if text == target:
        return 'equal'
    if _NUMBER.match(text) and _NUMBER.match(target):
        return 'numeric'
    if _contains(target, text):
        return 'answer-in-gold'
    if _contains(text, target):
        return 'gold-in-answer'
    return 'disjoint'


def relations(treatment: dict, control: dict, ids: list[str]) -> dict:
    """Classify the losing side of every flip, in both directions.

    A flip whose gold is absent on both sides is counted as `ungoverned` rather than folded into
    `disjoint`: "no relation" and "nothing to have a relation with" are different records, which is
    the rule `evidence-completeness.py` applies to a missing coverage block.
    """
    repaired = [i for i in ids if _verdict(treatment[i]) is True and _verdict(control[i]) is False]
    broken = [i for i in ids if _verdict(control[i]) is True and _verdict(treatment[i]) is False]
    table = {name: {'repaired': 0, 'broken': 0} for name in RELATION_CLASSES}
    ungoverned = {'repaired': 0, 'broken': 0}
    detail = []
    for direction, population, losing in (
        ('repaired', repaired, control),
        ('broken', broken, treatment),
    ):
        for identifier in population:
            gold = treatment[identifier].get('groundTruth')
            if gold is None:
                gold = control[identifier].get('groundTruth')
            if not isinstance(gold, (str, int, float)) or normalise(gold) == '':
                ungoverned[direction] += 1
                continue
            answer = losing[identifier].get('answer')
            name = classify_answer(answer, gold)
            table[name][direction] += 1
            detail.append(
                {
                    'questionId': identifier,
                    'direction': direction,
                    'class': name,
                    'capability': _capability(treatment[identifier]),
                    'answer': answer,
                    'gold': gold,
                }
            )
    return {'classes': table, 'ungoverned': ungoverned, 'detail': detail}


def identity(treatment: dict, control: dict, ids: list[str]) -> dict:
    """How many of the shared questions were sent the same prompt bytes on both sides."""
    identical = 0
    differ = 0
    missing = 0
    for identifier in ids:
        left = treatment[identifier].get('promptDigest')
        right = control[identifier].get('promptDigest')
        if not isinstance(left, str) or not isinstance(right, str):
            missing += 1
        elif left == right:
            identical += 1
        else:
            differ += 1
    return {'identical': identical, 'differ': differ, 'missing': missing, 'n': len(ids)}


def render(summary: dict) -> str:
    lines = [
        'Paired flip census',
        '',
        f'  treatment  {summary["treatment"]["path"]}',
        f'  control    {summary["control"]["path"]}',
        f'  shared     {summary["overall"]["n"]} questions'
        + (
            f' ({summary["overall"]["ungraded"]} ungraded on one side and excluded)'
            if summary['overall']['ungraded']
            else ''
        ),
        '',
    ]
    head = (
        f'{"population":16s} {"n":>5s} {"rep":>5s} {"brk":>5s} {"net":>5s} '
        f'{"p":>8s} {"resolution":>11s} {"power net":>10s}'
    )
    lines.append(head)
    lines.append('-' * len(head))

    def row(name: str, data: dict) -> str:
        resolution = '—' if data['resolution'] is None else f'{data["resolution"]}'
        power = '—' if data['power_net'] is None else f'{data["power_net"]:.1f}'
        return (
            f'{name:16s} {data["n"]:5d} {data["repaired"]:5d} {data["broken"]:5d} '
            f'{data["net"]:+5d} {data["p_value"]:8.4g} {resolution:>11s} {power:>10s}'
        )

    lines.append(row('overall', summary['overall']))
    for capability, data in sorted(summary['capabilities'].items()):
        lines.append(row(capability, data))

    if summary.get('partition'):
        part = summary['partition']
        lines += [
            '',
            f'Partition `{part["expression"]}` — post hoc, not registered before the run',
            '',
            f'{"side":16s} {"n":>5s} {"flips":>6s} {"rate":>7s} {"95% interval":>18s} '
            f'{"net":>5s} {"p":>8s}',
            '-' * 74,
        ]
        for name in ('acted', 'untouched'):
            side = part[name]
            rate = '—' if side['flip_rate'] is None else f'{side["flip_rate"]:.2%}'
            interval = (
                '—'
                if side['flip_interval'] is None
                else f'[{side["flip_interval"][0]:.2%}, {side["flip_interval"][1]:.2%}]'
            )
            lines.append(
                f'{name:16s} {side["n"]:5d} {side["discordant"]:6d} {rate:>7s} '
                f'{interval:>18s} {side["net"]:+5d} {side["p_value"]:8.4g}'
            )
        if part['missing_field']:
            lines.append(
                f'  {part["missing_field"]} questions do not carry the field and are on neither side'
            )
        if part['risk_ratio'] is not None:
            lines += [
                '',
                f'  risk ratio {part["risk_ratio"]:.2f}× — the acted side disagrees more often by '
                'this factor, and the direction of the net is a separate question from its size.',
                '  The untouched side is the arm\'s own disagreement and is the closest thing to a '
                'noise floor this data has.',
                '  It is not a control group: the split was chosen after seeing the treatment.',
            ]

    if summary.get('relations'):
        rel = summary['relations']
        ident = summary['identity']
        lines += [
            '',
            'Losing side of each flip, against its gold — post hoc, and the classifier reads the gold',
            '',
            f'{"class":16s} {"broken":>7s} {"repaired":>9s}',
            '-' * 34,
        ]
        for name in RELATION_CLASSES:
            row_counts = rel['classes'][name]
            if not row_counts['broken'] and not row_counts['repaired']:
                continue
            lines.append(f'{name:16s} {row_counts["broken"]:7d} {row_counts["repaired"]:9d}')
        if rel['ungoverned']['broken'] or rel['ungoverned']['repaired']:
            lines.append(
                f'{"ungoverned":16s} {rel["ungoverned"]["broken"]:7d} '
                f'{rel["ungoverned"]["repaired"]:9d}  (no gold on either side)'
            )
        lines += [
            '',
            f'prompt identity: {ident["identical"]}/{ident["n"]} identical, '
            f'{ident["differ"]} differ, {ident["missing"]} missing',
            '  a paired delta is a reader comparison only on the identical share; a delta whose',
            '  identity is 0 of 500 is a different experiment, not a smaller measurement of this one.',
        ]

    lines += [
        '',
        'Reading',
        '-------',
        f'  resolution is the smallest net the observed discordance could have called significant;',
        f'  a net below it is a reading of the noise, whatever the mechanism did.',
        f'  alpha = {ALPHA:g}, two-sided, exact binomial on the discordant split.',
    ]
    return '\n'.join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--treatment', required=True, help='the artifact under test')
    parser.add_argument('--control', required=True, help='the artifact it is paired against')
    parser.add_argument('--partition', default=None, help="a field predicate, e.g. 'auditConsultations>0'")
    parser.add_argument('--capability', action='append', default=None, help='restrict to these')
    parser.add_argument(
        '--relations',
        action='store_true',
        help='classify the losing side of each flip against its gold, and print prompt identity',
    )
    parser.add_argument('--json', action='store_true', help='the summary as JSON')
    args = parser.parse_args(argv)

    treatment_path = Path(args.treatment)
    control_path = Path(args.control)
    treatment = _records(json.loads(treatment_path.read_text()))
    control = _records(json.loads(control_path.read_text()))
    if not treatment or not control:
        print('FAIL one or both artifacts carry no questions', file=sys.stderr)
        return 1

    shared = [i for i in treatment if i in control]
    if args.capability:
        wanted = set(args.capability)
        shared = [i for i in shared if _capability(treatment[i]) in wanted]
    if not shared:
        print('FAIL the two artifacts share no question', file=sys.stderr)
        return 1

    graded = [i for i in shared if _verdict(treatment[i]) is not None and _verdict(control[i]) is not None]
    summary = {
        'treatment': {'path': str(treatment_path)},
        'control': {'path': str(control_path)},
        'overall': compare(treatment, control, shared),
        'capabilities': {},
        'partition': None,
    }
    for identifier in shared:
        capability = _capability(treatment[identifier]) or '?'
        summary['capabilities'].setdefault(capability, []).append(identifier)
    summary['capabilities'] = {
        capability: compare(treatment, control, ids)
        for capability, ids in summary['capabilities'].items()
    }
    if args.partition:
        summary['partition'] = partition(treatment, control, graded, args.partition)
    if args.relations:
        summary['relations'] = relations(treatment, control, graded)
        summary['identity'] = identity(treatment, control, shared)

    if args.json:
        print(json.dumps(summary, indent=1, sort_keys=True))
    else:
        print(render(summary))
    return 0


if __name__ == '__main__':
    sys.exit(main())
