#!/usr/bin/env python3
"""Every check this repository claims to run must be attached to an event that runs it.

## The defect this file is written against

`verify.yml` begins with a paragraph explaining that before it existed, the only workflow was
`workflow_dispatch`-only, so `pnpm check` ran on demand and "a push that broke the build produced no
signal at all". The file that fixed that has since accumulated two more gates -- the browser suites
and now the PostgreSQL integration suite -- each of which needed the same argument made again, in
prose, in a comment.

Prose is not a control. A job can be deleted from this workflow in a one-hunk diff, every test in
the repository still passes, and the only artifact is a workflow file that no longer mentions
PostgreSQL. GitHub does not warn about a gate that is not there. This script reads the workflow and
fails when one of the declared gates has lost its attachment.

## What "attached" means, precisely

A gate is attached when one job, in the same file:

- declares the service the gate needs (for the database gate) or needs none (for the others),
- exports the environment variable the gate reads,
- runs the command, and
- runs the checker that refuses a skip.

The fourth is the one that is easy to omit and impossible to notice: `pnpm test:pg` exits 0 when
`CORTEX_PG_URL` is unset, so a job that forgot the variable is a green job that asserted nothing.
`tools/pg-integration-count.mjs` is what turns that into a failure, and requiring it *here* means a
future edit cannot remove it without this file going red.

## Why the checks are a table

Each row is `(gate, predicate, explanation)`. A table makes the coverage of this script legible --
you can read what it does not check -- and it makes an added gate a single row rather than a new
branch. The pytest file beside this one feeds it a workflow with each row's requirement removed and
asserts that exactly that row fails.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass(frozen=True)
class Requirement:
    """One way a gate can be un-attached, and the sentence to print when it is."""

    name: str
    why: str


def jobs_of(workflow: dict) -> dict[str, dict]:
    jobs = workflow.get('jobs')
    if not isinstance(jobs, dict):
        return {}
    return {name: job for name, job in jobs.items() if isinstance(job, dict)}


def steps_text(job: dict) -> str:
    """Every `run:` and `uses:` in a job, concatenated.

    A gate is attached by a step, and the step may be an inline `run`, a multi-line `run`, or a
    reusable action. Reading the whole job would match a comment; reading only `run` would miss a
    composite action. This reads the steps and nothing else.
    """
    parts: list[str] = []
    for step in job.get('steps') or []:
        if not isinstance(step, dict):
            continue
        for key in ('run', 'uses', 'name'):
            value = step.get(key)
            if isinstance(value, str):
                parts.append(value)
        env = step.get('env')
        if isinstance(env, dict):
            parts.extend(f'{k}={v}' for k, v in env.items())
    job_env = job.get('env')
    if isinstance(job_env, dict):
        parts.extend(f'{k}={v}' for k, v in job_env.items())
    return '\n'.join(parts)


def service_images(job: dict) -> list[str]:
    services = job.get('services')
    if not isinstance(services, dict):
        return []
    images = []
    for service in services.values():
        if isinstance(service, dict) and isinstance(service.get('image'), str):
            images.append(service['image'])
    return images


def service_is_healthy_gated(job: dict) -> bool:
    """True when a postgres service waits for `pg_isready` before the job's steps start.

    Without it the first statement races the server's startup, which is a flake whose cause is a
    missing line rather than anything about the code under test. GitHub also offers
    `--health-*` on any service; the check is deliberately on the flag rather than on a specific
    command, because what matters is that readiness is a declared condition.
    """
    services = job.get('services')
    if not isinstance(services, dict):
        return False
    for service in services.values():
        if not isinstance(service, dict):
            continue
        options = service.get('options') or ''
        if isinstance(options, str) and 'health-cmd' in options:
            return True
    return False


REQUIREMENTS = (
    Requirement('triggers', 'no push/pull_request trigger: the gate runs only when dispatched'),
    Requirement('check', 'no job runs `pnpm check`'),
    Requirement('postgres-service', 'no job declares a postgres service'),
    Requirement('postgres-url', 'the postgres job does not export CORTEX_PG_URL'),
    Requirement('postgres-suite', 'the postgres job does not run `test:pg`'),
    Requirement('postgres-count', 'the postgres job does not run the skip-refusing count check'),
    Requirement('postgres-health', 'the postgres service has no readiness gate'),
    Requirement('browser', 'no job runs the browser suites'),
)


def evaluate(workflow: dict) -> list[tuple[Requirement, bool, str]]:
    """Every requirement, whether it holds, and what was found."""
    jobs = jobs_of(workflow)
    texts = {name: steps_text(job) for name, job in jobs.items()}
    all_text = '\n'.join(texts.values())

    # `on` is parsed by PyYAML's YAML 1.1 loader as the boolean True, because `on` is a yes-word.
    # Both spellings are read so this file does not depend on which loader ran.
    triggers = workflow.get('on', workflow.get(True))
    if isinstance(triggers, dict):
        trigger_names = set(triggers)
    elif isinstance(triggers, str):
        trigger_names = {triggers}
    elif isinstance(triggers, list):
        trigger_names = set(triggers)
    else:
        trigger_names = set()
    has_triggers = 'push' in trigger_names and 'pull_request' in trigger_names

    pg_jobs = [name for name, job in jobs.items() if any('postgres' in i for i in service_images(job))]
    pg_text = '\n'.join(texts[n] for n in pg_jobs)

    found: list[tuple[Requirement, bool, str]] = []
    found.append((REQUIREMENTS[0], has_triggers, f'triggers = {sorted(trigger_names)}'))
    found.append(
        (
            REQUIREMENTS[1],
            'pnpm check' in all_text,
            'a step runs `pnpm check`' if 'pnpm check' in all_text else 'not found',
        )
    )
    found.append(
        (
            REQUIREMENTS[2],
            bool(pg_jobs),
            f'jobs with a postgres service: {pg_jobs or "none"}',
        )
    )
    found.append(
        (
            REQUIREMENTS[3],
            'CORTEX_PG_URL' in pg_text,
            'CORTEX_PG_URL exported' if 'CORTEX_PG_URL' in pg_text else 'not exported',
        )
    )
    found.append(
        (
            REQUIREMENTS[4],
            'test:pg' in pg_text,
            'runs `test:pg`' if 'test:pg' in pg_text else 'not run',
        )
    )
    found.append(
        (
            REQUIREMENTS[5],
            'pg-integration-count' in pg_text,
            'runs the count check'
            if 'pg-integration-count' in pg_text
            else 'not run: the suite would pass while asserting nothing',
        )
    )
    found.append(
        (
            REQUIREMENTS[6],
            all(service_is_healthy_gated(jobs[n]) for n in pg_jobs) if pg_jobs else False,
            'readiness declared' if pg_jobs else 'no postgres job to check',
        )
    )
    found.append(
        (
            REQUIREMENTS[7],
            'test:browser' in all_text,
            'runs `test:browser`' if 'test:browser' in all_text else 'not run',
        )
    )
    return found


# The prerequisite rule, and why it is a second table rather than a ninth row.
#
# The eight requirements above are properties of ONE workflow (`verify.yml`) -- they say which gates
# are attached where the repository promises to run them. This one is a property of every workflow
# that runs the suite, present and future, and it was written the day a new one proved it necessary.
#
# `probe-multi-step.yml` was added to dispatch the multi-step retrieval probe, and it ran `pnpm check`
# before measuring -- deliberately, so the artifact could be cited without also citing a verify run
# that might be a different commit. Its first dispatch (`44863794098`) failed at the second command of
# the chain:
#
#   > pnpm test:tools
#   > python3 -m pytest tools/__tests__ ...
#   /usr/bin/python3: No module named pytest
#
# The defect is a copied step list, not a copied idea: `benchmark.yml` installs
# `tools/requirements-dev.txt` before it verifies, `probe-multi-step.yml` copied its corpus download
# and not its prerequisites. Nothing in the repository could see this, because the only audit of a
# workflow's steps looked at one file -- and the gate that would have caught it would have to be the
# one thing no gate can be, a reader of a file nobody has written yet.
#
# So the rule is decidable from the workflow alone: **if a job runs `pnpm check`, that job installs
# the Python dependencies the check needs.** `pnpm test:tools` is the second command in the chain and
# the `tools/` scripts import `yaml`; a runner without them fails after the build has been paid for.
PREREQUISITE = Requirement(
    'check-prerequisites',
    'a job runs `pnpm check` without setting up Python, installing `tools/requirements-dev.txt` or '
    'checking out the sibling `cortex-docs`, so the suite fails on a runner that has none of them',
)


def jobs_running_check(workflow: dict) -> list[tuple[str, dict]]:
    """Every job whose steps run `pnpm check`."""
    return [
        (name, job)
        for name, job in jobs_of(workflow).items()
        if 'pnpm check' in steps_text(job)
    ]


def checks_out_sibling(job: dict) -> bool:
    """Whether the job checks out `cortex-docs` at the path the suites read.

    Read from the step's own `with:` block rather than from `steps_text`, because `steps_text` reads
    `run`/`uses`/`name`/`env` and a `with:` mapping would match nothing there -- extending it would make
    every gate in this file able to be satisfied by a `with:` string, which is a looser reach than the
    gates were written against.

    Both halves are required. `repository` alone puts the tree at the workspace root, where the suites
    do not look: `verify.yml` records the same mistake in its own comment ("the first attempt wrote
    `path: cortex-docs` and assumed it meant `../cortex-docs`, which it does not"), and a rule that
    accepted the repository without the path would bless exactly that shape.
    """
    for step in job.get('steps') or []:
        if not isinstance(step, dict):
            continue
        uses = step.get('uses')
        if not isinstance(uses, str) or not uses.startswith('actions/checkout'):
            continue
        options = step.get('with')
        if not isinstance(options, dict):
            continue
        if (
            options.get('repository') == 'AgentiX-E/cortex-docs'
            and options.get('path') == 'cortex-docs'
        ):
            return True
    return False


def evaluate_prerequisites(workflow: dict) -> list[tuple[Requirement, bool, str]]:
    """Whether every job that runs the suite also installs what the suite needs.

    A workflow with no `pnpm check` passes vacuously and says so in its detail line: the rule is
    about the jobs that run the check, and a measurement-only workflow is not one of them.
    """
    jobs = jobs_running_check(workflow)
    if not jobs:
        return [(PREREQUISITE, True, 'no job runs `pnpm check`')]
    results: list[tuple[Requirement, bool, str]] = []
    for name, job in jobs:
        text = steps_text(job)
        has_python = 'actions/setup-python' in text
        has_requirements = 'requirements-dev.txt' in text
        # The third prerequisite, and the one that cost a dispatch to learn: several suites in
        # `tools/__tests__` run a script that lives in the **sibling repository**
        # (`cortex-docs/evidence/longmemeval/scripts/`), because that script decides whether a
        # registration gets a number at all. `verify.yml` has checked it out since the day those
        # tests landed; `benchmark.yml` never did, and it kept passing only because nobody
        # dispatched it between the tests landing and the first run after -- six days in which the
        # workflow that produces every quoted number could not pass its own gate. The run that
        # found it (`44876637554`) failed at `Verify library` with thirteen `No such file or
        # directory`, and no benchmark step ever started.
        has_sibling = checks_out_sibling(job)
        detail = ', '.join(
            [
                f'{name}: setup-python {"present" if has_python else "MISSING"}',
                f'requirements-dev.txt {"present" if has_requirements else "MISSING"}',
                f'cortex-docs checkout {"present" if has_sibling else "MISSING"}',
            ]
        )
        results.append((PREREQUISITE, has_python and has_requirements and has_sibling, detail))
    return results


# What GitHub accepts as a top-level key of a workflow file.
#
# ## Why the gate needs this and `yaml.safe_load` does not give it
#
# A workflow was pushed in this round whose comment block lost one `#`, so a line of prose became a
# top-level key `whole run:`. PyYAML parsed it -- a plain scalar followed by a colon is a mapping key --
# and every gate here was green, because `evaluate` reads `jobs` and `on` and never asks what else is in
# the document. GitHub refused the *dispatch* with `failed to parse workflow: (Line: 23, Col: 1):
# Unexpected value 'whole run'`, which is a failure of the only step a person can take with a
# dispatch-only workflow: it cannot be dispatched.
#
# So the check is against the schema GitHub validates, not against the one YAML permits. The list is
# the whole of it as of 2026-11: a key outside this set is a document GitHub will not run, and a gate
# that reports it green is a gate measuring its own file rather than the platform's.
WORKFLOW_TOP_LEVEL = frozenset(
    {'name', 'on', 'permissions', 'env', 'defaults', 'concurrency', 'jobs', 'run-name'}
)


def schema_problems(workflow: object) -> list[str]:
    """What GitHub would refuse, in the order a person can act on it."""
    if not isinstance(workflow, dict):
        return ['not a mapping']
    # `on` is a yes-word to PyYAML's YAML 1.1 loader, so the key arrives as `True`. Normalised here
    # rather than at each reader: a second reader is how the two spellings become two rules.
    keys = {('on' if key is True else key) for key in workflow}
    unknown = sorted(key for key in keys if key not in WORKFLOW_TOP_LEVEL)
    problems = [] if not unknown else [f'unexpected top-level key {unknown}']
    for required in ('on', 'jobs'):
        if required not in keys:
            problems.append(f'missing top-level key {required!r}')
    return problems


def audit_directory(directory: Path) -> int:
    """The prerequisite rule over every workflow in `directory`, not just the audited one.

    Returns the number of workflows that failed. Separate from `main` because the single-file gate
    and this one answer different questions, and a caller that mixed them would lose the ability to
    say which file a failure belongs to.
    """
    failures = 0
    for path in sorted(directory.glob('*.yml')):
        try:
            workflow = yaml.safe_load(path.read_text(encoding='utf-8'))
        except yaml.YAMLError as error:
            print(f'FAIL  {PREREQUISITE.name:<18} {path.name}: unparseable ({error})')
            failures += 1
            continue
        if not isinstance(workflow, dict):
            print(f'FAIL  {PREREQUISITE.name:<18} {path.name}: not a mapping')
            failures += 1
            continue
        problems = schema_problems(workflow)
        if problems:
            for problem in problems:
                print(f'FAIL  {"workflow-schema":<18} {path.name}: {problem}')
            failures += len(problems)
        for requirement, ok, detail in evaluate_prerequisites(workflow):
            print(f'{"PASS" if ok else "FAIL"}  {requirement.name:<18} {path.name}: {detail}')
            if not ok:
                failures += 1
    return failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--workflow',
        default=str(Path(__file__).resolve().parents[1] / '.github' / 'workflows' / 'verify.yml'),
        help='the workflow to audit (default: .github/workflows/verify.yml)',
    )
    args = parser.parse_args(argv)

    path = Path(args.workflow)
    if not path.is_file():
        print(f'ci-gate-audit: FAILED -- no workflow at {path}', file=sys.stderr)
        return 1

    workflow = yaml.safe_load(path.read_text(encoding='utf-8'))
    if not isinstance(workflow, dict):
        print(f'ci-gate-audit: FAILED -- {path} is not a mapping', file=sys.stderr)
        return 1

    results = evaluate(workflow)
    failures = [item for item in results if not item[1]]

    for requirement, ok, detail in results:
        print(f'{"PASS" if ok else "FAIL"}  {requirement.name:<18} {detail}')

    # The prerequisite rule over the whole directory. It is printed after the eight rows of *this*
    # file so the reader sees the audited workflow's verdict first, and it can fail independently:
    # `verify.yml` can be perfectly attached while a sibling workflow runs the same suite on a
    # runner with no pytest, which is the run that produced this rule.
    prerequisite_failures = audit_directory(path.parent)

    if failures:
        print(f'\nci-gate-audit: {len(failures)} gate(s) un-attached in {path.name}\n', file=sys.stderr)
        for requirement, _, detail in failures:
            print(f'  - {requirement.name}: {requirement.why} ({detail})', file=sys.stderr)
        return 1

    if prerequisite_failures:
        print(
            f'\nci-gate-audit: {prerequisite_failures} workflow(s) run `pnpm check` without its '
            f'prerequisites in {path.parent.name}\n',
            file=sys.stderr,
        )
        print(f'  - {PREREQUISITE.name}: {PREREQUISITE.why}', file=sys.stderr)
        return 1

    print(f'\nci-gate-audit: {len(results)} gates attached in {path.name}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
