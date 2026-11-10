"""The spend a dispatch will incur, computed before it is dispatched.

Every other cost instrument in this repository divides an artifact that already exists, which is
the right instrument for a ledger row and useless for the decision that spends the money. The
archived total this tool was written against is 14.26 CNY for one full pass of the cortex-memory
A/B, and the configuration that answers most questions about a change -- 200 questions, 2
repetitions -- is 2.85 CNY of the same measurement. Nothing in the dispatch path said either number
while the inputs were still editable.

So these tests pin the projection, and pin the four ways a plausible implementation would print a
number that means something else:

  - **a projection is not a model.** The arithmetic is `observed x (questions/N) x (runs/R)` and
    nothing else; a test that let a per-turn heuristic in would be testing a second opinion.
  - **cached input is not uncached input.** They differ by 10x and `42467` hits the prefix cache on
    96% of its input. Reporting one input price would either hide the cache or hide its absence.
  - **a sample is not a subsample when the shares move.** Per-question cost is route-scoped, so a
    sample that drops multi-session costs less per question than the run it is scaled from, and the
    refusal must fire rather than be absorbed into the total.
  - **a changed thinking reach is not a cheaper run.** Reasoning tokens are a property of the
    questions asked. The completion line is therefore not re-priced, and the total is labelled a
    lower bound instead of being presented as the cost of the new reach.
"""

import json
import pathlib
import subprocess

import pytest

TOOL = pathlib.Path(__file__).resolve().parents[1] / "spend-projection.mjs"
REPO = pathlib.Path(__file__).resolve().parents[2]


def _run_js(body: str) -> subprocess.CompletedProcess:
    script = f"import * as mod from {json.dumps(TOOL.as_uri())};\n{body}"
    return subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
    )


def _call(body: str) -> object:
    result = _run_js(f"const out = ({body});\nprocess.stdout.write(JSON.stringify(out));")
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def _call_error(body: str) -> subprocess.CompletedProcess:
    return _run_js(f"const out = ({body});\nprocess.stdout.write(JSON.stringify(out));")


def _cli(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["node", str(TOOL), *args], capture_output=True, text=True)


# One observed run small enough to price by hand: 1M prompt of which 800K cached, 100K output, over
# 100 questions x 2 runs. 0.8 x 0.2 + 0.2 x 2 + 0.1 x 3 = 0.86 CNY.
OBSERVED = {
    "promptTokens": 1_000_000,
    "cacheHitPromptTokens": 800_000,
    "completionTokens": 100_000,
}
OBSERVED_QUESTIONS = 100
OBSERVED_RUNS = 2
OBSERVED_LITERAL = json.dumps(OBSERVED)

OBSERVED_CENSUS = {"IE": 150, "MR": 121, "TR": 127, "KU": 72, "ABS": 30}


def _project(limit: int, runs: int, **extra) -> str:
    """A `mod.project(...)` call over the fixture, with `extra` passed through as JS literals."""
    parts = [
        f"observed: {OBSERVED_LITERAL}",
        f"observedQuestions: {OBSERVED_QUESTIONS}",
        f"observedRuns: {OBSERVED_RUNS}",
        f"limit: {limit}",
        f"runs: {runs}",
    ]
    for key, value in extra.items():
        parts.append(f"{key}: {json.dumps(value) if not isinstance(value, str) else json.dumps(value)}")
    return "mod.project({" + ", ".join(parts) + "})"


class TestPriceUsage:
    def test_cached_and_uncached_input_are_priced_apart(self):
        # Same token count, different cache outcome, 10x apart on the input line only.
        cold = _call("mod.priceUsage({promptTokens: 1000000, cacheHitPromptTokens: 0, completionTokens: 0})")
        hot = _call(
            "mod.priceUsage({promptTokens: 1000000, cacheHitPromptTokens: 1000000, completionTokens: 0})"
        )
        assert cold["total"] == 2.0
        assert hot["total"] == 0.2
        assert cold["output"] == 0.0

    def test_output_is_priced_at_its_own_rate(self):
        priced = _call(
            "mod.priceUsage({promptTokens: 0, cacheHitPromptTokens: 0, completionTokens: 1000000})"
        )
        assert priced["output"] == 3.0
        assert priced["total"] == 3.0

    def test_a_cache_hit_larger_than_its_prompt_is_refused(self):
        # A provider that reported this would be crediting a discount that was not earned, and
        # pricing it would print a bill below the one that could have happened.
        result = _call_error(
            "mod.priceUsage({promptTokens: 10, cacheHitPromptTokens: 11, completionTokens: 0})"
        )
        assert result.returncode != 0
        assert "exceeds promptTokens" in result.stderr

    def test_a_boolean_is_not_a_token_count(self):
        # JavaScript would coerce `true` to 1 in the multiplication without complaint.
        result = _call_error(
            "mod.priceUsage({promptTokens: true, cacheHitPromptTokens: 0, completionTokens: 0})"
        )
        assert result.returncode != 0
        assert "non-negative integer" in result.stderr

    def test_a_fractional_token_count_is_refused(self):
        result = _call_error(
            "mod.priceUsage({promptTokens: 1.5, cacheHitPromptTokens: 0, completionTokens: 0})"
        )
        assert result.returncode != 0


