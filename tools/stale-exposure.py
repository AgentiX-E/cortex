#!/usr/bin/env python3
"""Measure what a `KU` window actually contains: the obsolete statement, the correction, or both.

## Why this is a tool and not a paragraph

`MEASURE-PAIRED-POWER.md` and §13.366 justify the supersession pass by an argument that has never been a column:
*the correction is already in front of the reader; the reader does not treat it as a correction.* That sentence
is load-bearing. If it were false -- if the corrective turn were simply not retrieved for most of the failing
questions -- then a prompt-level pass could not help, the mechanism would be aimed at the wrong population, and
the six-point conversion bar in §13.366.1 would be unreachable by construction rather than by outcome.

So the claim is measured here, off the artifact, at zero cost, before the arm's read is believed. The artifact
already records the exact turn texts the reader was given (`questions[].turns[]`), and the dataset already
records which sessions hold the two values of an update question (`answer_session_ids`). Presence is therefore
a matter of comparing two lists of strings, not a matter of judgement.

## The three facts it separates

For every `KU` question the tool puts each answer session into one of four states -- `both`, `later-only`,
`earlier-only`, `neither` -- where "later" and "earlier" are the dates of the two answer sessions. Only `both`
is a reading failure; the other three are retrieval failures, and no prompt can reach them. The population is
counted, not assumed.

It then asks two questions that the ordering of the window settles on its own:

- **inversion** -- does the reader meet the correction before the statement it replaces? A window read
  chronologically ends with the correction, so inversion is the arrangement under which a recency preference
  produces the stale answer. Counting it tests that explanation instead of assuming it.
- **the last word** -- is the obsolete statement the last thing in the window? This is the sharpest form of the
  same explanation: the reader's final piece of evidence is the value it must not use.

## What it refuses

- **A question the dataset does not carry.** The join is by `question_id`; a roster entry with no dataset entry
  is an error, because the alternative is skipping the question and reporting a rate over a population chosen by
  the data's absence.
- **An answer session id the question's own haystack does not carry**, for the same reason one step down.
- **An artifact with no recorded turns.** A window that was not written down is not a window that was empty, and
  reading it as empty would manufacture exactly the retrieval failure this tool exists to rule out. The artifact
  must be one whose per-question records carry `turns`.

It does *not* refuse a question whose window turns do not match the dataset byte for byte. The arm truncates
long turns to its own budget, so per-turn agreement is partial by design; presence needs one matching turn, and
one is enough. The consequence is stated in the output rather than hidden: presence is exact, so the count of
`both` is a **lower** bound on how many windows carried both statements.

Usage:

    python3 tools/stale-exposure.py --artifact <control>.json --dataset data/longmemeval_s_cleaned.json
    python3 tools/stale-exposure.py --artifact A.json --dataset D.json --only TR --json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# The capability whose windows carry a value that a later statement replaces. Everything else in LongMemEval
# asks for a fact that no later turn revises, so the same measurement there would count retrieval and label it
# supersession.
DEFAULT_ONLY = "KU"

# A rendered turn in the artifact opens with its date and speaker: `[2023/05/23 (Tue) 13:01] user: ...`. The
# body is what has to be compared against the dataset, and the date is redundant with the session's own date --
# so it is stripped rather than parsed. A turn whose prefix does not match is compared whole, which is the safe
# direction: a missed strip can only fail to match, never match something it should not.
_RENDER_PREFIX = re.compile(r"^\[[^\]]*\]\s*(?:user|assistant|system):\s*", re.IGNORECASE)

# Numeric tokens in a gold answer: `6:00 pm`, `25:50`, `$400,000`, `5-2`, `1300`. Deliberately narrow. The
# column is printed as a **lower bound** because LongMemEval also answers with words (`seven`, `five`) and with
# noun phrases, and a matcher broad enough to catch those would need the reader's judgement, which is the thing
# under test.
_GOLD_TOKEN = re.compile(r"\d[\d:,./-]*\d|\d")


def normalise(text: str) -> str:
    """Whitespace-collapsed text, so a line wrap in the writer is not read as a different turn."""
    return re.sub(r"\s+", " ", text).strip()


def body(text: str) -> str:
    """A window turn's text without its `[date] role:` prefix."""
    return normalise(_RENDER_PREFIX.sub("", text, count=1))


