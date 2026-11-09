"""The amortisation crossover: a gap in tokens is not a reason to change architecture.

Zep's read path is cheaper than this arm's and its write path is not free. The quantity that
decides whether that trade is worth copying is how many questions one haystack is asked, and no
vendor publishes it -- so the tool computes it from the corpus shape rather than from a claim.

These tests pin the arithmetic on small integers, not on the shipped defaults, so a change to a
default cannot make a wrong formula look right.
"""

import json
import subprocess
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1] / "amortization-crossover.mjs"


def _call(expr: str) -> str:
    script = (
        f"import {{ crossover, ingestPerHaystack }} from {json.dumps(TOOL.as_uri())};\n"
        f"const out = ({expr});\n"
        "process.stdout.write(JSON.stringify(out));"
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


def _cli(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["node", str(TOOL), *args], capture_output=True, text=True)


class TestCrossover:
    def test_rounds_up_because_a_partial_question_repays_nothing(self):
        # 1,000 - 800 = 200 saved per question, 500 of ingestion: 2.5 questions, so 3.
        payload = json.loads(
            _call(
                "crossover({oursPerQuestion: 1000, theirsPerQuestion: 800,"
                " theirsIngestPerHaystack: 500})"
            )
        )
        assert payload["questionsToRepay"] == 3
        assert payload["savingPerQuestion"] == 200
        assert payload["verdict"] == "repays"

    def test_an_exact_division_is_not_rounded_up_one_more(self):
        payload = json.loads(
            _call(
                "crossover({oursPerQuestion: 1000, theirsPerQuestion: 800,"
                " theirsIngestPerHaystack: 400})"
            )
        )
        assert payload["questionsToRepay"] == 2

    def test_a_competitor_that_is_not_cheaper_per_question_has_nothing_to_amortise(self):
        # This is not a degenerate input: it is the state of the board for several rows, and
        # reporting a large crossover there would invent an incentive to adopt them.
        payload = json.loads(
            _call(
                "crossover({oursPerQuestion: 900, theirsPerQuestion: 1200,"
                " theirsIngestPerHaystack: 1e9})"
            )
        )
        assert payload["questionsToRepay"] == 0
        assert payload["verdict"] == "never"
        assert "nothing to amortise" in payload["reason"]

    def test_equal_read_costs_are_also_never(self):
        payload = json.loads(
            _call(
                "crossover({oursPerQuestion: 700, theirsPerQuestion: 700,"
                " theirsIngestPerHaystack: 5000})"
            )
        )
        assert payload["verdict"] == "never"
        assert payload["savingPerQuestion"] == 0


class TestIngestEstimate:
    def test_one_call_per_session_carries_the_session_and_its_overhead(self):
        value = json.loads(
            _call(
                "ingestPerHaystack({sessions: 2, tokensPerSession: 100, callsPerSession: 1,"
                " promptOverhead: 10, outputTokensPerCall: 5})"
            )
        )
        assert value == 2 * (100 + 10 + 5)

    def test_calls_per_session_multiplies_before_the_per_call_sum(self):
        value = json.loads(
            _call(
                "ingestPerHaystack({sessions: 3, tokensPerSession: 100, callsPerSession: 2,"
                " promptOverhead: 0, outputTokensPerCall: 0})"
            )
        )
        assert value == 600

    def test_zero_calls_per_session_is_refused_rather_than_read_as_free(self):
        # An architecture that makes no extraction calls is not this architecture; accepting 0
        # would silently price its ingestion at nothing and make every crossover infinite.
        script = (
            f"import {{ ingestPerHaystack }} from {json.dumps(TOOL.as_uri())};\n"
            "ingestPerHaystack({sessions: 1, tokensPerSession: 1, callsPerSession: 0,"
            " promptOverhead: 0, outputTokensPerCall: 0});"
        )
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script], capture_output=True, text=True
        )
        assert result.returncode != 0
        assert "callsPerSession" in result.stderr


class TestCommandLine:
    def test_the_defaults_print_a_crossover_and_name_the_corpus_it_came_from(self):
        result = _cli()
        assert result.returncode == 0
        # The corpus term is measured (47 sessions per question, ~115k haystack tokens) and the
        # arithmetic is recomputed here rather than copied, so a changed default fails this test
        # instead of agreeing with itself.
        ingest = 47 * (2447 + 500 + 800)
        expected = -(-ingest // (9201 - 4400))
        assert f"{expected:,} questions" in result.stdout
        assert "47 sessions" in result.stdout
        assert "1 question" in result.stdout

    def test_a_competitor_whose_ingest_never_repays_exits_nonzero(self):
        result = _cli("--theirs-read", "10000")
        assert result.returncode == 1
        assert "0 questions" in result.stdout
