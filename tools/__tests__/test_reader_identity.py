#!/usr/bin/env python3
"""The reading stage's self-description is part of the measurement, so it is tested like one.

## The defect this file is written against

`competitor-retrieval.yml` forwarded no `TEMPERATURE` to the harness, so `createLlmFromEnv` built the reader with
`temperature: null` and the request carried no sampling field: every T1 row ever read was served at the provider's
default. Nothing in the artifact said so, because the reader was named by a template literal that did not include
the temperature.

The cost is measurable and it was measured. Run `43178388235` read the same control arm twice on the same twenty
questions and moved **13 -> 11** (per-question agreement 80.0%), which fails `H5`'s 90% and is twice the inter-arm
difference the run existed to detect. `PREREGISTRATION` §13.118 records the same dispersion from the same cause on
the product axis, and §13.127 records what is left when it is pinned: on 379 byte-identical prompts, 19 verdicts
still moved (5.0%).

## Why the mapping lives in a module

Because a name assembled inline cannot be checked without a key and a dataset, and this repository's failure mode is
precisely the un-inspected string. `tools/reader-identity.mjs` is three pure functions; this file runs them through
node and asserts the mapping, so `null -> default` and `0 -> 0` cannot silently collapse into one spelling.

## What this deliberately does not check

Whether the provider honours the field. That is `reader-temperature.ts`'s contract and it is tested there; what is
asserted here is that the request is described the way it was made.
"""

from __future__ import annotations

import json
import pathlib
import subprocess

REPO = pathlib.Path(__file__).resolve().parents[2]
MODULE = REPO / "tools" / "reader-identity.mjs"


def _call(expression: str):
    """Evaluate one expression against the module and return its JSON-decoded value."""
    script = (
        "import { temperatureLabel, describeReaderIdentity, "
        "describeJudgeIdentity, NO_READER } "
        f"from {json.dumps(MODULE.as_uri())};\n"
        f"process.stdout.write(JSON.stringify({expression}));\n"
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


class TestTheTemperatureIsNeverOmitted:
    def test_an_absent_temperature_reads_default(self):
        # The value `readTemperature` returns when the environment asked for nothing. Writing `0`
        # here would retro-fit determinism onto a run that never had it -- the exact
        # mis-description this whole round is about.
        assert _call("temperatureLabel(null)") == "temp=default"

    def test_a_pinned_zero_reads_zero(self):
        # And it has to differ from the line above, because the two are different requests.
        assert _call("temperatureLabel(0)") == "temp=0"

    def test_a_fractional_temperature_survives_the_round_trip(self):
        assert _call("temperatureLabel(0.3)") == "temp=0.3"

    def test_the_absent_and_the_pinned_label_are_distinguishable(self):
        absent = _call("temperatureLabel(null)")
        pinned = _call("temperatureLabel(0)")
        assert absent != pinned


class TestTheIdentitiesCarryTheWholeRequest:
    def test_the_reader_names_the_model_the_prompt_the_temperature_and_the_call_count(self):
        name = _call(
            "describeReaderIdentity({model: 'deepseek-chat', mode: 'con', temperature: 0})"
        )
        assert name == "deepseek-chat (chain-of-note/con, temp=0, one request)"

    def test_the_judge_names_its_own_template_set_and_the_temperature(self):
        name = _call("describeJudgeIdentity({model: 'deepseek-chat', temperature: 0})")
        assert name == "deepseek-chat (official per-type templates, temp=0)"

    def test_two_runs_at_different_temperatures_do_not_compare_equal(self):
        # `comparability()` compares these strings and treats a difference as hard. If the label
        # omitted the temperature, a run at 0 and a run at the provider default would be graded `A`
        # against each other, which is how the campaign came to quote a 55.0% row that was never
        # deterministic.
        pinned = _call("describeReaderIdentity({model: 'm', mode: 'con', temperature: 0})")
        absent = _call("describeReaderIdentity({model: 'm', mode: 'con', temperature: null})")
        assert pinned != absent


class TestTheNonReadingStagesStayUnannotated:
    def test_a_retrieval_only_stage_names_no_model(self):
        # A stage that did not read must not carry a temperature: it would claim a request it
        # never made, and the table would show two different `none` spellings for one state.
        assert _call("NO_READER") == "none (retrieval only)"


class TestTheHarnessUsesTheModule:
    """The module is only worth testing if the harness routes through it."""

    def test_the_harness_imports_all_three_describers(self):
        source = (REPO / "tools" / "competitor-harness.mjs").read_text()
        assert "describeReaderIdentity" in source
        assert "describeJudgeIdentity" in source
        assert "NO_READER" in source

    def test_the_harness_does_not_assemble_the_reader_name_inline(self):
        # The removal test: the old spelling is gone. If someone reintroduces a template literal,
        # `temp=` would stop being produced by the module and this is what notices.
        source = (REPO / "tools" / "competitor-harness.mjs").read_text()
        assert "(chain-of-note/${readerMode}, one request)" not in source
        assert "(official per-type templates)" not in source
