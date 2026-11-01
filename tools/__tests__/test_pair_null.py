"""`readout-arm-run.py --null`, the instrument that measures a pair's own noise floor.

## The band this replaces

`§13.194.4`'s criterion 4 pinned `KU` to `{61, 62}` from **eight** observations -- two runs of four
repetitions at the same configuration -- and the next independent run read `60` twice. The criterion's
own text says a value outside the set "is not noise and means the abstention route's block reached a
route it must not reach". The next run falsified that sentence with the artifact that contains it:
`41222844945`'s `KU` prompts are `72/72` **byte-identical** to its control's, and `KU` still moved.

So the arm has been quoting a noise floor it never measured. This section measures it, per pair, from
the questions whose prompt did not change -- and it measures it at the granularity that decides
readings, which is the question rather than the capability.

## Why the mean is the wrong statistic on its own

`41222844945` gained exactly one `ABS` question in each of four repetitions. The aggregate delta (+1
on 30) is **inside** the band a 4.8% per-read flip rate implies (2 sd = 1.97), so a mean-only
instrument would report "no reading". But the same one question moved the same way four times, and
under a symmetric null the expected number of such questions is `30 * 2 * (0.033/2)**4 = 4.6e-06`.

Both facts are true and the second is the reading. Every test below pins one of the two branches,
because an instrument that can only say "inside the band" would have suppressed the finding it was
written for.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "readout-arm-run.py"


def _module():  # noqa: ANN202 - imported by path, like every other tool test in this directory
    spec = importlib.util.spec_from_file_location("readout_arm_run", TOOL)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def side(records: list[tuple[str, str, str]], bits: list[str]) -> dict:
    """One artifact: `(questionId, capability, promptDigest)` per question, and one bit string per run."""
    return {
        "questions": [
            {"questionId": identifier, "capability": capability, "promptDigest": digest}
            for identifier, capability, digest in records
        ],
        "ablation": {"featureCorrectByRun": bits},
    }


# Thirty-four questions, sized to reproduce the two statistics `41222844945` actually produced: a
# stratum whose prompts did not change and whose readings churned, and a stratum whose prompts moved
# and in which exactly one question converted in every repetition. A reader can check every column by
# hand, which is the point of a fixture that imitates a real artifact rather than a convenient one.
IDENTICAL = [("a", "MR", "d-a"), ("b", "KU", "d-b"), ("c", "KU", "d-c"), ("d", "IE", "d-d")]
DIFFERING_CONTROL = [(f"e{index:02d}", "ABS", f"d-e{index:02d}-control") for index in range(30)]
DIFFERING_RUN = [(f"e{index:02d}", "ABS", f"d-e{index:02d}-run") for index in range(30)]

# Control: `a` and `d` right, `b` and `c` wrong, and both `ABS` questions of the first two wrong --
# in every repetition.
CONTROL_BITS = ["1001" + "0" * 30 for _ in range(4)]
# Run: `b` converts in repetitions 1 and 3 only (churn, not a conversion), and `e00` converts in all
# four (the unanimous reading).
RUN_BITS = [
    "1001" + "1" + "0" * 29,
    "1101" + "1" + "0" * 29,
    "1001" + "1" + "0" * 29,
    "1101" + "1" + "0" * 29,
]


def pair(
    control_bits: list[str] | None = None,
    run_bits: list[str] | None = None,
    run_differing: list[tuple[str, str, str]] | None = None,
) -> tuple[dict, dict]:
    control = side(IDENTICAL + DIFFERING_CONTROL, control_bits or CONTROL_BITS)
    run = side(IDENTICAL + (run_differing or DIFFERING_RUN), run_bits or RUN_BITS)
    return run, control


class TestThePartition:
    def test_the_two_strata_are_counted_from_the_digest(self) -> None:
        module = _module()
        text, _ = module.null_section(*pair())
        assert "prompt identity: 4/34 byte-identical, 30 differ" in text

    def test_the_differing_capabilities_are_named(self) -> None:
        """Which capability moved is the first thing a reader needs and the last thing a table of
        strata gives them: a treatment that reached a route it must not reach shows up here."""
        module = _module()
        text, _ = module.null_section(*pair())
        assert "differing by capability: {'ABS': 30}" in text

    def test_a_question_with_no_digest_is_counted_as_unmeasured(self) -> None:
        module = _module()
        run, control = pair()
        run["questions"][0]["promptDigest"] = None
        text, _ = module.null_section(run, control)
        assert "1 unmeasured" in text
        assert "3/34 byte-identical" in text


class TestTheNumbers:
    def test_the_identical_stratum_moves_by_its_own_flip_rate(self) -> None:
        module = _module()
        text, _ = module.null_section(*pair())
        assert "per repetition delta: [0, 1, 0, 1]" in text

    def test_a_unanimous_conversion_is_named_on_the_differing_stratum(self) -> None:
        module = _module()
        text, unchanged = module.null_section(*pair())
        assert "unanimous gains: ['e00']" in text
        assert unchanged == 1

    def test_a_unanimous_loss_is_named_too(self) -> None:
        module = _module()
        run_bits = ["0001" + "1" + "0" * 29 for _ in range(4)]
        text, _ = module.null_section(*pair(run_bits=run_bits))
        assert "unanimous losses: ['a']" in text

    def test_a_question_that_moves_in_only_some_repetitions_is_not_unanimous(self) -> None:
        """`b` flips in two of four. Calling that a conversion would be the aggregation error this
        section exists to avoid, one level down."""
        module = _module()
        text, _ = module.null_section(*pair())
        assert "unanimous gains: ['e00']" in text
        assert "'b'" not in text.split("unanimous gains")[1]


class TestTheVerdict:
    def test_a_movement_outside_the_band_says_so(self) -> None:
        """Ten of thirty converting in every repetition: a delta of +10 against a band of 5.2."""
        module = _module()
        run_bits = ["1001" + "1" * 10 + "0" * 20 for _ in range(4)]
        text, unanimous = module.null_section(*pair(run_bits=run_bits))
        assert "outside it, so this pair carries a movement the identical stratum does not explain" in text
        assert unanimous == 10

    def test_the_band_is_printed_beside_the_observation(self) -> None:
        module = _module()
        text, _ = module.null_section(*pair())
        assert "2 sd = " in text

    def test_an_aggregate_inside_the_band_with_a_unanimous_question_is_still_a_reading(self) -> None:
        """The finding `41222844945` produced, in three questions: `+1` on 30 is inside the band and
        the question that produced it moved four times out of four."""
        module = _module()
        text, _ = module.null_section(*pair())
        assert "is inside the 1.97 band" in text or "inside the" in text
        assert "the reading is those questions, not the mean" in text

    def test_an_aggregate_inside_the_band_with_no_unanimous_question_is_not_a_reading(self) -> None:
        module = _module()
        text, unanimous = module.null_section(*pair(run_bits=CONTROL_BITS))
        assert "nothing on this stratum survives the reader's own churn" in text
        assert unanimous == 0

    def test_a_pair_whose_prompts_all_moved_has_an_empty_null_stratum(self) -> None:
        """When every prompt moved there is nothing to measure the reader against, and the section
        says so with a `-` row rather than by quietly reporting the differing stratum as if it were
        the null."""
        module = _module()
        run_records = [(identifier, capability, f"{digest}-run") for identifier, capability, digest in IDENTICAL]
        run = side(run_records, ["1111", "1111", "1111", "1111"])
        control = side(IDENTICAL, ["1010", "1010", "1010", "1010"])
        text, unanimous = module.null_section(run, control)
        assert "0/4 byte-identical" in text
        assert "  identical-prompt" in text
        assert "verdict: the differing stratum moved +2.00" in text
        # `b` and `d` convert in all four repetitions, so the section reports two.
        assert unanimous == 2


class TestTheRefusals:
    def test_a_report_without_a_roster_is_refused(self) -> None:
        module = _module()
        with pytest.raises(ValueError, match="no per-question roster"):
            module.null_section({"ablation": {"featureCorrectByRun": ["1"]}}, side(IDENTICAL, CONTROL_BITS[:1]))

    def test_a_duplicated_question_id_in_the_control_is_refused(self) -> None:
        """Pairing by questionId is only a pairing when the id is unique; a duplicate would silently
        compare the run's question against one of two controls."""
        module = _module()
        duplicated = IDENTICAL + [("a", "MR", "d-a")]
        control = side(duplicated, ["10101", "10101", "10101", "10101"])
        run = side(IDENTICAL, ["1010", "1010", "1010", "1010"])
        with pytest.raises(ValueError, match="repeats a questionId"):
            module.null_section(run, control)

    def test_a_question_the_control_does_not_have_is_refused(self) -> None:
        module = _module()
        run, control = pair()
        run["questions"].append({"questionId": "z", "capability": "IE", "promptDigest": "d-z"})
        run["ablation"]["featureCorrectByRun"] = [bits + "1" for bits in RUN_BITS]
        with pytest.raises(ValueError, match="absent from the control"):
            module.null_section(run, control)

    def test_bits_that_are_not_one_per_question_are_refused(self) -> None:
        module = _module()
        run, control = pair()
        run["ablation"]["featureCorrectByRun"] = [bits[:-1] for bits in RUN_BITS]
        with pytest.raises(ValueError, match="not one per question"):
            module.null_section(run, control)

    def test_a_report_without_per_run_bits_is_refused(self) -> None:
        """`questions[].correct` is the majority across repetitions -- the aggregation that hides the
        flip this section counts. Answering from it would be worse than refusing."""
        module = _module()
        run, control = pair()
        del run["ablation"]["featureCorrectByRun"]
        with pytest.raises(ValueError, match="no per-run correctness bits"):
            module.null_section(run, control)