class TestProject:
    def test_identity_projection_reproduces_the_observed_bill(self):
        projection = _call(_project(OBSERVED_QUESTIONS, OBSERVED_RUNS))
        assert projection["scaled"] is True
        assert projection["factor"] == 1
        assert projection["cost"]["total"] == pytest.approx(0.86)

    def test_the_question_axis_and_the_repetition_axis_both_scale(self):
        # 50 of 100 questions at 1 of 2 runs is a quarter of the measurement.
        projection = _call(_project(50, 1))
        assert projection["factor"] == 0.25
        assert projection["usage"]["promptTokens"] == 250_000
        assert projection["usage"]["cacheHitPromptTokens"] == 200_000
        assert projection["usage"]["completionTokens"] == 25_000
        # 0.2 x 0.2 + 0.05 x 2 + 0.025 x 3
        assert projection["cost"]["total"] == pytest.approx(0.215)

    def test_per_question_per_run_is_one_of_the_projections_own_divisions(self):
        projection = _call(_project(OBSERVED_QUESTIONS, OBSERVED_RUNS))
        assert projection["perQuestionPerRun"]["total"] == pytest.approx(0.86 / 200)

    def test_a_zero_run_count_is_refused_rather_than_divided_by(self):
        projection = _call(_project(10, 0))
        assert projection["scaled"] is False
        assert "zero" in projection["reason"]

    def test_a_sample_that_moves_the_capability_shares_is_not_projected(self):
        # Removing multi-session is the case that matters: it is where thinking is enabled, so a
        # sample without it is cheaper per question than the run it would be scaled from.
        projection = _call(
            _project(
                100,
                1,
                observedCensus=OBSERVED_CENSUS,
                census={"IE": 300, "MR": 0, "TR": 127, "KU": 72, "ABS": 30},
            )
        )
        assert projection["scaled"] is False
        assert "MR" in projection["reason"]

    def test_a_sample_that_keeps_the_shares_is_projected(self):
        projection = _call(
            _project(
                200,
                1,
                observedCensus=OBSERVED_CENSUS,
                census={"IE": 60, "MR": 48, "TR": 51, "KU": 29, "ABS": 12},
            )
        )
        assert projection["scaled"] is True

    def test_a_changed_thinking_reach_does_not_repricethe_completion_line(self):
        # The saving from disabling thinking is real and is not this tool's to compute: the
        # reasoning tokens are a property of the questions that were asked.
        same = _call(
            _project(
                OBSERVED_QUESTIONS,
                OBSERVED_RUNS,
                observedThinkingReach="multi-session+temporal",
                thinkingReach="multi-session+temporal",
            )
        )
        changed = _call(
            _project(
                OBSERVED_QUESTIONS,
                OBSERVED_RUNS,
                observedThinkingReach="multi-session+temporal",
                thinkingReach="temporal",
            )
        )
        assert same["thinkingReachChanged"] is False
        assert changed["thinkingReachChanged"] is True
        assert changed["lowerBound"] is True
        assert changed["cost"]["total"] == pytest.approx(same["cost"]["total"])


class TestCli:
    def test_no_arguments_prints_usage_and_exits_two(self):
        result = _cli()
        assert result.returncode == 2
        assert "usage:" in result.stderr

    def test_a_budget_breach_exits_nonzero_and_says_so(self, tmp_path):
        report = tmp_path / "report.json"
        report.write_text(
            json.dumps(
                {
                    "questionCount": OBSERVED_QUESTIONS,
                    "runs": OBSERVED_RUNS,
                    "llmUsage": OBSERVED,
                    "ablation": {"questionsByCapability": {"IE": 60, "MR": 40}},
                    "memoryArmConfig": {"reader": {"thinkingRoutes": ["multi-session", "temporal"]}},
                }
            )
        )
        result = _cli("--report", str(report), "--limit", "100", "--runs", "2", "--budget", "0.5")
        assert result.returncode == 1
        assert "BUDGET EXCEEDED" in result.stderr

    def test_a_report_without_a_billed_block_is_refused_not_defaulted(self, tmp_path):
        report = tmp_path / "report.json"
        report.write_text(json.dumps({"questionCount": 10, "runs": 1}))
        result = _cli("--report", str(report), "--limit", "10", "--runs", "1")
        assert result.returncode == 1
        assert "needs a run that was billed" in result.stderr


