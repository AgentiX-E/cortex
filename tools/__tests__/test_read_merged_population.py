"""The merged-population readback, and the shape it used to refuse without knowing it was refusing.

Run `43673528695` is the reason this file exists. It was `S10`'s control arm: one window per corpus,
`pairing=reference`, sixteen shards, all sixteen successful. The merge job went red anyway, because
the readback step required every question id to end in `<marker><windows>` so it could find the
second window -- and there is no second window at `windows=1`. The step was a heredoc inside the
workflow, so no test could exercise it, and the dispatch paid two hours to discover that a print
step had been written for its sibling row's shape.

The tests below are therefore mostly about what the script **declines** to do: not refusing a
one-window population, not reporting a carry reach for a pairing that never administers the carry,
and still refusing the two things that are genuinely wrong -- a roster that does not match its own
population, and a dispatch whose `windows` disagrees with the artifact's.
"""

import json
import pathlib
import subprocess

TOOL = pathlib.Path(__file__).resolve().parents[1] / "read-merged-population.py"


def document(windows=2, corpora=2, runs=2, carry=None, marker="#w", pair=None):
    """A merged evidence document, no larger than a reading needs.

    `pair` names the one-flag field the arm writes (`carryPair`, `clockPair`, `resolutionPair`), or
    nothing for a `reference` artifact -- which has no flag of its own, and whose fixtures must not carry
    one: the readback refuses an artifact that claims a pair the dispatch did not name.
    """
    ids = [
        f"q{corpus}{marker}{window}"
        for corpus in range(corpora)
        for window in range(1, windows + 1)
    ]
    payload = {
        "questionCount": len(ids),
        "runs": runs,
        "population": {"corpora": corpora, "windows": windows, "marker": marker},
        "merged": {"shards": 16},
        "questions": [{"questionId": question_id} for question_id in ids],
        "ablation": {
            "baselineCorrectByRun": ["1" * len(ids) for _ in range(runs)],
            "featureCorrectByRun": ["1" * len(ids) for _ in range(runs)],
        },
    }
    if carry is not None:
        payload["semanticCarry"] = carry
    if pair is not None:
        payload["featureConfig"] = {pair: True}
    if pair == "resolutionPair":
        # A `resolution` artifact always carries both sides: the baseline's two numbers as vectors in
        # `ablation` (there is no baseline row to live in) and the feature's on the roster (which is the
        # feature's, one row per question). Filling them here keeps every fixture a document the arm could
        # actually have written, and the tests that need a degenerate side overwrite them.
        payload["ablation"]["baselineRoleCensuses"] = [
            {"counts": {"user": 10}, "unclassified": 0, "total": 10} for _ in ids
        ]
        payload["ablation"]["baselinePromptChars"] = [40000] * len(ids)
        for row in payload["questions"]:
            row["roleCensus"] = {"counts": {"user": 13}, "unclassified": 0, "total": 13}
            row["promptChars"] = 40000
    return payload


def run(tmp_path, payload, *args):
    path = pathlib.Path(tmp_path) / "merged-evidence.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return subprocess.run(
        ["python3", str(TOOL), str(path), *args], capture_output=True, text=True
    )


def test_one_window_is_read_rather_than_refused(tmp_path):
    # The exact case that failed the run: `S10`'s shape, with ids that carry no second-window suffix
    # because there is no second window. Before the fix this exited 1 with a message about a marker.
    result = run(tmp_path, document(windows=1), "--windows", "1", "--pairing", "reference")
    assert result.returncode == 0, result.stderr
    assert "1 windows" in result.stdout
    assert "not taken" in result.stdout
    assert "refusing" not in result.stdout + result.stderr


def test_a_reference_pairing_does_not_report_a_carry_reach(tmp_path):
    # `reference` runs the carry off on both sides, so `matched: 0` is the configuration and not a
    # failure. A `::warning::` here would put a warning on every reference dispatch, which is how a
    # warning stops being read by the time it means something.
    result = run(
        tmp_path,
        document(windows=2, carry={"absorbed": 0, "matched": 0, "served": 0}),
        "--pairing",
        "reference",
    )
    assert result.returncode == 0, result.stderr
    assert "S13 reach" not in result.stdout
    assert "::warning::" not in result.stdout
    assert "not read from this dispatch" in result.stdout


def test_a_carry_pairing_reports_the_reach_and_the_paired_delta(tmp_path):
    # Two corpora, two windows: only the second window of each pairs. The baseline misses one of
    # them and the feature answers it, so the delta is +1.0 over n=2 with one discordant pair.
    payload = document(windows=2, carry={"absorbed": 1, "matched": 1, "served": 1}, pair="carryPair")
    payload["ablation"]["baselineCorrectByRun"] = ["1010"]
    payload["ablation"]["featureCorrectByRun"] = ["1110"]
    result = run(tmp_path, payload, "--pairing", "carry")
    assert result.returncode == 0, result.stderr
    assert "S13 reach: 1" in result.stdout
    assert "second window: n=2  delta=+1.0000" in result.stdout
    assert "b=0 c=1" in result.stdout
    assert "::notice::S12 readable" in result.stdout


def test_a_reach_of_zero_is_a_warning_and_not_a_pass(tmp_path):
    result = run(tmp_path, document(windows=2, carry={"matched": 0}, pair="carryPair"), "--pairing", "carry")
    assert result.returncode == 0, result.stderr
    assert "::warning::the merge reached no window" in result.stdout
    assert "S12 readable" not in result.stdout


def test_a_delta_below_the_floor_is_an_error_annotation(tmp_path):
    # Behaviour preserved from the heredoc: the annotation is printed and the exit code stays zero,
    # because the row's verdict is read from the artifact by the analysis script rather than from
    # this job's conclusion. Changing that here would be a change of instrument, not of shape.
    payload = document(windows=2, corpora=10, carry={"matched": 10}, pair="carryPair")
    payload["ablation"]["featureCorrectByRun"] = ["0" * payload["questionCount"]]
    result = run(tmp_path, payload, "--pairing", "carry")
    assert result.returncode == 0, result.stderr
    assert "delta=-10.0000" in result.stdout
    assert "::error::delta -10.0 is below the -5 floor" in result.stdout


