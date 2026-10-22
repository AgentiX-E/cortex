#!/usr/bin/env python3
"""The audit has to run where the artifact is produced, not only where it is read.

## The defect this guards against

`--audit` checks one artifact's fields against each other, and §13.107's census defect survived
three rounds because nobody ran such a check. A tool that exists and is never invoked is the same
state as no tool — and this campaign has already paid for that shape twice: `§13.17` found a
registered knob that no dispatch read, and `§13.55` found a validator that no path reached.

So the workflow that produces the report runs the audit against it. Three properties matter, and
none of them is implied by the others:

1. **It runs at all.** A step that exists but is commented out, or one whose path drifted from
   the tool's own default, produces nothing.
2. **It runs on the report the reader reads.** The artifact uploads a glob; the audit names one
   file. If those two disagree, the audit checks a file nobody downloads.
3. **It runs even when the run failed.** A benchmark that died halfway still leaves a partial
   artifact, and a partial artifact is exactly where a field contradicts another field. `if:
   always()` is what makes the check reach it.

## Why source rather than behaviour

`benchmark-cortex-memory.yml` is GitHub's to execute; no unit test can run it. Reading it as YAML
is the technique `test_workflow_yaml.py` uses for parseability, applied here to structure.
"""

from __future__ import annotations

import fnmatch
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "benchmark-cortex-memory.yml"

#: The report the readout tool defaults to and the workflow produces.
REPORT = "packages/cortex-memory/benchmark-cortex-memory-ablation-report.json"

#: The upload's glob, which must be able to match that report.
UPLOAD_GLOB = "packages/cortex-memory/benchmark-*.json"


def steps() -> list[dict]:
    document = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    for job in document["jobs"].values():
        return list(job.get("steps") or [])
    raise AssertionError("the workflow declares no job")


class TestTheAuditIsAWiredGate(unittest.TestCase):
    def test_a_step_runs_the_audit_on_the_report_the_reader_reads(self) -> None:
        matching = [
            step
            for step in steps()
            if "--audit" in str(step.get("run", ""))
        ]
        self.assertEqual(len(matching), 1, "expected exactly one audit step")
        run = str(matching[0]["run"])
        self.assertIn(REPORT, run, "the audit names a report the run does not produce")
        # The step's own failure has to be the job's failure, or a red audit reads as a comment.
        self.assertNotIn("continue-on-error", matching[0])

    def test_the_upload_glob_can_match_the_audited_report(self) -> None:
        # The two paths are written independently, and an audit of a file no reader downloads is
        # the shape §13.55 recorded: a check that runs, passes, and answers about nothing.
        self.assertTrue(
            fnmatch.fnmatch(REPORT, UPLOAD_GLOB),
            f"{REPORT} would not be picked up by {UPLOAD_GLOB}",
        )

    def test_the_audit_runs_even_when_the_benchmark_failed(self) -> None:
        # A run that died halfway still uploads its partial report, and a partial report is where
        # two fields are most likely to disagree.
        audited = [step for step in steps() if "--audit" in str(step.get("run", ""))]
        self.assertEqual(audited[0].get("if"), "always()")

    def test_the_audit_runs_after_the_upload(self) -> None:
        # Both orders publish the artifact, because the upload is `if: always()`. What differs is
        # the reader's experience: upload-then-audit shows the artifact and the verdict on it
        # together, while audit-then-upload shows a red job with nothing to download yet.
        names = [str(step.get("uses", "")) for step in steps()]
        upload = next(
            index for index, name in enumerate(names) if name.startswith("actions/upload-artifact")
        )
        audit = next(
            index
            for index, step in enumerate(steps())
            if "--audit" in str(step.get("run", ""))
        )
        self.assertLess(upload, audit)


if __name__ == "__main__":
    unittest.main()
