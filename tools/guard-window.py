#!/usr/bin/env python3
"""Would the degradation guard fire on a reader that is working?

`AUDIT-MODEL-PORTABILITY.md` 8 lists four falsifiers, and the third one is the only one that needs
no new calls: *if a deployment running on an **already measured** reader downgrades often, then
`3 of 20` is calibrated against the wrong scale and the guard is a random configuration generator.*
This tool answers it from artifacts that already exist.

## What it can and cannot read

`DegradationGuard` counts four signals. An artifact records one of them.

| signal | derivable from an artifact | why |
|---|---|---|
| `empty-completion` | **yes** | `rawOutput` is stored per question |
| `parse-failed` | no | the artifact stores the parse *result*, never a judgement that it was wrong |
| `abstention-unrecognised` | no | needs a lexicon, and a lexicon is a guess until someone measures it |
| `deadline-exceeded` | no | the adapter raises it; nothing writes it to a field |

So the honest answer for a published artifact is about **one** signal, and the tool prints the other
three as *not derivable* rather than as zero. A tool that reported "0 of 4 fired" when it could only
see one would be the same defect it is measuring: a count whose denominator is not what it says.

## The counterfactual, which is the interesting half

The one thing that looks like a failure and is stored per question on every run is the **decline**
(`answer === null`). Counting it would make the guard fire often, and the tool computes exactly how
often — because the temptation to treat "the model refused" as "the model is broken" is the mistake
`ABSTAIN_TOKEN` was written to prevent, and a number is the cheapest way to keep it prevented.

Run `41254359622` declines **32 of 500** times and **30 of those 32 are scored correct** — they are
the right answer to a question whose evidence is absent. The other two are declines on questions that
did have an answer, which is the one shape a guard could legitimately notice, and it occurs **twice in
five hundred calls** — about a tenth of the 4.22% rate at which this rule fires on one window in
twenty.

Counting the whole decline rate instead fires **105 of 481 windows (21.83%)** on that reader. A guard
that did that would downgrade a deployment for abstaining properly, and it would do it four times an
hour.

## The calibration the third falsifier actually needs

Inverting the rule gives the failure rate at which a *working* reader starts to trip it. At
`n = 20, k = 3, target = 5%` of windows that is **p ≈ 4.0%**. Compare §13.194.4's measured
same-prompt flip rate of 4.8%: a reader noisier than the one this campaign measured would fire on
more than one window in twenty, which is the regime where the guard stops describing the provider and
starts describing its own threshold.

## Three things the first version of this tool got wrong

**It slid where the guard tumbles.** `DegradationGuard` resets its counter every `GUARD_WINDOW`
calls, so it measures disjoint windows; `window_fires` counted every start position. The per-window
probability is the same, the *share of windows* is not, and the report printed the share. `stride`
now covers both and the guard's own setting is the one named in the output.

**It treated the artifact's call order as a sample of the deployment's.** The benchmark groups
questions by capability, so a window that straddles a boundary mixes two populations. `stratum_fires`
counts only windows that stay inside one label, and the two numbers are printed side by side: on
`run-41203245999` the raw share is **29.73%** and the stratum-local share is **10.15%**, a factor of
2.93 that no threshold change accounts for.

**It published a dispersion factor it had never measured.** The audit said the archive inflated the
firing rate by 1.65x. That number came from a hand-built array with five runs of six; the real
archives do not look like that array. Across the twelve 500-question reports in this campaign the
observed share is **0.76x to 1.15x** of the exchangeable prediction — median 0.81 — so the sign of
the arrangement effect is not fixed and no single correction factor exists. §9.2 of the audit
carries the table; the retraction is recorded there rather than quietly deleted.

That last correction is the reason `beta_binomial_tail` and `intraclass_correlation` are here at
all. The archives measure a **positive** intraclass correlation (+0.10 to +0.27, mean +0.13) and
still fire *less* than exchangeable, because clustering moves the tail in opposite directions on
either side of the trigger: at `p = 0.048` (expected count 0.96, trigger at 3) a dispersion of 0.1
takes the share from 6.85% to 13.27%; at `p = 0.10` (expected count 2.0) the same dispersion takes
it from 32.31% to 30.95%. A guard whose operating point is "well below the trigger" is in the first
regime by construction, which is where the exchangeable number is optimistic by up to 1.9x.

Exit codes: `0` every derivable signal is at or below the target, `1` a signal exceeds it, `2` the
input cannot be read.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from math import comb, exp, lgamma
from typing import Iterable, Sequence


# --------------------------------------------------------------------------- binomial

def binomial_tail(k: int, n: int, p: float) -> float:
    """P(X >= k) for X ~ Binomial(n, p), summed exactly rather than approximated.

    Exact because this number decides whether an operator's deployment changes configuration, and
    the normal approximation is worst exactly here: at `n = 20, p = 0.04` the mean is 0.8, which is
    inside the region where the tail crosses zero and a Gaussian gives a confident answer to a
    question that is about three discrete events.
    """
    if k <= 0:
        return 1.0
    if k > n:
        return 0.0
    if p <= 0.0:
        return 0.0
    if p >= 1.0:
        return 1.0
    total = 0.0
    for i in range(k, n + 1):
        total += comb(n, i) * (p ** i) * ((1.0 - p) ** (n - i))
    return total


def _log_beta(a: float, b: float) -> float:
    return lgamma(a) + lgamma(b) - lgamma(a + b)


def beta_binomial_tail(k: int, n: int, mean: float, rho: float) -> float:
    """P(X >= k) when the per-call rate is itself Beta-distributed with intraclass correlation `rho`.

    `X | p ~ Binomial(n, p)` and `p ~ Beta(a, b)` with `a = mean * s`, `b = (1 - mean) * s`,
    `s = 1 / rho - 1`. The mixture is the standard treatment for clustered binary data, and
    `rho = 1 / (a + b + 1)` is its intraclass correlation.

    Two limits are exact rather than numerical, and both matter:

    - `rho = 0` is the binomial. Delegated instead of approximated, because the log-Beta difference
      loses all its precision as `a + b` grows and the tool would report a dispersion effect where
      there is none.
    - `rho = 1` makes a window either empty or full, so `P(X >= k)` is exactly `mean`. This is also
      the reason the tail is **not monotone** in `rho`: it rises to a maximum at intermediate
      dispersion and then falls back to `mean`, which is below the binomial whenever the trigger sits
      in the tail.

    The non-monotonicity is not a defect to be smoothed over. It is the finding: there is no
    "more clustered means more firing" direction to correct for.
    """
    if not 0.0 <= mean <= 1.0:
        raise ValueError(f"mean must be in [0, 1], got {mean!r}")
    if not 0.0 <= rho <= 1.0:
        raise ValueError(f"rho must be in [0, 1], got {rho!r}")
    if k <= 0:
        return 1.0
    if k > n:
        return 0.0
    if mean <= 0.0:
        return 0.0
    if mean >= 1.0:
        return 1.0
    if rho == 0.0:
        return binomial_tail(k, n, mean)
    if rho >= 1.0:
        return mean
    scale = 1.0 / rho - 1.0
    a, b = mean * scale, (1.0 - mean) * scale
    base = _log_beta(a, b)
    total = 0.0
    for y in range(k, n + 1):
        log_pmf = (
            lgamma(n + 1) - lgamma(y + 1) - lgamma(n - y + 1) + _log_beta(y + a, n - y + b) - base
        )
        total += exp(log_pmf)
    return total


def intraclass_correlation(flags: Sequence[bool], window: int) -> float | None:
    """The one-way random-effects ICC of a binary sequence cut into `window`-sized blocks.

    `(MSB - MSW) / (MSB + (window - 1) * MSW)`, the standard estimator for clustered binary data.
    Returns `None` when the sequence is constant or shorter than two windows: both make the ratio
    `0 / 0`, and `0.0` would be a *claim* of exchangeability that the sequence cannot support.

    Negative values are returned, not clamped. A regular sequence is anti-correlated, the
    beta-binomial cannot represent it, and pretending otherwise would hide the eleven archives that
    fire less than exchangeable.
    """
    if window <= 0:
        raise ValueError(f"window must be positive, got {window!r}")
    if window < 2:
        return None
    blocks = len(flags) // window
    if blocks < 2:
        return None
    means = [sum(1 for flag in flags[i * window : (i + 1) * window] if flag) / window
             for i in range(blocks)]
    grand = sum(means) / blocks
    between = window * sum((p - grand) ** 2 for p in means) / (blocks - 1)
    within = 0.0
    for index, p in enumerate(means):
        start = index * window
        within += sum(((1.0 if flag else 0.0) - p) ** 2 for flag in flags[start : start + window])
    within /= blocks * (window - 1)
    denominator = between + (window - 1) * within
    if denominator == 0.0:
        return None
    return (between - within) / denominator


def rate_for_firing(k: int, n: int, target: float, rho: float = 0.0) -> float:
    """The per-call failure rate at which a window fires with probability `target`.

    Bisection on a monotone function, and the answer is reported to four decimals because it is a
    **threshold** rather than a measurement: quoting it to more places would suggest a precision the
    underlying `target` does not have.

    Monotone in the rate, which is what makes bisection valid, and *not* monotone in `rho`, which is
    why `rho` is a parameter here rather than something to be optimised over later.
    """
    if not 0.0 < target < 1.0:
        raise ValueError(f"target must be in (0, 1), got {target!r}")
    lo, hi = 0.0, 1.0
    for _ in range(200):
        mid = (lo + hi) / 2.0
        if beta_binomial_tail(k, n, mid, rho) < target:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


def ever_fires(rate: float, windows: int, needed: int = 1) -> float:
    """The probability a **latching** alarm has fired within `windows` windows.

    SPC quotes an average run length, `1 / rate`, and that number assumes the process restarts after
    an alarm and goes on producing opportunities. `DegradationGuard` does not: one downgrade is
    permanent and there is no method that undoes it, so the operator experiences the cumulative
    probability, and a rate that looks acceptable per window becomes near-certain over a deployment.

    `needed` is how many **consecutive** firing windows are required before the alarm acts, which is
    `GUARD_PERSISTENCE` in the guard. It matters more than anything else in this module: at 5% per
    window over one 500-question run, a single firing window is enough **72.26%** of the time and two
    consecutive ones **5.58%**.

    Computed by exact run-length enumeration over the states "no run yet, currently j in a row",
    because the closed form stops being one line at `needed > 1` and an approximation here would be
    an approximation of the number that decides whether a deployment changes configuration.
    """
    if not 0.0 <= rate <= 1.0:
        raise ValueError(f"rate must be in [0, 1], got {rate!r}")
    if windows <= 0:
        raise ValueError(f"windows must be positive, got {windows!r}")
    if needed <= 0:
        raise ValueError(f"needed must be positive, got {needed!r}")
    if needed > windows:
        return 0.0
    if rate >= 1.0:
        return 1.0
    # `state[j]` is the probability of having seen no run of `needed` yet and sitting on a run of j.
    state = [1.0] + [0.0] * (needed - 1)
    for _ in range(windows):
        following = [0.0] * needed
        for run, weight in enumerate(state):
            if weight == 0.0:
                continue
            following[0] += weight * (1.0 - rate)
            if run + 1 < needed:
                following[run + 1] += weight * rate
        state = following
    return 1.0 - sum(state)


# --------------------------------------------------------------------------- windows

def window_fires(flags: Sequence[bool], window: int, trigger: int, stride: int = 1) -> int:
    """How many windows contain at least `trigger` true flags.

    Windows start every `stride` positions, so the denominator is `window_count(...)` and two
    overlapping windows that fire count twice -- deliberate, because the question is "how often does
    this rule fire" and a rule that fires at positions 7 and 8 fired twice.

    `stride = 1` slides; `stride = window` tumbles, which is what `DegradationGuard` does with its
    call counter. Both are reported because they answer different questions about the same rule.
    """
    if window <= 0:
        raise ValueError(f"window must be positive, got {window!r}")
    if trigger <= 0:
        raise ValueError(f"trigger must be positive, got {trigger!r}")
    if stride <= 0:
        raise ValueError(f"stride must be positive, got {stride!r}")
    fired = 0
    for start in range(0, len(flags) - window + 1, stride):
        if sum(1 for flag in flags[start : start + window] if flag) >= trigger:
            fired += 1
    return fired


def window_count(calls: int, window: int, stride: int = 1) -> int:
    """The denominator `window_fires` is divided by, or zero when no window fits.

    A trailing partial window is not counted: it would be a window of a different width reported
    under the same heading.
    """
    if window <= 0:
        raise ValueError(f"window must be positive, got {window!r}")
    if stride <= 0:
        raise ValueError(f"stride must be positive, got {stride!r}")
    if calls < window:
        return 0
    return (calls - window) // stride + 1


def stratum_fires(
    flags: Sequence[bool], strata: Sequence[str], window: int, trigger: int, stride: int = 1
) -> tuple[int, int]:
    """(fired, windows) counting only windows whose calls all carry the same stratum label.

    The benchmark orders questions by capability, so the population a window samples changes at every
    boundary. A rate model assumes the calls in a window are exchangeable; a window that spans two
    labels is the one place that assumption is definitely false, so those windows are dropped rather
    than counted as silence.

    Returns `(0, 0)` when no stratum is long enough to hold a window -- and the caller must print
    that as "not measurable", never as "quiet", because nothing was measured.
    """
    if len(flags) != len(strata):
        raise ValueError(
            f"strata must align with flags: {len(strata)} labels for {len(flags)} calls"
        )
    fired = windows = 0
    start = 0
    while start < len(flags):
        end = start + 1
        while end < len(flags) and strata[end] == strata[start]:
            end += 1
        segment = flags[start:end]
        fired += window_fires(segment, window, trigger, stride)
        windows += window_count(len(segment), window, stride)
        start = end
    return fired, windows


# --------------------------------------------------------------------------- artifact

class Artifact:
    """The fields one run's report carries that this question needs.

    Parsed defensively and with named failures, because the alternative — a `.get` chain — turns a
    renamed field into a zero, and a zero is the answer this tool is asked to certify.
    """

    def __init__(self, path: pathlib.Path, raw: dict) -> None:
        self.path = path
        try:
            self.questions: list[dict] = raw["questions"]
            self.reasons: dict = raw["abstentionReasons"]
            self.run_id = str(raw.get("runId") or raw.get("generatedAt") or path.name)
        except (KeyError, TypeError) as error:
            raise SystemExit(
                f"{path}: not a cortex-memory report ({error}). This tool reads the fields the "
                "arm writes; it does not guess at another artifact's shape."
            ) from error
        if not isinstance(self.questions, list) or not self.questions:
            raise SystemExit(f"{path}: `questions` is empty, so there is no call stream to window")

    # -- derivable signals ---------------------------------------------------

    def empty_completion(self) -> list[bool]:
        """One flag per call, in the artifact's own order.

        A completion whose text is empty *or whitespace* counts: `parseAnswer` trims first and
        returns the empty answer, so `"  \\n "` reaches the scorer as a blank — a wrong answer, and
        the same event the guard is meant to notice.
        """
        return [not str(question.get("rawOutput") or "").strip() for question in self.questions]

    def declines(self) -> list[bool]:
        """The counterfactual signal: the reader declined rather than failed."""
        return [question.get("answer") is None for question in self.questions]

    def strata(self) -> list[str] | None:
        """The per-call stratum label, when the artifact carries one, else `None`.

        `capability` is what the benchmark groups by, and grouping is what breaks exchangeability.
        Absent label means the caller gets the unstratified reading only -- not a single stratum,
        which would silently claim the ordering is homogeneous.
        """
        labels = [question.get("capability") for question in self.questions]
        if any(label is None for label in labels):
            return None
        return [str(label) for label in labels]

    def decline_correctness(self) -> tuple[int, int]:
        """(declines that were scored correct, declines). The second number is the first's ceiling."""
        declined = [question for question in self.questions if question.get("answer") is None]
        correct = sum(1 for question in declined if question.get("correct") is True)
        return correct, len(declined)

    def aggregate_calls(self) -> int:
        """Calls the run reports having made, which is `runs * questions` for the arm."""
        return sum(int(value) for value in self.reasons.values())


