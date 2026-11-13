#!/usr/bin/env python3
"""The CI gate audit fails when a gate loses its attachment, one requirement at a time.

## The defect this file is written against

`tools/ci-gate-audit.py` is a check about checks, so the way it fails is subtle: it can pass
because every gate is attached, or because its own predicates are wrong. Those two look identical
in the output, and the second is worse than having no audit at all -- a green line headed
"8 gates attached" is exactly the sentence a reader stops questioning.

So this file removes one requirement at a time from a copy of the real workflow and asserts that
the audit reports **that** requirement as failed. A predicate that never fails is a comment.

## Why the assertions are on the set and not on a single row

Removing the PostgreSQL service un-attaches four requirements at once -- the URL, the suite, the
count check and the readiness gate are all properties of a job that no longer exists. Asserting
"exactly one failure" would therefore be asserting a coupling that is not in the design. What is
asserted is that the target row is among the failures and that the failure count moved, which is
what distinguishes a working predicate from one that agrees with itself.

## The control

`test_the_real_workflow_passes` runs the audit against the checked-in file. Without it every other
case here could pass while the repository's own workflow is broken -- a guard tested only on
fixtures is a guard about fixtures.
"""

from __future__ import annotations

import contextlib
import copy
import io
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
WORKFLOW = REPO / '.github' / 'workflows' / 'verify.yml'

sys.path.insert(0, str(REPO / 'tools'))

import importlib.util

_spec = importlib.util.spec_from_file_location('ci_gate_audit', REPO / 'tools' / 'ci-gate-audit.py')
assert _spec is not None and _spec.loader is not None
audit = importlib.util.module_from_spec(_spec)
# Registered before execution because `@dataclass` resolves annotations through
# `sys.modules[cls.__module__]`. Loading without this line raises `AttributeError: 'NoneType'
# object has no attribute '__dict__'` inside the standard library, which reads as a dataclass bug
# rather than as a missing registration.
sys.modules['ci_gate_audit'] = audit
_spec.loader.exec_module(audit)


def load() -> dict:
    import yaml

    return yaml.safe_load(WORKFLOW.read_text(encoding='utf-8'))


def failed_names(workflow: dict) -> set[str]:
    return {req.name for req, ok, _ in audit.evaluate(workflow) if not ok}


def postgres_job(workflow: dict) -> dict:
    jobs = audit.jobs_of(workflow)
    for job in jobs.values():
        if any('postgres' in image for image in audit.service_images(job)):
            return job
    raise AssertionError('the checked-in workflow has no postgres job to mutate')


class TestTheRealWorkflowPasses(unittest.TestCase):
    def test_the_real_workflow_passes(self) -> None:
        self.assertEqual(
            failed_names(load()),
            set(),
            'the workflow in this repository does not satisfy the audit',
        )

    def test_the_audit_reports_every_requirement(self) -> None:
        results = audit.evaluate(load())
        self.assertEqual(
            [req.name for req, _, _ in results],
            [req.name for req in audit.REQUIREMENTS],
            'a requirement in the table is not evaluated, so it can never fail',
        )

    def test_cli_exits_zero_and_names_the_count(self) -> None:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = audit.main(['--workflow', str(WORKFLOW)])
        self.assertEqual(code, 0)
        self.assertIn(f'{len(audit.REQUIREMENTS)} gates attached', out.getvalue())

    def test_a_missing_workflow_is_a_failure_not_a_crash(self) -> None:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = audit.main(['--workflow', str(REPO / 'does-not-exist.yml')])
        self.assertEqual(code, 1)
        self.assertIn('no workflow at', err.getvalue())


class TestEachRequirementCanFail(unittest.TestCase):
    def test_triggers(self) -> None:
        workflow = load()
        workflow['on'] = {'workflow_dispatch': None}
        self.assertIn('triggers', failed_names(workflow))

    def test_check(self) -> None:
        workflow = load()
        for job in audit.jobs_of(workflow).values():
            job['steps'] = [
                step for step in job.get('steps', []) if 'pnpm check' not in (step.get('run') or '')
            ]
        self.assertIn('check', failed_names(workflow))

    def test_postgres_service(self) -> None:
        workflow = load()
        postgres_job(workflow).pop('services')
        self.assertIn('postgres-service', failed_names(workflow))

    def test_postgres_url(self) -> None:
        workflow = load()
        postgres_job(workflow).pop('env')
        self.assertIn('postgres-url', failed_names(workflow))

    def test_postgres_suite(self) -> None:
        workflow = load()
        job = postgres_job(workflow)
        for step in job['steps']:
            if 'test:pg' in (step.get('run') or ''):
                step['run'] = 'pnpm test'
        self.assertIn('postgres-suite', failed_names(workflow))

    def test_postgres_count(self) -> None:
        workflow = load()
        job = postgres_job(workflow)
        job['steps'] = [
            step for step in job['steps'] if 'pg-integration-count' not in (step.get('run') or '')
        ]
        self.assertIn('postgres-count', failed_names(workflow))

    def test_postgres_health(self) -> None:
        workflow = load()
        job = postgres_job(workflow)
        for service in job['services'].values():
            service.pop('options')
        self.assertIn('postgres-health', failed_names(workflow))

    def test_browser(self) -> None:
        workflow = load()
        for job in audit.jobs_of(workflow).values():
            for step in job.get('steps', []):
                if 'test:browser' in (step.get('run') or ''):
                    step['run'] = 'pnpm test'
        self.assertIn('browser', failed_names(workflow))

    def test_an_empty_workflow_fails_every_requirement_without_raising(self) -> None:
        self.assertEqual(
            failed_names({}),
            {req.name for req in audit.REQUIREMENTS},
            'an empty workflow must fail everything, rather than crash on a missing key',
        )

    def test_requirement_names_are_unique(self) -> None:
        names = [req.name for req in audit.REQUIREMENTS]
        self.assertEqual(len(names), len(set(names)))

    def test_every_requirement_explains_itself(self) -> None:
        # A requirement whose `why` is empty prints `- name:  (detail)` at the one moment a reader
        # needs it, which is the failure. Cheap to assert, so asserted.
        for req in audit.REQUIREMENTS:
            self.assertTrue(req.why.strip(), f'{req.name} has no explanation')


if __name__ == '__main__':
    unittest.main()
