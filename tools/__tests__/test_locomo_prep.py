"""Tests for tools/locomo-prep.mjs — the corpus census, and the four assumptions it refuses.

## What this file protects

LoCoMo is the corpus the `H2` ablation needs (§169.4), and every number taken on it is divided by
something this tool counts. Four of those counts can go wrong without failing anything, and each has a
test below:

  * **session numbering.** The real corpus declares a `session_N_date_time` for every N but carries a
    body for fewer — ten dialogues, 272 bodies, 16 date-only keys. A loop over the declared range reads
    `undefined` as a session and reports a shorter corpus rather than a gap.
  * **dialog ids.** Evidence is `D1:3`, and the corpus is free to number a session differently from its
    key. Indexing by parsing the id's digits would resolve evidence against the wrong session while
    reporting every id as found, so the index is built from the turns.
  * **unresolvable evidence.** 9 of the 2,815 gold evidence ids do not resolve in the published file.
    An evidence reading whose denominator includes them is a reading about a corpus that does not exist;
    one that silently drops them is a reading over 99.7% of the corpus presented as 100%.
  * **the annotations.** `event_summary`, `observation` and `session_summary` are human-written summaries
    of the dialogue, sitting in the same file. A system that reads them is not doing retrieval, so their
    presence is recorded rather than discovered later.

The two that remain are about the category column, which carries integers and no names, and about the
source digest that makes two readings comparable.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'locomo-prep.mjs'


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['node', str(TOOL), *args],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=120,
    )


def sample(sample_id: str = 'conv-1', **overrides) -> dict:
    """One dialogue shaped like the published file: two sessions with bodies, one key with only a date."""
    base = {
        'sample_id': sample_id,
        'conversation': {
            'speaker_a': 'Caroline',
            'speaker_b': 'Melanie',
            'session_1_date_time': '1:56 pm on 8 May, 2023',
            'session_1': [
                {'speaker': 'Caroline', 'dia_id': 'D1:1', 'text': 'Hey Mel!'},
                {'speaker': 'Melanie', 'dia_id': 'D1:2', 'text': 'Hi Caroline.'},
            ],
            'session_2_date_time': '2:10 pm on 9 May, 2023',
            'session_2': [{'speaker': 'Caroline', 'dia_id': 'D2:1', 'text': 'I adopted a dog.'}],
            'session_3_date_time': '3:00 pm on 10 May, 2023',
        },
        'qa': [
            {'question': 'When did Caroline go to the group?', 'answer': '7 May 2023', 'evidence': ['D1:1', 'D9:9'], 'category': 2},
            {'question': 'What pet did she adopt?', 'answer': 'a dog', 'evidence': ['D2:1'], 'category': 1},
        ],
        'event_summary': {'events_session_1': 'nothing'},
        'session_summary': {'session_1_summary': 'Greetings.'},
        'observation': {},
    }
    base.update(overrides)
    return base


def prepare(tmp_path: Path, payload, *extra: str):
    tmp_path.mkdir(parents=True, exist_ok=True)
    source = tmp_path / 'locomo10.json'
    source.write_text(json.dumps(payload))
    out = tmp_path / 'out'
    result = run('--input', str(source), '--out-dir', str(out), *extra)
    assert result.returncode == 0, result.stderr
    return (
        result,
        json.loads((out / 'locomo-census.json').read_text()),
        json.loads((out / 'locomo-questions.json').read_text()),
    )


def test_a_date_only_session_is_reported_as_a_gap_not_as_a_conversation(tmp_path: Path) -> None:
    _, census, _ = prepare(tmp_path, [sample()])
    row = census['rows'][0]
    assert row['sessionsPresent'] == 2
    assert row['sessionsWithDateOnly'] == [3]
    assert row['sessionNumbers'] == [1, 2]
    assert row['turns'] == 3
    assert census['sessionsWithDateOnly'] == 1


def test_the_dialog_index_is_built_from_turns_not_from_the_id_text(tmp_path: Path) -> None:
    # The turn says D2:1 inside session_2. If an id's digits were parsed instead, a corpus that numbered
    # this turn `D7:1` would resolve evidence against session 7 and report it as found.
    odd = sample()
    odd['conversation']['session_2'] = [{'speaker': 'Caroline', 'dia_id': 'D7:1', 'text': 'I adopted a dog.'}]
    odd['qa'] = [{'question': 'What pet?', 'answer': 'a dog', 'evidence': ['D7:1'], 'category': 1}]
    _, census, questions = prepare(tmp_path, [odd])
    assert census['rows'][0]['evidenceResolved'] == 1
    assert questions['questions'][0]['evidence'] == ['D7:1']


def test_unresolvable_evidence_is_kept_apart_from_resolved_evidence(tmp_path: Path) -> None:
    _, census, questions = prepare(tmp_path, [sample()])
    assert census['evidenceTotal'] == 3
    assert census['evidenceResolved'] == 2
    first = questions['questions'][0]
    assert first['evidence'] == ['D1:1']
    assert first['evidenceMissing'] == ['D9:9']
    assert questions['questions'][1]['evidenceMissing'] == []


def test_categories_are_counted_as_the_integers_the_corpus_carries(tmp_path: Path) -> None:
    # No name table anywhere in this tool: the published evaluator dispatches on integers and the data
    # carries no labels. A translation invented here would end up as a column heading.
    _, census, questions = prepare(tmp_path, [sample()])
    assert census['categories'] == {'1': 1, '2': 1}
    assert [question['category'] for question in questions['questions']] == [2, 1]


def test_the_human_annotations_are_named_so_a_reading_can_disclaim_them(tmp_path: Path) -> None:
    _, census, _ = prepare(tmp_path, [sample()])
    assert census['annotationKeys'] == ['event_summary', 'observation', 'session_summary']


def test_questions_are_flat_and_addressable_across_dialogues(tmp_path: Path) -> None:
    _, _, questions = prepare(tmp_path, [sample('conv-1'), sample('conv-2')])
    ids = [question['questionId'] for question in questions['questions']]
    assert ids == ['conv-1#0', 'conv-1#1', 'conv-2#0', 'conv-2#1']
    assert [question['sampleId'] for question in questions['questions']] == ['conv-1', 'conv-1', 'conv-2', 'conv-2']


def test_a_samples_wrapper_is_read_like_a_bare_array(tmp_path: Path) -> None:
    _, bare, _ = prepare(tmp_path / 'bare', [sample()])
    _, wrapped, _ = prepare(tmp_path / 'wrapped', {'samples': [sample()]})
    assert bare['dialogues'] == wrapped['dialogues'] == 1
    assert bare['questions'] == wrapped['questions'] == 2


def test_the_census_carries_the_digest_of_the_corpus_it_read(tmp_path: Path) -> None:
    # LoCoMo's own revision is pinned in the URL; this digest is what says the pinned revision is the one
    # the numbers came from, without trusting the pin.
    _, census, _ = prepare(tmp_path, [sample()])
    assert len(census['source']['sha256']) == 64
    assert census['source']['bytes'] > 0


def test_the_stdout_reading_names_the_denominator_beside_the_resolved_count(tmp_path: Path) -> None:
    # A census that prints "2806 resolved" without "of 2815" invites the number into a table where it
    # reads as complete. The pair is printed together for the same reason it is stored together.
    result, _, _ = prepare(tmp_path, [sample()])
    assert '2/3 resolved' in result.stdout
    assert '+1 date-only' in result.stdout