class TestTheSearchBudgetAtThisPairsOwnSigma:
    """`--search-effect`, which is `--null` reporting how wide a search this pair can read.

    ## Why the connection belongs here rather than in a document

    `AUDIT-PARAMETER-SELF-EVOLUTION.md` computes `E[max_k]` and `tools/search-budget.py` decides
    whether a given search is readable, but both need a `sigma`, and a `sigma` supplied by hand is a
    claim. `--null` already measures this pair's own `sigma` from the questions whose prompt did not
    change. Attaching the candidate count to that measurement is the difference between "a search is
    unreadable in general" and "**on this pair**, two candidates are readable and three are not".

    ## Why it is optional

    The effect size has to be named before the reading, not after. A tool that picked one -- the 2 sd
    band, or yesterday's registered effect -- would be choosing the bar to fit the result. So the
    flag is absent by default and the output is byte-identical to before when it is.
    """

    def test_the_candidate_count_is_printed_beside_the_measured_sigma(self) -> None:
        module = _module()
        run, control = pair()
        section, _ = module.null_section(run, control, search_effect=1.0)
        assert "search: at this pair's sigma" in section
        assert "candidate(s) stays under the 1.00 question effect" in section

    def test_absent_by_default_so_existing_transcripts_do_not_move(self) -> None:
        module = _module()
        run, control = pair()
        without, _ = module.null_section(run, control)
        assert "search:" not in without

    def test_the_count_comes_from_the_one_definition_of_the_integral(self) -> None:
        # A second implementation of `E[max_k]` in this file would be a second definition of the
        # same number, and the two would drift the first time either changed. Asserted by value,
        # against the shared module, so a rewrite of one fails here.
        module = _module()
        budget = module.search_budget()
        run, control = pair()
        section, _ = module.null_section(run, control, search_effect=1.0)
        sd = float(section.split("2 sd = ")[1].split(")")[0]) / 2
        assert f"a search of {budget.candidates_for_readability(1.0, sd)} candidate(s)" in section

    def test_the_next_candidate_count_is_named_as_the_one_that_fails(self) -> None:
        # The inverse, for the same reason `search-budget.py` prints its own: a refusal that does not
        # name the boundary cannot be acted on.
        module = _module()
        run, control = pair()
        section, _ = module.null_section(run, control, search_effect=1.0)
        assert "does not" in section or "also does" in section

    def test_a_pair_without_an_identical_stratum_says_why_it_cannot_print_the_count(self) -> None:
        # Silence would read as "no search fitted", which is a different statement from "this pair
        # has no measurement of its own noise". The second is what is true.
        module = _module()
        control = side(DIFFERING_CONTROL, ["0" * 30 for _ in range(4)])
        run = side(DIFFERING_RUN, ["1" * 30 for _ in range(4)])
        section, _ = module.null_section(run, control, search_effect=1.0)
        assert "no identical-prompt stratum" in section
        assert "claim rather than a measurement" in section

    def test_a_zero_effect_is_refused_rather_than_treated_as_always_readable(self) -> None:
        module = _module()
        run, control = pair()
        with pytest.raises(ValueError, match="positive"):
            module.null_section(run, control, search_effect=0.0)