@dataclass(frozen=True)
class AnswerSession:
    """One of the sessions that carry a value for the question, and whether the window showed it."""

    session_id: str
    date: str
    turns_in_window: int
    turns_in_session: int

    @property
    def present(self) -> bool:
        return self.turns_in_window > 0


@dataclass(frozen=True)
class Exposure:
    """One question's window, reduced to the facts the four states and the two orderings need."""

    question_id: str
    state: str
    sessions: list[AnswerSession]
    inverted: bool
    obsolete_has_last_word: bool
    gold_tokens_present: int
    gold_tokens_total: int
    correct: bool

    @property
    def reading_failure(self) -> bool:
        """Wrong answer with both statements in the window: the only state a prompt can reach."""
        return self.state == "both" and not self.correct


def load_dataset(path: Path) -> dict[str, dict[str, Any]]:
    """The dataset keyed by `question_id`, refusing duplicates."""
    records = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(records, list) or not records:
        raise SystemExit(f"{path}: expected a list of questions")
    keyed: dict[str, dict[str, Any]] = {}
    for record in records:
        question_id = str(record.get("question_id") or "")
        if not question_id:
            raise SystemExit(f"{path}: a question carries no `question_id`")
        if question_id in keyed:
            raise SystemExit(f"{path}: duplicate question_id `{question_id}`")
        keyed[question_id] = record
    return keyed


def answer_sessions(question: dict[str, Any]) -> list[AnswerSession]:
    """The question's answer sessions with their dates, in the order the dataset lists them.

    The lookups are refused rather than defaulted: a session id that the question's own `haystack_session_ids`
    does not carry means the two halves of the record disagree, and picking a date by position would attach the
    wrong timestamp to the wrong value -- which is the one mistake that would invert every ordering below.
    """
    ids = question.get("haystack_session_ids") or []
    dates = question.get("haystack_dates") or []
    sessions = question.get("haystack_sessions") or []
    if not (len(ids) == len(dates) == len(sessions)):
        raise SystemExit(
            f"{question.get('question_id')}: haystack is ragged -- {len(ids)} ids, {len(dates)} dates, "
            f"{len(sessions)} session bodies"
        )
    position = {str(session_id): index for index, session_id in enumerate(ids)}
    out: list[AnswerSession] = []
    for session_id in question.get("answer_session_ids") or []:
        session_id = str(session_id)
        if session_id not in position:
            raise SystemExit(
                f"{question.get('question_id')}: answer session `{session_id}` is not in the question's haystack"
            )
        index = position[session_id]
        out.append(
            AnswerSession(
                session_id=session_id,
                date=str(dates[index]),
                turns_in_window=0,
                turns_in_session=len(sessions[index] or []),
            )
        )
    if not out:
        raise SystemExit(f"{question.get('question_id')}: the question names no answer session")
    return out


def window_bodies(record: dict[str, Any]) -> list[str]:
    """The bodies of the turns the reader was handed, in the order it was handed them."""
    turns = record.get("turns")
    if not isinstance(turns, list):
        raise SystemExit(
            f"{record.get('questionId')}: the artifact records no window (`turns`). An unrecorded window is not "
            "an empty window, and reading it as one would manufacture the retrieval failure this tool rules out."
        )
    return [body(str(turn.get("text") or "")) for turn in turns]


