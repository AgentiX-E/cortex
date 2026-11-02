#!/usr/bin/env python3
"""One number, two languages: the prompt budget the product ships and the one the reader divides by.

## The defect this file is written against

`DEFAULT_MAX_PROMPT_CHARS` lives in `packages/cortex-memory/src/prompt.ts` and is the budget a
caller gets by asking for nothing. `tools/readout-arm-run.py` divides every `--window` reading by
it, and Python cannot import a TypeScript constant, so the number is written down twice.

That is the same shape as `test_ask_table_parity.py` one module over, and it is worse here,
because the two copies fail **differently**:

- the product's copy changing alone leaves the reader dividing by a stale budget, so every
  `--window` table reports a fill percentage nobody asked for -- §13.81 already paid for that once,
  when a 48,000 artifact was read against the 24,000 constant and the first table reported **200%
  of budget** on a prompt that fitted perfectly;
- the reader's copy changing alone is silent in the opposite direction: the tool would divide by a
  number no artifact was ever produced under, and the docblocks that quote it would all agree with
  each other and be wrong together.

Neither copy is authoritative by convention. `prompt.ts` is authoritative **because a test reads it
out of the source and compares** -- the claim and the check have to be the same thing.

## Why the workflow is in this file

`benchmark-cortex-memory.yml` declares `cortex_memory_max_prompt_chars` with an **empty** default,
which is what makes an unset dispatch take the product's default instead of a literal. A number
written into that input would be a third copy, and the one furthest from any test. So the third
assertion here is about the *shape* of the input rather than its value: empty means "whatever the
product ships", and that is the property that keeps three copies from becoming three numbers.

## Why source is read as text

`cortex-memory` and `tools/` share no runtime, and a test that imported either would only see its
own copy. Reading both as text is the one place the comparison can happen, and it is the technique
`test_ask_table_parity.py` and `test_dispatch_inputs.py` already use.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PRODUCT = ROOT / "packages" / "cortex-memory" / "src" / "prompt.ts"
READER = ROOT / "tools" / "readout-arm-run.py"
WORKFLOW = ROOT / ".github" / "workflows" / "benchmark-cortex-memory.yml"

PRODUCT_PATTERN = re.compile(r"^export const DEFAULT_MAX_PROMPT_CHARS = (?P<value>[0-9][0-9_]*);$", re.M)
READER_PATTERN = re.compile(r"^DEFAULT_PROMPT_BUDGET_CHARS = (?P<value>[0-9][0-9_]*)$", re.M)


def _product_budget() -> int:
    """The product's constant, parsed rather than imported, and refused when absent."""
    match = PRODUCT_PATTERN.search(PRODUCT.read_text(encoding="utf-8"))
    if match is None:
        raise AssertionError(
            f"{PRODUCT} no longer declares `export const DEFAULT_MAX_PROMPT_CHARS = <n>;` at the "
            "start of a line. The pattern is part of the guard: a declaration this test cannot "
            "parse is a declaration nothing compares, and renaming it would otherwise disable the "
            "check silently."
        )
    return int(match.group("value").replace("_", ""))


def _reader_budget() -> int:
    """The readout tool's copy, parsed with the same refusal."""
    match = READER_PATTERN.search(READER.read_text(encoding="utf-8"))
    if match is None:
        raise AssertionError(
            f"{READER} no longer declares `DEFAULT_PROMPT_BUDGET_CHARS = <n>` at the start of a "
            "line, so nothing compares it with the product's constant."
        )
    return int(match.group("value").replace("_", ""))


class PromptBudgetParity(unittest.TestCase):
    def test_the_two_copies_name_the_same_budget(self) -> None:
        product = _product_budget()
        reader = _reader_budget()
        self.assertEqual(
            product,
            reader,
            f"the product ships a {product}-character budget and tools/readout-arm-run.py divides "
            f"--window readings by {reader}. Whichever moved, the other has to follow: a reader "
            "dividing by a budget no artifact was produced under reports a fill percentage that is "
            "arithmetically correct and describes nothing.",
        )

    def test_the_dispatch_input_defaults_to_the_product_rather_than_to_a_literal(self) -> None:
        source = WORKFLOW.read_text(encoding="utf-8")
        block = re.search(
            r"^      cortex_memory_max_prompt_chars:\n(?P<body>(?:        .*\n)+)",
            source,
            re.M,
        )
        self.assertIsNotNone(
            block,
            "benchmark-cortex-memory.yml no longer declares the cortex_memory_max_prompt_chars "
            "input, so an unset dispatch has no stated relationship with the product's default.",
        )
        body = block.group("body")  # type: ignore[union-attr]
        default = re.search(r"^        default: '(?P<value>[^']*)'$", body, re.M)
        self.assertIsNotNone(
            default,
            "the budget input lost its default line. `ReadMaxPromptChars` distinguishes unset from "
            "zero, so the default is load-bearing rather than cosmetic.",
        )
        self.assertEqual(
            default.group("value"),  # type: ignore[union-attr]
            "",
            "the budget input carries a literal default. Empty is what makes an unset dispatch take "
            "the product's constant; a number here is a third copy, and the one no test reads.",
        )


if __name__ == "__main__":
    unittest.main()