def test_a_roster_without_its_own_marker_is_refused_when_a_second_window_exists(tmp_path):
    # The refusal that was right all along: at two windows an id set carrying no suffix cannot be
    # paired, and a fallback would pair the first window against itself and call it +0.
    payload = document(windows=2, pair="carryPair")
    payload["questions"] = [
        {"questionId": f"q{index}"} for index in range(payload["questionCount"])
    ]
    result = run(tmp_path, payload, "--pairing", "carry")
    assert result.returncode == 1
    assert "does not match its own population" in result.stderr


def test_a_bitstring_that_is_not_aligned_with_the_roster_is_refused(tmp_path):
    payload = document(windows=2, carry={"matched": 1}, pair="carryPair")
    payload["ablation"]["featureCorrectByRun"] = ["1"]
    result = run(tmp_path, payload, "--pairing", "carry")
    assert result.returncode == 1
    assert "not aligned with the roster" in result.stderr


def test_a_dispatch_window_count_that_disagrees_with_the_artifact_is_refused(tmp_path):
    result = run(tmp_path, document(windows=1), "--windows", "2")
    assert result.returncode == 1
    assert "different experiments" in result.stderr


def test_an_unknown_pairing_is_refused(tmp_path):
    # The message names every pairing the tool builds, because it is the only place a dispatcher
    # learns the closed set -- and the set is now three wide. A refusal that named two of three
    # teaches its reader to invent the third.
    result = run(tmp_path, document(windows=1), "--pairing", "reference-and-carry")
    assert result.returncode == 1
    assert "is not one of" in result.stderr
    for name in ("reference", "carry", "clock"):
        assert name in result.stderr


def test_an_unknown_argument_is_refused(tmp_path):
    result = run(tmp_path, document(windows=1), "--shards", "16")
    assert result.returncode == 1
    assert "unknown argument" in result.stderr


def test_a_one_flag_pair_at_one_window_is_read_over_the_whole_population(tmp_path):
    """The reading this tool could not produce, on the dispatch that needed it.

    `windows < 2` used to end the readback with "paired delta: not taken", which is right for
    `reference` -- the two sides there are two systems and the window is what pairs -- and wrong for
    a pairing that puts ONE FLAG between the sides: `pairing=clock` at one window is exactly the
    experiment, and the tool that was supposed to read it said there was nothing to pair. Run
    `44891901371` paid for the reading and then failed on this line.
    """
    payload = document(windows=1, corpora=4)
    payload["ablation"]["baselineCorrectByRun"] = ["1010"]
    payload["ablation"]["featureCorrectByRun"] = ["1110"]
    payload["featureConfig"] = {"clockPair": True}
    result = run(tmp_path, payload, "--windows", "1", "--pairing", "clock")
    assert result.returncode == 0, result.stderr
    assert "whole population: n=4  delta=+1.0000" in result.stdout
    assert "b=0 c=1" in result.stdout
    assert "not taken" not in result.stdout


def test_a_clock_pairing_does_not_claim_a_carry_reach(tmp_path):
    """The clock dispatch runs the carry off on both sides, like a reference one.

    Warning about a reach of zero there would be a warning on a dispatch behaving exactly as
    registered -- the shape that stops a warning being read by the time it means something.
    """
    result = run(
        tmp_path,
        {**document(windows=1), "semanticCarry": {"absorbed": 0, "matched": 0, "served": 0},
         "featureConfig": {"clockPair": True}},
        "--windows",
        "1",
        "--pairing",
        "clock",
    )
    assert result.returncode == 0, result.stderr
    assert "S13 reach" not in result.stdout
    assert "::warning::" not in result.stdout
    assert "not read from this dispatch" in result.stdout


def test_the_artifact_must_agree_with_the_pairing_it_was_read_under(tmp_path):
    """A dispatch says `clock` and the artifact says `clockPair: false` -- two statements, one run.

    Refused rather than printed, because every number below it would be read as the clock's when the
    arm that produced it built both sides without the clock.
    """
    payload = document(windows=1)
    payload["featureConfig"] = {"clockPair": False}
    result = run(tmp_path, payload, "--windows", "1", "--pairing", "clock")
    assert result.returncode == 1
    assert "clockPair" in result.stderr

    other = document(windows=1)
    other["featureConfig"] = {"clockPair": True}
    result = run(tmp_path, other, "--windows", "1", "--pairing", "carry")
    assert result.returncode == 1
    assert "clockPair" in result.stderr


def test_the_pairing_vocabulary_is_the_arms_vocabulary():
    """Two copies of one closed set, held to each other by reading both.

    This is the check whose absence cost run `44891901371` its conclusion: the dispatcher's copy was
    held to `arm-pairing.ts` and this tool's copy was not, so `clock` passed the gate that was
    written for it and failed the one that was not.

    The union is read with `\\s*` after the `=` rather than a single space, and the reason is a repair
    rather than a convenience: eight members do not fit on one line at the repository's print width, so
    Prettier breaks the union into a leading-`|` list and a pattern anchored on `" = "` stops matching.
    The first thing that happened when the eighth key was added was this test failing with "arm-pairing.ts
    has no `ArmPairing` union" -- a message about the file's *layout* standing in for a check on its
    *vocabulary*. The set is what the two copies have to agree about; the whitespace is not.
    """
    import re

    root = pathlib.Path(__file__).resolve().parents[2]
    source = (root / "packages/cortex-eval/src/arm-pairing.ts").read_text(encoding="utf-8")
    union = re.search(r"type ArmPairing =[ \t]*\n?([^;]+);", source)
    assert union is not None, "arm-pairing.ts has no `ArmPairing` union"
    arm = sorted(re.findall(r"'(\w+)'", union.group(1)))
    tool = (root / "tools/read-merged-population.py").read_text(encoding="utf-8")
    closed = re.search(r"^PAIRINGS = \(([^)]+)\)", tool, re.M)
    assert closed is not None, "the readback has no `PAIRINGS` tuple"
    names = sorted(re.findall(r"'([^']+)'", closed.group(1)))
    assert names == arm, f"the readback reads {names} and the arm builds {arm}"