def _session_match_counts(
    question: dict[str, Any], sessions: list[AnswerSession], window: list[str]
) -> list[AnswerSession]:
    """For each answer session, how many of its turns appear in the window, and where it first appears.

    Exact equality after whitespace collapse. The two sides come from the same dataset -- the artifact's turn
    text is a rendering of the dataset's turn content -- so a paraphrase would mean the arm rewrote the corpus,
    and a partial match would be the arm's own truncation. Neither is a reason to loosen the comparison, because
    presence needs only one whole turn and every question here has twelve per session.
    """
    ids = [str(session_id) for session_id in question.get("haystack_session_ids") or []]
    position = {session_id: index for index, session_id in enumerate(ids)}
    bodies = question.get("haystack_sessions") or []
    counts = []
    for session in sessions:
        contents = {
            normalise(str(turn.get("content") or "")) for turn in bodies[position[session.session_id]] or []
        }
        counts.append(
            AnswerSession(
                session_id=session.session_id,
                date=session.date,
                turns_in_window=sum(1 for text in window if text in contents),
                turns_in_session=session.turns_in_session,
            )
        )
    return counts


def _first_and_last(window: list[str], question: dict[str, Any], session_id: str) -> tuple[int, int] | None:
    """The window positions of the first and last turn belonging to `session_id`, or `None` if absent."""
    ids = [str(value) for value in question.get("haystack_session_ids") or []]
    position = {value: index for index, value in enumerate(ids)}
    bodies = question.get("haystack_sessions") or []
    contents = {normalise(str(turn.get("content") or "")) for turn in bodies[position[session_id]] or []}
    hits = [index for index, text in enumerate(window) if text in contents]
    if not hits:
        return None
    return hits[0], hits[-1]


def classify(contains: list[bool]) -> str:
    """The four states, from which of the answer sessions the window showed.

    `contains` is in dataset order, which for an update question runs from the statement that was replaced to
    the statement that replaces it -- the order the dates corroborate and the order the artifact's own windows
    are built in. Anything other than one or two sessions is passed through as its own state rather than being
    forced into the four, because a claim about "the obsolete value" needs exactly two.
    """
    if len(contains) < 2:
        return "single-session"
    if all(contains):
        return "both"
    if not any(contains):
        return "neither"
    # Present, but not all: which end is missing decides which failure it is.
    return "later-only" if contains[-1] else "earlier-only"


def gold_tokens(ground_truth: str, window: list[str]) -> tuple[int, int]:
    """How many of the answer's numeric tokens appear anywhere in the window, and how many there are."""
    tokens = _GOLD_TOKEN.findall(ground_truth)
    if not tokens:
        return 0, 0
    haystack = " ".join(window).lower()
    return sum(1 for token in tokens if token in haystack), len(tokens)


def exposure(record: dict[str, Any], question: dict[str, Any]) -> Exposure:
    """One question, measured."""
    window = window_bodies(record)
    sessions = answer_sessions(question)
    counted = _session_match_counts(question, sessions, window)
    ordered = sorted(range(len(counted)), key=lambda index: counted[index].date)
    earliest, latest = ordered[0], ordered[-1]
    span_earliest = _first_and_last(window, question, counted[earliest].session_id)
    span_latest = _first_and_last(window, question, counted[latest].session_id)
    present, total = gold_tokens(str(record.get("groundTruth") or ""), window)
    return Exposure(
        question_id=str(record.get("questionId")),
        state=classify([session.present for session in counted]),
        sessions=counted,
        # Only defined when both ends are in the window: with the correction missing there is no ordering to
        # invert, and a `False` there would be read as "not inverted" rather than "not applicable".
        inverted=bool(span_earliest and span_latest) and span_earliest[0] > span_latest[0],
        obsolete_has_last_word=bool(span_earliest and span_latest) and span_earliest[1] > span_latest[1],
        gold_tokens_present=present,
        gold_tokens_total=total,
        correct=bool(record.get("correct")),
    )


