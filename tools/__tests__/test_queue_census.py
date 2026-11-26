#!/usr/bin/env python3
"""The queue is priced from a frozen census, and an empty class is a refusal.

## The defect this file is written against

`AUDIT-FAILURE-CLASSES.md` section 5 concluded that *"the delivery institution is empty on this arm
under both renderings"* -- and the roadmap kept the delivery row at "~10 CNY, not designed" for two
more rounds anyway. Nothing was wrong with the arithmetic and nothing was wrong with the reading: the
sentence lived in a note and the row lived in a table, and no mechanism compared them.

That is the same class this repository has recorded for workflows (`arm-config-guard.mjs`: three
copies of the numbers and the gate was green because the workflows were not one of them) one layer
out. The fix is not a fourth copy. It is a file the table is *generated from* plus a check that the
file adds up.

## What is asserted

1. the census is internally consistent -- routes sum to the population, classes sum to the failures,
   and an uncounted failure is refused rather than ignored;
2. the three rows the last two rounds argued about price the way the argument says -- delivery on
   `TR`/`IE`/`KU` is **empty**, delivery anywhere is **refused** by the floor, and the numeric
   institution bundled is the only row with room above it;
3. a class name outside the eight the classifier can emit is refused rather than read as zero, so a
   typo cannot turn a measured class into an empty one.
"""

from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools" / "queue-floor.mjs"
CENSUS = ROOT / "tools" / "failure-census.json"


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", str(TOOL), *args],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
    )


def _census() -> dict:
    return json.loads(CENSUS.read_text(encoding="utf-8"))


class TestTheCensusAddsUp(unittest.TestCase):
    def test_the_routes_sum_to_the_population(self) -> None:
        table = _census()
        self.assertEqual(sum(row["n"] for row in table["routes"].values()), table["questionCount"])
        self.assertEqual(
            sum(row["correct"] for row in table["routes"].values()),
            table["questionCount"] - sum(row["count"] for row in table["classes"].values()),
        )

    def test_every_route_is_one_the_product_prints(self) -> None:
        # The six route names are the artifact's own vocabulary; a census over a seventh name would be
        # a census over a route no question carries.
        self.assertEqual(
            set(_census()["routes"]),
            {
                "multi-session",
                "temporal",
                "flat",
                "knowledge-update",
                "abstention",
                "assistant",
            },
        )

    def test_a_census_that_does_not_add_up_is_refused(self) -> None:
        table = dict(_census())
        table["questionCount"] = 501
        path = ROOT / "tools" / "__tests__" / "census-mutation.json"
        path.write_text(json.dumps(table), encoding="utf-8")
        try:
            result = _run("--census", str(path))
        finally:
            path.unlink()
        self.assertEqual(result.returncode, 1)
        self.assertIn("does not add up", result.stderr)


class TestTheRowsPriceTheWayTheArgumentSays(unittest.TestCase):
    def _rows(self) -> dict[str, dict]:
        table = _census()
        path = CENSUS
        result = _run("--census", str(path))
        self.assertIn("failures", result.stdout)
        self.assertEqual(result.returncode, 1, "a queue with a refused row exits non-zero")
        # Read the verdicts from the tool's own output rather than recomputing them here: a second
        # implementation of the floor is the defect this whole file is about.
        rows = {}
        for line in result.stdout.splitlines():
            for target in table["targets"]:
                if line.startswith(target["name"][:44].ljust(44)):
                    rows[target["name"]] = line.split()[-1]
        self.assertEqual(len(rows), len(table["targets"]), "every target printed one row")
        return rows

    def test_the_delivery_row_is_empty_on_the_three_short_routes(self) -> None:
        # The row two rounds kept queued: its population is 349 questions and its class is nothing.
        self.assertEqual(self._rows()["delivery on TR/IE/KU"], "empty")

    def test_the_delivery_institution_is_refused_by_the_floor(self) -> None:
        rows = self._rows()
        self.assertEqual(rows["delivery, suite"], "refused")
        self.assertEqual(rows["delivery, multi-session"], "refused")

    def test_the_numeric_institution_is_the_one_row_with_room(self) -> None:
        rows = self._rows()
        self.assertEqual(rows["numeric institution, bundled (suite)"], "certifiable")
        self.assertEqual(rows["numeric institution, bundled (MR)"], "certifiable")

    def test_the_preference_route_is_at_the_line_rather_than_above_it(self) -> None:
        # Six questions on 94 is a ceiling of 6.38 against a floor of 6.38: certifiable only at a
        # hundred per cent conversion, which is why the row is not recommended despite "certifiable".
        self.assertEqual(self._rows()["preference (flat)"], "certifiable")


class TestAnUnknownClassNameIsRefused(unittest.TestCase):
    def test_a_name_outside_the_taxonomy_is_not_read_as_zero(self) -> None:
        # The failure mode this guards: `text-absent` has no members on this arm, so a tool that read
        # an absent class as zero and an unknown class as zero would price a typo as a measurement.
        table = _census()
        table["targets"] = [
            {"id": "typo", "name": "a class that does not exist", "classes": ["text-abscent"], "population": "suite"}
        ]
        path = ROOT / "tools" / "__tests__" / "census-typo.json"
        path.write_text(json.dumps(table), encoding="utf-8")
        try:
            result = _run("--census", str(path))
        finally:
            path.unlink()
        self.assertEqual(result.returncode, 1)
        self.assertIn("names unknown class text-abscent", result.stderr)


if __name__ == "__main__":
    unittest.main()