def test_a_resolution_pair_is_read_over_the_whole_population_at_one_window(tmp_path):
    """`C7`'s `F3` reads a ratio of two medians on one population, and its population is one window.

    The layer this replaced would have printed "no second window to pair against" and exited zero --
    a green step over an unread experiment, twice over: `resolution` is a one-flag pair, so the window
    is not what pairs, and `F3` is registered on the registered population (`limit: 0`, one window).
    """
    payload = document(windows=1, corpora=4, pair="resolutionPair")
    payload["ablation"]["baselineCorrectByRun"] = ["1010"]
    payload["ablation"]["featureCorrectByRun"] = ["1110"]
    result = run(tmp_path, payload, "--windows", "1", "--pairing", "resolution")
    assert result.returncode == 0, result.stderr
    assert "whole population: n=4  delta=+1.0000" in result.stdout
    # Named, not the bare phrase: `C8`'s `G4` legitimately says "not taken" when no question gained, and a
    # substring assertion about the paired delta would be satisfied by that line instead -- which is how a
    # guard stops guarding while still passing.
    assert "paired delta: not taken" not in result.stdout


def test_a_resolution_pairing_does_not_claim_a_carry_reach(tmp_path):
    # The same rule the clock's test states: a rendering experiment runs the carry off on both sides,
    # so warning about a reach of zero there would put a `::warning::` on a dispatch behaving exactly
    # as registered -- and a warning that fires on correct runs stops being read.
    result = run(
        tmp_path,
        document(windows=1, pair="resolutionPair", carry={"absorbed": 0, "matched": 0, "served": 0}),
        "--windows",
        "1",
        "--pairing",
        "resolution",
    )
    assert result.returncode == 0, result.stderr
    assert "S13 reach" not in result.stdout
    assert "::warning::" not in result.stdout
    assert "not read from this dispatch" in result.stdout


def test_a_resolution_dispatch_must_agree_with_the_flag_the_arm_wrote(tmp_path):
    """Two statements about one run, and `C7`'s whole judgement rests on which one is true.

    A dispatch that says `--pairing resolution` over an artifact whose arm built the carry pair would
    be read as "the layered form is worth this much" when it is worth nothing of the sort. Both
    directions are refused: the flag absent, and another flag present.
    """
    absent = document(windows=1)
    result = run(tmp_path, absent, "--windows", "1", "--pairing", "resolution")
    assert result.returncode == 1
    assert "resolutionPair" in result.stderr

    crossed = document(windows=2, pair="clockPair")
    result = run(tmp_path, crossed, "--pairing", "resolution")
    assert result.returncode == 1
    assert "clockPair" in result.stderr


def test_a_resolution_pair_reports_the_density_ratio_f3_divides(tmp_path):
    """`F3` is the假证 clause: same prompt budget, more delivered turns, or this family closes.

    The two medians have to come from ONE roster -- `promptChars` within ±2% is what separates
    "denser" from "wider", and a cross-run comparison could not tell them apart because both numbers
    would move for reasons the pairing does not control.
    """
    payload = document(windows=1, corpora=4, pair="resolutionPair")
    payload["ablation"]["baselineRoleCensuses"] = [
        {"counts": {"user": 10}, "unclassified": 0, "total": 10},
        {"counts": {"user": 12}, "unclassified": 0, "total": 12},
        {"counts": {"user": 14}, "unclassified": 0, "total": 14},
        {"counts": {"user": 16}, "unclassified": 0, "total": 16},
    ]
    payload["ablation"]["baselinePromptChars"] = [40000, 40100, 40200, 40300]
    for row, turns, chars in zip(
        payload["questions"], (15, 18, 21, 24), (40400, 40500, 40600, 40700)
    ):
        row["roleCensus"] = {"counts": {"user": turns}, "unclassified": 0, "total": turns}
        row["promptChars"] = chars
    result = run(tmp_path, payload, "--windows", "1", "--pairing", "resolution")
    assert result.returncode == 0, result.stderr
    # Medians of 4 even counts are the mean of the middle two: baseline (12+14)/2 = 13, feature 19.5.
    assert "turns median 13 -> 19.5  (+50.0%)" in result.stdout
    assert "chars median 40150 -> 40550  (+1.0%)" in result.stdout
    assert "F3 pass" in result.stdout


def test_a_density_reading_that_misses_the_threshold_says_which_clause_failed(tmp_path):
    # The same population with the turns flat: the ratio is the clause that decides the family, and a
    # reader that reported "F3 failed" without saying which of the two numbers missed would send the next
    # round back to the drawing board with no direction.
    payload = document(windows=2, corpora=2, pair="resolutionPair")
    payload["ablation"]["baselineRoleCensuses"] = [
        {"counts": {"user": 10}, "unclassified": 0, "total": 10}
    ] * 4
    payload["ablation"]["baselinePromptChars"] = [40000] * 4
    for row in payload["questions"]:
        row["roleCensus"] = {"counts": {"user": 11}, "unclassified": 0, "total": 11}
        row["promptChars"] = 40000
    result = run(tmp_path, payload, "--pairing", "resolution")
    assert result.returncode == 0, result.stderr
    assert "(+10.0%)" in result.stdout
    assert "F3 fail: turns +10.0% is below the +20% floor" in result.stdout


