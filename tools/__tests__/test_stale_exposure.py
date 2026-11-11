#!/usr/bin/env python3
"""The exposure instrument's own gates, on synthetic artifacts and a synthetic dataset.

## What is being pinned

`tools/stale-exposure.py` decides whether the supersession pass is aimed at the population it claims. Its
output is one sentence -- *the correction is in the window, the reader does not use it* -- and that sentence is
false in three different ways that each look like a healthy reading:

1. **A window that was never recorded read as an empty window.** Every question would land in `neither` and the
   instrument would report a total retrieval failure as a finding rather than a missing column.
2. **A missing dataset entry skipped rather than refused.** The remaining questions are not a sample of the
   roster; they are the ones the dataset happens to answer for, and a rate over them cannot be compared to a
   rate over the roster.
3. **A date attached by position instead of by session id.** The two ends of an update question are told apart
   by their dates alone, so one misattributed date inverts `inverted` and the last word for that question --
   silently, in the direction that manufactures a recency explanation.

The four states, the two orderings, and the token lower bound are each pinned to a hand-built case whose answer
is known without running the tool.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1]


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), TOOLS / f"{name}.py")
    if spec is None or spec.loader is None:  # pragma: no cover - a broken checkout, not a defect
        raise ImportError(name)
    module = importlib.util.module_from_spec(spec)
    # Before execution, because `@dataclass` resolves annotations through `sys.modules[cls.__module__]`.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


exposure_tool = _load("stale-exposure")


def turn(role: str, content: str) -> dict:
    return {"role": role, "content": content}


def question(
    *,
    question_id: str = "q1",
    sessions: list[list[dict]],
    dates: list[str] | None = None,
    answer_indices: list[int] | None = None,
) -> dict:
    """A dataset question whose haystack is exactly the sessions given, so positions are readable."""
    ids = [f"s{index}" for index in range(len(sessions))]
    return {
        "question_id": question_id,
        "question_type": "knowledge-update",
        "question": "q?",
        "answer": "a",
        "haystack_session_ids": ids,
        "haystack_dates": dates or [f"2023/01/0{index + 1} (Sun) 00:00" for index in range(len(sessions))],
        "haystack_sessions": sessions,
        "answer_session_ids": [ids[index] for index in (answer_indices or [0, len(sessions) - 1])],
    }


def window(*bodies: tuple[str, str]) -> list[dict]:
    """A recorded window from `(date, content)` pairs, rendered the way the arm renders them."""
    return [{"index": index, "text": f"[{date}] user: {content}"} for index, (date, content) in enumerate(bodies)]


def record(*, question_id: str = "q1", turns: list[dict] | None, correct: bool = False, ground_truth: str = "a"):
    return {
        "questionId": question_id,
        "capability": "KU",
        "correct": correct,
        "groundTruth": ground_truth,
        "turns": turns,
    }


class TextTest(unittest.TestCase):
    def test_body_strips_the_rendered_prefix(self) -> None:
        self.assertEqual(exposure_tool.body("[2023/05/23 (Tue) 13:01] user:  hello   there "), "hello there")

    def test_body_keeps_a_turn_without_a_prefix_whole(self) -> None:
        # The safe direction: a missed strip can only fail to match, never match the wrong turn.
        self.assertEqual(exposure_tool.body("plain  content"), "plain content")

    def test_body_strips_an_assistant_prefix_too(self) -> None:
        self.assertEqual(exposure_tool.body("[d] assistant: x"), "x")

    def test_normalise_collapses_a_line_wrap(self) -> None:
        self.assertEqual(exposure_tool.normalise("a\n  b\tc"), "a b c")


class ClassifyTest(unittest.TestCase):
    def test_both(self) -> None:
        self.assertEqual(exposure_tool.classify([True, True]), "both")

    def test_neither(self) -> None:
        self.assertEqual(exposure_tool.classify([False, False]), "neither")

    def test_later_only(self) -> None:
        self.assertEqual(exposure_tool.classify([False, True]), "later-only")

    def test_earlier_only(self) -> None:
        self.assertEqual(exposure_tool.classify([True, False]), "earlier-only")

    def test_single_session_is_its_own_state(self) -> None:
        # An update question needs two ends; one end cannot be described as stale or corrected.
        self.assertEqual(exposure_tool.classify([True]), "single-session")


class AnswerSessionTest(unittest.TestCase):
    def test_dates_come_from_the_session_id_and_not_from_position(self) -> None:
        q = question(
            sessions=[[turn("user", "old")], [turn("user", "new")]],
            dates=["2023/01/01 (Sun) 00:00", "2023/02/01 (Wed) 00:00"],
            answer_indices=[1, 0],
        )
        sessions = exposure_tool.answer_sessions(q)
        self.assertEqual([session.date for session in sessions], ["2023/02/01 (Wed) 00:00", "2023/01/01 (Sun) 00:00"])

    def test_a_ragged_haystack_is_refused(self) -> None:
        q = question(sessions=[[turn("user", "a")], [turn("user", "b")]])
        q["haystack_dates"] = q["haystack_dates"][:1]
        with self.assertRaises(SystemExit):
            exposure_tool.answer_sessions(q)

    def test_an_unknown_answer_session_is_refused(self) -> None:
        q = question(sessions=[[turn("user", "a")]])
        q["answer_session_ids"] = ["s9"]
        with self.assertRaises(SystemExit):
            exposure_tool.answer_sessions(q)

    def test_a_question_with_no_answer_session_is_refused(self) -> None:
        q = question(sessions=[[turn("user", "a")]])
        q["answer_session_ids"] = []
        with self.assertRaises(SystemExit):
            exposure_tool.answer_sessions(q)


class WindowTest(unittest.TestCase):
    def test_an_unrecorded_window_is_refused(self) -> None:
        with self.assertRaises(SystemExit):
            exposure_tool.window_bodies(record(turns=None))

    def test_an_empty_recorded_window_is_not_refused(self) -> None:
        # Empty is a fact about the run; absent is a fact about the writer. Only the second is an error.
        self.assertEqual(exposure_tool.window_bodies(record(turns=[])), [])


class ExposureTest(unittest.TestCase):
    def setUp(self) -> None:
        self.question = question(
            sessions=[
                [turn("user", "old value is 10"), turn("user", "still 10")],
                [turn("user", "corrected value is 20")],
            ],
            dates=["2023/01/01 (Sun) 00:00", "2023/03/01 (Wed) 00:00"],
        )

    def test_both_statements_present_is_a_reading_failure(self) -> None:
        row = exposure_tool.exposure(
            record(turns=window(("d1", "old value is 10"), ("d2", "corrected value is 20")), correct=False),
            self.question,
        )
        self.assertEqual(row.state, "both")
        self.assertTrue(row.reading_failure)

    def test_both_present_and_correct_is_not_a_reading_failure(self) -> None:
        row = exposure_tool.exposure(
            record(turns=window(("d1", "old value is 10"), ("d2", "corrected value is 20")), correct=True),
            self.question,
        )
        self.assertEqual(row.state, "both")
        self.assertFalse(row.reading_failure)

    def test_a_missing_correction_is_earlier_only(self) -> None:
        row = exposure_tool.exposure(record(turns=window(("d1", "old value is 10")), correct=False), self.question)
        self.assertEqual(row.state, "earlier-only")
        self.assertFalse(row.reading_failure)

    def test_a_missing_obsolete_statement_is_later_only(self) -> None:
        row = exposure_tool.exposure(
            record(turns=window(("d2", "corrected value is 20")), correct=False), self.question
        )
        self.assertEqual(row.state, "later-only")

    def test_neither(self) -> None:
        row = exposure_tool.exposure(record(turns=window(("d3", "unrelated")), correct=False), self.question)
        self.assertEqual(row.state, "neither")

    def test_chronological_order_is_not_inverted(self) -> None:
        row = exposure_tool.exposure(
            record(turns=window(("d1", "old value is 10"), ("d2", "corrected value is 20"))), self.question
        )
        self.assertFalse(row.inverted)
        self.assertFalse(row.obsolete_has_last_word)

    def test_an_obsolete_statement_after_the_correction_is_inverted_and_has_the_last_word(self) -> None:
        row = exposure_tool.exposure(
            record(turns=window(("d2", "corrected value is 20"), ("d1", "old value is 10"))), self.question
        )
        self.assertTrue(row.inverted)
        self.assertTrue(row.obsolete_has_last_word)

    def test_the_correction_first_and_again_last_is_inverted_without_the_obsolete_last_word(self) -> None:
        # Inverted is about *first* appearances; the last word is about *final* positions. A window that opens
        # with the correction, drops to the obsolete value, and returns to the correction is inverted and still
        # ends on the correction -- which is why these are two columns and not one.
        row = exposure_tool.exposure(
            record(
                turns=window(
                    ("d2", "corrected value is 20"),
                    ("d1", "old value is 10"),
                    ("d2", "corrected value is 20"),
                )
            ),
            self.question,
        )
        self.assertTrue(row.inverted)
        self.assertFalse(row.obsolete_has_last_word)

    def test_a_missing_end_makes_both_orderings_inapplicable(self) -> None:
        row = exposure_tool.exposure(record(turns=window(("d1", "old value is 10"))), self.question)
        self.assertFalse(row.inverted)
        self.assertFalse(row.obsolete_has_last_word)

    def test_numeric_tokens_of_the_answer_are_counted(self) -> None:
        row = exposure_tool.exposure(
            record(turns=window(("d2", "it is 27 minutes and 45 seconds")), ground_truth="27 minutes and 45 seconds"),
            self.question,
        )
        self.assertEqual((row.gold_tokens_present, row.gold_tokens_total), (2, 2))

    def test_an_answer_without_a_number_reports_no_tokens(self) -> None:
        # `seven` is a real LongMemEval answer and this matcher cannot see it; the column is a lower bound and
        # `wrong_without_number` exists so the report can say how much of the population it could not judge.
        row = exposure_tool.exposure(
            record(turns=window(("d2", "seven")), ground_truth="seven"), self.question
        )
        self.assertEqual((row.gold_tokens_present, row.gold_tokens_total), (0, 0))


class DatasetTest(unittest.TestCase):
    def _write(self, payload) -> Path:
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(payload, handle)
        handle.close()
        return Path(handle.name)

    def test_a_duplicate_id_is_refused(self) -> None:
        path = self._write([question(question_id="a", sessions=[[turn("user", "x")]]),
                            question(question_id="a", sessions=[[turn("user", "y")]])])
        with self.assertRaises(SystemExit):
            exposure_tool.load_dataset(path)

    def test_a_question_without_an_id_is_refused(self) -> None:
        path = self._write([{"question": "q"}])
        with self.assertRaises(SystemExit):
            exposure_tool.load_dataset(path)

    def test_an_empty_dataset_is_refused(self) -> None:
        with self.assertRaises(SystemExit):
            exposure_tool.load_dataset(self._write([]))


class ReadTest(unittest.TestCase):
    def _artifacts(self, *, dataset_ids: list[str], artifact_ids: list[str], turns: list[dict] | None = None):
        dataset = [
            question(question_id=key, sessions=[[turn("user", f"old {key}")], [turn("user", f"new {key}")]])
            for key in dataset_ids
        ]
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(dataset, handle)
        handle.close()
        artifact = {
            "questions": [
                record(
                    question_id=key,
                    turns=turns
                    if turns is not None
                    else window(("d1", f"old {key}"), ("d2", f"new {key}")),
                    correct=False,
                )
                for key in artifact_ids
            ]
        }
        artifact_handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(artifact, artifact_handle)
        artifact_handle.close()
        return Path(artifact_handle.name), Path(handle.name)

    def test_a_question_absent_from_the_dataset_is_refused(self) -> None:
        artifact, dataset = self._artifacts(dataset_ids=["a"], artifact_ids=["a", "b"])
        with self.assertRaises(SystemExit):
            exposure_tool.read(artifact, dataset)

    def test_the_counts_are_right_on_two_questions(self) -> None:
        artifact, dataset = self._artifacts(dataset_ids=["a", "b"], artifact_ids=["a", "b"])
        result = exposure_tool.read(artifact, dataset)
        self.assertEqual(result["questions"], 2)
        self.assertEqual(result["both"], 2)
        self.assertEqual(result["retrieval_attributable"], 0)
        self.assertEqual(result["reading_failures"], 2)

    def test_only_filters_the_capability(self) -> None:
        artifact, dataset = self._artifacts(dataset_ids=["a"], artifact_ids=["a"])
        payload = json.loads(artifact.read_text())
        payload["questions"][0]["capability"] = "TR"
        artifact.write_text(json.dumps(payload))
        self.assertEqual(exposure_tool.read(artifact, dataset, only="KU")["questions"], 0)


class StableTest(unittest.TestCase):
    def test_no_recorded_masks_yields_none(self) -> None:
        self.assertIsNone(exposure_tool.stable_failures({"questions": []}, 1))

    def test_a_ragged_mask_is_refused(self) -> None:
        # Positional masks: one shifted entry credits the wrong question's answer to the wrong window.
        with self.assertRaises(SystemExit):
            exposure_tool.stable_failures({"ablation": {"featureCorrectByRun": [[1, 0]]}}, 3)

    def test_a_question_right_once_is_not_stable(self) -> None:
        masks = {"ablation": {"featureCorrectByRun": [[1, 0], [0, 0]]}}
        self.assertEqual(exposure_tool.stable_failures(masks, 2), [1])

    def test_stable_positions_are_mapped_through_the_filtered_roster(self) -> None:
        # The roster starts with a `TR` question, so the `KU` rows begin at position 1. A tool that indexed the
        # filtered list with a roster position would read the wrong question and report a healthy split.
        dataset = [
            question(question_id="t", sessions=[[turn("user", "old t")], [turn("user", "new t")]]),
            question(question_id="k", sessions=[[turn("user", "old k")], [turn("user", "new k")]]),
        ]
        artifact = {
            "questions": [
                {**record(question_id="t", turns=window(("d1", "old t"), ("d2", "new t")), correct=True),
                 "capability": "TR"},
                record(question_id="k", turns=window(("d1", "old k"), ("d2", "new k")), correct=False),
            ],
            "ablation": {"featureCorrectByRun": [[1, 0], [1, 0]]},
        }
        dataset_path = Path(tempfile.mkdtemp()) / "dataset.json"
        artifact_path = dataset_path.parent / "artifact.json"
        dataset_path.write_text(json.dumps(dataset))
        artifact_path.write_text(json.dumps(artifact))
        result = exposure_tool.read(artifact_path, dataset_path)
        self.assertEqual(result["stable"]["n"], 1)
        self.assertEqual(result["stable"]["both"], 1)

    def test_a_stable_failure_outside_the_capability_is_not_counted(self) -> None:
        dataset = [question(question_id="t", sessions=[[turn("user", "old t")], [turn("user", "new t")]])]
        artifact = {
            "questions": [
                {**record(question_id="t", turns=window(("d1", "old t"), ("d2", "new t")), correct=False),
                 "capability": "TR"},
            ],
            "ablation": {"featureCorrectByRun": [[0], [0]]},
        }
        dataset_path = Path(tempfile.mkdtemp()) / "dataset.json"
        artifact_path = dataset_path.parent / "artifact.json"
        dataset_path.write_text(json.dumps(dataset))
        artifact_path.write_text(json.dumps(artifact))
        self.assertEqual(exposure_tool.read(artifact_path, dataset_path)["stable"]["n"], 0)


class ReportTest(unittest.TestCase):
    def test_the_report_names_the_retrieval_count_and_the_ordering_groups(self) -> None:
        result = {
            "capability": "KU",
            "questions": 2,
            "states": {"both": 1, "neither": 1},
            "both": 1,
            "retrieval_attributable": 1,
            "reading_failures": 1,
            "ordering": {
                "all": {"n": 2, "inverted": 0, "obsolete_has_last_word": 0},
                "correct": {"n": 1, "inverted": 0, "obsolete_has_last_word": 0},
                "wrong": {"n": 1, "inverted": 0, "obsolete_has_last_word": 0},
            },
            "gold_tokens": {
                "wrong": 1,
                "wrong_with_any": 0,
                "wrong_with_all": 0,
                "wrong_without_any": 1,
                "wrong_without_number": 0,
            },
            "rows": [],
        }
        text = exposure_tool.report(result)
        self.assertIn("1/2", text)
        self.assertIn("reading failures", text)
        self.assertIn("| wrong | 1 |", text)
        self.assertIn("lower bound", text)

    def test_the_report_renders_the_stable_split_when_the_masks_are_there(self) -> None:
        result = {
            "capability": "KU",
            "questions": 1,
            "states": {"both": 1},
            "both": 1,
            "retrieval_attributable": 0,
            "reading_failures": 1,
            "stable": {
                "n": 1,
                "both": 1,
                "earlier_only": 0,
                "later_only": 0,
                "neither": 0,
                "inverted": 0,
                "obsolete_has_last_word": 0,
            },
            "ordering": {
                "all": {"n": 1, "inverted": 0, "obsolete_has_last_word": 0},
                "correct": {"n": 0, "inverted": 0, "obsolete_has_last_word": 0},
                "wrong": {"n": 1, "inverted": 0, "obsolete_has_last_word": 0},
            },
            "gold_tokens": {
                "wrong": 1,
                "wrong_with_any": 1,
                "wrong_with_all": 1,
                "wrong_without_any": 0,
                "wrong_without_number": 0,
            },
            "rows": [],
        }
        self.assertIn("1/1 stable failures carry both statements", exposure_tool.report(result))

    def test_the_report_says_so_when_the_masks_are_absent(self) -> None:
        result = {
            "capability": "KU",
            "questions": 0,
            "states": {},
            "both": 0,
            "retrieval_attributable": 0,
            "reading_failures": 0,
            "stable": None,
            "ordering": {
                "all": {"n": 0, "inverted": 0, "obsolete_has_last_word": 0},
                "correct": {"n": 0, "inverted": 0, "obsolete_has_last_word": 0},
                "wrong": {"n": 0, "inverted": 0, "obsolete_has_last_word": 0},
            },
            "gold_tokens": {
                "wrong": 0,
                "wrong_with_any": 0,
                "wrong_with_all": 0,
                "wrong_without_any": 0,
                "wrong_without_number": 0,
            },
            "rows": [],
        }
        self.assertIn("cannot be made", exposure_tool.report(result))


class MainTest(unittest.TestCase):
    def test_json_output_is_parseable(self) -> None:
        dataset = [question(question_id="a", sessions=[[turn("user", "old")], [turn("user", "new")]])]
        artifact = {"questions": [record(question_id="a", turns=window(("d1", "old"), ("d2", "new")))]}
        dataset_path = Path(tempfile.mkdtemp()) / "dataset.json"
        artifact_path = dataset_path.parent / "artifact.json"
        dataset_path.write_text(json.dumps(dataset))
        artifact_path.write_text(json.dumps(artifact))
        # The tool prints; capturing stdout is the only way to assert the CLI contract from here.
        import contextlib
        import io

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = exposure_tool.main(
                ["--artifact", str(artifact_path), "--dataset", str(dataset_path), "--json"]
            )
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(buffer.getvalue())["both"], 1)


if __name__ == "__main__":
    unittest.main()
