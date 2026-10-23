#!/usr/bin/env python3
"""The A3 review page has to be one file, and its `--out` has to be the file you named.

## The defect this file is written against

Two of them, and both were found by running the tool rather than reading it.

**`join` appended an absolute path instead of replacing it.** `path.join('/a', '/b/c')`
is `'/a/b/c'`, so a caller passing `--out /tmp/review.html` from a directory the tool
does not own -- which is what a CI step does -- had the file written to a path *inside*
the repository that did not exist, and the run died with ENOENT. The same line existed
in `cortex-ai/test/proposer/run.mjs`, and it took out two of the three measurement steps
of the first `measure-models.yml` dispatch while the third passed.

**A page that is not one file is a page nobody opens.** The review has been runnable
since step 13 and nobody has run it; every extra file beside the HTML is one more step
between a person and the twenty judgements that are the only thing left. So the
assertion is that the document loads nothing: no stylesheet, no script, no font, no
image, no `fetch`.

## What it does not check

Whether the page looks right. That needs a browser, and this repository's browser
checks are deliberately separate (`test:browser`, which needs Chromium). What is
checked here is what a headless runner can decide: the arguments are honoured, the
refusals are refusals, and the output is self-contained.
"""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools" / "a3-review-page.mjs"


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", str(TOOL), *args], cwd=ROOT, capture_output=True, text=True, check=False
    )


def cards(*, prompt: str | None = "triage-proposer/v2", profile: str | None = "local qwen") -> dict:
    """Two cards, shaped the way `a3-review.mjs prepare` writes them."""
    out = []
    for index in range(2):
        card = {
            "cardId": f"c{index}",
            "source": f"I moved to Berlin in March and {index}.",
            "atoms": [f"I moved to Berlin in March and {index}."],
        }
        if prompt is not None:
            card["promptVersion"] = prompt
        if profile is not None:
            card["profile"] = profile
        out.append(card)
    return {"cards": out}


class ReviewPageToolTest(unittest.TestCase):
    def write(self, directory: Path, payload: dict) -> Path:
        path = directory / "cards.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_absolute_out_is_written_where_it_says(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            target = directory / "review.html"
            result = run("--cards", str(self.write(directory, cards())), "--out", str(target))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(target.exists(), "the file was not written to the path given")
            # And nowhere else: the bug wrote a directory *inside the package* beside the tool.
            stray = ROOT / "tools" / raw.lstrip("/")
            self.assertFalse(stray.exists(), f"a stray copy was written to {stray}")

    def test_the_document_loads_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            target = directory / "review.html"
            self.assertEqual(
                run("--cards", str(self.write(directory, cards())), "--out", str(target)).returncode,
                0,
            )
            html = target.read_text(encoding="utf-8")
            for forbidden in ('src="http', "href=\"http", "fetch(", "XMLHttpRequest", "@import"):
                self.assertNotIn(forbidden, html, f"the page reaches the network through {forbidden}")
            # Exactly two script elements: the data blob and the client.
            self.assertEqual(len(re.findall(r"<script", html)), 2)

    def test_every_card_is_shown_twice_in_the_payload(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            target = directory / "review.html"
            self.assertEqual(
                run("--cards", str(self.write(directory, cards())), "--out", str(target)).returncode,
                0,
            )
            html = target.read_text(encoding="utf-8")
            start = html.index('id="a3-data">') + len('id="a3-data">')
            payload = json.loads(html[start : html.index("</script>", start)])
            self.assertEqual(payload["pairCount"], 2)
            self.assertEqual([step["arm"] for step in payload["steps"]], ["source", "atoms", "atoms", "source"])
            self.assertEqual(payload["promptVersion"], "triage-proposer/v2")

    def test_refuses_cards_that_cannot_name_their_configuration(self) -> None:
        # A review whose cards do not record their prompt and profile cannot be compared with any
        # other review, and the file it produces would look exactly like one that can.
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            target = directory / "review.html"
            for payload, expected in (
                (cards(prompt=None), "no promptVersion"),
                (cards(profile=None), "no profile"),
                (cards(), "more than one configuration"),
            ):
                if expected == "more than one configuration":
                    payload = cards()
                    payload["cards"][1]["profile"] = "remote deepseek"
                result = run("--cards", str(self.write(directory, payload)), "--out", str(target))
                self.assertNotEqual(result.returncode, 0, f"{expected}: the tool accepted it")
                self.assertIn(expected, result.stderr)
                self.assertFalse(target.exists(), "a refusal still wrote a file")

    def test_refuses_empty_cards(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            target = directory / "review.html"
            result = run("--cards", str(self.write(directory, {"cards": []})), "--out", str(target))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("no cards", result.stderr)

    def test_requires_both_arguments(self) -> None:
        self.assertNotEqual(run().returncode, 0)
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            only_cards = run("--cards", str(self.write(directory, cards())))
            self.assertNotEqual(only_cards.returncode, 0)
            self.assertIn("usage", only_cards.stderr)


if __name__ == "__main__":
    unittest.main()
