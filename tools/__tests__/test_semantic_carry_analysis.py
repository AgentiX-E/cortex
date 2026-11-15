#!/usr/bin/env python3
"""Tests for `cortex-docs/evidence/longmemeval/scripts/semantic_carry_analysis.py`.

## The defect this file is written against

`semantic_carry_analysis.py` decides whether `S12` gets **a registered number** or **no number at
all**, and the decision is one branch: a `registered` run writes `paired.deltaQuestions`, a
`screening` run writes `screening.deltaQuestions` and leaves `paired` absent so the row that reads
that key stays `unrun`. Nothing exercised that branch, and the cost of getting it wrong is
asymmetric: a screening pair that wrote `paired` would turn `unrun` into `pass` on 72 corpora at two
repetitions, which is a claim about 500 at four that nobody measured. The `void`-to-`pass` guard
(`S12.requires = ['S13']`) sits on the same file, so a census that failed to reach the output would
make a null result look like a pass.

The fixture is deliberately **not** the size of the registered population. Every guard here is about
*shape* -- which key is written, which key is withheld, which input is refused -- and a test that
built 500 corpora to check a key name would be slow enough that someone would eventually delete it.

## What each case pins

| Case | Must hold |
| --- | --- |
| `registered` | `paired.deltaQuestions` over the second windows; no `screening` key |
| `screening` | `screening.deltaQuestions`; **no** `paired` key, so `S12` stays `unrun` |
| no census | no `semanticCarry` key, `readable: False` -- absent is not zero |
| no `population` | refused; a one-window dispatch cannot price a second-window delta |
| no `#w2` ids | refused; the delta would be over an empty selection and read as `0` |
| misaligned bitstring | refused by name, because the pairing would be a guess |
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO.parent / 'cortex-docs' / 'evidence' / 'longmemeval' / 'scripts' / 'semantic_carry_analysis.py'

# Eight corpora asked twice: sixteen questions, and the second window is the eight a carry can reach.
# Eight rather than four because `withinThreshold` is `>= -5` and a four-question window cannot go below
# it -- a case meant to show the verdict can miss has to be able to miss.
IDS = [f'c{n}#w{w}' for w in (1, 2) for n in range(1, 9)]
WINDOW = len(IDS) // 2


def artifact(
    *,
    baseline: str | list[str] = '1' * len(IDS),
    feature: str | list[str] = '1' * WINDOW + '0' + '1' * (WINDOW - 1),
    populations: bool = True,
    census: bool = True,
    drop_second_window: bool = False,
    runs: int = 1,
) -> dict:
    """A minimal `merged-ablation` document: one bitstring per repetition, aligned with the roster."""
    ids = [qid for qid in IDS if not (drop_second_window and qid.endswith('#w2'))]
    # The bitstrings are trimmed to the roster rather than written by hand per case: a fixture that
    # carried eight verdicts for four questions would be refused by the alignment guard before the
    # case under test ever ran, which fails the test for the wrong reason.
    def bits(value: str | list[str]) -> list[str]:
        return [run[: len(ids)] for run in ([value] * runs if isinstance(value, str) else value)]

    return {
        'kind': 'merged-ablation',
        'dataset': 'longmemeval',
        'questionCount': len(ids),
        'runs': runs,
        **({} if not populations else {'population': {'windows': 2, 'corpora': len(ids) // 2, 'marker': '#w'}}),
        'memoryArmConfig': {
            'reviewPass': 'supersede',
            'semanticCarry': True,
            'reader': {'model': 'deepseek-chat'},
            'judge': {'model': 'deepseek-chat'},
        },
        **(
            {}
            if not census
            else {
                'semanticCarry': {
                    'absorbed': 1,
                    'dropped': 0,
                    'matched': 2,
                    'served': 2,
                    'withheld': 2,
                    'stored': {'episodic': 0, 'procedural': 0, 'semantic': 1},
                }
            }
        ),
        'ablation': {
            'baselineCorrectByRun': bits(baseline),
            'featureCorrectByRun': bits(feature),
        },
        'questions': [{'questionId': qid} for qid in ids],
    }


def analyse(document: dict, *extra: str) -> subprocess.CompletedProcess[str]:
    """Run the script against `document` and return the process, with its output for the message."""
    with tempfile.TemporaryDirectory() as scratch:
        source = Path(scratch) / 'report.json'
        source.write_text(json.dumps(document), encoding='utf-8')
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(source), *extra],
            capture_output=True,
            text=True,
            check=False,
        )


def evidence_of(document: dict, *extra: str, out: str = 'evidence.json') -> dict:
    """Run the script with `--write` and read back what it wrote."""
    with tempfile.TemporaryDirectory() as scratch:
        source = Path(scratch) / 'report.json'
        target = Path(scratch) / out
        source.write_text(json.dumps(document), encoding='utf-8')
        done = subprocess.run(
            [sys.executable, str(SCRIPT), str(source), '--write', str(target), *extra],
            capture_output=True,
            text=True,
            check=False,
        )
        assert done.returncode == 0, done.stdout + done.stderr
        assert target.exists(), f'the script reported success but wrote nothing: {done.stdout}'
        return json.loads(target.read_text(encoding='utf-8'))


def test_registered_writes_the_key_s12_reads() -> None:
    """The key `S12` reads is written by a registered run, and it is over the second windows only."""
    evidence = evidence_of(artifact(), '--run', '123', '--tier', 'registered')

    assert evidence['tier'] == 'registered'
    assert evidence['sourceRun'] == '123'
    # One question lost on `#w2`, none on `#w1`: the second-window delta is -1 over eight.
    assert evidence['paired']['n'] == WINDOW
    assert evidence['paired']['deltaQuestions'] == -1.0
    assert evidence['paired']['deltaQuestionsAllWindows'] == -1.0
    assert 'screening' not in evidence, 'a registered run must not publish a screening reading beside it'


def test_screening_withholds_the_key_so_s12_stays_unrun() -> None:
    """A screening pair publishes its delta where no criterion reads it, and says what the blocker is."""
    evidence = evidence_of(artifact(), '--tier', 'screening')

    assert evidence['tier'] == 'screening'
    assert 'paired' not in evidence, (
        'S12 reads paired.deltaQuestions; a screening pair that wrote it would turn unrun into pass '
        'on a population the row was not registered on'
    )
    assert evidence['screening']['deltaQuestions'] == -1.0
    assert evidence['screening']['n'] == WINDOW
    assert 'blocker' in evidence['screening'] and evidence['screening']['blocker']


def test_registered_is_the_default() -> None:
    """No `--tier` means registered -- the arity of the run, not the caller's memory, decides."""
    assert evidence_of(artifact())['tier'] == 'registered'


