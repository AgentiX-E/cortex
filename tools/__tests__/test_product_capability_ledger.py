"""The product capability ledger's contract, proved by mutation on a throwaway tree.

Every failure this tool can report is a claim about a state of the code, so every
test here builds the state, runs the tool, and asserts the failure names it. A gate
whose failures cannot be reproduced on demand is a gate nobody trusts after the
first red.

The tree is a fixture rather than the checkout, for the reason `EXPORT_CENSUS_ROOT`
documents: injecting a defect into the tree the suite is asserting about makes the
suite a writer of its own subject.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1] / 'product-capability-ledger.mjs'

# The smallest tree that exercises every state: a product package whose entry is
# `memory.ts`, the harness, and a tool.
BASE_FILES = {
    'packages/cortex-memory/src/memory.ts': (
        "import { decideWrite } from './admission.js';\n"
        'export class CortexMemory { run() { return decideWrite(); } }\n'
    ),
    'packages/cortex-memory/src/admission.ts': 'export function decideWrite() { return 1; }\n',
    'packages/cortex-memory/src/disclosure/session.ts': (
        'export class DisclosureSession { }\n'
        'export function usedOnlyBySession() { return 1; }\n'
    ),
    'packages/cortex-memory/src/dead.ts': 'export function neverCalled() { return 1; }\n',
    'packages/cortex-eval/src/bench.ts': (
        "import { decideWrite } from '@agentix-e/cortex-memory';\n"
        'export const scored = decideWrite();\n'
    ),
    'tools/demo.mjs': "import '../packages/cortex-memory/dist/memory.js';\n",
}


def row(**overrides: object) -> dict:
    """One declaration row, with the fields the ledger requires."""
    base = {
        'id': 1,
        'capability': 'write value gate',
        'expect': 'product',
        'symbol': 'decideWrite',
        'site': 'packages/cortex-memory/src/admission.ts',
        'd3': 'declared: reads the product state',
    }
    base.update(overrides)
    return base


def declarations(*rows: dict, boundary: list[dict] | None = None) -> dict:
    return {'capabilities': list(rows), 'boundary': boundary or []}


def build(root: Path, files: dict[str, str], decl: dict) -> Path:
    """Write the fixture tree and its declarations, and return the tree root."""
    for path, text in files.items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding='utf-8')
    (root / 'tools').mkdir(parents=True, exist_ok=True)
    (root / 'tools/product-capability-declarations.json').write_text(
        json.dumps(decl, indent=2), encoding='utf-8'
    )
    return root


def run(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ)
    env['CAPABILITY_LEDGER_ROOT'] = str(root)
    # The tool spawns the census, which reads its own root from the environment.
    env.pop('EXPORT_CENSUS_ROOT', None)
    return subprocess.run(
        ['node', str(TOOL), *args],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(root),
        check=False,
    )


def ledger(root: Path, files: dict[str, str], decl: dict, *args: str):
    """Build the tree, regenerate the document, then run the requested command.

    The document is written first because `--check` compares it: a tree with no
    ledger on disk fails for a reason that has nothing to do with what these tests
    are asking about. The one test that cares about the missing document builds its
    own tree.
    """
    run(build(root, files, decl), '--write')
    return run(root, *args)


def test_a_product_row_with_a_caller_passes(tmp_path: Path) -> None:
    result = ledger(tmp_path, BASE_FILES, declarations(row()), '--check')
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'the record and the code agree' in result.stdout


def test_a_product_row_whose_caller_disappears_fails_and_says_blocked(tmp_path: Path) -> None:
    """Mutation 1. The claim is `product`; the code has no reference from the entry.

    This is the direction that matters most: a published capability just became
    unreachable, and the ledger has to notice without anybody editing a row.
    """
    files = dict(BASE_FILES)
    files['packages/cortex-memory/src/memory.ts'] = 'export class CortexMemory { }\n'
    result = ledger(tmp_path, files, declarations(row()), '--check')
    assert result.returncode == 1
    assert 'row 1' in result.stderr
    assert 'derived blocked' in result.stderr
    assert 'wire a product caller' in result.stderr


def test_a_row_behind_a_gate_passes_only_while_the_gate_exists(tmp_path: Path) -> None:
    gated = (
        "import { decideWrite } from './admission.js';\n"
        'export class CortexMemory {\n'
        "  run() { if (this.options.reviewPass === 'tally') return decideWrite(); }\n"
        '}\n'
    )
    files = dict(BASE_FILES)
    files['packages/cortex-memory/src/memory.ts'] = gated
    decl = declarations(row(gate="this.options.reviewPass === 'tally'"))
    ok = ledger(tmp_path / 'green', files, decl, '--check')
    assert ok.returncode == 0, ok.stdout + ok.stderr

    stripped = dict(files)
    stripped['packages/cortex-memory/src/memory.ts'] = gated.replace(
        "if (this.options.reviewPass === 'tally') ", ''
    )
    red = ledger(tmp_path / 'red', stripped, decl, '--check')
    assert red.returncode == 1
    assert 'gate not found in product source' in red.stderr


def test_a_declaring_file_that_imports_the_instrument_fails_with_the_specifier(
    tmp_path: Path,
) -> None:
    """D2 is a claim that can fail the build, not a column of ticks.

    A product capability whose declaring file imports the harness is reachable by a
    customer only if the harness is installed. The message names the specifier,
    because "isolation failed" is not something a reader can act on.
    """
    files = dict(BASE_FILES)
    files['packages/cortex-memory/src/admission.ts'] = (
        "import { judged } from '@agentix-e/cortex-eval';\n"
        'export function decideWrite() { return judged; }\n'
    )
    result = ledger(tmp_path, files, declarations(row()), '--check')
    assert result.returncode == 1
    assert 'reaches the instrument' in result.stderr
    assert '@agentix-e/cortex-eval' in result.stderr

    # The state stays `product` -- the product calls it -- so the failure is
    # attributed to the isolation fact rather than to reachability. One finding,
    # one cause.
    document = (tmp_path / 'docs/PRODUCT-CAPABILITY-LEDGER.md').read_text(encoding='utf-8')
    row_line = next(line for line in document.splitlines() if line.startswith('| 1 |'))
    assert row_line.count('✗') == 1


def test_a_gap_row_closes_when_its_token_appears(tmp_path: Path) -> None:
    """Mutation 3, in the form this repository can express: a gap is falsifiable."""
    decl = declarations(
        row(
            id=5,
            capability='inline superseded rendering',
            expect='gap',
            symbol=None,
            site=None,
            absent='renderSupersededInline',
            reason='Named as the fix for the knowledge-update failures and absent from the product.',
        )
    )
    green = ledger(tmp_path / 'green', BASE_FILES, decl, '--check')
    assert green.returncode == 0, green.stdout + green.stderr

    files = dict(BASE_FILES)
    files['packages/cortex-memory/src/conflict.ts'] = 'export function renderSupersededInline() {}\n'
    red = ledger(tmp_path / 'red', files, decl, '--check')
    assert red.returncode == 1
    assert 'the gap closed' in red.stderr


def test_a_non_product_row_without_a_reason_is_refused(tmp_path: Path) -> None:
    result = ledger(tmp_path, BASE_FILES, declarations(row(expect='product-blocked', reason='')), '--check')
    assert result.returncode == 1
    assert 'needs a reason of at least 20 characters' in result.stderr


def test_a_placeholder_reason_is_refused(tmp_path: Path) -> None:
    for index, placeholder in enumerate(('TBD', 'n/a', 'todo', 'later')):
        decl = declarations(row(expect='product-blocked', reason=placeholder))
        result = ledger(tmp_path / str(index), BASE_FILES, decl, '--check')
        assert result.returncode == 1, placeholder
        assert 'needs a reason' in result.stderr


def test_a_blocked_row_with_an_unreachable_caller_stays_blocked(tmp_path: Path) -> None:
    """The `CardQueue` shape, as a unit.

    `usedOnlyBySession` is called by `DisclosureSession`, which nothing constructs.
    A one-hop caller count says "product"; reachability says "blocked". The audit's
    row for the disclosure boundary depended on which of those the tool meant.
    """
    decl = declarations(
        row(
            id=15,
            capability='disclosure boundary',
            expect='product-blocked',
            symbol='usedOnlyBySession',
            site='packages/cortex-memory/src/disclosure/session.ts',
            reason='Reached only through a class the product never constructs.',
        )
    )
    result = ledger(tmp_path, BASE_FILES, decl, '--check')
    assert result.returncode == 0, result.stdout + result.stderr


def test_a_barrel_does_not_make_its_exports_reachable(tmp_path: Path) -> None:
    """A re-export is not a call: the census's oldest rule, applied to reachability."""
    files = dict(BASE_FILES)
    files['packages/cortex-memory/src/index.ts'] = "export * from './dead.js';\n"
    decl = declarations(
        row(
            id=99,
            capability='a symbol only a barrel names',
            expect='product-blocked',
            symbol='neverCalled',
            site='packages/cortex-memory/src/dead.ts',
            reason='Exported through the barrel and never called by anything.',
        )
    )
    result = ledger(tmp_path, files, decl, '--check')
    assert result.returncode == 0, result.stdout + result.stderr