def test_a_density_reading_with_no_baseline_census_is_refused_rather_than_guessed(tmp_path):
    """`reference` pairings produce an all-`null` baseline vector, and a median over nulls is not zero.

    Reporting `0` there would read as "the control delivered no turns", which is the strongest possible
    claim from no evidence -- the reason `featureByCapability` is absent rather than degenerate at one
    repetition.
    """
    payload = document(windows=1, corpora=2, pair="resolutionPair")
    payload["ablation"]["baselineRoleCensuses"] = [None, None]
    result = run(tmp_path, payload, "--windows", "1", "--pairing", "resolution")
    assert result.returncode == 1
    assert "no density reading" in result.stderr


def census(record=0, excerpt=0, raw=0):
    """One question's cap census, with the per-form split the roster carries since `C8`.

    `cut` is the turns a form shortened and `whole` the ones it left alone, so the object satisfies the
    arithmetic the record documents (`record + excerpt + raw == cut + whole`) instead of being a shape no
    producer could emit.
    """
    return {
        "cut": record + excerpt,
        "marked": record + excerpt,
        "whole": raw,
        "forms": {
            "raw": {"turns": raw, "chars": raw * 100},
            "excerpt": {"turns": excerpt, "chars": excerpt * 500},
            "record": {"turns": record, "chars": record * 240},
        },
    }


def test_a_resolution_run_reports_the_form_criteria_beside_the_density_verdict(tmp_path):
    """`C8`'s `G1`, `G2` and `G4`, on a population whose arithmetic is small enough to check by hand.

    Four questions, baseline 10 turns and feature 15, so `G2`'s direction is characters down and turns up --
    the signature `C7`'s `F3` forbids. Three of the four gained, with record shares 1.0, 0.8 and 0.6 against
    a population median of 0.7: the ratio is 1.1428..., below `G4`'s 1.5, so the mechanism helped and this
    criterion says it did not help *this way*.
    """
    payload = document(windows=1, corpora=4, runs=1, pair="resolutionPair")
    payload["ablation"]["baselineCorrectByRun"] = ["0010"]
    payload["ablation"]["featureCorrectByRun"] = ["1111"]
    payload["ablation"]["baselineRoleCensuses"] = [
        {"counts": {"user": 10}, "unclassified": 0, "total": 10}
    ] * 4
    payload["ablation"]["baselinePromptChars"] = [40000] * 4
    for row in payload["questions"]:
        row["roleCensus"] = {"counts": {"user": 15}, "unclassified": 0, "total": 15}
        row["promptChars"] = 38000
    splits = [(15, 0, 0), (12, 0, 3), (0, 0, 15), (9, 0, 6)]
    for row, (record, excerpt, raw) in zip(payload["questions"], splits):
        row["turnWindowCensus"] = census(record=record, excerpt=excerpt, raw=raw)

    result = run(tmp_path, payload, "--windows", "1", "--pairing", "resolution")
    assert result.returncode == 0, result.stderr
    assert "forms: 4/4 questions rendered by a form (record or excerpt on 3)  -- G1 floor 1" in result.stdout
    assert "G1 pass  3 >= 1" in result.stdout
    assert "G2 pass  chars -5.0% <= -3% with turns +50.0% >= +1%" in result.stdout
    assert "record share median: gainers 0.800 (n=3) vs population 0.700 (n=4)  ratio 1.14" in result.stdout
    assert "G4 fail" in result.stdout
    # The density verdict is still printed, and it still fails: the two families are read on one run and the
    # disagreement is the finding, not a contradiction to be reconciled.
    assert "F3 fail" in result.stdout


def test_g4_passes_when_the_gainers_are_the_questions_the_records_dominate(tmp_path):
    # Two questions gain and both are all-record; two do not gain and carry no record at all. The population
    # median is 0.5 and the gainers' is 1.0, so the ratio is exactly 2.0 -- over the 1.5 the pre-registration
    # requires.
    payload = document(windows=1, corpora=4, runs=1, pair="resolutionPair")
    payload["ablation"]["baselineCorrectByRun"] = ["0011"]
    payload["ablation"]["featureCorrectByRun"] = ["1111"]
    payload["ablation"]["baselineRoleCensuses"] = [
        {"counts": {"user": 10}, "unclassified": 0, "total": 10}
    ] * 4
    payload["ablation"]["baselinePromptChars"] = [40000] * 4
    for row in payload["questions"]:
        row["roleCensus"] = {"counts": {"user": 15}, "unclassified": 0, "total": 15}
        row["promptChars"] = 38000
    splits = [(15, 0, 0), (15, 0, 0), (0, 0, 15), (0, 0, 15)]
    for row, (record, excerpt, raw) in zip(payload["questions"], splits):
        row["turnWindowCensus"] = census(record=record, excerpt=excerpt, raw=raw)

    result = run(tmp_path, payload, "--windows", "1", "--pairing", "resolution")
    assert result.returncode == 0, result.stderr
    assert "gainers 1.000 (n=2) vs population 0.500 (n=4)  ratio 2.00" in result.stdout
    assert "G4 pass" in result.stdout


def test_a_population_with_no_gainers_says_g4_was_not_taken(tmp_path):
    # A ratio over an empty numerator is not a reading, and printing `0.0` would read as "the gainers carried
    # no records" -- a statement about a set that does not exist.
    payload = document(windows=1, corpora=2, runs=1, pair="resolutionPair")
    payload["ablation"]["baselineCorrectByRun"] = ["11"]
    payload["ablation"]["featureCorrectByRun"] = ["11"]
    payload["ablation"]["baselineRoleCensuses"] = [
        {"counts": {"user": 10}, "unclassified": 0, "total": 10}
    ] * 2
    payload["ablation"]["baselinePromptChars"] = [40000] * 2
    for row in payload["questions"]:
        row["roleCensus"] = {"counts": {"user": 15}, "unclassified": 0, "total": 15}
        row["promptChars"] = 38000
        row["turnWindowCensus"] = census(record=15)

    result = run(tmp_path, payload, "--windows", "1", "--pairing", "resolution")
    assert result.returncode == 0, result.stderr
    assert "G4 not taken: no question improved" in result.stdout
    assert "record share median" not in result.stdout


