#!/usr/bin/env python3
"""Per-capability accuracy, with the interval and the resolution floor, from one artifact.

## Why this is a tool

Four acceptance rows (`S2`-`S5`) read `evidence/longmemeval/summary.json`, which is four *independent
dispatches* of a configuration that no longer ships. The arm they name has been read since through
`benchmark-cortex-memory.yml`, and its per-capability counts are in every artifact as
`ablation.featureByCapability` -- but a `perCapability` field carries `min / avg / max` across
repetitions, and none of those three is the number a row wants. `avg` is the repetition mean and is the
right one, while `min` and `max` read 3 to 4 questions apart on the same population, and a document that
quotes one of them by hand has already been wrong twice in this repository (`S1` read 83.45% for three
rounds, and a mechanism bar named 65 control-perfect questions where the masks said 62).

So the mean is computed here from the masks, in one place, and the file it writes names the run id it
came from. `--write` refuses without `--run`, which is the same discipline `tools/cost-ledger.py` and
`tools/evidence-budget.py` follow: an evidence file that cannot state its provenance cannot exist.

## Why the interval is exact and not Wilson

`ablation.featureConfidence` is a Wilson score interval, which is a normal approximation. Bowyer,
Aitchison and Ivanova (arXiv:2402.04702) measured what that costs on benchmarks this size: CLT-based
methods "perform very poorly, usually dramatically underestimating uncertainty". The per-capability
denominators here are **72, 121, 127 and 30**, which is squarely in the range where the approximation
is worst -- `ABS` at n=30 is the smallest and reads 100%, where Wilson returns a lower bound that the
exact interval places lower still. So this tool inverts the binomial CDF by bisection instead:
Clopper-Pearson, exact at every n, computed from `math.comb` and therefore with no special functions
and no numerics to get wrong. The cost of exactness is conservatism -- the interval is wider than it
needs to be -- and the direction of that error is the one a gate may make.

## Why a resolution floor beside an interval

An interval says what the mean could be. It does not say what a *difference* would have to be before
this population could see it, and those are different questions. Miller's rule for the smallest
detectable effect of a binary-scored set (`Adding Error Bars to Evals`, arXiv:2411.00640) is

    delta_min = (z_0.975 + z_0.8) * sqrt(p(1-p)/n) = 2.8016 * sqrt(p(1-p)/n)

at 5% significance and 80% power, using the paired variance `p(1-p)` (Wang's rule of thumb). On the
`MR` column at 121 questions and p = 0.839 that is **9.4 points**: a mechanism would have to move
multi-session accuracy by more than 9.4 points before 121 questions could tell it from noise four times
in five. That number is the reason a mechanism whose reachable set is three questions is cancelled
rather than dispatched, and it is the reason the interval and the floor are printed side by side.

Two things the floor is not. It is **not** a paired McNemar floor: `p(1-p)` is the conservative
substitute for the true paired variance, and a real pair with a low disagreement rate resolves less than
this. And it **does not** shrink with the repetition count -- averaging four repetitions divides the
*within-question* variance, which is the prediction noise, while `p(1-p)/n` is the *between-question*
variance and depends on `n` alone. That is the single most expensive misunderstanding available here:
four repetitions per question is 2.8x the sampling cost of one and moves the floor not at all.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from importlib import import_module
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
# The registration gate, shared with the other two writers. `S2`-`S5` read the file this tool writes,
# and §13.336 is the case that proved a provenance check is not a configuration check: `42355323615`
# named its run correctly and described a room map that had stopped shipping.
registration = import_module('registration-attest')

REGISTRATION = Path(__file__).resolve().parent / 'arm-config-baseline.json'


def require_registered(report: dict, baseline: Path = REGISTRATION) -> None:
    """Refuse to write an evidence file from an artifact of a configuration nobody registers."""
    reading = registration.attestation(report, json.loads(baseline.read_text(encoding='utf-8')))
    if not reading['matched']:
        raise SystemExit(registration.refusal(reading, baseline))

# z at 0.975 plus z at 0.80, the two-sided 5% / 80% power constant. Stated rather than recomputed so a
# reader can check the formula against a table without importing anything.
POWER_Z = 2.801585

# LongMemEval-S's five capabilities, in the order the artifacts emit them. The order is fixed here so a
# file written today and a file written next month have the same key order and a diff is a real change.
CAPABILITIES = ('IE', 'MR', 'KU', 'TR', 'ABS')


def _binomial_cdf(k: int, n: int, p: float) -> float:
    """P(X <= k) for X ~ Binomial(n, p), exactly in the summands and by `math.comb` for the weights."""
    if k < 0:
        return 0.0
    if k >= n:
        return 1.0
    if p <= 0.0:
        return 1.0
    if p >= 1.0:
        return 0.0
    total = 0.0
    for i in range(0, k + 1):
        total += math.comb(n, i) * (p**i) * ((1.0 - p) ** (n - i))
    return min(1.0, total)


def _bisect_decreasing(f, target: float, lo: float = 0.0, hi: float = 1.0, steps: int = 200) -> float:
    """Solve f(p) = target where f is non-increasing in p. Clopper-Pearson's upper bound is this shape."""
    for _ in range(steps):
        mid = (lo + hi) / 2.0
        if f(mid) > target:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