def test_a_new_instrument_only_export_fails_the_boundary(tmp_path: Path) -> None:
    """The red the audit asked for: adding a mechanism to the harness side."""
    files = dict(BASE_FILES)
    files['packages/cortex-memory/src/memory.ts'] = 'export class CortexMemory { }\n'
    files['tools/demo.mjs'] = (
        "import { decideWrite } from '../packages/cortex-memory/dist/admission.js';\n"
        'decideWrite();\n'
    )
    decl = declarations(row(expect='product-blocked', reason='Reached only by a tool, for now.'))
    result = ledger(tmp_path, files, decl, '--check')
    assert result.returncode == 1
    assert 'is a product export called only by the instrument' in result.stderr
    assert '`decideWrite`' in result.stderr


def test_a_recorded_boundary_entry_that_is_reachable_again_is_refused(tmp_path: Path) -> None:
    boundary = [
        {
            'category': 'moved-into-the-product',
            'rationale': 'Recorded while the harness was the only caller; the product calls it now.',
            'symbols': ['decideWrite'],
        }
    ]
    result = ledger(tmp_path, BASE_FILES, declarations(row(), boundary=boundary), '--check')
    assert result.returncode == 1
    assert 'recorded as instrument-only but is not' in result.stderr


def test_the_document_must_match_and_write_regenerates_it(tmp_path: Path) -> None:
    root = build(tmp_path, BASE_FILES, declarations(row()))
    missing = run(root, '--check')
    assert missing.returncode == 1
    assert 'does not exist' in missing.stderr

    written = run(root, '--write')
    assert written.returncode == 0, written.stdout + written.stderr
    document = root / 'docs/PRODUCT-CAPABILITY-LEDGER.md'
    assert 'Generated by tools/product-capability-ledger.mjs' in document.read_text(encoding='utf-8')

    assert run(root, '--check').returncode == 0

    # Drift: the code changes, nobody regenerates. The caller list is part of the
    # document, so a second caller is enough -- the row's state does not have to
    # change for the record to be stale.
    (root / 'packages/cortex-memory/src/second.ts').write_text(
        "import { decideWrite } from './admission.js';\nexport const also = decideWrite();\n",
        encoding='utf-8',
    )
    drifted = run(root, '--check')
    assert drifted.returncode == 1
    assert 'is not what the ledger renders' in drifted.stderr


