#!/usr/bin/env python3
"""Divide one arm artifact's prompt tokens into the part a competitor's number also counts, and the rest.

## The defect this file exists for

Every cost claim this repository makes about a competitor is a division, and until round 59 not one of
them named what the two sides counted. The record is unambiguous about where that leads:

| claim                                | our numerator                 | their denominator                | what it says |
| ------------------------------------ | ----------------------------- | -------------------------------- | ------------ |
| "9,201 against Synap's 7,400"        | whole prompt, per question    | `memory` + `source_evidence`     | we are 1.24x dearer |
| "10,105 against Synap's 7,740"       | whole prompt, per **correct**  | content only, per **correct**    | we are 1.31x dearer |
| "9,201 against Contextier's 2,807"   | whole prompt, per question    | retrieved context, per question  | we are 3.28x dearer |

Each row is arithmetic on two numbers, and each is wrong in the same way: **one side counts the
instructions, the session header and the question, and the other does not.** §13.340.3 caught this
once for Synap -- it retracted a 1.64x and published "~1.0x all-in" -- and the defect came back in
round 58 as a 1.31x, which is the version that survives in `MEASURE-COST-LEVER.md` §6 today. A
prose retraction does not hold, because prose has no arithmetic in it to re-run.

So the fix is not a third sentence. It is to make the quantity **a function of two committed
records**, and to run the function in the gate:

- the artifact's own per-question `promptChars` (delivered evidence) and `deliveredPromptChars`
  (the whole prompt), which are recorded for every question of every run and are what
  `question-record.ts` already asserts an ordering on;
- the ledger's cost row for each competitor, which now has to declare `basis` and `statistic`
  before it can be quoted at all.

`--write` records the projection of one artifact into `tools/token-basis.json`, which is small and
reviewable. `--check` re-derives the partition and every ratio from those inputs plus the ledger,
**without the artifact**, so a drifted number fails in `pnpm check` rather than in a review six
months later. A ledger row that changes without the reading being re-recorded fails the same way,
which is the property the previous arrangement lacked.

## The two axes, and why neither substitutes for the other

`basis` is what a token count counts, and there are exactly two values because there are exactly
two questions a buyer asks:

- `context` -- the retrieved evidence alone. This is what a memory system publishes, because it is
  the number that flatters a compression story.
- `prompt` -- everything the reader is handed, evidence plus instructions plus header plus question.

A purchase decision is made on `prompt`, because the instructions and the question are billed. A
retrieval comparison is made on `context`, because that is the only quantity the memory layer
controls. Both are legitimate and they are 2.8% apart on this arm -- which is the finding that
makes the whole argument tractable: the basis error was worth **2.8 points of accuracy-equivalent
cost**, not the 24% the mixed rows implied, because this arm's prompt is 97.2% evidence.

`statistic` is the other dialect: a mean against a median is not a ratio either, and Zep's 4,408 is
a median while this arm's 9,201 is a mean. The tool marks those rows rather than refusing them,
because the comparison is still the best available and a reader who is told which statistic is
looking at a caveat rather than a defect.

## What is not computed

A verdict. The tool prints ratios and caveats; it does not decide whether 3.19x is bad. That
judgement depends on what the extra evidence buys in accuracy, which is a different record
(`MEASURE-COST-LEVER.md` §1 has the pool experiment that says it buys nothing, and the room curve
in §2 that says the bill is the cap), and a tool that folded the two together would produce the
same table whether or not it was right.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
LEDGER = HERE / 'competitor-ledger.json'
READING = HERE / 'token-basis.json'

#: What a token count counts. Two values, because there are two questions.
BASES = ('context', 'prompt')

#: How the per-question figure was reduced. A mean against a median is a caveat, not a ratio.
STATISTICS = ('mean', 'median')

#: The tokenizer the artifact's own count is under: the reader's. A competitor that declares a
#: different one is a caveat on the ratio rather than a defect in it, because the conversion needs
#: a characters-per-token rate the vendor published for its own text and not for ours.
READER_TOKENIZER = 'deepseek'

#: The marker a document uses to quote a number this tool computes, in the convention
#: `tools/docs-crosscheck.mjs` established: `<!-- token-ratio:<id> -->3.19x`.
RATIO_MARKER = re.compile(
    r'<!--\s*token-ratio:([a-z0-9-]+(?:/(?:context|prompt))?(?:@correct)?)\s*-->\s*([0-9.]+x)'
)

#: A document may also quote the token figure itself rather than a ratio.
FIGURE_MARKER = re.compile(r'<!--\s*token-figure:([a-z0-9-]+(?:/(?:context|prompt))?)\s*-->\s*([0-9][0-9,]*)')

#: The two axes a ratio marker can address. `per question` is the cost of the evidence; `@correct`
#: applies the accuracy multiplier to **both** sides, which is the only form in which that number
#: is a ratio at all. They need separate keys because one document may quote both and a single key
#: would make the second quote fail against the first value.
AXES = ('ratio', 'ratioPerCorrect')


class Refused(Exception):
    """A record that cannot answer the question asked of it, with the reason in the message."""


def canonical(payload):
    """The bytes two runs of this tool must agree on, so `--check` can compare them."""
    return json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def _whole(name, value, minimum):
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise Refused(f'{name} is {value!r}, which is not a whole number >= {minimum}')
    return value


def partition(artifact):
    """Split a run's prompt tokens into evidence and everything else.

    The arithmetic is proportional rather than per-question, because the artifact records
    **characters** per question and **tokens** per run: the token count comes from the reader's own
    accounting, which is the only place it exists, and the two are joined by the run's measured
    characters-per-token. That ratio is recorded in the reading rather than assumed, because it is
    what makes the split falsifiable -- a run whose prompts were mostly non-English or mostly
    numbers would have a different one, and a reader comparing this against a competitor's stated
    tokenizer needs to see it.
    """
    questions = artifact.get('questions')
    if not isinstance(questions, list) or not questions:
        raise Refused('the artifact records no questions, so it has no prompt to divide')

    evidence = 0
    whole = 0
    for index, question in enumerate(questions):
        if not isinstance(question, dict):
            raise Refused(f'question {index} is {type(question).__name__}, not a record')
        evidence += _whole(f'question {index} promptChars', question.get('promptChars'), 0)
        delivered = _whole(
            f'question {index} deliveredPromptChars', question.get('deliveredPromptChars'), 1
        )
        if question['promptChars'] > delivered:
            # The invariant `question-record.ts` states and the audit relies on: the delivered
            # evidence is a subset of the prompt, so it cannot be longer than it. A record that
            # breaks it would make the overhead negative and the ratio meaningless, which is the
            # failure mode a tool like this has -- silently reporting a number from a bad record.
            raise Refused(
                f'question {index} delivers {delivered} prompt characters but claims '
                f'{question["promptChars"]} of evidence, which cannot be a subset'
            )
        whole += delivered

    cost = artifact.get('costEfficiency')
    if not isinstance(cost, dict):
        raise Refused('the artifact records no costEfficiency, so it has no token count')
    tokens = cost.get('promptTokensPerQuestion')
    if not isinstance(tokens, (int, float)) or isinstance(tokens, bool) or not tokens > 0:
        raise Refused(f'promptTokensPerQuestion is {tokens!r}, which is not a positive count')

    return derive(
        len(questions),
        evidence / len(questions),
        whole / len(questions),
        float(tokens),
        cost.get('accuracy'),
    )


def derive(questions, mean_evidence, mean_prompt, tokens, accuracy):
    """Every published quantity, from the three numbers the artifact contributes.

    Split out so `--check` can re-run the arithmetic without an artifact, and so the committed
    record round-trips exactly: the share is taken from the **rounded** means, which makes a
    re-derivation from the file identical to the first run rather than identical to six places.
    """
    mean_evidence = round(mean_evidence, 3)
    mean_prompt = round(mean_prompt, 3)
    if mean_prompt <= 0:
        raise Refused('the mean prompt is zero characters, so there is no share to take')
    share = mean_evidence / mean_prompt
    return {
        'questions': questions,
        'meanEvidenceChars': mean_evidence,
        'meanPromptChars': mean_prompt,
        'charsPerToken': round(mean_prompt / tokens, 4),
        'promptTokens': round(tokens, 4),
        'evidenceTokens': round(tokens * share, 4),
        'overheadTokens': round(tokens * (1.0 - share), 4),
        'evidenceShare': round(share, 6),
        'accuracy': accuracy,
    }


def costRows(ledger):
    """Every quotable competitor cost, with the two dialects a ratio needs declared.

    A row without `basis` or `statistic` is refused rather than defaulted, for the reason the
    ledger already refuses a number without a `source`: a default here is a guess about what
    somebody else counted, and the guess would be invisible in every table that followed.
    """
    entries = ledger.get('entries')
    if not isinstance(entries, list) or not entries:
        raise Refused('the ledger records no entries')
    rows = []
    seen = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise Refused(f'ledger entry {index} is not an object')
        costs = entry.get('cost')
        if costs is None:
            continue
        if not isinstance(costs, list) or not costs:
            raise Refused(f'ledger entry {index} carries a cost that is not a non-empty list')
        for one in costs:
            if not isinstance(one, dict):
                raise Refused(f'ledger entry {index} carries a cost that is not an object')
            missing = [key for key in ('id', 'tokens', 'basis', 'statistic', 'source') if key not in one]
            if missing:
                raise Refused(
                    f'ledger entry {index} cost is missing {", ".join(missing)}; a cost quoted '
                    'without its basis is the defect this file exists for'
                )
            identifier = one['id']
            if not isinstance(identifier, str) or not re.fullmatch(r'[a-z0-9-]+', identifier):
                raise Refused(f'ledger entry {index} has id {identifier!r}, which is not a slug')
            if identifier in seen:
                raise Refused(f'the id {identifier!r} is used twice, so a marker cannot address it')
            seen.add(identifier)
            if one['basis'] not in BASES:
                raise Refused(
                    f'{identifier} declares basis {one["basis"]!r}, which is not one of {BASES}'
                )
            if one['statistic'] not in STATISTICS:
                raise Refused(
                    f'{identifier} declares statistic {one["statistic"]!r}, which is not one of '
                    f'{STATISTICS}'
                )
            tokens = one['tokens']
            if not isinstance(tokens, (int, float)) or isinstance(tokens, bool) or not tokens > 0:
                raise Refused(f'{identifier} declares tokens {tokens!r}, which is not positive')
            if not isinstance(one['source'], str) or not one['source'].strip():
                raise Refused(f'{identifier} declares no source')
            rows.append(
                {
                    'id': identifier,
                    'system': entry.get('system'),
                    'score': entry.get('score'),
                    'tokens': float(tokens),
                    'basis': one['basis'],
                    'statistic': one['statistic'],
                    'tokenizer': one.get('tokenizer'),
                    'kind': one.get('kind') or entry.get('kind'),
                    'source': one['source'],
                }
            )
    if not rows:
        raise Refused('the ledger declares no cost at all, so nothing can be compared')
    return rows


def comparison(part, rows):
    """Our figure against each competitor's, on the competitor's own basis and on both axes.

    Two axes per row, because `tokens per correct answer` is not a different basis -- it is the
    accuracy multiplier applied to the same one -- and the mixed pairs in this repository's record
    came from applying it to one side only. A row whose `statistic` differs from this arm's is
    marked rather than dropped: the ratio is the best available and the reader is told which.
    """
    ours = {'context': part['evidenceTokens'], 'prompt': part['promptTokens']}
    accuracy = part.get('accuracy')
    out = []
    for row in rows:
        per_question = ours[row['basis']] / row['tokens']
        entry = {
            'id': row['id'],
            'system': row['system'],
            'basis': row['basis'],
            'statistic': row['statistic'],
            'theirTokens': round(row['tokens'], 3),
            'ourTokens': round(ours[row['basis']], 3),
            'ratio': round(per_question, 4),
            'caveats': [],
        }
        if row['statistic'] != 'mean':
            entry['caveats'].append(
                f'theirs is a {row["statistic"]} and ours is a mean, so the ratio is between '
                'different reductions'
            )
        if not row.get('tokenizer'):
            entry['caveats'].append(
                'no tokenizer is stated, so the count is not reproducible on this side'
            )
        elif row['tokenizer'] != READER_TOKENIZER:
            entry['caveats'].append(
                f'counted under {row["tokenizer"]}, this arm under the reader\'s own'
            )
        if isinstance(row.get('score'), (int, float)) and isinstance(accuracy, (int, float)) and accuracy:
            # The per-correct-answer axis, computed on **one** basis for both sides. This is the
            # only form in which it means anything: the two 1.31x claims in this repository's record
            # divided our all-in count by their content-only one.
            theirs = row['tokens'] / (row['score'] / 100.0)
            ours_per_correct = ours[row['basis']] / accuracy
            entry['theirTokensPerCorrect'] = round(theirs, 3)
            entry['ourTokensPerCorrect'] = round(ours_per_correct, 3)
            entry['ratioPerCorrect'] = round(ours_per_correct / theirs, 4)
        out.append(entry)
    return sorted(out, key=lambda one: (one['basis'], one['id']))


def identityOf(artifact, run=None):
    """What the reading has to remember about the run, so a quotient is reproducible later.

    The configuration fingerprint is here for the reason `MEASURE-CONFIGURATION-IDENTITY.md` gives:
    a cost figure measured on a configuration the arm no longer runs is a record of what that
    configuration cost, and a reading that could not say which one would be quoted as current.
    """
    config = artifact.get('memoryArmConfig')
    config = config if isinstance(config, dict) else {}
    identifier = artifact.get('run') or run
    if identifier is None:
        # The artifact does not carry its own run id -- the workflow knows it and the report does
        # not -- so it is an argument rather than a silently absent field. A reading that could not
        # name the run it came from is a number with no provenance, which is the defect this file
        # is written against one level up.
        raise Refused('--run is required: this artifact does not record the run it came from')
    return {
        'run': identifier,
        'generatedAt': artifact.get('generatedAt'),
        'questionCount': artifact.get('questionCount'),
        'runs': artifact.get('runs'),
        'dataset': artifact.get('dataset'),
        'datasetFingerprint': artifact.get('datasetFingerprint'),
        'configurationFingerprint': config.get('configurationFingerprint')
        or artifact.get('memoryArmConfigFingerprint'),
    }


def reading(identity, part, rows):
    """The committed record: small enough to review, complete enough to re-derive every ratio."""
    return {
        'why': (
            'The projection of one arm artifact onto the two bases a competitor cost can be '
            'compared on. `--check` re-derives the partition and every ratio from these inputs plus '
            'tools/competitor-ledger.json, so a ratio that drifts from its records fails the gate '
            'rather than surviving in prose.'
        ),
        'artifact': identity,
        'partition': part,
        'rows': rows,
    }


def markers(text, pattern):
    return [(match.group(1), match.group(2)) for match in pattern.finditer(text)]


def claimDefects(documents, recorded):
    """A document that quotes a number this tool owns, and quotes a different one than it computes.

    The markers exist because prose cannot be checked. `docs-crosscheck.mjs` established the
    convention for criteria; this is the same convention for costs, and it is here rather than
    there because the numbers are computed here.
    """
    figures = {}
    for row in recorded['rows']:
        figures[f'{row["id"]}/{row["basis"]}'] = row
        figures[row['id']] = row
    ours = {
        'cortex/context': recorded['partition']['evidenceTokens'],
        'cortex/prompt': recorded['partition']['promptTokens'],
    }
    defects = []
    for name, text in documents.items():
        for key, quoted in markers(text, RATIO_MARKER):
            axis = 'ratioPerCorrect' if key.endswith('@correct') else 'ratio'
            target = key[: -len('@correct')] if axis == 'ratioPerCorrect' else key
            if target in ours:
                raise Refused(f'{name} quotes a ratio for {target}, which is this arm rather than a competitor')
            row = figures.get(target)
            if row is None:
                defects.append(f'{name}: token-ratio:{key} names no cost row in the ledger')
                continue
            if axis not in row:
                defects.append(
                    f'{name}: token-ratio:{key} asks for {axis} and the ledger row carries no score'
                )
                continue
            expected = f'{row[axis]:.2f}x'
            if quoted != expected:
                defects.append(f'{name}: token-ratio:{key} says {quoted}, the records say {expected}')
        for key, quoted in markers(text, FIGURE_MARKER):
            expected_value = ours.get(key)
            if expected_value is None:
                row = figures.get(key)
                if row is None:
                    defects.append(f'{name}: token-figure:{key} names no cost row in the ledger')
                    continue
                expected_value = row['theirTokens']
            expected = f'{expected_value:,.0f}'
            if quoted.replace(',', '') != expected.replace(',', ''):
                defects.append(f'{name}: token-figure:{key} says {quoted}, the records say {expected}')
    return defects


def loadLedger(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        raise Refused(f'{path} does not exist') from None
    except json.JSONDecodeError as error:
        raise Refused(f'{path} is not JSON: {error}') from None


def printTable(recorded):
    part = recorded['partition']
    print(
        f"run {recorded['artifact'].get('run')} | {part['questions']} questions x "
        f"{recorded['artifact'].get('runs')} repetitions | accuracy {part.get('accuracy'):.4f}"
    )
    print(
        f"  prompt {part['promptTokens']:,.1f} tokens = evidence {part['evidenceTokens']:,.1f} "
        f"+ overhead {part['overheadTokens']:,.1f}  (evidence share {part['evidenceShare'] * 100:.2f}%)"
    )
    print(
        f"  {part['meanPromptChars']:,.1f} prompt characters at {part['charsPerToken']:.4f} "
        f'characters per token'
    )
    print()
    print(f"{'id':<24}{'basis':<9}{'theirs':>10}{'ours':>10}{'x':>7}   {'per-correct x':>12}  caveats")
    for row in recorded['rows']:
        per_correct = f"{row['ratioPerCorrect']:.2f}x" if 'ratioPerCorrect' in row else '-'
        caveats = '; '.join(row['caveats']) if row['caveats'] else ''
        print(
            f"{row['id']:<24}{row['basis']:<9}{row['theirTokens']:>10,.0f}"
            f"{row['ourTokens']:>10,.0f}{row['ratio']:>6.2f}x   {per_correct:>12}  {caveats}"
        )


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--artifact', type=Path, help='the arm artifact to project')
    parser.add_argument('--run', help='the run id, when the artifact does not record it')
    parser.add_argument('--ledger', type=Path, default=LEDGER)
    parser.add_argument('--write', action='store_true', help='record the reading into tools/token-basis.json')
    parser.add_argument('--check', action='store_true', help='re-derive every ratio and refuse a drift')
    parser.add_argument('--docs', type=Path, nargs='*', default=None, help='documents whose markers to verify')
    args = parser.parse_args(argv)

    try:
        ledger = loadLedger(args.ledger)
        rows = costRows(ledger)
        if args.check:
            recorded = json.loads(READING.read_text(encoding='utf-8'))
            part = partition_from(recorded['partition'])
            recomputed = reading(recorded['artifact'], part, comparison(part, rows))
            if canonical(recomputed) != canonical(recorded):
                for key in sorted(set(recomputed) | set(recorded)):
                    if canonical(recomputed.get(key)) != canonical(recorded.get(key)):
                        print(f'DRIFT  {key}', file=sys.stderr)
                        print(f'  recorded   {canonical(recorded.get(key))}', file=sys.stderr)
                        print(f'  recomputed {canonical(recomputed.get(key))}', file=sys.stderr)
                print('token-basis: the committed reading no longer follows from its records', file=sys.stderr)
                return 1
            documents = {}
            for path in args.docs if args.docs is not None else sorted((REPO / 'docs').glob('*.md')):
                documents[str(path.relative_to(REPO))] = path.read_text(encoding='utf-8')
            defects = claimDefects(documents, recorded)
            for defect in defects:
                print(f'CLAIM  {defect}', file=sys.stderr)
            if defects:
                return 1
            printTable(recorded)
            print()
            print('token-basis: {0} rows re-derived, {1} documents agree'.format(len(recorded['rows']), len(documents)))
            return 0

        if args.artifact is None:
            raise Refused('--write needs --artifact: the reading is a projection of one run')
        artifact = json.loads(args.artifact.read_text(encoding='utf-8'))
        part = partition(artifact)
        recorded = reading(identityOf(artifact, args.run), part, comparison(part, rows))
        if args.write:
            READING.write_text(json.dumps(recorded, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
            print(f'wrote {READING.relative_to(REPO)}')
        printTable(recorded)
        return 0
    except Refused as refusal:
        print(f'REFUSED  {refusal}', file=sys.stderr)
        return 1


def partition_from(recorded):
    """Re-run the arithmetic from the committed primitives, with no artifact in hand.

    The point is that `evidenceTokens` is *derived*, so a hand edit of it -- or a `meanPromptChars`
    that moved while the share did not -- is caught. What cannot be caught here is the artifact
    disagreeing with `meanPromptChars`; that needs the artifact, and it is what `--write` is for.
    """
    return derive(
        _whole('questions', recorded.get('questions'), 1),
        float(recorded['meanEvidenceChars']),
        float(recorded['meanPromptChars']),
        float(recorded['promptTokens']),
        recorded.get('accuracy'),
    )


if __name__ == '__main__':
    sys.exit(main())