def _bisect_increasing(f, target: float, lo: float = 0.0, hi: float = 1.0, steps: int = 200) -> float:
    """Solve f(p) = target where f is non-decreasing in p. Clopper-Pearson's lower bound is this shape."""
    for _ in range(steps):
        mid = (lo + hi) / 2.0
        if f(mid) < target:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


def clopper_pearson(k: float, n: int, level: float = 0.95) -> tuple[float, float]:
    """The exact interval for a binomial proportion, inverted from the CDF at each end.

    `k` is a float because a repetition mean is a mean of integer counts: on `MR` the four repetitions of
    `42355323615` pass 99, 101, 104 and 102 of 121, and the mean is 101.5. An exact interval is defined
    for an integer count, so the caller passes the mean and this function inverts the CDF at that
    non-integer point -- which is the continuous extension of the same inversion and is monotone in `k`,
    so it brackets the interval of every count that averaged to it. Stated because a reader who expects
    an integer will assume a rounding happened somewhere.
    """
    if n <= 0:
        raise ValueError('n must be positive')
    if k < 0 or k > n:
        raise ValueError(f'k={k} outside [0, {n}]')
    alpha = 1.0 - level
    # Both ends solve for the *same* tail mass, which is the whole of Clopper-Pearson and the place a
    # first implementation goes wrong: the lower bound is where P(X >= k) = alpha/2, not where
    # P(X >= k) = 1 - alpha/2. The later target puts the bound on the wrong side of the point estimate,
    # and does it silently -- the interval still brackets something, it is just no longer the interval.
    lower = 0.0 if k <= 0 else _bisect_increasing(lambda p: 1.0 - _binomial_cdf(int(math.floor(k)) - 1, n, p), alpha / 2.0)
    upper = 1.0 if k >= n else _bisect_decreasing(lambda p: _binomial_cdf(int(math.floor(k)), n, p), alpha / 2.0)
    return (max(0.0, lower), min(1.0, upper))


def resolution_points(p: float, n: int, power_z: float = POWER_Z) -> float | None:
    """The smallest true difference this population detects 80% of the time, in points.

    `None` rather than zero at p of exactly 0 or 1. The formula returns 0 there because `p(1-p)` is 0,
    and a zero floor reads as "this population resolves any difference at all", which is the opposite of
    the truth: a ceiling reading carries no information about a difference, and the exact interval on
    30 of 30 is `[88.43, 100]` wide. A row that printed 0.00 would invite exactly that misreading.
    """
    if n <= 0:
        return None
    if p <= 0.0 or p >= 1.0:
        return None
    return 100.0 * power_z * math.sqrt(max(0.0, p * (1.0 - p)) / n)


def masks_of(report: dict) -> tuple[list[str], list[dict]]:
    """The per-repetition masks, validated against the question list they index.

    Every refusal here is a state a hand reading has silently accepted: a mask whose width is not the
    question count would index the wrong question, and a mask that is not made of `0` and `1` would make
    `passes` a count of something else.
    """
    questions = report.get('questions')
    ablation = report.get('ablation')
    if not isinstance(questions, list) or not questions:
        raise ValueError('artifact has no questions[]')
    if not isinstance(ablation, dict):
        raise ValueError('artifact has no ablation block')
    feature = ablation.get('featureCorrectByRun')
    if not isinstance(feature, list) or not feature:
        raise ValueError('artifact has no ablation.featureCorrectByRun')
    base = ablation.get('baselineCorrectByRun')
    if isinstance(base, list) and len(base) != len(feature):
        raise ValueError(f'feature has {len(feature)} repetitions and baseline has {len(base)}')
    for index, row in enumerate(feature):
        if not isinstance(row, str):
            raise ValueError(f'repetition {index} is {type(row).__name__}, not a mask string')
        if len(row) != len(questions):
            raise ValueError(f'repetition {index} covers {len(row)} questions, the question list has {len(questions)}')
        bad = set(row) - {'0', '1'}
        if bad:
            raise ValueError(f'repetition {index} contains {sorted(bad)!r}, which is not a pass/fail mask')
    return feature, questions


