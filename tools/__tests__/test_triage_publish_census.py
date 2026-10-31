"""Tests for tools/triage-publish-census.mjs and the reading it produced.

## What this file protects

Gate 3 asks for a false-share upper bound of 5%. The two numbers that stood behind it before this
census were `0/12` on a hand-labelled sample (upper 24.2%, i.e. nothing) and `0/1,467` on persona
facts where the publishing rule never fired at all (a bound over a mechanism that did not run).
Neither has a denominator of *publications*, and a publication is the only way a private fact leaves
the device.

The census changes the denominator, and with it the answer: on 47,927 real user utterances the
shipped rule published 211 rows, and reading every one of them found 20 that carry a policy-private
circumstance. That is 9.48% with an upper bound of 14.19% — a failing gate, and the first time this
project has had a number for the thing it was claiming.

The tests below hold three things: the arithmetic of the committed reading, the completeness of the
adjudication file, and the behaviour of the gate itself when a rate is above 5% or a publication has
not been read.
"""

from __future__ import annotations

import json
import math
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'triage-publish-census.mjs'
READING = REPO / 'tools' / 'triage-census-reading.json'
VERDICTS = REPO / 'tools' / 'triage-publications-adjudicated.json'


def wilson_upper(successes: int, n: int, z: float = 1.959963984540054) -> float:
    if n == 0:
        return 1.0
    p = successes / n
    denominator = 1 + (z * z) / n
    centre = p + (z * z) / (2 * n)
    margin = z * math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
    return min(1.0, (centre + margin) / denominator)


def corpus(tmp_path: Path, rows: list[str]) -> Path:
    path = tmp_path / 'turns.json'
    path.write_text(json.dumps({'source': 'synthetic', 'turns': rows}))
    return path


def verdicts(tmp_path: Path, entries: list[dict]) -> Path:
    path = tmp_path / 'verdicts.json'
    path.write_text(json.dumps({'rows': entries}))
    return path


def publishing_rows(count: int) -> list[str]:
    # "we decided" is the publishing rule; nothing private fires on these, so every row publishes.
    return [f'We decided the roadmap for project {index} in sprint {index}.' for index in range(count)]


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['node', str(TOOL), *args], cwd=REPO, capture_output=True, text=True, timeout=120
    )


def test_the_committed_reading_recomputes() -> None:
    # The arithmetic has to survive a reader who did not run the tool. 20 of 211 is 9.48%, and the
    # upper bound is 14.19% -- the number that made the gate red.
    reading = json.loads(READING.read_text())
    before = reading['reading']['before']
    after = reading['reading']['after']

    assert before['published'] == 211
    assert before['errors'] == 20
    assert abs(before['falseShare'] - before['errors'] / before['published']) < 5e-5
    assert abs(before['falseShareUpper'] - wilson_upper(before['errors'], before['published'])) < 5e-5

    assert after['published'] == 189
    assert after['errors'] == 0
    assert abs(after['falseShareUpper'] - wilson_upper(0, after['published'])) < 5e-5
    assert after['falseShareUpper'] <= 0.05


def test_every_publication_in_the_adjudication_has_a_verdict() -> None:
    # An unjudged row is not a pass. The file covers all 211 rows that were published *before* the
    # repair; the two that the repair moved out of the publishing set keep their verdict, so the
    # same reading serves both columns.
    data = json.loads(VERDICTS.read_text())
    rows = data['rows']
    assert len(rows) == 211
    assert {row['verdict'] for row in rows} == {'shared', 'private'}
    private = [row for row in rows if row['verdict'] == 'private']
    assert len(private) == 20
    for row in private:
        assert row['class'] in {'health', 'family', 'third-party', 'career-status'}
        assert row['why'], row['index']
    for row in rows:
        assert row['text'], row['index']
        assert row['trigger'], row['index']