def test_strict_refuses_any_row_that_is_not_product(tmp_path: Path) -> None:
    files = dict(BASE_FILES)
    files['packages/cortex-memory/src/memory.ts'] = 'export class CortexMemory { }\n'
    decl = declarations(row(expect='product-blocked', reason='Not reachable yet, by construction.'))
    result = ledger(tmp_path, files, decl, '--check', '--strict')
    assert result.returncode == 1
    assert '--strict: row 1' in result.stderr


def test_a_declaration_naming_a_site_that_does_not_exist_is_a_refusal(tmp_path: Path) -> None:
    """Exit 2, not 1: the tool could not form an opinion, which is not a finding."""
    decl = declarations(row(site='packages/cortex-memory/src/absent.ts'))
    result = ledger(tmp_path, BASE_FILES, decl, '--check')
    assert result.returncode == 2
    assert 'names a site that does not exist' in result.stderr


def test_an_unknown_claim_is_reported_rather_than_ignored(tmp_path: Path) -> None:
    result = ledger(tmp_path, BASE_FILES, declarations(row(expect='probably-fine')), '--check')
    assert result.returncode == 1
    assert 'is not a claim this ledger knows' in result.stderr


def test_the_json_payload_carries_the_state_and_the_problems(tmp_path: Path) -> None:
    files = dict(BASE_FILES)
    files['packages/cortex-memory/src/memory.ts'] = 'export class CortexMemory { }\n'
    result = ledger(tmp_path, files, declarations(row()), '--json')
    payload = json.loads(result.stdout)
    assert payload['rows'][0]['state'] == 'blocked'
    assert payload['rows'][0]['problems']
    assert payload['counts']['blocked'] == 1