def test_g1_fails_when_no_form_reached_a_single_question(tmp_path):
    # The run that would otherwise be read as "the mechanism did nothing": every long turn rendered raw, or a
    # `resolution` that never reached the renderer. Either way the population is not a reading of `C8`, and
    # the wording has to say so rather than leave a delta standing on no mechanism.
    payload = document(windows=1, corpora=2, runs=1, pair="resolutionPair")
    payload["ablation"]["baselineCorrectByRun"] = ["10"]
    payload["ablation"]["featureCorrectByRun"] = ["11"]
    payload["ablation"]["baselineRoleCensuses"] = [
        {"counts": {"user": 10}, "unclassified": 0, "total": 10}
    ] * 2
    payload["ablation"]["baselinePromptChars"] = [40000] * 2
    for row in payload["questions"]:
        row["roleCensus"] = {"counts": {"user": 15}, "unclassified": 0, "total": 15}
        row["promptChars"] = 38000
        row["turnWindowCensus"] = census(raw=15)

    result = run(tmp_path, payload, "--windows", "1", "--pairing", "resolution")
    assert result.returncode == 0, result.stderr
    assert "G1 fail: 0 of 2 questions had a compressed or widened turn" in result.stdout
    # And the absence of a split is named as an absence of a split. Run `44915923906` printed "no question
    # improved" over a population where 27 had, because an empty share map and an empty gainer set led to the
    # same line; that sentence sent the reading after the mechanism instead of after the instrument.
    # The fixture's two questions carry a form (every turn is `raw`), so the shares exist and are all zero:
    # that is the denominator case, not the absent case. Printed as `ratio inf` and `G4 pass` before the guard.
    assert "G4 unread: the population median record share is 0.000" in result.stdout


def test_g4_is_unread_rather_than_infinite_when_no_question_carries_a_split(tmp_path):
    # The other empty state: head-cut censuses with no `forms` at all. Run `44915923906` produced exactly this
    # shape by accident -- the product's accessor dropped the split -- and the reader answered "no question
    # improved" over 27 that had.
    payload = document(windows=1, corpora=2, runs=1, pair="resolutionPair")
    payload["ablation"]["baselineCorrectByRun"] = ["10"]
    payload["ablation"]["featureCorrectByRun"] = ["11"]
    payload["ablation"]["baselineRoleCensuses"] = [
        {"counts": {"user": 10}, "unclassified": 0, "total": 10}
    ] * 2
    payload["ablation"]["baselinePromptChars"] = [40000] * 2
    for row in payload["questions"]:
        row["roleCensus"] = {"counts": {"user": 15}, "unclassified": 0, "total": 15}
        row["promptChars"] = 38000
        row["turnWindowCensus"] = {"cut": 4, "marked": 4, "whole": 11}

    result = run(tmp_path, payload, "--windows", "1", "--pairing", "resolution")
    assert result.returncode == 0, result.stderr
    assert "G4 unread: no question carries a form split" in result.stdout
    assert "ratio inf" not in result.stdout


def test_a_question_without_a_split_is_left_out_of_g4_rather_than_counted_as_zero(tmp_path):
    # A head-cut question reports `{cut, marked, whole}` and no `forms`: the cap decided a length rather than
    # choosing between renderings. Counting it as share 0.0 would drag the population median down and make
    # every gainer look concentrated, which is the criterion grading itself.
    payload = document(windows=1, corpora=3, runs=1, pair="resolutionPair")
    payload["ablation"]["baselineCorrectByRun"] = ["001"]
    payload["ablation"]["featureCorrectByRun"] = ["111"]
    payload["ablation"]["baselineRoleCensuses"] = [
        {"counts": {"user": 10}, "unclassified": 0, "total": 10}
    ] * 3
    payload["ablation"]["baselinePromptChars"] = [40000] * 3
    for row in payload["questions"]:
        row["roleCensus"] = {"counts": {"user": 15}, "unclassified": 0, "total": 15}
        row["promptChars"] = 38000
    payload["questions"][0]["turnWindowCensus"] = census(record=15)
    payload["questions"][1]["turnWindowCensus"] = census(record=15)
    payload["questions"][2]["turnWindowCensus"] = {"cut": 4, "marked": 4, "whole": 11}

    result = run(tmp_path, payload, "--windows", "1", "--pairing", "resolution")
    assert result.returncode == 0, result.stderr
    # `formed` counts the two rows that carry a split, and the population median is over those two only.
    assert "forms: 2/3 questions rendered by a form" in result.stdout
    assert "vs population 1.000 (n=2)" in result.stdout


def test_g2_reads_totals_where_f3_reads_medians(tmp_path):
    """The one population where the two quantities give opposite verdicts, so the wiring is observable.

    Baseline 40,000 characters on every question and feature 40,000 on three of them with 20,000 on the
    fourth: the **median does not move at all** while the **total falls 12.5%**. `C8`'s `G2` is registered on
    totals -- reallocation pays if the population spends fewer characters -- so the verdict here is `pass`,
    and a `print_forms` that had been handed `delivered_medians` would print `0.0%` and fail it.
    """
    payload = document(windows=1, corpora=4, runs=1, pair="resolutionPair")
    payload["ablation"]["baselineCorrectByRun"] = ["0000"]
    payload["ablation"]["featureCorrectByRun"] = ["0000"]
    payload["ablation"]["baselineRoleCensuses"] = [
        {"counts": {"user": 10}, "unclassified": 0, "total": 10}
    ] * 4
    payload["ablation"]["baselinePromptChars"] = [40000] * 4
    for row in payload["questions"]:
        row["roleCensus"] = {"counts": {"user": 13}, "unclassified": 0, "total": 13}
    payload["questions"][0]["promptChars"] = 40000
    payload["questions"][1]["promptChars"] = 40000
    payload["questions"][2]["promptChars"] = 40000
    payload["questions"][3]["promptChars"] = 20000

    result = run(tmp_path, payload, "--windows", "1", "--pairing", "resolution")
    assert result.returncode == 0, result.stderr
    # `F3`'s medians are untouched by the fourth question...
    assert "chars median 40000 -> 40000  (+0.0%)" in result.stdout
    # ...while `G2`'s totals are not, and that difference is the whole reason the two functions exist.
    assert "G2 pass  chars -12.5% <= -3% with turns +30.0% >= +1%" in result.stdout