def test_a_run_without_a_census_omits_the_key_rather_than_reporting_zero() -> None:
    """`S13` absent and `S13` zero are different facts, and only one of them is a measurement."""
    evidence = evidence_of(artifact(census=False))

    assert 'semanticCarry' not in evidence
    assert evidence['verdict']['reached'] is None
    assert evidence['verdict']['readable'] is False, 'no census means the delta cannot be read, whatever it is'


def test_a_reached_census_makes_the_delta_readable() -> None:
    """The one branch that turns a null delta into a result: something was carried and nothing was lost."""
    evidence = evidence_of(artifact())

    assert evidence['verdict'] == {
        'reached': True,
        'withinThreshold': True,
        'readable': True,
        'rule': 'delta over the second window >= -5 AND reach >= 1',
    }
    assert evidence['mcnemar'] == {'p': 1.0, 'b': 1, 'c': 0}


def test_a_delta_below_the_floor_is_reported_as_a_miss() -> None:
    """`withinThreshold` has to be able to be false, or the verdict is a constant dressed as a reading."""
    evidence = evidence_of(artifact(baseline='1' * len(IDS), feature='0' * len(IDS)))

    assert evidence['paired']['deltaQuestions'] == -float(WINDOW)
    assert evidence['verdict']['withinThreshold'] is False


def test_no_population_is_refused_by_name() -> None:
    """A one-window dispatch graded as if it had two would publish a reach of zero as a mechanism result."""
    done = analyse(artifact(populations=False))

    assert done.returncode != 0, done.stdout
    assert 'carries no `population`' in done.stderr
    assert 'CORTEX_WINDOWS=2' in done.stderr, 'the refusal has to name the dispatch that fixes it'


def test_a_population_without_a_second_window_is_refused() -> None:
    """An empty selection yields delta `0`, which satisfies `>= -5` -- the refusal is what stops that."""
    done = analyse(artifact(drop_second_window=True))

    assert done.returncode != 0, done.stdout
    assert 'no id ends in #w2' in done.stderr


def test_a_misaligned_bitstring_is_refused_rather_than_paired() -> None:
    """A bitstring shorter than the roster would pair each verdict with the wrong question."""
    done = analyse(artifact(baseline='1' * (len(IDS) - 1)))

    assert done.returncode != 0, done.stdout
    assert f'{len(IDS) - 1} verdicts for {len(IDS)} questions' in done.stderr
    assert 'not aligned with the roster' in done.stderr


def test_repetitions_are_averaged_per_question() -> None:
    """Two repetitions split one question: the paired delta is in questions, and -0.5 is the reading."""
    evidence = evidence_of(
        artifact(
            baseline=['1' * len(IDS), '1' * len(IDS)],
            feature=['1' * WINDOW + '0' + '1' * (WINDOW - 1), '1' * len(IDS)],
            runs=2,
        )
    )

    # Per-question means over two repetitions: the lost question reads 0.5 against 1.0, so -0.5 in total.
    assert evidence['arm']['runs'] == 2
    assert evidence['paired']['deltaQuestions'] == -0.5
    # The McNemar reading is on the first repetition, where the question is simply wrong.
    assert evidence['mcnemar'] == {'p': 1.0, 'b': 1, 'c': 0}


def test_usage_travels_with_the_reading_so_the_bill_is_not_retyped() -> None:
    """The token counts are copied, not re-derived: one price table lives in `spend-projection.mjs`."""
    document = artifact()
    document['llmUsage'] = {
        'calls': 40,
        'unpricedCalls': 0,
        'promptTokens': 200_000,
        'completionTokens': 3_000,
        'cacheHitPromptTokens': 190_000,
    }

    assert evidence_of(document)['usage'] == {
        'calls': 40,
        'promptTokens': 200_000,
        'cacheHitPromptTokens': 190_000,
        'completionTokens': 3_000,
    }


def test_an_absent_usage_block_omits_the_key() -> None:
    """A run deployed without usage accounting is a different fact from a run that spent nothing."""
    assert 'usage' not in evidence_of(artifact())


def test_an_incomplete_usage_block_is_refused() -> None:
    """A usage block missing `promptTokens` would price the run at zero output and pass any budget."""
    document = artifact()
    document['llmUsage'] = {'calls': 40, 'completionTokens': 3_000}

    done = analyse(document)

    assert done.returncode != 0, done.stdout
    assert 'llmUsage' in done.stderr and 'promptTokens' in done.stderr
