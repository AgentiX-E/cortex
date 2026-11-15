"""Tests for the cross-vendor judge path: the credential, the parse, and the comparison.

## Why this file exists

`I1` asks one question: how much of the published `Δ_judge` is the judge being **stricter** and how
much is it **favouring the reader it shares a family with**? The archived answer to half of it is
`−3.2 points`, taken by re-grading with `deepseek-v4-pro` an artifact `deepseek-chat` graded. Both
models are DeepSeek, so "stricter" and "same-family lenient" are the same number and the reading
cannot separate them. A judge from another vendor can.

Three things have to be true before that dispatch is worth paying for, and each of them fails
silently if it is false:

1. **The credential follows the judge.** `createJudgeFromEnv` reads the key of the provider the
   *selection* names, and `judge-audit.yml` exported only `DEEPSEEK_API_KEY`. A `zhipu:` judge would
   therefore have collected a 401 on every one of ~500 questions -- or, worse, run on a DeepSeek key
   sent to a Zhipu endpoint.

2. **A reply the parser cannot read is counted, not read as "no".** `parseJudgeResponse` defaults to
   `false`, which is right for a verdict and catastrophic for an *instrument swap*: a judge that
   answers "**Yes**" in markdown would reject all 508 judge-channel questions and the reading would
   report a cross-vendor gap equal to the whole channel. That number would look like a finding.

3. **The comparison is arithmetic, not a paragraph.** The decision rule is in questions (`≤1` is
   "undetectable", `>5` is "split M1"), so it is computed from the two readings by a tool that
   refuses pairs which are not two readings of one artifact under two providers.

Everything here runs against a stub HTTP server, so nothing in this file can spend credits. That is
the same arrangement `test_judge_regrade.py` uses and for the same reason: the layers that must not
disagree (the provider table, the temperature wrapper, the parser) are exactly the layers a stubbed
client would skip.
"""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
REGRADE = REPO / 'tools' / 'judge-regrade.mjs'
CREDENTIAL = REPO / 'tools' / 'judge-credential.mjs'
COMPARE = REPO / 'tools' / 'judge-cross-vendor.mjs'
WORKFLOW = REPO / '.github' / 'workflows' / 'judge-audit.yml'


class _StubHandler(BaseHTTPRequestHandler):
    """Answer every completion with one fixed reply, and keep the request it was given."""

    def do_POST(self) -> None:  # noqa: N802 - the base class names this
        length = int(self.headers.get('content-length') or 0)
        raw = self.rfile.read(length) if length else b'{}'
        self.server.recorded.append(
            {
                'body': json.loads(raw),
                'authorization': self.headers.get('authorization'),
            }
        )
        payload = json.dumps(
            {'choices': [{'message': {'content': self.server.reply}, 'finish_reason': 'stop'}]}
        ).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args: object) -> None:
        """Silence the per-request line; the assertions are the record."""


@contextlib.contextmanager
def stub(reply: str = 'YES'):
    """A local provider that says `reply`, plus the requests it was sent."""
    server = ThreadingHTTPServer(('127.0.0.1', 0), _StubHandler)
    server.recorded = []
    server.reply = reply
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_address[1]}/v1', server.recorded
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=10)


def clean_env(**extra: str) -> dict[str, str]:
    """The ambient environment with every judge variable removed, then `extra` applied.

    Stripped rather than inherited, because a developer machine with `CORTEX_JUDGE_MODEL` exported
    would make the "the artifact decides" test pass for the wrong reason -- the same class of
    accident as the workflow that pinned the judge in a variable the factory does not read.
    """
    env = {
        key: value
        for key, value in os.environ.items()
        if key
        not in {
            'CORTEX_JUDGE_MODEL',
            'DEEPSEEK_MODEL',
            'CORTEX_READER_MODEL',
            'ZHIPU_LLM_MODEL',
            'TEMPERATURE',
            'DEEPSEEK_THINKING',
            'CORTEX_READER_TIMEOUT_MS',
        }
    }
    for name in ('DEEPSEEK_API_KEY', 'ZHIPU_API_KEY', 'ZHIPU_LLM_API_KEY', 'CORTEX_READER_API_KEY'):
        env.pop(name, None)
    env.update(extra)
    return env