def test_g2_names_a_magnitude_failure_apart_from_a_direction_failure(tmp_path):
    """Characters down 3.3% with turns flat is a direction failure; the reverse split is a floor failure.

    Both are `fail`, and they send the next round in opposite directions: one says the mechanism does not
    reallocate, the other says it does and the saving is smaller than the floor. Run `44915923906` produced
    the second (chars -2.8%, turns +3.7%) and the script called it the first until this test existed.
    """
    payload = document(windows=1, corpora=4, runs=1, pair="resolutionPair")
    payload["ablation"]["baselineCorrectByRun"] = ["0000"]
    payload["ablation"]["featureCorrectByRun"] = ["0000"]
    payload["ablation"]["baselineRoleCensuses"] = [
        {"counts": {"user": 10}, "unclassified": 0, "total": 10}
    ] * 4
    payload["ablation"]["baselinePromptChars"] = [40000] * 4
    for row in payload["questions"]:
        row["roleCensus"] = {"counts": {"user": 11}, "unclassified": 0, "total": 11}
        row["promptChars"] = 39000
        row["turnWindowCensus"] = census(raw=11)

    result = run(tmp_path, payload, "--windows", "1", "--pairing", "resolution")
    assert result.returncode == 0, result.stderr
    assert "G2 fail on magnitude" in result.stdout
    assert "the direction appeared (chars -2.5% with turns +10.0%)" in result.stdout


# ---------------------------------------------------------------------------------------------------
# `G3` and `G5`: the two criteria the script left to whoever wrote the evidence file
# ---------------------------------------------------------------------------------------------------


def criteria_fixture(gainers=4, population=10, record_turns=8, forms=True, tokens=None):
    """A `resolution` population whose five criteria can each be checked by hand.

    `gainers` of `population` answer on the feature side and never on the baseline, so the delta is
    `+gainers`, `c` is `gainers` and `b` is zero -- the smallest shape in which `G3`'s two clauses can
    disagree (`+40 points` with an up-down of `+4` fails the second one).

    `record_turns` decides the form split: a question with at least one `record` turn reports a share,
    and `G4` divides the gainers' median share by the population's. Every question here reports the
    same share, so `G4` reads a ratio of 1.0 and fails on concentration -- which is the honest answer
    for a population where the mechanism reached everyone equally.
    """
    ids = [f'q{index}#w2' for index in range(population)]
    rows = []
    for index in range(population):
        row = {
            'questionId': ids[index],
            'roleCensus': {'counts': {'user': 11}, 'unclassified': 0, 'total': 11},
            'promptChars': 38000,
        }
        if forms:
            row['turnWindowCensus'] = census(record=record_turns if index < 6 else 0, raw=3)
        rows.append(row)
    payload = {
        'questionCount': population,
        'runs': 1,
        'population': {'corpora': population, 'windows': 2, 'marker': '#w'},
        'merged': {'shards': 4},
        'questions': rows,
        'ablation': {
            'baselineCorrectByRun': ['0' * population],
            'featureCorrectByRun': ['1' * gainers + '0' * (population - gainers)],
            'baselineRoleCensuses': [
                {'counts': {'user': 10}, 'unclassified': 0, 'total': 10}
            ] * population,
            'baselinePromptChars': [40000] * population,
        },
        'featureConfig': {'resolutionPair': True},
    }
    if tokens is not None:
        payload['tokens'] = {'prompt_per_answer': {'delta_pct': tokens}}
    return payload


def test_g3_is_decided_by_the_script_rather_than_by_the_evidence_file(tmp_path):
    """`G3` is `>= +1.5 points AND up-down >= +5`, and both clauses can fail independently.

    Until this round the script printed the delta line and stopped, and `44915923906`'s `criteria` block
    carries a `G3: pass` that no code produced. The two cases below are the clause pair: ten questions
    with four net gains is `+40.00 points` and an up-down of `+4`, so the point clause clears by a factor
    of twenty-six and the discordant clause does not clear at all.
    """
    payload = criteria_fixture(gainers=4, population=10)
    result = run(tmp_path, payload, '--pairing', 'resolution')
    assert result.returncode == 0, result.stderr
    assert 'G3 fail: the delta line above gives +40.00 points and up-down +4, against +1.5 and +5' in (
        result.stdout
    )

    payload = criteria_fixture(gainers=6, population=10)
    result = run(tmp_path, payload, '--pairing', 'resolution')
    assert result.returncode == 0, result.stderr
    assert 'G3 pass  the delta line above clears +1.5 points and the +5 up-down floor (up-down +6)' in (
        result.stdout
    )


def test_g5_reads_the_paired_ratio_and_refuses_to_invent_one(tmp_path):
    """Three states, and the third is the one a defaulting implementation would have hidden.

    The absolute `7,416` threshold belongs to the arm whose two sides are the reference pipeline and this
    one; a `resolution` pair runs this system on both sides, so the clause is the paired ratio. An
    artifact with no token block is `unread` and not `pass` -- both hand-written verdicts in `cortex-docs`
    read `fail`, so a script that defaulted to `pass` would have agreed with the wrong one by accident.
    """
    payload = criteria_fixture(tokens=-2.0)
    result = run(tmp_path, payload, '--pairing', 'resolution')
    assert result.returncode == 0, result.stderr
    # `fell 2.00%`, not `fell -2.00%`: the verb already carries the sign, and a double negative is what a
    # skimming reader takes as an increase.
    assert 'G5 pass  the paired bill fell 2.00%' in result.stdout

    payload = criteria_fixture(tokens=0.18)
    result = run(tmp_path, payload, '--pairing', 'resolution')
    assert result.returncode == 0, result.stderr
    assert (
        'G5 fail: the paired bill rose 0.18%; the absolute threshold belongs to the reference arm'
        in result.stdout
    )

    payload = criteria_fixture(tokens=None)
    result = run(tmp_path, payload, '--pairing', 'resolution')
    assert result.returncode == 0, result.stderr
    assert 'G5 unread: the artifact carries no paired prompt-token ratio' in result.stdout