def category_rows(report: dict, level: float = 0.95) -> dict:
    """Per capability: the repetition mean, the exact interval, the repetition spread and the floor."""
    feature, questions = masks_of(report)
    runs = len(feature)
    by_cap: dict[str, list[int]] = {}
    for index, question in enumerate(questions):
        capability = question.get('capability')
        if not isinstance(capability, str) or not capability:
            raise ValueError(f'question {index} has no capability')
        by_cap.setdefault(capability, []).append(index)

    rows: dict[str, dict] = {}
    for capability in sorted(by_cap, key=lambda name: (CAPABILITIES.index(name) if name in CAPABILITIES else 99, name)):
        indexes = by_cap[capability]
        n = len(indexes)
        per_run = [sum(1 for i in indexes if feature[r][i] == '1') for r in range(runs)]
        passes = sum(per_run) / runs
        mean = passes / n
        lower, upper = clopper_pearson(passes, n, level)
        # The per-question mean over repetitions, and its variance. This is the only spread here that
        # carries the reader's own nondeterminism: `per_run` moves when the whole arm moves, while
        # `itemVar` moves when one question does, and a mechanism acts on questions.
        item_means = [sum(1 for r in range(runs) if feature[r][i] == '1') / runs for i in indexes]
        item_var = sum((value - mean) ** 2 for value in item_means) / (n - 1) if n > 1 else 0.0
        run_rates = [count / n for count in per_run]
        run_sd = math.sqrt(sum((rate - mean) ** 2 for rate in run_rates) / (runs - 1)) if runs > 1 else 0.0
        rows[capability] = {
            'denominator': n,
            'perRun': per_run,
            'passes': passes,
            'mean': mean,
            'lower': lower,
            'upper': upper,
            'halfWidth': (upper - lower) / 2.0,
            'perRunMin': min(run_rates),
            'perRunMax': max(run_rates),
            'perRunSd': run_sd,
            'repetitionSeOfMean': run_sd / math.sqrt(runs) if runs > 1 else 0.0,
            'itemVariance': item_var,
            'itemSeOfMean': math.sqrt(item_var / n) if n > 0 else 0.0,
            'resolution': resolution_points(mean, n),
        }
    return rows


def pooled_row(report: dict, level: float = 0.95) -> dict:
    """The same reading over all 500 questions, as the denominator the overall row uses."""
    feature, questions = masks_of(report)
    runs = len(feature)
    n = len(questions)
    per_run = [sum(1 for ch in row if ch == '1') for row in feature]
    passes = sum(per_run) / runs
    mean = passes / n
    lower, upper = clopper_pearson(passes, n, level)
    return {
        'denominator': n,
        'perRun': per_run,
        'passes': passes,
        'mean': mean,
        'lower': lower,
        'upper': upper,
        'halfWidth': (upper - lower) / 2.0,
        'resolution': resolution_points(mean, n),
    }


def ledger(report: dict, run: str, level: float = 0.95, arm: str = 'cortex-memory') -> dict:
    """The whole file. `run` is required and is written into it, so the file names its artifact.

    `arm` is the **configuration label**, not the pipeline name. It defaults to the pipeline so a
    hand run does not have to invent one, and the acceptance rows attest it: `S1` attests
    `shipping.arm == 'route-room'`, so a capability file generated from some other configuration is a
    file about a different system, and the rows read `stale` rather than a number. Without that clause
    the four category rows could drift onto a different arm exactly the way they drifted onto
    `summary.json`, and the drift would be invisible because both files are JSON.
    """
    if not run:
        raise ValueError('a ledger cannot be written without the run id it came from')
    rows = category_rows(report, level)
    pooled = pooled_row(report, level)
    return {
        '$comment': (
            'Per-capability accuracy for one dispatch, computed from ablation.featureCorrectByRun by '
            'tools/capability-ledger.py. Every number here is a repetition mean over the masks: '
            'ablation.featureByCapability carries min/avg/max across repetitions and only `avg` is the '
            'repetition mean, while `min` and `max` read 3 to 4 questions apart on the same population. '
            'Intervals are Clopper-Pearson rather than Wilson because the denominators are 72 to 127, '
            'where a normal approximation under-covers. `resolution` is the smallest true difference the '
            'population detects at 80% power and depends on the denominator, not on the repetition count.'
        ),
        'run': run,
        'arm': arm,
        # The configuration, not the label. `arm` is a name the caller supplies on the command line and a
        # name can outlive its meaning -- §13.336 adopted a room map and the `route-room` label went on
        # resolving to the map it replaced, which is how `S2`-`S5` came to read a configuration that had
        # stopped shipping. This is compared against the registration record by `acceptance.ts`.
        'configurationFingerprint': registration.fingerprint(report.get('memoryArmConfig')),
        'benchmark': 'LongMemEval-S',
        'accuracySource': 'repetition-mean',
        'runs': len(report['ablation']['featureCorrectByRun']),
        'questionCount': len(report['questions']),
        'interval': {
            'method': 'clopper-pearson',
            'level': level,
            'note': 'exact at every n; wider than Wilson on purpose',
        },
        'resolution': {
            'form': '2.8016 * sqrt(p(1-p)/n), 80% power at 5% significance',
            'source': 'arXiv:2411.00640',
            'units': 'points',
            'note': (
                'a conservative substitute for the paired floor: p(1-p) is Wang\'s rule of thumb for the '
                'paired variance, so a real pair with a low disagreement rate resolves less than this, and '
                'no number here shrinks with the repetition count'
            ),
        },
        'pooled': pooled,
        'categories': rows,
        'grouping': (
            'these are the local regrouping, 150 / 121 / 72 / 127 / 30, not the published 150 / 133 / 78 / '
            '133 / 30; a category percentage here is not comparable with one quoted from a paper that used '
            'the published grouping'
        ),
    }