def run_tool(tool: Path, env: dict[str, str], *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['node', str(tool), *args],
        capture_output=True,
        text=True,
        cwd=REPO,
        timeout=180,
        env=env,
    )


def report(tmp_path: Path, judge: dict[str, object] | None = None) -> Path:
    """An artifact with one gradable question and one that is wrong by construction.

    Two questions, because a reading of one question cannot show a difference between judges: the
    question the stub accepts and the question it cannot parse have to be separate rows.
    """
    questions = [
        {
            'questionId': 'q-gradable',
            'question': 'Where did I put the keys?',
            'capability': 'IE',
            'questionType': 'single-session-user',
            'groundTruth': 'in the drawer',
            'answer': 'In the kitchen drawer.',
            'correct': True,
        },
        {
            'questionId': 'q-second',
            'question': 'When is the dentist appointment?',
            'capability': 'IE',
            'questionType': 'single-session-user',
            'groundTruth': 'on Tuesday',
            'answer': 'Tuesday morning.',
            'correct': True,
        },
        {
            'questionId': 'q-nogold',
            'question': 'Where did I put the keys?',
            'capability': 'IE',
            'questionType': 'single-session-user',
            'groundTruth': '',
            'answer': 'In the kitchen drawer.',
            'correct': False,
        },
    ]
    payload: dict[str, object] = {'questions': questions}
    if judge is not None:
        payload['memoryArmConfig'] = {'judge': judge}
    path = tmp_path / 'report.json'
    path.write_text(json.dumps(payload), encoding='utf-8')
    return path


def reading(
    tmp_path: Path,
    name: str,
    *,
    selection: str,
    provider: str,
    recorded: int,
    regraded: int,
    judged: int = 467,
    judge_source: str | None = 'reader',
    unrecognised: int | None = 0,
    position: int = 0,
) -> Path:
    """One archived regrade reading, in the payload `judge-regrade.mjs --out` writes."""
    payload: dict[str, object] = {
        'what': 'How often the judge changes its verdict on the same answer.',
        'artifact': 'readings/artifact/benchmark-cortex-memory-ablation-report.json',
        'generatedAt': '2026-11-15T00:00:00.000Z',
        'passes': 2,
        'scorer': 'full',
        'channels': None,
        'judge': {
            'artifact': {
                'provider': 'deepseek',
                'model': 'deepseek-chat',
                'temperature': 0,
                'judgeSource': judge_source,
            },
            'regrade': {
                'selection': selection,
                'providerId': provider,
                'temperature': 0,
                'thinking': 'disabled',
            },
            'matchesArtifact': provider == 'deepseek',
        },
        'reading': {
            'judged': judged,
            'flips': 2,
            'rate': 0.004,
            'recordedCorrect': recorded,
            'regradedCorrect': regraded,
        },
    }
    if unrecognised is not None:
        payload['judge']['parse'] = {  # type: ignore[index]
            'calls': 508,
            'unrecognised': unrecognised,
            'samples': [],
        }
    path = tmp_path / f'{name}-{position}.json'
    path.write_text(json.dumps(payload), encoding='utf-8')
    return path


# --------------------------------------------------------------------------------------------
# 1. The credential follows the judge
# --------------------------------------------------------------------------------------------


def test_the_workflow_exports_the_credential_the_cross_vendor_judge_needs() -> None:
    """A `zhipu:` judge with no `ZHIPU_API_KEY` in the job is a 500-question 401.

    The workflow exported `DEEPSEEK_API_KEY` and nothing else, which was correct while the judge
    could only be a DeepSeek model and is the reason the cross-vendor reading was unreachable
    rather than merely unattempted.
    """
    text = WORKFLOW.read_text(encoding='utf-8')
    assert 'ZHIPU_API_KEY: ${{ secrets.ZHIPU_API_KEY }}' in text, (
        'the cross-vendor judge has no credential in the job that would run it'
    )