def test_the_five_criteria_print_in_id_order(tmp_path):
    """`G1 G2 G3 G4 G5`, with the two informational lines still above the criterion each belongs to.

    `G3` between `G2` and `G4` rather than appended last: the evidence tables in `cortex-docs` read
    `G1`-`G5` in that order, and a script that printed `G1 G2 G4 G5 G3` would make every reader renumber
    the table before comparing it with the document.
    """
    result = run(tmp_path, criteria_fixture(), '--pairing', 'resolution')
    assert result.returncode == 0, result.stderr
    order = [
        line.split(' ')[0]
        for line in result.stdout.splitlines()
        if line[:2] in {'G1', 'G2', 'G3', 'G4', 'G5'}
    ]
    assert order == ['G1', 'G2', 'G3', 'G4', 'G5'], result.stdout
    assert result.stdout.index('forms:') < result.stdout.index('G1 ')


def test_the_json_block_and_the_printed_block_are_one_verdict(tmp_path):
    """The `--criteria-json` block is the printed block as data, not a second judgement.

    This is the assertion that makes the change worth making. Two representations of one reading are
    safe only while they are the same expression formatted twice; the moment the JSON were computed
    separately, an evidence file could contradict the log it was written from and nothing would fail.
    Every `reason` below is required to appear **verbatim** in the printed line carrying its id.
    """
    result = run(tmp_path, criteria_fixture(tokens=0.18), '--pairing', 'resolution', '--criteria-json', '1')
    assert result.returncode == 0, result.stderr
    # The block's first key is `bill` since the replication's criteria joined it, so it is located as the
    # first line that opens an object rather than by the name that happened to sort first.
    start = result.stdout.rindex('\n{\n') + 1
    payload = json.loads(result.stdout[start:])
    report = payload['criteria']
    assert sorted(report) == ['G1', 'G2', 'G3', 'G4', 'G5']

    printed = {}
    for line in result.stdout[:start].splitlines():
        head = line.split(' ')[0]
        if head in report:
            # Strip `<id> <verdict><separator>` back to the sentence, which must be the JSON's `reason`.
            rest = line[len(head) + 1 :]
            for separator in (': ', '  '):
                at = rest.find(separator)
                if at != -1:
                    printed[head] = rest[at + len(separator) :]
                    break
    for ident, entry in report.items():
        assert printed[ident] == entry['reason'], (ident, printed[ident], entry['reason'])

    # The canonical three-state, with the magnitude qualifier folded into `fail` rather than into a fourth
    # value: a consumer filtering on `fail` has to see a magnitude miss, because the mechanism worked.
    assert report['G5'] == {
        'verdict': 'fail',
        'reason': 'the paired bill rose 0.18%; the absolute threshold belongs to the reference arm',
    }
    assert report['G3']['verdict'] == 'fail'


# ---------------------------------------------------------------------------------------------------
# `R1`-`R4`: the criteria the third replication was dispatched against, decided by the same script
# ---------------------------------------------------------------------------------------------------

def replication_fixture(
    *,
    mr=(5, 13),
    other=(4, 6),
    tokens=None,
    usage=None,
    capability='MR',
    capabilities=('MR', 'TR'),
):
    """A population whose `resolution` criteria can each be checked by hand.

    `mr` and `other` are `(b, c)` pairs -- questions the baseline got right and the feature did not,
    and the reverse -- and the per-question means are built so that every discordant question lands
    strictly on one side. The census is written in the shape `merge-ablation.mjs` emits: sums, with
    `answerChars` ignored by the reader.
    """
    ids, rows = [], []
    baseline_bits, feature_bits = [], []
    for label, (down, up) in zip(capabilities, (mr, other)):
        for side, count in (('down', down), ('up', up)):
            for index in range(count):
                ids.append(f'{label}-{side}-{index}#w2')
                rows.append(
                    {
                        'questionId': ids[-1],
                        'capability': label,
                        'roleCensus': {'counts': {'user': 15}, 'unclassified': 0, 'total': 15},
                        'promptChars': 38000,
                        # The form split `G1` and `G4` read. Every question is a record here, so `G4`
                        # has a population share to divide the gainers' by.
                        'turnWindowCensus': census(record=15, excerpt=0, raw=0),
                    }
                )
                baseline_bits.append('0' if side == 'up' else '1')
                feature_bits.append('1' if side == 'up' else '0')
    payload = {
        'questionCount': len(ids),
        'runs': 1,
        'population': {'corpora': len(ids), 'windows': 1, 'marker': '#w'},
        # The reader names the shard count on its first line, because a merged population and an
        # unsharded artifact are different objects and a delta over 500 questions split eight ways is
        # not a delta over a run that answered them in one process.
        'merged': {'shards': 8},
        'questions': rows,
        'featureConfig': {'resolutionPair': True},
        'ablation': {
            'baselineCorrectByRun': [''.join(baseline_bits)],
            'featureCorrectByRun': [''.join(feature_bits)],
            # `F3`'s two medians, as the merge carries them: a per-question vector of role censuses and
            # one of prompt sizes, both aligned with the roster.
            'baselineRoleCensuses': [
                {'counts': {'user': 10}, 'unclassified': 0, 'total': 10} for _ in ids
            ],
            'baselinePromptChars': [40000 for _ in ids],
        },
    }
    if tokens is not None:
        payload['tokens'] = {'prompt_per_answer': {'delta_pct': tokens}}
    if usage is not None:
        payload['usageBySide'] = usage
    return payload