def render(human: dict, as_json: bool) -> str:
    if as_json:
        return json.dumps(human, indent=2, sort_keys=False) + '\n'
    lines = [
        f"run {human['run']}  {human['questionCount']} questions x {human['runs']} repetitions  "
        f"({human['accuracySource']})",
        '',
        f"{'cap':<5}{'n':>5}{'mean':>8}{'exact 95%':>17}{'half':>7}{'spread':>8}{'floor':>8}",
    ]
    for capability, row in list(human['categories'].items()) + [('all', human['pooled'])]:
        interval = f"[{100 * row['lower']:.2f}, {100 * row['upper']:.2f}]"
        spread = '' if 'perRunMin' not in row else f"{100 * (row['perRunMax'] - row['perRunMin']):.2f}"
        lines.append(
            f"{capability:<5}{row['denominator']:>5}{100 * row['mean']:>7.2f}%{interval:>17}"
            f"{100 * row['halfWidth']:>7.2f}{spread:>8}{'-' if row['resolution'] is None else format(row['resolution'], '.2f'):>8}"
        )
    lines += [
        '',
        'exact    Clopper-Pearson 95% interval, in percent',
        'half     its half-width, in points',
        'spread   max minus min across the repetitions, in points',
        'floor    smallest true difference this denominator detects at 80% power, in points',
    ]
    return '\n'.join(lines) + '\n'


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description='Per-capability accuracy, interval and resolution floor.')
    parser.add_argument('artifact', help='a benchmark-cortex-memory-ablation-report.json')
    parser.add_argument('--run', help='the workflow run id the artifact came from; required with --write')
    parser.add_argument('--level', type=float, default=0.95, help='interval level, default 0.95')
    parser.add_argument(
        '--arm',
        default='cortex-memory',
        help="the configuration label this artifact ran, e.g. route-room; attested by S2-S5",
    )
    parser.add_argument('--json', action='store_true', help='print the file rather than the table')
    parser.add_argument('--write', help='write the JSON file here rather than printing it')
    parser.add_argument('--baseline', default=str(REGISTRATION), help='the registration record')
    options = parser.parse_args(argv)

    # Before the artifact is read, not after: the refusal a caller meets should be the one about the
    # missing run id, so that a malformed artifact cannot mask a missing provenance.
    if options.write and not options.run:
        print('--write requires --run: an evidence file that cannot name its run cannot exist', file=sys.stderr)
        return 2

    try:
        report = json.loads(Path(options.artifact).read_text(encoding='utf-8'))
    except OSError as error:
        print(f'cannot read {options.artifact}: {error}', file=sys.stderr)
        return 2
    if options.write:
        require_registered(report, Path(options.baseline))
    try:
        built = ledger(report, options.run or '', options.level, options.arm)
    except ValueError as error:
        print(f'{options.artifact}: {error}', file=sys.stderr)
        return 2

    if options.write:
        Path(options.write).write_text(json.dumps(built, indent=2) + '\n', encoding='utf-8')
        print(f'wrote {options.write} from run {options.run}')
        return 0

    sys.stdout.write(render(built, options.json))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