def test_the_refusal_step_asks_the_tool_which_credential_it_needs() -> None:
    """The provider table lives in `reader-provider.ts`, and the shell must not carry a second copy.

    A hand-written `case` over provider names would be a third statement of a table that already has
    two homes' worth of trouble; the tool resolves it through the same declaration
    `createJudgeFromEnv` uses, so the check and the request cannot name different variables.
    """
    text = WORKFLOW.read_text(encoding='utf-8')
    assert 'judge-credential.mjs' in text, 'the workflow does not check the judge’s credential'
    assert 'if [ -z "${DEEPSEEK_API_KEY}" ]' not in text, (
        'the refinement of "which key" is still hardcoded to one provider'
    )


def test_the_credential_is_the_one_the_artifact_s_judge_needs(tmp_path: Path) -> None:
    """An artifact graded by a Zhipu judge needs a Zhipu key, even with DeepSeek's key present.

    This is the whole point of asking the artifact: the dispatch usually does not pin a judge, and
    the default is not "DeepSeek" but "whatever graded this artifact".
    """
    artifact = report(
        tmp_path,
        judge={'providerId': 'zhipu', 'model': 'glm-4.6', 'temperature': 0, 'source': 'reader'},
    )
    result = run_tool(
        CREDENTIAL,
        clean_env(ZHIPU_API_KEY='zhipu-secret-value', DEEPSEEK_API_KEY='deepseek-secret-value'),
        '--artifact',
        str(artifact),
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'zhipu:glm-4.6' in result.stdout
    assert 'ZHIPU_API_KEY' in result.stdout
    assert 'judge from       the artifact' in result.stdout


def test_a_missing_credential_is_a_refusal_that_names_the_variable(tmp_path: Path) -> None:
    """And it must not print the value it did find, which is why the check is not `env | grep`."""
    artifact = report(
        tmp_path,
        judge={'providerId': 'zhipu', 'model': 'glm-4.6', 'temperature': 0, 'source': 'reader'},
    )
    result = run_tool(CREDENTIAL, clean_env(DEEPSEEK_API_KEY='deepseek-secret-value'), '--artifact', str(artifact))
    assert result.returncode == 1, result.stdout + result.stderr
    # The most specific name the declaration lists: an operator reads this and sets one variable.
    assert 'ZHIPU_LLM_API_KEY' in result.stderr
    assert 'zhipu' in result.stderr
    assert 'deepseek-secret-value' not in result.stdout + result.stderr


def test_a_present_credential_is_reported_by_length_only(tmp_path: Path) -> None:
    artifact = report(tmp_path)
    result = run_tool(
        CREDENTIAL,
        clean_env(DEEPSEEK_API_KEY='deepseek-secret-value'),
        '--artifact',
        str(artifact),
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert f'length {len("deepseek-secret-value")}' in result.stdout
    assert 'deepseek-secret-value' not in result.stdout


def test_a_zhipu_judge_reaches_the_endpoint_with_the_zhipu_key(tmp_path: Path) -> None:
    """End to end through `createJudgeFromEnv`, which is the only place the swap can be observed.

    The base URL is overridden through the variable **the provider declares**
    (`CORTEX_READER_BASE_URL`), not through `DEEPSEEK_BASE_URL`: a test that reached the stub by a
    variable the Zhipu declaration does not read would be describing a path no dispatch takes.
    """
    artifact = report(tmp_path)
    out = tmp_path / 'reading.json'
    with stub('YES') as (base_url, recorded):
        result = run_tool(
            REGRADE,
            clean_env(
                CORTEX_JUDGE_MODEL='zhipu:glm-4.6',
                ZHIPU_API_KEY='zhipu-stub-key',
                CORTEX_READER_BASE_URL=base_url,
            ),
            '--artifact',
            str(artifact),
            '--passes',
            '2',
            '--scorer',
            'full',
            '--out',
            str(out),
        )
    assert result.returncode == 0, result.stdout + result.stderr
    assert recorded, 'the judge never reached the stub'
    bodies = [entry['body'] for entry in recorded]
    assert {body['model'] for body in bodies} == {'glm-4.6'}
    # `Bearer <key>`: the Zhipu key travelled, not the DeepSeek one -- and there is no DeepSeek key
    # in this environment to travel by accident.
    assert {entry['authorization'] for entry in recorded} == {'Bearer zhipu-stub-key'}
    payload = json.loads(out.read_text(encoding='utf-8'))
    assert payload['judge']['regrade']['providerId'] == 'zhipu'
    assert payload['judge']['regrade']['selection'] == 'zhipu:glm-4.6'


# --------------------------------------------------------------------------------------------
# 2. An unreadable reply is counted, not read as "no"
# --------------------------------------------------------------------------------------------


def test_replies_the_parser_cannot_read_are_counted_and_sampled(tmp_path: Path) -> None:
    """`parseJudgeResponse` returns `false` for anything it does not recognise, by design.

    That default is right for a verdict and wrong for a reading: it turns "this judge answers in
    markdown" into "this judge rejected 508 answers", and the cross-vendor gap would then be the size
    of the whole judge channel. So the reading carries the count, and the raw text of a few, which is
    what makes a later parser change evaluable offline instead of by another dispatch.
    """
    artifact = report(tmp_path)
    out = tmp_path / 'unparsed.json'
    with stub('**Yes**, the response matches.') as (base_url, _):
        result = run_tool(
            REGRADE,
            clean_env(
                CORTEX_JUDGE_MODEL='zhipu:glm-4.6',
                ZHIPU_API_KEY='zhipu-stub-key',
                CORTEX_READER_BASE_URL=base_url,
            ),
            '--artifact',
            str(artifact),
            '--passes',
            '2',
            '--scorer',
            'full',
            '--out',
            str(out),
        )
    assert result.returncode == 0, result.stdout + result.stderr
    payload = json.loads(out.read_text(encoding='utf-8'))
    parse = payload['judge']['parse']
    assert parse['unrecognised'] == parse['calls'], 'a markdown reply was read as a verdict'
    assert parse['calls'] > 0
    assert any('Yes' in sample for sample in parse['samples'])
    # And the consequence, stated where a reader will meet it: the arm scores 0 under this judge.
    assert payload['reading']['regradedCorrect'] == 0


def test_a_readable_reply_is_not_counted_as_unrecognised(tmp_path: Path) -> None:
    """The counter must not fire on the format the whole campaign was graded in."""
    artifact = report(tmp_path)
    out = tmp_path / 'parsed.json'
    with stub('YES') as (base_url, _):
        result = run_tool(
            REGRADE,
            clean_env(
                CORTEX_JUDGE_MODEL='deepseek-chat',
                DEEPSEEK_API_KEY='stub',
                DEEPSEEK_BASE_URL=base_url,
            ),
            '--artifact',
            str(artifact),
            '--passes',
            '2',
            '--scorer',
            'full',
            '--out',
            str(out),
        )
    assert result.returncode == 0, result.stdout + result.stderr
    payload = json.loads(out.read_text(encoding='utf-8'))
    assert payload['judge']['parse']['unrecognised'] == 0
    assert payload['reading']['regradedCorrect'] == payload['reading']['recordedCorrect']


def test_the_reading_states_both_sides_of_its_own_difference(tmp_path: Path) -> None:
    """`recordedCorrect` is what makes `Δ` computable from the file alone.

    Without it a comparison has to reconstruct the recorded side from `artifactOnly`, `regradeOnly`
    and `ties` -- and a tie's composition is not recorded at all, so two of the four numbers would be
    a guess. A reading that cannot state both sides of its difference cannot be compared.
    """
    artifact = report(tmp_path)
    out = tmp_path / 'both-sides.json'
    with stub('NO') as (base_url, _):
        result = run_tool(
            REGRADE,
            clean_env(
                CORTEX_JUDGE_MODEL='deepseek-chat',
                DEEPSEEK_API_KEY='stub',
                DEEPSEEK_BASE_URL=base_url,
            ),
            '--artifact',
            str(artifact),
            '--passes',
            '2',
            '--scorer',
            'full',
            '--out',
            str(out),
        )
    assert result.returncode == 0, result.stdout + result.stderr
    payload = json.loads(out.read_text(encoding='utf-8'))
    assert payload['reading']['recordedCorrect'] == 2
    assert payload['reading']['regradedCorrect'] == 0
    # The instrument the reading describes, on both sides, with the provenance of the artifact's.
    assert payload['judge']['artifact']['judgeSource'] is None
    assert payload['judge']['regrade']['providerId'] == 'deepseek'


# --------------------------------------------------------------------------------------------
# 3. The comparison is arithmetic
# --------------------------------------------------------------------------------------------


def test_the_same_gap_under_two_judges_is_undetectable_favouritism(tmp_path: Path) -> None:
    """`≤1 question` is the pre-declared line, and it is the line this prints.

    Two judges that move the artifact by the same number of questions give no evidence that the
    reader's family was favoured: the strictness explains the whole gap.
    """
    same = reading(tmp_path, 'same', selection='deepseek-v4-pro', provider='deepseek', recorded=427, regraded=412)
    cross = reading(tmp_path, 'cross', selection='zhipu:glm-4.6', provider='zhipu', recorded=427, regraded=411, position=1)
    result = run_tool(COMPARE, clean_env(), '--same', str(same), '--cross', str(cross))
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'favoritism-undetectable' in result.stdout
    # Both deltas printed, so the verdict can be checked against the two numbers it came from.
    assert '-15' in result.stdout
    assert '-16' in result.stdout


def test_a_gap_between_the_thresholds_is_inconclusive_and_says_so(tmp_path: Path) -> None:
    """2 to 5 questions is neither "no effect" nor "split M1", and rounding it would be a claim."""
    same = reading(tmp_path, 'same', selection='deepseek-v4-pro', provider='deepseek', recorded=427, regraded=412)
    cross = reading(tmp_path, 'cross', selection='zhipu:glm-4.6', provider='zhipu', recorded=427, regraded=408, position=1)
    result = run_tool(COMPARE, clean_env(), '--same', str(same), '--cross', str(cross))
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'inconclusive' in result.stdout


def test_a_large_gap_requires_the_m1_number_to_be_split(tmp_path: Path) -> None:
    """`>5` is where the 4.3 pp of `M1` stops being a single statement about the reader."""
    same = reading(tmp_path, 'same', selection='deepseek-v4-pro', provider='deepseek', recorded=427, regraded=412)
    cross = reading(tmp_path, 'cross', selection='zhipu:glm-4.6', provider='zhipu', recorded=427, regraded=390, position=1)
    result = run_tool(COMPARE, clean_env(), '--same', str(same), '--cross', str(cross))
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'split-required' in result.stdout
    # The gap has to be printed as the number it was decided on, not just its verdict.
    assert 'gap              22 question(s)' in result.stdout


def test_the_boundaries_are_the_declared_ones(tmp_path: Path) -> None:
    """1 and 2, 5 and 6: the three states are separated exactly where the plan says they are.

    Off-by-one at a threshold is the kind of defect that changes a published conclusion while every
    number in the table stays right, so both sides of both boundaries are asserted.
    """
    cases = [
        (1, 'favoritism-undetectable'),
        (2, 'inconclusive'),
        (5, 'inconclusive'),
        (6, 'split-required'),
    ]
    for index, (gap, expected) in enumerate(cases):
        same = reading(
            tmp_path,
            f'same-{index}',
            selection='deepseek-v4-pro',
            provider='deepseek',
            recorded=427,
            regraded=412,
        )
        cross = reading(
            tmp_path,
            f'cross-{index}',
            selection='zhipu:glm-4.6',
            provider='zhipu',
            recorded=427,
            regraded=412 - gap,
            position=index + 1,
        )
        result = run_tool(COMPARE, clean_env(), '--same', str(same), '--cross', str(cross))
        assert result.returncode == 0, result.stdout + result.stderr
        assert expected in result.stdout, f'gap {gap} read as something else: {result.stdout}'


def test_two_readings_of_one_provider_are_refused(tmp_path: Path) -> None:
    """Comparing DeepSeek with DeepSeek answers a different question and answers it as zero."""
    same = reading(tmp_path, 'same', selection='deepseek-v4-pro', provider='deepseek', recorded=427, regraded=412)
    other = reading(tmp_path, 'other', selection='deepseek-chat', provider='deepseek', recorded=427, regraded=405, position=1)
    result = run_tool(COMPARE, clean_env(), '--same', str(same), '--cross', str(other))
    assert result.returncode == 1
    assert 'same provider' in result.stderr


def test_two_readings_of_different_populations_are_refused(tmp_path: Path) -> None:
    """A Δ on 467 questions and a Δ on 500 are not two measurements of one quantity."""
    same = reading(tmp_path, 'same', selection='deepseek-v4-pro', provider='deepseek', recorded=427, regraded=412)
    cross = reading(
        tmp_path,
        'cross',
        selection='zhipu:glm-4.6',
        provider='zhipu',
        recorded=455,
        regraded=440,
        judged=500,
        position=1,
    )
    result = run_tool(COMPARE, clean_env(), '--same', str(same), '--cross', str(cross))
    assert result.returncode == 1
    assert 'population' in result.stderr


def test_a_reading_that_does_not_state_its_recorded_side_is_refused(tmp_path: Path) -> None:
    """The older payload, and the reason it is refused rather than reconstructed."""
    same = reading(tmp_path, 'same', selection='deepseek-v4-pro', provider='deepseek', recorded=427, regraded=412)
    cross = reading(tmp_path, 'cross', selection='zhipu:glm-4.6', provider='zhipu', recorded=427, regraded=400, position=1)
    payload = json.loads(cross.read_text(encoding='utf-8'))
    del payload['reading']['recordedCorrect']
    cross.write_text(json.dumps(payload), encoding='utf-8')
    result = run_tool(COMPARE, clean_env(), '--same', str(same), '--cross', str(cross))
    assert result.returncode == 1
    assert 'recordedCorrect' in result.stderr


def test_a_reading_that_does_not_count_its_unreadable_replies_is_refused(tmp_path: Path) -> None:
    """An unknown parse rate is not a zero parse rate.

    The `judge.parse` block is what bounds how much of a Δ could be parser mismatch instead of
    strictness, and a reading without it cannot say its Δ is about the judge at all.
    """
    same = reading(tmp_path, 'same', selection='deepseek-v4-pro', provider='deepseek', recorded=427, regraded=412)
    cross = reading(
        tmp_path,
        'cross',
        selection='zhipu:glm-4.6',
        provider='zhipu',
        recorded=427,
        regraded=400,
        unrecognised=None,
        position=1,
    )
    result = run_tool(COMPARE, clean_env(), '--same', str(same), '--cross', str(cross))
    assert result.returncode == 1
    assert 'unrecognised' in result.stderr


def test_a_reading_whose_parse_rate_exceeds_the_threshold_is_refused(tmp_path: Path) -> None:
    """`>1` unreadable reply is more uncertainty than the `≤1` decision can carry."""
    same = reading(tmp_path, 'same', selection='deepseek-v4-pro', provider='deepseek', recorded=427, regraded=412)
    cross = reading(
        tmp_path,
        'cross',
        selection='zhipu:glm-4.6',
        provider='zhipu',
        recorded=427,
        regraded=400,
        unrecognised=9,
        position=1,
    )
    result = run_tool(COMPARE, clean_env(), '--same', str(same), '--cross', str(cross))
    assert result.returncode == 1
    assert 'unrecognised' in result.stderr