# --------------------------------------------------------------------------- report

NOT_DERIVABLE = (
    (
        "parse-failed",
        "the artifact stores the parse result, never a judgement that the parse was wrong",
    ),
    (
        "abstention-unrecognised",
        "needs a lexicon, and a lexicon is a guess until someone measures it",
    ),
    (
        "deadline-exceeded",
        "the adapter raises it and no artifact field carries it",
    ),
)


def describe(flags: Sequence[bool], window: int, trigger: int, stride: int = 1) -> str:
    """The count, the rate, and the windows — the three numbers that make the rate checkable."""
    calls = len(flags)
    hits = sum(1 for flag in flags if flag)
    rate = hits / calls if calls else 0.0
    fired = window_fires(flags, window, trigger, stride)
    denominator = window_count(calls, window, stride)
    share = fired / denominator if denominator else 0.0
    return (
        f"{hits:>4} of {calls} calls ({rate * 100:6.3f}%)   "
        f"windows fired {fired:>3} of {denominator} ({share * 100:6.2f}%)"
    )


def _arrangement_note(observed: float, predicted: float) -> str:
    """What the gap between the measured share and the exchangeable prediction means, in one line.

    Three outcomes, not two: the tool says "not measurable" when the prediction is zero, because a
    ratio of `0.00% / 0.00%` would read as agreement and it is not agreement, it is silence.
    """
    if predicted <= 0.0:
        return "arrangement   no exchangeable prediction: this stream has no events to arrange"
    ratio = observed / predicted
    if abs(ratio - 1.0) < 0.02:
        return f"arrangement   observed {observed * 100:.2f}% is {ratio:.2f}x exchangeable — indistinguishable"
    if ratio > 1.0:
        return (
            f"arrangement   observed {observed * 100:.2f}% is {ratio:.2f}x exchangeable — this stream "
            "clusters, so the rate model under-predicts here"
        )
    return (
        f"arrangement   observed {observed * 100:.2f}% is {ratio:.2f}x exchangeable — this stream is "
        "more regular than random, so the rate model over-predicts here"
    )


