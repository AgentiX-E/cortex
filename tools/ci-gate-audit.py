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

    if failures:
        print(f'\nci-gate-audit: {len(failures)} gate(s) un-attached in {path.name}\n', file=sys.stderr)
        for requirement, _, detail in failures:
            print(f'  - {requirement.name}: {requirement.why} ({detail})', file=sys.stderr)
        return 1

    print(f'\nci-gate-audit: {len(results)} gates attached in {path.name}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
