"""What a competitor's published "context tokens per question" actually counts.

Maximem Synap publishes 95.6% at ~7,400 context tokens per question, against this repository's
91.95% at 12,137. Read as one number against the other that is a 40% price advantage, and it is
what makes "replicate their engine" look like the obvious move. The 500 per-question records the
vendor publishes let the number be taken apart instead of trusted, and the parts do not support
that reading:

- `source_evidence` -- verbatim excerpts -- is **60.3%** of the serialised context, and `memory`,
  the LLM-written summary, is **6.2%**. The system is not a compression engine that spends fewer
  tokens on the same evidence; it spends most of its budget on raw text too.
- **41%** of memory items carry no `source_evidence` at all, so those entries reach the reader as
  a summary with nothing to check it against.
- 7,391 is reproducible as `memory + source_evidence` divided by ~3.6 characters per token, which
  is the content only. The answering prompt alone is a 21.5 kB file. A number that excludes the
  system prompt is not comparable with one that includes it.

The census below is arithmetic on public data. It does not call a model, and it does not need the
vendor's engine, which is closed.
"""

import json
import os
import subprocess
from pathlib import Path

import pytest

TOOL = Path(__file__).resolve().parents[1] / "synap-context-census.mjs"

# The vendor's per-question records are 23 MB of third-party artefacts and are not vendored into
# this repository. Point `SYNAP_RECORDS` at a local copy to run the smoke test; without it the
# reading is the one recorded in `docs/COMPETITOR-SYNAP-DECOMPOSITION.md`, and CI says so by
# skipping rather than by passing a fixture that stands in for a 500-question corpus.
VENDOR_RECORDS = Path(os.environ.get("SYNAP_RECORDS", "/workspace/synap-res/qr.json"))