def render(
    artifact: Artifact,
    window: int,
    trigger: int,
    target: float,
    stride: int = 1,
    persistence: int = 1,
) -> tuple[str, int]:
    lines: list[str] = []
    calls = len(artifact.questions)
    denominator = window_count(calls, window, stride)
    lines.append(f"artifact  {artifact.path}")
    lines.append(
        f"  calls {calls}, aggregate {artifact.aggregate_calls()} (x{artifact.aggregate_calls() // calls}"
        f" repetitions)   window {window}, trigger {trigger}, stride {stride}"
        f" ({'tumbling, as the guard counts' if stride == window else 'sliding'}),"
        f" target {target * 100:.1f}% of windows"
        if calls
        else f"  calls 0   window {window}, trigger {trigger}, stride {stride}"
    )
    if denominator == 0:
        lines.append(
            f"  no window fits: {calls} calls is shorter than the {window}-call window, so the "
            "guard could not have fired and this artifact cannot falsify anything"
        )
        return "\n".join(lines), 2

    exceeded = False
    lines.append("  derivable  1 of 4 guard signals")
    empty = artifact.empty_completion()
    lines.append(f"    empty-completion       {describe(empty, window, trigger, stride)}")
    if window_fires(empty, window, trigger, stride) / denominator > target:
        exceeded = True

    lines.append("  not derivable from this artifact")
    for name, reason in NOT_DERIVABLE:
        lines.append(f"    {name:<22} {reason}")

    declined = artifact.declines()
    correct, total = artifact.decline_correctness()
    lines.append("  counterfactual: counting a decline as a failure")
    lines.append(f"    declined-as-signal     {describe(declined, window, trigger, stride)}")
    lines.append(
        f"    of those {total} declined calls, {correct} were scored **correct** — so a guard that "
        "counted declines would downgrade a deployment for abstaining properly"
    )

    rate = sum(1 for flag in declined if flag) / calls
    fired = window_fires(declined, window, trigger, stride)
    share = fired / denominator
    rho = intraclass_correlation(declined, window)
    if rho is None:
        lines.append("  dispersion  no dispersion to measure (the decline stream is constant)")
    else:
        lines.append(
            f"  dispersion  intraclass correlation {rho:+.4f} over {calls // window} windows of "
            f"{window}"
        )
        for label, damped in (("exchangeable", 0.0), ("at this rho", max(rho, 0.0))):
            predicted = beta_binomial_tail(trigger, window, rate, damped)
            lines.append(
                f"    {label:<12} predicts {predicted * 100:6.2f}% of windows at a rate of "
                f"{rate * 100:.2f}%"
            )
    lines.append(
        "    " + _arrangement_note(share, binomial_tail(trigger, window, rate))
    )

    strata = artifact.strata()
    if strata is not None:
        stratified_fired, stratified_windows = stratum_fires(declined, strata, window, trigger, stride)
        if stratified_windows == 0:
            lines.append(
                "  strata       no stratum is long enough to hold a window, so the population the "
                "guard samples cannot be held fixed and this reading is unavailable"
            )
        else:
            lines.append(
                f"  strata       {stratified_fired} of {stratified_windows} stratum-local windows "
                f"({stratified_fired / stratified_windows * 100:.2f}%) against "
                f"{share * 100:.2f}% unstratified — a factor of "
                f"{(share / (stratified_fired / stratified_windows)) if stratified_fired else 0:.2f}"
            )

    threshold = rate_for_firing(trigger, window, target)
    lines.append(
        f"  calibration  a reader whose per-call failure rate is {threshold * 100:.2f}% fires on "
        f"{target * 100:.1f}% of windows, if its calls are exchangeable"
    )
    if rho is not None and rho > 0.0:
        clustered = rate_for_firing(trigger, window, target, min(rho, 0.999))
        lines.append(
            f"               at the measured rho of {rho:+.4f} the same 5% target is reached at "
            f"{clustered * 100:.2f}%, so the exchangeable figure is "
            f"{threshold / clustered:.2f}x too generous as a tolerance"
        )

    exposures = calls // window
    if exposures >= 1:
        # The guard latches, so the per-window rate is not the number an operator meets.
        clustered_rate = (
            beta_binomial_tail(trigger, window, rate, min(rho, 0.999))
            if rho is not None and rho > 0.0
            else binomial_tail(trigger, window, rate)
        )
        latched = ever_fires(target, exposures)
        persisted = ever_fires(target, exposures, persistence)
        lines.append(
            f"  cumulative   over {exposures} windows ({exposures * window} calls) a working reader "
            f"is downgraded with probability {persisted * 100:.2f}% at the {target * 100:.1f}% "
            f"tolerance, because {persistence} consecutive firing window(s) are required"
        )
        if persistence == 1:
            lines.append(
                "               one window is enough here, so this is the latched figure; requiring "
                "two would divide it by roughly 1 / (1 - (1 - p))"
            )
        else:
            lines.append(
                f"               the same tolerance with one window enough would be {latched * 100:.2f}%"
            )
        if clustered_rate > 0.0:
            lines.append(
                f"               and {ever_fires(clustered_rate, exposures, persistence) * 100:.2f}% at "
                f"this stream's own {clustered_rate * 100:.2f}% per-window rate"
            )

    verdict = (
        "verdict: quiet on the one signal this artifact can express, and the other three are "
        "stated as unreadable rather than as zero"
        if not exceeded
        else "verdict: FIRES above the target on a measured reader, which falsifies the 3-of-20 scale"
    )
    lines.append(verdict)
    return "\n".join(lines), (1 if exceeded else 0)


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Falsifier 3 of the portability audit: does the guard fire on a working reader?",
    )
    parser.add_argument("artifact", nargs="+", help="cortex-memory ablation report(s) to window")
    parser.add_argument("--window", type=int, default=20, help="calls per window (the guard's own)")
    parser.add_argument("--trigger", type=int, default=3, help="signals that downgrade a bucket")
    parser.add_argument(
        "--stride",
        type=int,
        default=1,
        help=(
            "start positions between windows. 1 slides (the smoother reading); set it equal to "
            "--window to tumble, which is what DegradationGuard does when it resets its counter"
        ),
    )
    parser.add_argument(
        "--persistence",
        type=int,
        default=1,
        help=(
            "consecutive firing windows required before the alarm acts. The shipped guard uses 2; "
            "1 reproduces the latched figure the first version of this tool reported"
        ),
    )
    parser.add_argument(
        "--target",
        type=float,
        default=0.05,
        help=(
            "share of windows a working reader may fire on before the scale is wrong. 5%% is one "
            "window in twenty: high enough that a single bad question cannot trip it twice, low "
            "enough that a broken reader cannot stay quiet"
        ),
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.window <= 0 or args.trigger <= 0:
        print("--window and --trigger must be positive", file=sys.stderr)
        return 2
    if args.stride <= 0:
        print("--stride must be positive", file=sys.stderr)
        return 2
    if args.persistence <= 0:
        print("--persistence must be positive", file=sys.stderr)
        return 2
    if not 0.0 < args.target < 1.0:
        print("--target must be in (0, 1)", file=sys.stderr)
        return 2

    worst = 0
    for raw_path in args.artifact:
        path = pathlib.Path(raw_path)
        try:
            raw = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as error:
            print(f"{path}: cannot read ({error})", file=sys.stderr)
            return 2
        text, code = render(
            Artifact(path, raw),
            args.window,
            args.trigger,
            args.target,
            args.stride,
            args.persistence,
        )
        print(text)
        print()
        worst = max(worst, code)
    return worst


if __name__ == "__main__":
    raise SystemExit(main())