class TestShippedArtifact:
    """One reading of the archived run, so the tool is not only ever tested on a fixture."""

    def test_the_archived_full_pass_is_the_number_the_ledger_states(self):
        archived = REPO / "tools" / "__tests__" / "fixtures" / "spend-projection-42467.json"
        if not archived.exists():
            pytest.skip("archived usage fixture is not present")
        result = _cli("--report", str(archived), "--limit", "500", "--runs", "4")
        assert result.returncode == 0, result.stderr
        assert "14.2" in result.stdout

    def test_the_screening_configuration_is_one_fifth_of_it(self):
        archived = REPO / "tools" / "__tests__" / "fixtures" / "spend-projection-42467.json"
        if not archived.exists():
            pytest.skip("archived usage fixture is not present")
        result = _cli("--report", str(archived), "--limit", "200", "--runs", "2")
        assert result.returncode == 0, result.stderr
        assert "2.85" in result.stdout


class TestCapabilityScopedRuns:
    """§13.345's population selector, on the pricing side.

    A capability-scoped dispatch is a fifth of a pass, so the gate has to price it as one. Without
    this the budget default of 3.00 CNY refuses every capability run -- a gate that fires on the
    cheap configuration while letting the expensive one through is worse than no gate.
    """

    BASELINE = REPO / "tools" / "spend-baseline.json"

    def _run(self, *args):
        if not self.BASELINE.exists():
            pytest.skip("the spend baseline is not present")
        return _cli("--report", str(self.BASELINE), "--runs", "1", *args)

    def test_one_capability_is_priced_from_the_census_not_from_the_file(self):
        # `MR` is 121 of 500 questions, so the factor is 0.242 of a one-repetition pass and the total
        # has to land under a fifth of it -- if the tool priced the file, this would read ~3.57.
        result = self._run("--limit", "0", "--capability", "MR")
        assert result.returncode == 0, result.stderr
        assert "capability MR" in result.stdout
        assert "0.8" in result.stdout
        assert "3.5" not in result.stdout

    def test_the_whole_file_is_either_zero_or_its_own_size(self):
        # Two spellings of one state: the workflow says `limit=0` and the tool's default is the file's
        # size. A capability projection must read the same for both or two callers price one run twice.
        zero = self._run("--limit", "0", "--capability", "MR")
        filesize = self._run("--limit", "500", "--capability", "MR")
        assert zero.returncode == 0 and filesize.returncode == 0
        assert zero.stdout.splitlines()[0] == filesize.stdout.splitlines()[0]

    def test_a_sample_plus_a_capability_is_refused(self):
        # The sampler round-robins over seven buckets, so `limit=200` then `MR` yields whatever the
        # first two hundred questions happened to contain. A number there would be a guess dressed as
        # a measurement, which §22.68's rule two forbids.
        result = self._run("--limit", "200", "--capability", "MR")
        assert result.returncode == 1
        assert "not projectable" in result.stdout

    def test_an_unknown_capability_names_the_census(self):
        result = self._run("--limit", "0", "--capability", "XX")
        assert result.returncode == 1
        assert "carries no XX" in result.stdout
        assert "ABS, IE, KU, MR, TR" in result.stdout


def test_the_per_thousand_questions_line_is_the_observed_price_times_a_thousand() -> None:
    """The one figure comparable to a published bill without a scale factor.

    `perQuestionPerRun` is exact for the run it came from, so x 1,000 is what a thousand questions
    cost at the same rates -- and it must be printed beside the note that embeddings are absent,
    because a floor presented as a total is the defect every other cost row in this repository was
    written to prevent.
    """
    described = _run_js(
        "const projection = {"
        " scaled: true, factor: 1, questionFactor: 1, runFactor: 1,"
        " usage: { promptTokens: 0, cacheHitPromptTokens: 0, completionTokens: 0 },"
        " cost: { cached: 0, uncached: 0, output: 0, total: 0 },"
        " perQuestionPerRun: { cached: 0, uncached: 0, output: 0, total: 0.00658 },"
        " thinkingReachChanged: false,"
        " prices: { model: 'x', asOf: 'y', cacheHitCnyPerMillion: 1, cacheMissCnyPerMillion: 1, outputCnyPerMillion: 1 } };"
        "process.stdout.write(mod.describe(projection, { limit: 500, runs: 4 }).join('\\n'));"
    )
    assert described.returncode == 0, described.stderr
    assert "per 1,000 qs" in described.stdout
    assert "6.58 CNY" in described.stdout
    assert "embeddings not in the artifact" in described.stdout
