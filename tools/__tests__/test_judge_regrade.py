"""Tests for tools/judge-regrade.mjs — the half that runs without a model or a key.

## What this file protects

`judge-audit.mjs` measures the judge's **bias**: it asks about answers that are wrong by construction.
This tool measures the judge's **variance**: it asks about the same answer twice and counts how often
the verdict moves. §13.255.3 left that split open — two dispatches of one configuration produced
identical bytes and still moved 16 questions — so the number this tool prints is subtracted from the
arm's noise floor rather than added to it.

The rate is worthless if the loop is not actually asking twice, and the failure is silent:
`createLlmJudge` memoises on the prompt, so a two-pass loop without `clearJudgeCache()` returns the
first verdict on every pass and reports a perfect 0.0%. That defect used to be untestable here
("it needs a model"), and the cost of that gap is §13.312: **the tool was re-asking a different
judge than the one that produced the artifact**, so its readings described `deepseek-chat` at the
provider's default temperature rather than the arm's own reader at temperature 0, and the 10 of 29
preference questions it "rescued" were a model difference read as an artifact error.

So this file now runs the tool against a **stub endpoint** rather than against no endpoint. The
stub is a real HTTP server speaking the provider's protocol; nothing in `cortex-eval`, `cortex-ai`
or the tool is replaced. That makes the two guarantees the header claims — the cache is cleared
between passes, and the request carries the identity the artifact pinned — observable in the
request bodies, which is the only place they can be observed without spending credits.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'judge-regrade.mjs'
AUDIT_TOOL = REPO / 'tools' / 'judge-audit.mjs'
WORKFLOW = REPO / '.github' / 'workflows' / 'judge-audit.yml'


class _JudgeHandler(BaseHTTPRequestHandler):
    """Answer every `POST /chat/completions` with one fixed verdict, and keep the body.

    A stub *server* rather than a stubbed client: the object under test is the tool's assembly of
    the judge, and a `fetch` replaced inside the process would skip exactly the layers whose
    disagreement is being measured (`withTemperature`, the thinking mode, the transport numbers).
    """

    def do_POST(self) -> None:  # noqa: N802 - the base class names this
        length = int(self.headers.get('content-length') or 0)
        raw = self.rfile.read(length) if length else b'{}'
        self.server.recorded.append(json.loads(raw))
        payload = json.dumps(
            {'choices': [{'message': {'content': self.server.verdict}, 'finish_reason': 'stop'}]}
        ).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args: object) -> None:
        """Silence the per-request line; the assertions are the record."""


@contextlib.contextmanager
def judge_stub(verdict: str = 'YES'):
    """A local provider that says `verdict`, plus the bodies it was sent."""
    server = ThreadingHTTPServer(('127.0.0.1', 0), _JudgeHandler)
    server.recorded = []
    server.verdict = verdict
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_address[1]}/v1', server.recorded
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=10)


def judge_env(base_url: str, model: str = 'stub-judge', **extra: str) -> dict[str, str]:
    """The environment a run's judge is built from, pointed at the stub.

    `DEEPSEEK_BASE_URL` is the variable `reader-provider.ts` reads for a custom endpoint, so the
    probe reaches a server this process owns while every factory reads the same declarations a
    real dispatch does. The key is a placeholder: the stub ignores it, and requiring a real one
    would make this test un-runnable in CI without the org secret it exists to avoid spending.
    """
    env = {
        **os.environ,
        'DEEPSEEK_BASE_URL': base_url,
        'DEEPSEEK_API_KEY': 'stub-key-not-a-credential',
        'CORTEX_JUDGE_MODEL': model,
        **extra,
    }
    for absent in ('TEMPERATURE', 'DEEPSEEK_THINKING', 'CORTEX_READER_TIMEOUT_MS'):
        if absent not in extra:
            env.pop(absent, None)
    return env


def run_with(env: dict[str, str], *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['node', str(TOOL), *args],
        capture_output=True,
        text=True,
        cwd=REPO,
        timeout=180,
        env=env,
    )


def artifact(tmp_path: Path) -> Path:
    """A miniature report covering the cases that decide eligibility."""
    questions = [
        {
            'questionId': 'q-ie',
            'question': 'Where did I put the keys?',
            'capability': 'IE',
            'questionType': 'single-session-user',
            'groundTruth': 'in the drawer',
            'answer': 'In the kitchen drawer.',
            'correct': True,
        },
        {
            'questionId': 'q-abs',
            'question': 'What is my sister called?',
            'capability': 'ABS',
            'questionType': 'single-session-user_abs',
            'groundTruth': 'The user never mentioned a sister.',
            'answer': 'You have not mentioned a sister.',
            'correct': True,
        },
        {
            'questionId': 'q-noanswer',
            'question': 'Where did I put the keys?',
            'capability': 'IE',
            'questionType': 'single-session-user',
            'groundTruth': 'in the drawer',
            'answer': '   ',
            'correct': False,
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
    path = tmp_path / 'report.json'
    path.write_text(json.dumps({'questions': questions}), encoding='utf-8')
    return path


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['node', str(TOOL), *args],
        capture_output=True,
        text=True,
        cwd=REPO,
        timeout=120,
    )


def test_plan_lists_only_questions_that_can_be_graded(tmp_path: Path) -> None:
    """A question with no answer, or with no gold, has nothing to re-grade.

    The plan is the reviewable form: it prints what a real run would spend, so an ineligible question
    showing up here would be a question whose verdict could never be compared.
    """
    result = run('--artifact', str(artifact(tmp_path)), '--plan-only')
    assert result.returncode == 0, result.stderr
    assert 'questions       2' in result.stdout
    assert 'q-ie' in result.stdout
    # Abstention is gradable here — nothing is perturbed — which is the opposite of the false-accept
    # audit's rule and the reason the two tools are separate.
    assert 'q-abs' in result.stdout
    assert 'q-noanswer' not in result.stdout


def test_plan_reports_the_recorded_correct_count(tmp_path: Path) -> None:
    """`recorded correct` is what the artifact claimed, and it is the number the flips are read against."""
    result = run('--artifact', str(artifact(tmp_path)), '--plan-only')
    assert 'recorded correct 2 / 2' in result.stdout


def test_a_single_pass_is_refused(tmp_path: Path) -> None:
    """One pass has no second reading, so a flip rate from it would be 0 by construction."""
    result = run('--artifact', str(artifact(tmp_path)), '--passes', '1', '--plan-only')
    assert result.returncode == 2
    assert 'passes must be an integer >= 2' in result.stderr


def test_a_non_integer_pass_count_is_refused(tmp_path: Path) -> None:
    result = run('--artifact', str(artifact(tmp_path)), '--passes', '1.5', '--plan-only')
    assert result.returncode == 2


def test_the_tool_refuses_an_artifact_with_nothing_to_grade(tmp_path: Path) -> None:
    """Zero gradable questions is a refusal rather than a 0.0% reading, which would look like a result."""
    empty = tmp_path / 'empty.json'
    empty.write_text(json.dumps({'questions': []}), encoding='utf-8')
    result = run('--artifact', str(empty), '--plan-only')
    assert result.returncode == 1
    assert 'no gradable questions' in result.stderr


def test_the_tool_refuses_a_file_without_a_questions_array(tmp_path: Path) -> None:
    broken = tmp_path / 'broken.json'
    broken.write_text(json.dumps({'rows': []}), encoding='utf-8')
    result = run('--artifact', str(broken), '--plan-only')
    assert result.returncode != 0
    assert 'no questions array' in result.stderr


def test_the_tool_explains_its_usage_when_given_no_artifact() -> None:
    result = run('--plan-only')
    assert result.returncode == 2
    assert 'usage: judge-regrade.mjs' in result.stderr


def test_the_plan_is_reproducible_from_the_artifact_alone(tmp_path: Path) -> None:
    """No key, no model, no clock: two invocations must print the same plan."""
    first = run('--artifact', str(artifact(tmp_path)), '--plan-only')
    second = run('--artifact', str(artifact(tmp_path)), '--plan-only')
    assert first.stdout == second.stdout


def test_the_pure_counting_is_importable() -> None:
    """`tally` and `signTest` are the halves a model is not needed for, so they are asserted directly.

    Driving them through node's import rather than through the CLI is deliberate: the CLI path needs a
    key, and a rate that is only ever checked by eye is how a counting error survives a campaign.
    """
    script = """
      import { tally, signTest } from './tools/judge-regrade.mjs';
      const rows = [
        { questionId: 'a', capability: 'MR', recorded: true, verdicts: [true, true] },
        { questionId: 'b', capability: 'MR', recorded: true, verdicts: [false, true] },
        { questionId: 'c', capability: 'IE', recorded: false, verdicts: [true, false] },
      ];
      const reading = tally(rows);
      console.log(JSON.stringify({
        flips: reading.flips,
        up: reading.up,
        down: reading.down,
        agrees: reading.agreesWithArtifact,
        p: signTest(1, 1),
        mr: reading.byCapability.MR,
      }));
    """
    result = subprocess.run(
        ['node', '--input-type=module', '-e', script],
        capture_output=True,
        text=True,
        cwd=REPO,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    reading = json.loads(result.stdout)
    assert reading['flips'] == 2
    assert reading['up'] == 1
    assert reading['down'] == 1
    assert reading['agrees'] == 1
    assert reading['p'] == 1.0
    assert reading['mr'] == {'n': 2, 'flips': 1, 'rate': 0.5}


def preference_artifact(tmp_path: Path) -> Path:
    """Two gradable questions, one of each gold shape.

    The preference gold is a real LongMemEval one: it describes what a good answer should do
    ("The user would prefer responses that ..."), which is a criterion rather than an answer, so it
    can never be matched and always reaches the judge. Separating it is what lets a regrade say
    whether the judge's variance lives in the question type whose verdict is least mechanical.
    """
    questions = [
        {
            'questionId': 'q-pref',
            'question': 'Any tips for keeping my kitchen clean?',
            'capability': 'IE',
            'questionType': None,
            'groundTruth': 'The user would prefer responses that acknowledge their existing efforts.',
            'answer': 'Clean your utensil holder regularly.',
            'correct': True,
        },
        {
            'questionId': 'q-fact',
            'question': 'Where did I put the keys?',
            'capability': 'IE',
            'questionType': 'single-session-user',
            'groundTruth': 'in the drawer',
            'answer': 'In the kitchen drawer.',
            'correct': True,
        },
    ]
    path = tmp_path / 'preference.json'
    path.write_text(json.dumps({'questions': questions}), encoding='utf-8')
    return path


def gradable_count(stdout: str) -> int:
    """The `questions N` line, read rather than pattern-matched, so spacing is not the assertion."""
    for line in stdout.splitlines():
        if line.startswith('questions'):
            return int(line.split()[1])
    raise AssertionError(f'no question count in:\n{stdout}')


def test_preference_only_selects_the_criterion_golds(tmp_path: Path) -> None:
    out = run('--artifact', str(preference_artifact(tmp_path)), '--plan-only', '--preference-only')
    assert out.returncode == 0, out.stderr
    assert gradable_count(out.stdout) == 1


def test_non_preference_only_is_the_complement(tmp_path: Path) -> None:
    """The two filters must partition the list, not merely both be non-empty.

    A filter that overlapped or dropped would make the two readings incomparable while both looked
    plausible, which is the defect shape this file already pins for eligibility.
    """
    artifact_path = str(preference_artifact(tmp_path))
    both = gradable_count(run('--artifact', artifact_path, '--plan-only').stdout)
    preference = gradable_count(run('--artifact', artifact_path, '--plan-only', '--preference-only').stdout)
    rest = gradable_count(
        run('--artifact', artifact_path, '--plan-only', '--non-preference-only').stdout
    )
    assert preference + rest == both


def test_no_filter_flag_keeps_every_gradable_question(tmp_path: Path) -> None:
    out = run('--artifact', str(preference_artifact(tmp_path)), '--plan-only')
    assert gradable_count(out.stdout) == 2


def test_the_majority_verdict_and_its_direction(tmp_path: Path) -> None:
    """A flip rate says the verdict moved; it cannot say which way the artifact was wrong.

    On the M1 preference population this distinction decides a published conclusion: arm B's
    artifact recorded 13 of 29 correct and the re-grade disagreed with 10 of them, while the five
    passes agreed with each other. Without a direction those ten questions are consistent with
    "the artifact was too strict" (B is really 23/29) and with "the artifact was too lenient"
    (B is really 3/29), and the two readings support opposite conclusions about requirement 12.

    What the direction alone still could not say is which side was *right*, and §13.312 records the
    answer: neither. The two readings came from two different judges, so the disagreement measured
    the instrument and not the arm.
    """
    script = """
      import { tally, majority } from './tools/judge-regrade.mjs';
      const rows = [
        // Re-graded true every time, artifact said false: the artifact was strict.
        { questionId: 'a', capability: 'IE', recorded: false, verdicts: [true, true, true] },
        // Re-graded false every time, artifact said true: the artifact was lenient.
        { questionId: 'b', capability: 'IE', recorded: true, verdicts: [false, false, false] },
        // Unstable, majority true.
        { questionId: 'c', capability: 'IE', recorded: false, verdicts: [true, true, false] },
        // Unstable with no majority: a tie is not a verdict.
        { questionId: 'd', capability: 'IE', recorded: true, verdicts: [true, false] },
      ];
      const reading = tally(rows);
      console.log(JSON.stringify({
        regradedCorrect: reading.regradedCorrect,
        artifactOnlyCorrect: reading.artifactOnlyCorrect,
        regradeOnlyCorrect: reading.regradeOnlyCorrect,
        ties: reading.ties,
        tieIsFalse: majority([true, false]),
      }));
    """
    out = subprocess.run(
        ['node', '--input-type=module', '-e', script],
        capture_output=True,
        text=True,
        cwd=REPO,
        timeout=120,
    )
    assert out.returncode == 0, out.stderr
    reading = json.loads(out.stdout)
    # `a` and `c` are correct on the majority; `b` is not; `d` is a tie and a tie is not a verdict.
    assert reading['regradedCorrect'] == 2
    assert reading['artifactOnlyCorrect'] == 1
    assert reading['regradeOnlyCorrect'] == 2
    assert reading['ties'] == 1
    assert reading['tieIsFalse'] is False


def test_the_re_grade_is_assembled_by_the_judge_factory(tmp_path: Path) -> None:
    """The tool must build its judge the way the run built it, and a route-scoped run proves it.

    Both M1 arms were dispatched with `DEEPSEEK_THINKING=multi-session+temporal` and every artifact
    records the reach (`memoryArmConfig.reader.thinkingRoutes`). `createLlmFromEnv` — the *reader*
    factory this tool used to call — cannot express that value at all: it throws, because one reader
    cannot administer a route list. `createJudgeFromEnv` accepts it and disables thinking, which is
    what the run's judge did.

    So this is not a style preference: on the two artifacts the campaign is actually arguing about,
    the old factory either refused to run or silently graded with a different instrument. The
    assertion is the request body, because `thinking: disabled` is the one property of the judge the
    artifact can be compared against.
    """
    with judge_stub('YES') as (base_url, recorded):
        result = run_with(
            judge_env(base_url, DEEPSEEK_THINKING='multi-session+temporal', TEMPERATURE='0'),
            '--artifact',
            str(artifact(tmp_path)),
            '--passes',
            '2',
        )
    assert result.returncode == 0, result.stderr
    # Two gradable questions, two passes: anything less means a pass did not ask.
    assert len(recorded) == 4
    assert all(body['thinking'] == {'type': 'disabled'} for body in recorded)


def test_the_cache_is_cleared_between_passes(tmp_path: Path) -> None:
    """The defect the header warns about, caught at the only place it is visible: the wire.

    `createLlmJudge` memoises on the prompt, so a loop that forgot `clearJudgeCache()` would send
    two requests instead of four and print a perfect 0.0% — a number that reads as "the judge is
    reproducible" and is a property of a `Map`. Counting the requests is what tells the two apart.
    """
    with judge_stub('YES') as (base_url, recorded):
        result = run_with(judge_env(base_url), '--artifact', str(artifact(tmp_path)), '--passes', '3')
    assert result.returncode == 0, result.stderr
    assert len(recorded) == 6, 'three passes over two questions is six requests, or the cache leaked'


def test_the_request_carries_the_identity_the_dispatch_pinned(tmp_path: Path) -> None:
    """A re-grade is only about the same judge if the same judge is named, at the same temperature.

    Both halves reach the request body, and both are decisions the *dispatch* makes: the workflow
    supplies `CORTEX_JUDGE_MODEL`, and `TEMPERATURE` (which `benchmark-cortex-memory.yml` always sets
    to `0`). §13.312 is the round where neither was supplied and the reading described a third
    model at the provider's default temperature.
    """
    with judge_stub('YES') as (base_url, recorded):
        result = run_with(
            judge_env(base_url, model='deepseek-v4-pro', TEMPERATURE='0'),
            '--artifact',
            str(artifact(tmp_path)),
            '--passes',
            '2',
        )
    assert result.returncode == 0, result.stderr
    assert {body['model'] for body in recorded} == {'deepseek-v4-pro'}
    assert {body['temperature'] for body in recorded} == {0}


def test_the_two_factories_differ_in_the_way_the_tool_depends_on() -> None:
    """Pins the discriminator itself, so the tool's choice of factory cannot be read as arbitrary.

    `createLlmFromEnv` refuses a route list and `createJudgeFromEnv` accepts it. That asymmetry is
    the whole reason the reader factory is the wrong instrument for a judge, and it is a property of
    the package rather than of this tool — so it is asserted against `dist`, where both are exported.
    """
    script = """
      import { createLlmFromEnv, createJudgeFromEnv } from './packages/cortex-eval/dist/index.js';
      const env = {
        DEEPSEEK_API_KEY: 'stub-key-not-a-credential',
        DEEPSEEK_MODEL: 'stub-judge',
        DEEPSEEK_THINKING: 'multi-session+temporal',
      };
      const outcome = (build) => {
        try { build(); return 'built'; } catch (err) {
          return /cannot be administered by a single reader/.test(String(err.message))
            ? 'refused'
            : `other: ${err.message}`;
        }
      };
      console.log(JSON.stringify({
        reader: outcome(() => createLlmFromEnv(env)),
        judge: outcome(() => createJudgeFromEnv(env)),
      }));
    """
    result = subprocess.run(
        ['node', '--input-type=module', '-e', script],
        capture_output=True,
        text=True,
        cwd=REPO,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    reading = json.loads(result.stdout)
    assert reading['reader'] == 'refused'
    assert reading['judge'] == 'built'


def test_both_readings_of_the_judge_are_built_by_one_factory() -> None:
    """The bias tool and the variance tool are two questions about one instrument.

    They are separate files because they print different quantities (§13.31x), and that separation is
    exactly what let them drift: `judge-audit.mjs` and `judge-regrade.mjs` both called the reader
    factory while `run-ablation.ts` and `regrade-partial.ts` both call the judge factory. Four
    callers, two instruments, and the difference is invisible in every number either tool printed.

    Asserted on the import rather than through a run because the audit's false-accept path needs
    perturbed cases *and* a model; the sibling test above covers the runtime half for the re-grade.
    """
    # Matched on the import list rather than on the file text: both headers *describe* the defect
    # they repaired, and a substring search would fail on the explanation of the fix.
    imported = re.compile(r'^\s*(create(?:Llm|Judge)FromEnv),?\s*$', re.MULTILINE)
    for tool in (TOOL, AUDIT_TOOL):
        names = set(imported.findall(tool.read_text(encoding='utf-8')))
        assert 'createJudgeFromEnv' in names, f'{tool.name} does not name the judge factory'
        assert 'createLlmFromEnv' not in names, f'{tool.name} still builds a judge from the reader'


def test_the_workflow_names_the_judge_in_variable_the_factory_reads() -> None:
    """Two names for one idea, and the workflow had the one the factory ignores.

    `judge-audit.yml` set `CORTEX_LLM_MODEL` — the profile variable of `cortex-ai`'s *other*
    generation path. `createJudgeFromEnv` resolves its model from `DEEPSEEK_MODEL` (with
    `CORTEX_READER_MODEL` as the declaration's fallback), so the input was decoration: every audit
    dispatched so far graded with the default `deepseek-chat`, whatever it said.

    The workflow now names the variable the factory reads, and leaves it empty by default so that
    `judge-identity.mjs` fills it from the artifact. Both halves are asserted here because either one
    alone reintroduces the defect: a right variable with a wrong default still grades a third model.
    """
    text = WORKFLOW.read_text(encoding='utf-8')
    assigned = set(re.findall(r'^\s*([A-Z_]+):\s*\$\{\{\s*inputs\.', text, re.MULTILINE))
    assert 'CORTEX_JUDGE_MODEL' in assigned, 'the workflow does not pin the judge'
    assert 'CORTEX_LLM_MODEL' not in assigned, 'the inert variable is back'
    assert "default: 'deepseek-chat'" not in text, 'the judge model is defaulted again'


def test_an_artifact_that_does_not_name_its_judge_is_unverifiable_not_matching() -> None:
    """`null` and `true` are different claims, and only one of them is earned here.

    An artifact from before `memoryArmConfig.reader` existed records no model. A re-grade of it is a
    legitimate measurement, but it cannot claim to describe that artifact's judge, and the repo's rule
    (`§13.11.2`, and the `null`-versus-`''` distinction in `benchmark.ts`) is that an unknown printed
    as a known value is worse than an absent one. So the third state survives into the reading.
    """
    script = """
      import {
        artifactJudgeIdentity,
        judgeEnvFor,
        judgeMatchesArtifact,
        selectionFor,
      } from './tools/judge-identity.mjs';
      const recorded = {
        memoryArmConfig: {
          reader: { providerId: 'deepseek', model: 'deepseek-v4-pro', temperature: 0 },
        },
      };
      const silent = { questions: [] };
      const env = (extra) => ({ ...extra });
      console.log(JSON.stringify({
        // An artifact that says, and a dispatch that says nothing: the artifact wins.
        filled: judgeEnvFor(recorded, env({})).CORTEX_JUDGE_MODEL,
        filledTemperature: judgeEnvFor(recorded, env({})).TEMPERATURE,
        // An artifact that says, and a dispatch that disagrees: the dispatch wins, visibly.
        overridden: judgeEnvFor(recorded, env({ CORTEX_JUDGE_MODEL: 'deepseek-chat' })).CORTEX_JUDGE_MODEL,
        matchesWhenOverridden: judgeMatchesArtifact(recorded, env({ CORTEX_JUDGE_MODEL: 'deepseek-chat' })),
        matchesWhenDerived: judgeMatchesArtifact(recorded, judgeEnvFor(recorded, env({}))),
        // A model is not a judge without the temperature it read at.
        matchesAtOtherTemperature: judgeMatchesArtifact(recorded, env({ TEMPERATURE: '1' })),
        matchesUnrecorded: judgeMatchesArtifact(silent, env({ CORTEX_JUDGE_MODEL: 'deepseek-chat' })),
        identityUnrecorded: artifactJudgeIdentity(silent),
        // The selection grammar: a bare id is the default provider, anything else is prefixed.
        unknownProviderIsPrefixed: selectionFor('zhipu', 'glm-4.6'),
        noModelIsNoSelection: selectionFor('zhipu', null),
      }));
    """
    result = subprocess.run(
        ['node', '--input-type=module', '-e', script],
        capture_output=True,
        text=True,
        cwd=REPO,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    reading = json.loads(result.stdout)
    assert reading['filled'] == 'deepseek-v4-pro'
    assert reading['filledTemperature'] == '0'
    assert reading['overridden'] == 'deepseek-chat'
    assert reading['matchesWhenOverridden'] is False
    assert reading['matchesWhenDerived'] is True
    assert reading['matchesAtOtherTemperature'] is False
    assert reading['matchesUnrecorded'] is None
    assert reading['identityUnrecorded'] == {
        'provider': None,
        'model': None,
        'temperature': None,
        'source': None,
    }
    assert reading['unknownProviderIsPrefixed'] == 'zhipu:glm-4.6'
    assert reading['noModelIsNoSelection'] is None


def test_the_recorded_judge_wins_over_the_recorded_reader(tmp_path: Path) -> None:
    """An artifact written after §13.312 says which of the two its judge was, and that is the answer.

    Before the field, the reconstruction ("the judge was whatever answered") was the only option and
    it was wrong exactly when it mattered: on the `M1` pair the judge followed each arm's reader, so
    reading the reader back reproduced the confound instead of detecting it. An artifact that names
    both is therefore read in the order that can distinguish them -- and the reader stays in the file
    as the arm's own description, not as the instrument.
    """
    questions = [
        {
            'questionId': 'q-pref',
            'question': 'Any tips for keeping my kitchen clean?',
            'capability': 'IE',
            'questionType': 'single-session-preference',
            'groundTruth': 'The user would prefer responses that acknowledge their existing efforts.',
            'answer': 'Clean your utensil holder regularly.',
            'correct': True,
        }
    ]
    report = tmp_path / 'pinned.json'
    report.write_text(
        json.dumps(
            {
                'questions': questions,
                'memoryArmConfig': {
                    'reader': {'providerId': 'deepseek', 'model': 'deepseek-v4-pro', 'temperature': 0},
                    'judge': {'providerId': 'deepseek', 'model': 'deepseek-chat', 'temperature': 0, 'source': 'pinned'},
                },
            }
        ),
        encoding='utf-8',
    )
    result = run('--artifact', str(report), '--plan-only')
    assert result.returncode == 0, result.stderr
    # The artifact's judge is `deepseek-chat`; the arm's reader is `deepseek-v4-pro`. The line the
    # tool prints is the judge, because the judge is what it will re-ask.
    assert 'artifact judge  model=deepseek-chat temperature=0' in result.stdout
    assert 're-grade judge  model=deepseek-chat temperature=0 matchesArtifact=true' in result.stdout


def test_a_run_that_did_not_pin_its_judge_is_reported_as_having_followed_its_reader(tmp_path: Path) -> None:
    """`source` is the field that makes the confound detectable after the fact.

    A `pinned` judge is comparable across arms by construction; a `reader` judge is comparable only
    within one dispatch, because the arm *is* the reader. Printing it is the difference between
    "this artifact can be compared with that one" being checkable and being assumed.
    """
    report = tmp_path / 'followed.json'
    report.write_text(
        json.dumps(
            {
                'questions': [],
                'memoryArmConfig': {
                    'judge': {'providerId': 'deepseek', 'model': 'deepseek-v4-pro', 'temperature': 0, 'source': 'reader'},
                },
            }
        ),
        encoding='utf-8',
    )
    # No gradable question is a refusal, not a reading; the identity line is printed before it would
    # have been, which is why this asserts on stderr rather than on the printed plan.
    result = run('--artifact', str(report), '--plan-only')
    assert result.returncode == 1
    assert 'no gradable questions' in result.stderr


def exact_artifact(tmp_path: Path) -> Path:
    """One question the scorer can decide without a model, and one it cannot.

    The pair is what makes `--scorer full` observable: an exact match costs no request and a
    near-miss costs one, so the request count discriminates between the two instruments.
    """
    questions = [
        {
            'questionId': 'q-exact',
            'question': 'Where did I put the keys?',
            'capability': 'IE',
            'questionType': 'single-session-user',
            # Identical after `normalizeAnswer`, which trims and lower-cases and does not strip
            # punctuation -- so a trailing full stop on one side would make this a judged question.
            'groundTruth': 'In the drawer',
            'answer': 'in the drawer',
            'correct': True,
        },
        {
            'questionId': 'q-judged',
            'question': 'Where did I put the keys?',
            'capability': 'IE',
            'questionType': 'single-session-user',
            'groundTruth': 'in the drawer',
            'answer': 'In the kitchen drawer.',
            'correct': True,
        },
    ]
    path = tmp_path / 'exact-report.json'
    path.write_text(json.dumps({'questions': questions}), encoding='utf-8')
    return path


def test_full_scorer_decides_an_exact_match_without_asking_the_judge(tmp_path: Path) -> None:
    """`--scorer full` is what turns a re-grade into an arm score instead of a judge reading.

    `J8` registered the distinction because the judge channel alone is not an arm's accuracy: for the
    five non-preference capabilities an answer `exact` would have accepted is submitted to the model
    instead, so a judge-channel reading can disagree with the artifact about questions the artifact
    never asked a model about.

    The difference is observable on the wire rather than in the prose: `judgeScorer` short-circuits a
    normalized string equality, so an answer that IS its gold costs no request. Two questions, one of
    them exact, two passes -- two requests, not four.
    """
    with judge_stub('YES') as (base_url, recorded):
        result = run_with(
            judge_env(base_url),
            '--artifact',
            str(exact_artifact(tmp_path)),
            '--passes',
            '2',
            '--scorer',
            'full',
        )
    assert result.returncode == 0, result.stderr
    assert len(recorded) == 2, 'the exact match must not reach the endpoint, once per pass'
    assert 'scorer channels:' in result.stdout, 'a full reading has to print its channel split'
    assert 'exact 2' in result.stdout, 'one exact verdict per pass'


def test_the_judge_channel_is_still_the_default(tmp_path: Path) -> None:
    """The default must not change under a reader who did not ask for it.

    Every archived reading in this campaign was taken with the judge channel, and a default that moved
    would silently re-label them: the same numbers would describe a different instrument.
    """
    with judge_stub('YES') as (base_url, recorded):
        result = run_with(
            judge_env(base_url), '--artifact', str(exact_artifact(tmp_path)), '--passes', '2'
        )
    assert result.returncode == 0, result.stderr
    assert len(recorded) == 4, 'the judge channel asks about every question, exact match or not'
    assert 'scorer channels:' not in result.stdout


def test_an_unknown_scorer_is_refused_with_the_two_that_exist(tmp_path: Path) -> None:
    """A typo must not silently select the instrument the caller was trying to replace."""
    result = run('--artifact', str(exact_artifact(tmp_path)), '--scorer', 'exact')
    assert result.returncode == 2
    assert 'judge' in result.stderr and 'full' in result.stderr


def test_the_workflow_forwards_the_scorer_and_defaults_to_the_archived_instrument() -> None:
    """A dispatch input with no forward is the failure this file exists to prevent, one level up.

    The workflow is the only way this tool is run for a reading, so an input the job does not pass to
    the command line is a dispatch that names an instrument nobody built -- and the artifact would
    then describe the other one. The default is `judge` on purpose: it is what every archived reading
    was taken with.
    """
    text = WORKFLOW.read_text(encoding='utf-8')
    assert 'SCORER: ${{ inputs.scorer }}' in text
    assert text.count('--scorer "$SCORER"') == 2, 'both the plan and the reading have to name it'
    assert "default: 'judge'" in text


def test_the_usage_line_names_the_two_instruments() -> None:
    """`--plan-only` is what a reader reviews before spending credits, so its usage line is the place
    a third instrument would be discovered to be missing."""
    result = run()
    assert result.returncode == 2
    assert '--scorer judge|full' in result.stderr
