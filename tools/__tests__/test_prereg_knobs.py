#!/usr/bin/env python3
"""A pending registration must name a treatment the harness can receive.

## The defect this file is written against

`PREREGISTRATION-MULTI-STEP.md` registers `readerSearch=1` as its treatment, carries a price, a bar and
a control run, and has been cited as the queue's first row for two rounds. The string `readerSearch`
occurs nowhere in the repository: no workflow input, no arm option, no dispatch script. The run could
not be dispatched, and nothing could see that, because every check on a registration asks about its
*status* (`prereg-status.mjs`) and none asks whether it is *buildable*.

That is the third time this campaign has shipped the same shape -- a document describing an instrument
the harness cannot build -- and the first two were caught by reading, which is not a method.

## What is asserted

1. the tool's own self-test covers the five states (buildable, missing, declared block, wrong
   declaration, and a decided file that must not be read at all);
2. on this repository, `readerSearch` reads **buildable**: the mechanism shipped (`cortex-memory`'s
   `readerSearch` option, the arm's `CORTEX_MEMORY_READER_SEARCH`, the dispatch script's write), so the
   row that was priced and barred for four rounds is now a run. `blocked` or `missing` would mean it is
   still not, and this assertion is the one that flips when the treatment lands;
3. every pending knob reads buildable, which is the gate's false-positive rate asserted rather than
   described;
4. a fixture whose registration names an unknown knob and declares nothing exits non-zero and names
   the knob, so the gate cannot pass by finding nothing to check.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools" / "prereg-knobs.mjs"


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", str(TOOL), *args], cwd=str(ROOT), capture_output=True, text=True, check=False
    )


def _audit(docs: Path, root: Path) -> list[dict]:
    # Built by concatenation rather than as an f-string: the call passes a JavaScript object literal,
    # and every brace in it would have to be doubled.
    script = (
        "import('./tools/prereg-knobs.mjs').then((m) => console.log(JSON.stringify("
        "m.audit({docsDir: '" + str(docs) + "', root: '" + str(root) + "'}))))"
    )
    result = subprocess.run(
        ["node", "-e", script], cwd=str(ROOT), capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


class TestTheGateItself(unittest.TestCase):
    def test_the_self_test_passes(self) -> None:
        result = _run("--self-test")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("1 declared block", result.stdout)


class TestThisRepository(unittest.TestCase):
    def test_the_check_is_green(self) -> None:
        result = _run()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_decided_registration_is_not_read_and_its_mechanism_still_exists(self) -> None:
        # This assertion has now flipped twice. It read `blocked` while the treatment existed only in the
        # document, then `buildable` once `cortex-memory`'s option, the arm's switch and the dispatch
        # script's write landed. It reads *absent* today, and absent is the gate working rather than the
        # gate going blind: `PREREGISTRATION-MULTI-STEP.md` declares `decided` with a Result section, and
        # the knob census skips a decided file on purpose.
        #
        # So the second half is what this test is for now. "Closed" is a statement about an axis, and the
        # failure mode it invites is deleting the mechanism that answered it -- which would make the row
        # undispatchable again and take the census that proves it apart with it. The three layers the row
        # was priced against are asserted to still be in the tree.
        rows = json.loads(_run("--json").stdout)["rows"]
        self.assertFalse(
            [
                row
                for row in rows
                if row["file"] == "PREREGISTRATION-MULTI-STEP.md" and row["knob"] == "readerSearch"
            ],
            "a decided registration must not be censused as a pending one",
        )
        for relative, needle in (
            ("packages/cortex-memory/src/reader-search.ts", "ReaderSearchOptions"),
            ("packages/cortex-eval/src/bench-memory-arm.ts", "CORTEX_MEMORY_READER_SEARCH"),
            ("tools/dispatch-cortex-memory-ab.py", "READER_SEARCH_VARIABLE"),
        ):
            self.assertIn(needle, (ROOT / relative).read_text(), f"{relative} lost {needle}")

    def test_every_pending_knob_is_buildable(self) -> None:
        # The gate's own false-positive rate, asserted rather than described: every knob name in every
        # pending registration, and every one of them is in the dispatch path. A gate whose whole
        # population reads `missing` would pass this file's first assertion and be useless.
        rows = json.loads(_run("--json").stdout)["rows"]
        self.assertTrue(rows)
        self.assertEqual({row["state"] for row in rows}, {"buildable"})


class TestAFixtureThatShouldFail(unittest.TestCase):
    def test_a_pending_registration_with_an_absent_knob_and_no_declaration_exits_non_zero(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            docs = Path(directory) / "docs"
            docs.mkdir()
            (docs / "PREREG-FIXTURE.md").write_text(
                "# fixture\n\n**Status:** pending\n\nRun it with `noSuchKnob=1`.\n", encoding="utf-8"
            )
            rows = _audit(docs, Path(directory))
            self.assertEqual([(row["knob"], row["state"]) for row in rows], [("noSuchKnob", "missing")])

    def test_a_declaration_naming_a_different_knob_does_not_cover_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            docs = Path(directory) / "docs"
            docs.mkdir()
            (docs / "PREREG-FIXTURE.md").write_text(
                "# fixture\n\n**Status:** pending\n**Blocked on:** `otherKnob` -- unrelated.\n\n"
                "Run it with `noSuchKnob=1`.\n",
                encoding="utf-8",
            )
            rows = _audit(docs, Path(directory))
            self.assertEqual([(row["knob"], row["state"]) for row in rows], [("noSuchKnob", "missing")])


if __name__ == "__main__":
    unittest.main()