def test_the_gate_passes_when_every_publication_is_organisational(tmp_path: Path) -> None:
    rows = publishing_rows(100)
    marks = verdicts(tmp_path, [{'index': i, 'verdict': 'shared'} for i in range(len(rows))])
    result = run('--corpus', str(corpus(tmp_path, rows)), '--verdicts', str(marks))
    assert result.returncode == 0, result.stdout
    assert '0/100' in result.stdout
    assert 'NOT MEASURED' not in result.stdout


def test_the_gate_fails_above_five_percent(tmp_path: Path) -> None:
    rows = publishing_rows(100)
    marks = verdicts(
        tmp_path,
        [{'index': i, 'verdict': 'private' if i < 10 else 'shared'} for i in range(len(rows))],
    )
    result = run('--corpus', str(corpus(tmp_path, rows)), '--verdicts', str(marks))
    assert result.returncode == 1, result.stdout
    assert '10/100' in result.stdout


def test_an_unread_publication_refuses_to_produce_a_rate(tmp_path: Path) -> None:
    # The failure this prevents is the one the persona corpus made: a bound computed over rows that
    # were never read. It exits non-zero and says NOT MEASURED rather than reporting a smaller
    # denominator.
    rows = publishing_rows(100)
    marks = verdicts(tmp_path, [{'index': i, 'verdict': 'shared'} for i in range(90)])
    result = run('--corpus', str(corpus(tmp_path, rows)), '--verdicts', str(marks))
    assert result.returncode == 1, result.stdout
    assert 'NOT MEASURED' in result.stdout
    assert '10 unjudged' in result.stdout


def test_a_corpus_with_no_publications_is_not_a_pass(tmp_path: Path) -> None:
    rows = ['I went for a jog before breakfast.'] * 50
    result = run('--corpus', str(corpus(tmp_path, rows)))
    assert result.returncode == 1, result.stdout
    assert 'NOT MEASURED' in result.stdout


def test_the_committed_reading_records_the_reverification(tmp_path: Path) -> None:
    # `gym` and `bike` were removed after this census was first read. The reread has to be in the
    # file, not only in a commit message: the publication count is unchanged, which is the claim
    # that the two words were never load-bearing here.
    reading = json.loads(READING.read_text())
    reread = reading['reverifiedWithGymAndBikeRemoved']
    assert reread['published'] == reading['reading']['after']['published']
    assert reread['errors'] == 0
    assert abs(reread['falseShareUpper'] - reading['reading']['after']['falseShareUpper']) < 5e-5


def test_the_ablation_publishes_deferrals_and_never_gates(tmp_path: Path) -> None:
    # A4 is one predicate: a deferral lands shared. The first row fires no rule at all, so under the
    # shipped policy it stays on the device and under the ablation it leaves.
    rows = ['The bookshop on the corner reopens next month.', *publishing_rows(10)]
    result = run('--corpus', str(corpus(tmp_path, rows)), '--defer-shared')
    assert result.returncode == 0, result.stdout
    assert f'published             {len(rows)} of {len(rows)} (100.00%)' in result.stdout, result.stdout
    # No rate, on purpose: 40,822 rows nobody read is not a denominator. The label column is exactly
    # what has to be absent -- the note itself mentions false-share in order to refuse it.
    assert 'false-share           ' not in result.stdout
    assert 'Read the count, not the ratio' in result.stdout


def test_the_ablation_and_the_shipped_policy_differ_by_a_factor(tmp_path: Path) -> None:
    # Same corpus, one predicate between them. This is the whole A4 claim in miniature: the deferral
    # default is the difference between a row staying home and a row leaving.
    rows = ['The bookshop on the corner reopens next month.', *publishing_rows(10)]
    shipped = run('--corpus', str(corpus(tmp_path, rows)))
    ablation = run('--corpus', str(corpus(tmp_path, rows)), '--defer-shared')
    assert 'published             10 (90.91%)' in shipped.stdout, shipped.stdout
    assert 'published             11 of 11' in ablation.stdout, ablation.stdout
    # And the shipped run is still a gate: one unread publication, so it fails rather than reporting
    # a rate over the ten rows a reader happened to see.
    assert shipped.returncode == 1
    assert ablation.returncode == 0
