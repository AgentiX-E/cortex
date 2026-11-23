"""Tests for tools/competitor-pairing.mjs — the gap split into instrument and system.

## What this file protects

The campaign's headline is one number, 95.60% against 91.20%, and it mixes two effects: their judge is
not our judge, and their answers are not our answers. The tool separates them by holding one side fixed
at a time. Three ways that separation can silently collapse into the headline it is supposed to explain:

  * **the judge reading uses the wrong side's verdicts** -- then "ruler" and "reference" are the same
    table with different labels, and the split is a relabelling;
  * **the system reading uses the published verdicts** -- then it is the reference again, and the
    finding "under one judge they lead by X" is actually "under two judges they lead by Y";
  * **the two rescued/revoked counters share a name** -- then a strictness finding can be quoted as a
    capability finding, which is the exact conflation the tool exists to prevent.

The fourth is arithmetic: the cortex side must be the per-question verdict (`questions[].correct`,
456/500), not the report's headline accuracy (1,825/2,000, four passes). Pairing a single-pass count
against a four-pass one is the units error the pre-registration §1 corrects.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'competitor-pairing.mjs'


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['node', str(TOOL), *args],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=120,
    )


def export(script: str):
    result = subprocess.run(
        ['node', '--input-type=module', '-e', script],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


# id, ours, theirs-under-our-judge, theirs-under-their-judge
ROWS = [
    ('a', True, True, True),
    ('b', True, True, False),   # we accept, their judge rejected -> ruler-only
    ('c', False, True, True),   # their answer is right under our judge, ours is not -> system-only
    ('d', False, False, True),  # we reject, their judge accepted -> ruler-only, other direction
    ('e', False, False, False),
    ('f', True, False, False),  # our answer right, theirs wrong under our judge -> system-only
]


def prepare(tmp_path: Path):
    tmp_path.mkdir(parents=True, exist_ok=True)
    ours = tmp_path / 'benchmark-report.json'
    ours.write_text(json.dumps({'questions': [{'questionId': rid, 'correct': o} for rid, o, _, _ in ROWS]}))
    regrade = tmp_path / 'regrade.json'
    regrade.write_text(
        json.dumps(
            {
                'judge': {'providerId': 'deepseek', 'model': 'deepseek-chat'},
                'channels': {'judge': 500, 'exact': 12},
                'abstentionUnknown': 0,
                'rows': [
                    {
                        'questionId': rid,
                        'questionType': 'single-session-user',
                        'abstention': False,
                        'ourVerdict': under_ours,
                        'publishedVerdict': under_theirs,
                    }
                    for rid, _, under_ours, under_theirs in ROWS
                ],
            }
        )
    )
    out = tmp_path / 'out'
    result = run('--ours', str(ours), '--regrade', str(regrade), '--out-dir', str(out))
    assert result.returncode == 0, result.stderr
    return result, json.loads((out / 'pairing.json').read_text())


def test_the_ruler_reading_holds_the_answers_fixed_and_varies_the_judge(tmp_path: Path) -> None:
    _, pairing = prepare(tmp_path)
    ruler = pairing['readings']['ruler']
    assert ruler['paired'] == 6
    # Same six answers under two judges: 3 accepted by each, and the two disagreements point apart.
    assert ruler['underOurJudge'] == 3
    assert ruler['underTheirJudge'] == 3
    assert ruler['underOurJudgeOnly'] == 1
    assert ruler['underTheirJudgeOnly'] == 1
    assert ruler['delta'] == 0
    assert ruler['pValue'] == 1


def test_the_system_reading_uses_one_judge_on_both_sides(tmp_path: Path) -> None:
    _, pairing = prepare(tmp_path)
    system = pairing['readings']['system']
    assert system['ours'] == 3
    # The right-hand side is our judge applied to their answers -- not their published verdicts, which
    # would make this row indistinguishable from `reference`.
    assert system['theirs'] == 3
    assert system['oursOnly'] == 1  # f
    assert system['theirsOnly'] == 1  # c
    assert system['agreeBoth'] == 2
    assert system['agreeNeither'] == 2


def test_the_reference_reading_is_the_old_headline_and_differs_from_both(tmp_path: Path) -> None:
    _, pairing = prepare(tmp_path)
    reference = pairing['readings']['reference']
    assert reference['theirs'] == 3
    # Two each: `c` (right under both rulers, ours wrong) and `d` (right only under their ruler) on their
    # side; `b` and `f` on ours. The system reading sees one of each because it holds the ruler fixed.
    assert reference['theirsOnly'] == 2
    assert reference['oursOnly'] == 2
    # The three readings are three different comparisons over the same six questions, and the counters
    # that distinguish them are not interchangeable.
    assert pairing['readings']['ruler']['underTheirJudgeOnly'] == 1
    assert pairing['readings']['system']['theirsOnly'] == 1
    # The counters are named per side, so the ruler's counters cannot be mistaken for the system's: a
    # strictness count read as a capability count is the conflation this tool exists to prevent.
    assert 'theirsOnly' not in pairing['readings']['ruler']


def test_questions_the_cortex_report_does_not_carry_are_left_out(tmp_path: Path) -> None:
    # A regrade artefact over a different population would otherwise be scored against a side that never
    # answered some of it.
    tmp_path.mkdir(parents=True, exist_ok=True)
    ours = tmp_path / 'benchmark-report.json'
    ours.write_text(json.dumps({'questions': [{'questionId': 'a', 'correct': True}]}))
    regrade = tmp_path / 'regrade.json'
    regrade.write_text(
        json.dumps(
            {
                'rows': [
                    {'questionId': 'a', 'ourVerdict': True, 'publishedVerdict': True},
                    {'questionId': 'zzz', 'ourVerdict': False, 'publishedVerdict': False},
                ]
            }
        )
    )
    out = tmp_path / 'out'
    result = run('--ours', str(ours), '--regrade', str(regrade), '--out-dir', str(out))
    assert result.returncode == 0, result.stderr
    pairing = json.loads((out / 'pairing.json').read_text())
    assert pairing['pairedQuestions'] == 1
    assert [row['questionId'] for row in pairing['rows']] == ['a']


def test_the_cortex_side_is_the_per_question_verdict_not_the_headline_accuracy() -> None:
    # 456 of 500 is the denominator 95.6% also uses. 1,825 of 2,000 is not, and reading it here would
    # reproduce the units error the pre-registration corrects.
    result = export(
        "import {oursById} from './tools/competitor-pairing.mjs';"
        "const report = {costEfficiency: {accuracy: 0.9125},"
        "  questions: [{questionId: 'a', correct: true}, {questionId: 'b', correct: false}]};"
        "const map = oursById(report);"
        "console.log(JSON.stringify({size: map.size, a: map.get('a'), b: map.get('b')}));"
    )
    assert result == {'size': 2, 'a': True, 'b': False}


def test_the_sign_test_is_exact() -> None:
    result = export(
        "import {signTest} from './tools/competitor-pairing.mjs';"
        "console.log(JSON.stringify({none: signTest(0,0), three: signTest(3,0), "
        "six: signTest(6,0), symmetric: signTest(2,2), flipped: signTest(0,3)}));"
    )
    assert result == {'none': 1, 'three': 0.25, 'six': 0.03125, 'symmetric': 1, 'flipped': 0.25}


def test_an_artefact_with_no_rows_is_refused(tmp_path: Path) -> None:
    tmp_path.mkdir(parents=True, exist_ok=True)
    ours = tmp_path / 'benchmark-report.json'
    ours.write_text(json.dumps({'questions': []}))
    regrade = tmp_path / 'regrade.json'
    regrade.write_text(json.dumps({'rows': []}))
    result = run('--ours', str(ours), '--regrade', str(regrade), '--out-dir', str(tmp_path / 'out'))
    assert result.returncode != 0
    assert 'no rows' in result.stderr