def _call(expr: str) -> object:
    script = (
        "import { readFileSync } from 'node:fs';\n"
        f"import {{ contextCensus, summarise, evidenceShape, explainHeadline, parseRecords }} "
        f"from {json.dumps(TOOL.as_uri())};\n"
        f"process.stdout.write(JSON.stringify(({expr})));"
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def _item(memory: str, evidence: list | None = None, **fields) -> dict:
    """One retrieved memory, shaped as the vendor's published records shape it."""
    item = {
        "id": "0" * 36,
        "memory": memory,
        "score": 0.9,
        "source": "vector",
        "metadata": {"scope": "user", "similarity_score": 0.8, "rank_score": 0.5},
        "context_type": "fact",
        "event_date": None,
        "said_at": "2023-05-25 20:21:00",
        "event_end": None,
        "event_precision": None,
        "valid_until": None,
        "temporal_category": "episode",
        "extracted_at": "2026-10-13 13:39:55+00:00",
    }
    if evidence is not None:
        item["source_evidence"] = evidence
    item.update(fields)
    return item


def _record(items: list, question_id: str = "q1") -> dict:
    return {
        "question_id": question_id,
        "retrieval": {"question_id": question_id, "retrieved_context": items},
    }


class TestContextCensus:
    def test_material_is_memory_plus_evidence_and_serialised_is_everything(self):
        # The two sizes answer different questions: what the reader spends versus what it reads.
        items = [_item("a" * 100, ["b" * 400])]
        row = _call(f"contextCensus({json.dumps([_record(items)])})[0]")
        assert row["items"] == 1
        assert row["material"] == 500
        assert row["serialised"] > row["material"]

    def test_an_item_without_evidence_contributes_only_its_summary(self):
        # 41% of published items are like this. Counting them as content would inflate the reading.
        items = [_item("a" * 100), _item("c" * 50, ["d" * 50])]
        row = _call(f"contextCensus({json.dumps([_record(items)])})[0]")
        assert row["items"] == 2
        assert row["withEvidence"] == 1
        assert row["material"] == 200

    def test_a_record_with_no_context_reports_null_rather_than_zero(self):
        # Nothing retrieved and nothing to measure are different claims, and a median over zeros
        # would let a failed retrieval look like a cheap one.
        rows = _call(f"contextCensus({json.dumps([_record([])])})")
        assert rows[0]["items"] == 0
        assert rows[0]["material"] is None
        assert rows[0]["serialised"] is None

    def test_material_excludes_the_field_skeleton(self):
        # `id`, `score`, `metadata`, `said_at` and friends are carried per item. They are part of
        # the serialised size and not part of the content, which is exactly the difference the
        # vendor's headline depends on.
        bare = _call(f"contextCensus({json.dumps([_record([_item('a' * 10)])])})[0]")
        assert bare["material"] == 10
        assert bare["fields"] > 200


class TestEvidenceShape:
    def test_evidence_pieces_are_counted_with_their_lengths(self):
        items = [
            _item("m", ["(said May 25, 2023) " + "x" * 2000]),
            _item("m", ["(said May 26, 2023) " + "y" * 1000]),
        ]
        shape = _call(f"evidenceShape({json.dumps([_record(items)])})")
        assert shape["pieces"] == 2
        # `"(said May 25, 2023) "` is 20 characters, so the pieces are 2,020 and 1,020, and the
        # median of two is their midpoint -- not either one of them.
        assert shape["median"] == 1520
        assert shape["itemsWithoutEvidence"] == 0

    def test_a_missing_evidence_key_is_not_an_empty_excerpt(self):
        # An absent key means the system stored no excerpt; an empty list means it tried and got
        # nothing. Both leave the reader with a summary, and both are counted here.
        items = [_item("m"), _item("m", [])]
        shape = _call(f"evidenceShape({json.dumps([_record(items)])})")
        assert shape["pieces"] == 0
        assert shape["itemsWithoutEvidence"] == 2
        assert shape["median"] is None

    def test_a_non_string_excerpt_is_skipped_rather_than_crashing(self):
        items = [_item("m", ["ok", 7])]
        shape = _call(f"evidenceShape({json.dumps([_record(items)])})")
        assert shape["pieces"] == 1


class TestExplainHeadline:
    def test_the_headline_is_reproduced_from_the_content_size(self):
        # If a census reads 26,460 material characters per question, then 7,391 tokens implies
        # 3.58 characters per token -- the content-only reading.
        census = {"material": 26_460, "serialised": 40_071, "items": 18}
        out = _call(f"explainHeadline({json.dumps(census)}, 7391)")
        assert out["charsPerTokenIfContent"] == round(26_460 / 7391, 2)
        assert out["reading"] == "content-only"

    def test_a_serialised_reading_is_named_rather_than_forced(self):
        # The same headline against the full serialisation implies ~5.4 characters per token,
        # which no English tokenizer produces. The function must say so instead of picking the
        # flattering interpretation.
        census = {"material": 26_460, "serialised": 40_071, "items": 18}
        out = _call(f"explainHeadline({json.dumps(census)}, 7391)")
        assert out["charsPerTokenIfSerialised"] == round(40_071 / 7391, 2)
        assert out["serialisedReading"] == "implausible"

    def test_a_missing_material_size_yields_no_reading(self):
        out = _call("explainHeadline({material: null, serialised: null, items: 0}, 7391)")
        assert out["reading"] is None
        assert out["charsPerTokenIfContent"] is None


class TestSummarise:
    def test_the_median_is_taken_over_questions_not_items(self):
        # A question with 40 items must not outweigh one with 2: the published headline is a
        # per-question median, so the census has to use the same unit or it is not comparable.
        census = [
            {"items": 40, "material": 80_000, "serialised": 120_000, "withEvidence": 40},
            {"items": 2, "material": 2_000, "serialised": 3_000, "withEvidence": 0},
        ]
        out = _call(f"summarise({json.dumps(census)})")
        assert out["questions"] == 2
        assert out["medianItems"] == 21
        assert out["medianMaterial"] == 41_000

    def test_a_census_with_no_measurable_question_returns_nulls(self):
        out = _call("summarise([{items: 0, material: null, serialised: null, withEvidence: 0}])")
        assert out["medianMaterial"] is None
        assert out["medianItems"] == 0

    def test_the_share_of_items_carrying_an_excerpt_is_reported(self):
        census = [
            {"items": 10, "material": 100, "serialised": 200, "withEvidence": 6},
            {"items": 10, "material": 100, "serialised": 200, "withEvidence": 4},
        ]
        out = _call(f"summarise({json.dumps(census)})")
        assert out["itemsTotal"] == 20
        assert out["withEvidenceTotal"] == 10
        assert out["evidenceShare"] == 0.5


@pytest.mark.skipif(
    not VENDOR_RECORDS.exists(),
    reason="vendor per-question records are not vendored; set SYNAP_RECORDS to a local copy",
)
class TestPublishedRecords:
    """The reading this document quotes, recomputed from the artefact it quotes it from."""

    def test_the_headline_is_a_content_only_count(self):
        out = _call(
            f"(() => {{"
            f"  const raw = readFileSync({json.dumps(str(VENDOR_RECORDS))}, 'utf8');"
            f"  const parsed = parseRecords(raw);"
            f"  const s = summarise(contextCensus(parsed.records));"
            f"  return {{ parsed: parsed.parsed, census: s, shape: evidenceShape(parsed.records),"
            f"    headline: explainHeadline({{ material: s.medianMaterial,"
            f"    serialised: s.medianSerialised, items: s.medianItems }}, 7391) }};"
            f"}})()"
        )
        assert out["parsed"] >= 200
        # 7,391 tokens against the content reproduces an ordinary English characters-per-token
        # ratio. Against the whole record it does not, and the tool names that rather than
        # averaging the two.
        assert out["headline"]["reading"] == "content-only"
        assert out["headline"]["serialisedReading"] == "implausible"
        assert 3.0 <= out["headline"]["charsPerTokenIfContent"] <= 4.5
        # Most items carry an excerpt and a large minority do not.
        assert 0.5 < out["census"]["evidenceShare"] < 0.65
        assert out["shape"]["itemsWithoutEvidence"] > 0


class TestCommandLine:
    def test_no_argument_prints_usage_and_exits_two(self):
        # Exit 2 for "the command was called wrong", distinct from 1 for "the reading failed":
        # a caller that treats both as failure cannot tell a typo from a broken artefact.
        result = subprocess.run(
            ["node", str(TOOL)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 2
        assert "usage:" in result.stderr

    @pytest.mark.skipif(
        not VENDOR_RECORDS.exists(),
        reason="vendor per-question records are not vendored; set SYNAP_RECORDS to a local copy",
    )
    def test_a_real_file_prints_both_readings(self):
        result = subprocess.run(
            ["node", str(TOOL), str(VENDOR_RECORDS)],
            capture_output=True,
            text=True,
            check=True,
        )
        assert "as content" in result.stdout
        assert "as whole record" in result.stdout
        assert "content-only" in result.stdout