def usage_census(calls=100, prompt=100000, hit=90000, completion=10000):
    """One side's usage census, in the shape the artifact writes it.

    Named `usage_census` rather than `census` because this file already has one of those, for the
    turn-window split, and the second definition silently shadowed the first -- eight `G` tests went
    red with `census() got an unexpected keyword argument 'record'`, which is what a name collision
    looks like when both functions take keyword arguments.
    """
    return {
        'calls': calls,
        'unpricedCalls': 0,
        'promptTokens': prompt,
        'completionTokens': completion,
        'cacheHitPromptTokens': hit,
        'answerChars': 1000,
        'truncatedCalls': 0,
    }


def test_r1_reads_the_capability_rather_than_the_population(tmp_path):
    """`R1` is the sign on `MR`, and the whole-population sign is allowed to disagree with it.

    The third replication's population moved `+10` up-down while `KU` moved `-2`: a script that read
    `R1` off the population would call a mechanism that helps one capability and hurts another a
    clean replication, and the retirement rule (three misses and the axis goes) would never fire.
    """
    result = run(tmp_path, replication_fixture(mr=(5, 13), other=(9, 1)), '--pairing', 'resolution')
    assert result.returncode == 0, result.stderr
    assert 'R1 pass  the MR up-down is +8 (b=5 c=13)' in result.stdout

    flipped = run(tmp_path, replication_fixture(mr=(13, 5), other=(1, 9)), '--pairing', 'resolution')
    assert flipped.returncode == 0, flipped.stderr
    assert 'R1 fail: the MR up-down is -8 (b=13 c=5)' in flipped.stdout
    assert 'the axis retires' in flipped.stdout


def test_r2_refuses_to_combine_with_a_dispatch_nobody_named(tmp_path):
    """`unread` rather than a p-value, because the combination's provenance is the claim.

    The fixture below is the third replication's arithmetic: `b=9 c=19` gives `p=0.0872` alone, which
    does not clear 0.05; with `44915923906`'s `15/27` (`p=0.0884`) Fisher's method gives `0.0452`.
    """
    result = run(tmp_path, replication_fixture(), '--pairing', 'resolution')
    assert result.returncode == 0, result.stderr
    assert 'R2 unread: this population alone gives p=' in result.stdout
    assert 'R4 unread: R4 is `R2` and `R3`' in result.stdout

    combined = run(
        tmp_path,
        replication_fixture(),
        '--pairing',
        'resolution',
        '--prior-discordant',
        '15,27',
        '--prior-name',
        '44915923906',
    )
    assert combined.returncode == 0, combined.stderr
    assert 'R2 pass  Fisher with 44915923906: p=0.0452' in combined.stdout, (
        'the combined p-value is the number the adoption decision quotes, so the arithmetic is pinned: '
        'two tests at 0.0872 and 0.0884 combine to 0.0452 on four degrees of freedom'
    )
    assert 'independence assumption' in combined.stdout


def test_a_prior_pair_that_is_not_two_numbers_is_refused(tmp_path):
    result = run(
        tmp_path, replication_fixture(), '--pairing', 'resolution', '--prior-discordant', '15;27'
    )
    assert result.returncode != 0
    assert 'is not two whole numbers' in result.stderr


def test_r3_reads_the_census_when_the_arm_wrote_no_ratio(tmp_path):
    """The bill clause has to be readable on a sharded dispatch, which is every real dispatch.

    `G5` says `unread` for all of them, correctly: the merge does not recompute `tokens`, and `S12`'s
    shape is 500 questions split across jobs. `R3` reads the same clause off `usageBySide`, which the
    merge *does* sum, and prints which of the two it used.
    """
    flat = {'baseline': usage_census(), 'feature': usage_census()}
    result = run(tmp_path, replication_fixture(usage=flat), '--pairing', 'resolution')
    assert result.returncode == 0, result.stderr
    assert 'R3 pass  the paired prompt bill moved +0.00% of +1.00% allowed [usageBySide]' in result.stdout
    # `G5` still says it cannot read the arm's own field, and the two statements are about different
    # sources rather than about different arithmetic.
    assert 'G5 unread' in result.stdout

    dearer = {
        'baseline': usage_census(),
        'feature': usage_census(calls=100, prompt=140000, hit=90000, completion=10000),
    }
    result = run(tmp_path, replication_fixture(usage=dearer), '--pairing', 'resolution')
    assert result.returncode == 0, result.stderr
    assert 'R3 fail: the paired prompt bill moved +40.00% of +1.00% allowed' in result.stdout
    assert 'R4 not-taken' in result.stdout


def test_r4_says_the_price_is_not_the_clause_it_cleared(tmp_path):
    """The finding this round: a token ratio that stays flat while the cache empties.

    The feature side below embeds the same number of prompt tokens and puts 2,148,498 of them outside
    the provider's cache against the baseline's 228,105. `R3`'s registered clause is a token ratio and
    passes; the price index is 1.55x. A script that printed only `R4 fired` would let the next round
    quote this mechanism as free.
    """
    thrash = {
        'baseline': usage_census(calls=1020, prompt=7362839, hit=7134734, completion=1158539),
        'feature': usage_census(calls=1018, prompt=7353298, hit=5204800, completion=987930),
    }
    result = run(
        tmp_path,
        replication_fixture(mr=(5, 13), usage=thrash),
        '--pairing',
        'resolution',
        '--prior-discordant',
        '15,27',
    )
    assert result.returncode == 0, result.stderr
    assert 'R3 pass  the paired prompt bill moved +0.07%' in result.stdout
    assert 'the cache-adjusted price is 1.55x the baseline' in result.stdout
    assert 'does not see' in result.stdout


def test_a_capability_the_population_does_not_have_is_refused(tmp_path):
    # An up-down of zero is what a mechanism that moved nothing and a flag that names nothing look
    # like, and `R1` would read the second as the first.
    result = run(
        tmp_path, replication_fixture(capabilities=('TR',)), '--pairing', 'resolution', '--capability', 'MR'
    )
    assert result.returncode != 0
    assert 'matches no question' in result.stderr