def stable_failures(report: dict[str, Any], roster_size: int) -> list[int] | None:
    """Roster positions the artifact answered wrong in **every** repetition, or `None` if unrecorded.

    The gate in §13.366.1 is stated over the control's *stable* failures, not over its single-repetition wrong
    answers: a question this window reaches that the arm already fixes one time in four is not a question the
    arm has to convert. Carrying that distinction here means the claim "the pass is aimed at the right
    population" is made about the same eight questions the gate is, rather than about a superset.

    Positional, because `featureCorrectByRun` is a list of masks in roster order and carries no ids. A mask whose
    length disagrees with the roster is refused: shifting one position would credit the wrong question's answer
    to the wrong window, which is the one arithmetic error this tool cannot recover from.
    """
    masks = (report.get("ablation") or {}).get("featureCorrectByRun")
    if not isinstance(masks, list) or not masks:
        return None
    for mask in masks:
        if len(mask) != roster_size:
            raise SystemExit(
                f"a repetition mask has {len(mask)} entries against a roster of {roster_size}; the masks are "
                "positional, so a length disagreement attributes answers to the wrong questions"
            )
    return [
        position
        for position in range(roster_size)
        if all(int(str(mask[position])) == 0 for mask in masks)
    ]


def _stable(
    rows: list[Exposure], positions: list[int], stable_positions: list[int] | None
) -> dict[str, Any] | None:
    """The gate's own population, measured: how many stable failures have both statements in the window."""
    if stable_positions is None:
        return None
    by_position = dict(zip(positions, rows))
    stable = [by_position[position] for position in stable_positions if position in by_position]
    return {
        "n": len(stable),
        "both": sum(1 for row in stable if row.state == "both"),
        "earlier_only": sum(1 for row in stable if row.state == "earlier-only"),
        "later_only": sum(1 for row in stable if row.state == "later-only"),
        "neither": sum(1 for row in stable if row.state == "neither"),
        "inverted": sum(1 for row in stable if row.inverted),
        "obsolete_has_last_word": sum(1 for row in stable if row.obsolete_has_last_word),
    }


def read(artifact_path: Path, dataset_path: Path, only: str = DEFAULT_ONLY) -> dict[str, Any]:
    """Every count the printed table shows, computed once so the two forms cannot disagree."""
    report = json.loads(artifact_path.read_text(encoding="utf-8"))
    records = report.get("questions")
    if not isinstance(records, list) or not records:
        raise SystemExit(f"{artifact_path}: the artifact carries no per-question roster")
    dataset = load_dataset(dataset_path)

    rows: list[Exposure] = []
    positions: list[int] = []
    for position, record in enumerate(records):
        if str(record.get("capability") or "?") != only:
            continue
        question_id = str(record.get("questionId"))
        question = dataset.get(question_id)
        if question is None:
            raise SystemExit(
                f"{question_id}: in the artifact's `{only}` roster and not in {dataset_path}. Skipping it would "
                "report a rate over a population chosen by the data's absence."
            )
        rows.append(exposure(record, question))
        positions.append(position)

    states: dict[str, int] = {}
    for row in rows:
        states[row.state] = states.get(row.state, 0) + 1
    wrong = [row for row in rows if not row.correct]
    right = [row for row in rows if row.correct]

    def ordering(group: list[Exposure]) -> dict[str, Any]:
        return {
            "n": len(group),
            "inverted": sum(1 for row in group if row.inverted),
            "obsolete_has_last_word": sum(1 for row in group if row.obsolete_has_last_word),
        }

    return {
        "capability": only,
        "questions": len(rows),
        "states": states,
        "both": sum(1 for row in rows if row.state == "both"),
        "retrieval_attributable": sum(1 for row in rows if row.state != "both"),
        "reading_failures": sum(1 for row in rows if row.reading_failure),
        "stable": _stable(rows, positions, stable_failures(report, len(records))),
        "ordering": {"all": ordering(rows), "correct": ordering(right), "wrong": ordering(wrong)},
        "gold_tokens": {
            "wrong_with_any": sum(1 for row in wrong if row.gold_tokens_present > 0),
            "wrong_with_all": sum(1 for row in wrong if row.gold_tokens_total and row.gold_tokens_present == row.gold_tokens_total),
            "wrong_without_any": sum(1 for row in wrong if row.gold_tokens_total and row.gold_tokens_present == 0),
            "wrong_without_number": sum(1 for row in wrong if row.gold_tokens_total == 0),
            "wrong": len(wrong),
        },
        "rows": [
            {
                "id": row.question_id,
                "state": row.state,
                "correct": row.correct,
                "inverted": row.inverted,
                "obsolete_has_last_word": row.obsolete_has_last_word,
                "sessions": [
                    {"session": session.session_id, "date": session.date, "turns": session.turns_in_window}
                    for session in row.sessions
                ],
            }
            for row in rows
        ],
    }


def report(result: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append(f"# what the `{result['capability']}` windows contain ({result['questions']} questions)")
    lines.append("")
    lines.append("## is the correction in the window at all")
    lines.append("")
    lines.append("| state | questions | what a wrong answer there means |")
    lines.append("| --- | ---: | --- |")
    meanings = {
        "both": "reading failure -- the pass's population",
        "later-only": "retrieval -- the obsolete value never appeared",
        "earlier-only": "retrieval -- the correction never appeared",
        "neither": "retrieval -- neither value appeared",
        "single-session": "not an update question with two ends",
    }
    for state, count in sorted(result["states"].items(), key=lambda pair: (-pair[1], pair[0])):
        lines.append(f"| `{state}` | {count} | {meanings.get(state, '—')} |")
    lines.append("")
    lines.append(
        f"**{result['both']}/{result['questions']}** windows carry both statements, so "
        f"**{result['retrieval_attributable']}** question(s) here can be blamed on retrieval and "
        f"**{result['reading_failures']}** are reading failures."
    )
    lines.append("")
    lines.append("## does the window's order explain it")
    lines.append("")
    lines.append("| group | n | inverted | obsolete has the last word |")
    lines.append("| --- | ---: | ---: | ---: |")
    for name in ("all", "correct", "wrong"):
        row = result["ordering"][name]
        lines.append(
            f"| {name} | {row['n']} | {row['inverted']} | {row['obsolete_has_last_word']} |"
        )
    lines.append("")
    lines.append(
        "Inversion is the reader meeting the correction first; the last word is the obsolete value being the "
        "final thing in the window. A recency explanation needs both to be common among the wrong answers."
    )
    lines.append("")
    stable = result.get("stable")
    lines.append("## the gate's own population: failures that held across every repetition")
    lines.append("")
    if stable is None:
        lines.append("The artifact records no repetition masks, so this split cannot be made.")
    else:
        lines.append(
            f"{stable['both']}/{stable['n']} stable failures carry both statements "
            f"(`earlier-only` {stable['earlier_only']}, `later-only` {stable['later_only']}, "
            f"`neither` {stable['neither']}); {stable['inverted']} inverted, "
            f"{stable['obsolete_has_last_word']} with the obsolete value last."
        )
    lines.append("")
    tokens = result["gold_tokens"]
    lines.append("## was the answer's own value in the window (numeric tokens only, a lower bound)")
    lines.append("")
    lines.append(
        f"of {tokens['wrong']} wrong answers: {tokens['wrong_with_any']} carry at least one of the answer's "
        f"numeric tokens in the window, {tokens['wrong_with_all']} carry all of them, "
        f"{tokens['wrong_without_any']} carry none, and {tokens['wrong_without_number']} state the answer "
        "without a number at all."
    )
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--artifact", required=True, type=Path)
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--only", default=DEFAULT_ONLY, help="the capability to measure (default `KU`)")
    parser.add_argument("--json", action="store_true", help="emit the reading as JSON")
    arguments = parser.parse_args(argv)
    result = read(arguments.artifact, arguments.dataset, arguments.only)
    if arguments.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(report(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
