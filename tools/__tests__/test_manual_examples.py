"""Tests for tools/manual-examples.mjs -- the gate that keeps the user manual true.

## What this file protects

`docs/USER-MANUAL.md` is the page a new user reads first, and it is the one artifact in this
repository whose claims are read by people who will never run the test suite. The three failure
modes that matter are all silent:

  * an example that stopped compiling after a rename, which a reader discovers as a runtime error;
  * a table that documents an option the type no longer has, or omits one it gained, which a reader
    discovers as an option that "does nothing";
  * a subpath that was renamed in a manifest and not in the prose, which a reader discovers as an
    unresolvable import.

So the gate has to be proved able to fail, in the specific way it claims. Every test below is a
mutation of the real page: delete a row, add a row, break an example, unbalance a fence, name a
subpath that does not exist. A gate whose only test is "the real page passes" is a gate that cannot
distinguish `clean` from `not running`, which is the defect this repository has paid for three times
already (`docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md` §13.327).

## Why the line number is asserted rather than the message

The value of compiling the page is that the failure points at the page. A compiler error reported
against a scratch file named `example-07.ts` sends the reader into a temporary directory that no
longer exists by the time they look. The mapping is `fence_line + compiler_line`, so it is asserted
directly: the test finds the line its own mutation landed on and expects the tool to name that line.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'manual-examples.mjs'
MANUAL = REPO / 'docs' / 'USER-MANUAL.md'


def run(*args: str, timeout: int = 180) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['node', str(TOOL), *args],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def mutated(tmp_path: Path, transform) -> Path:  # noqa: ANN001 - a str -> str callable
    text = MANUAL.read_text(encoding='utf8')
    changed = transform(text)
    assert changed != text, 'the mutation changed nothing, so the test would prove nothing'
    target = tmp_path / 'USER-MANUAL.md'
    target.write_text(changed, encoding='utf8')
    return target


def line_of(text: str, needle: str) -> int:
    """The 1-based line the needle sits on. Fails loudly rather than returning -1."""
    index = text.index(needle)
    return text.count('\n', 0, index) + 1


def test_the_real_manual_compiles_and_its_tables_match_the_option_types() -> None:
    # The positive control. Without it every assertion below could pass because the tool refuses
    # everything, which reads exactly like a page with no problems.
    result = run()
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'manual:check ok' in result.stdout
    examples = int(re.search(r'(\d+) example', result.stdout).group(1))
    assert examples >= 10, f'the page has {examples} examples; a manual that thin would pass vacuously'


def test_an_option_removed_from_the_table_is_reported_at_the_table(tmp_path: Path) -> None:
    # The direction that loses information: the type still accepts `ask`, the page no longer says so.
    target = mutated(tmp_path, lambda text: re.sub(r'^\| `ask` \|.*\n', '', text, count=1, flags=re.M))
    result = run('--file', str(target))
    assert result.returncode == 1
    assert 'CortexMemoryOptions.ask is declared in the type and not documented' in result.stderr


def test_an_option_invented_by_the_table_is_reported_at_the_row(tmp_path: Path) -> None:
    # The other direction, and the more embarrassing one: a documented option that does not exist.
    def add_row(text: str) -> str:
        anchor = '| `llm` | `LLM` |'
        index = text.index(anchor)
        end = text.index('\n', index) + 1
        return text[:end] + '| `temperature` | `number` | `0` | A knob that was removed. |\n' + text[end:]

    target = mutated(tmp_path, add_row)
    result = run('--file', str(target))
    assert result.returncode == 1
    assert 'CortexMemoryOptions.temperature is documented and not declared' in result.stderr
    # It must name the row's own line, not the table's opening marker.
    text = target.read_text(encoding='utf8')
    assert f':{line_of(text, "| `temperature` |")}:' in result.stderr


def test_a_duplicate_row_is_refused(tmp_path: Path) -> None:
    # A duplicate is how a table loses a row while looking complete: the set comparison still passes
    # only because the other row is counted twice.
    def duplicate(text: str) -> str:
        anchor = '| `now` | `number` |'
        index = text.index(anchor)
        end = text.index('\n', index) + 1
        return text[:end] + text[index:end] + text[end:]

    target = mutated(tmp_path, duplicate)
    result = run('--file', str(target))
    assert result.returncode == 1
    assert 'now is listed twice' in result.stderr


def test_a_broken_example_is_reported_at_the_manual_line(tmp_path: Path) -> None:
    # The whole reason for compiling rather than describing. The mutation is one wrong literal inside
    # the first example, so the compiler has exactly one diagnostic and the assertion is on the line
    # it must name. A duplicate-key mutation would let the compiler choose either line and the test
    # would pass or fail on the compiler's preference rather than on the mapping.
    target = mutated(tmp_path, lambda text: text.replace("  name: 'echo',", '  name: 42,', 1))
    result = run('--file', str(target))
    assert result.returncode == 1
    named = re.findall(rf'{re.escape(str(target))}:(\d+):', result.stderr)
    assert named, result.stderr
    expected = line_of(target.read_text(encoding='utf8'), '  name: 42,')
    assert named == [str(expected)], f'expected line {expected}, named {named}'


def test_an_unterminated_fence_at_the_end_is_refused(tmp_path: Path) -> None:
    # An opening fence with no close is an authoring slip that would otherwise swallow whatever the
    # next edit appends to the page.
    target = mutated(tmp_path, lambda text: text + '\n```ts\nconst tail = 1;\n')
    result = run('--file', str(target))
    assert result.returncode == 1
    assert 'unbalanced fence' in result.stderr


def test_a_swallowed_closing_fence_still_fails(tmp_path: Path) -> None:
    # The other shape of the same slip: removing a closing fence does not leave the page unbalanced
    # (the next opening line is not a closer, but the next closer is), it merges two examples into one
    # block that cannot compile. Either way the page must not pass, and this asserts the gate is not
    # relying on the marker count alone.
    target = mutated(
        tmp_path, lambda text: text.replace('```\n\n`answer` may return', '\n\n`answer` may return', 1)
    )
    result = run('--file', str(target))
    assert result.returncode == 1
    assert 'manual:check FAILED' in result.stderr


def test_a_page_with_no_examples_is_refused(tmp_path: Path) -> None:
    # `0 examples checked` and `every example compiled` must not be the same output.
    target = mutated(tmp_path, lambda text: re.sub(r'```ts\n[\s\S]*?\n```\n', '', text))
    result = run('--file', str(target))
    assert result.returncode == 1
    assert 'no ```ts fences found' in result.stderr


def test_a_page_with_no_tables_is_refused(tmp_path: Path) -> None:
    # Same vacuity rule for the option surface.
    target = mutated(tmp_path, lambda text: re.sub(r'<!-- contract-table[\s\S]*?<!-- /contract-table -->\n', '', text))
    result = run('--file', str(target))
    assert result.returncode == 1
    assert 'no contract tables found' in result.stderr


def test_a_subpath_that_no_package_export_is_refused(tmp_path: Path) -> None:
    # The manifest is the source of truth for what is importable; the prose is not.
    target = mutated(
        tmp_path,
        lambda text: text.replace(
            'import { SqliteStorage } from \'@agentix-e/cortex-storage/sqlite\';',
            'import { SqliteStorage } from \'@agentix-e/cortex-storage/sqlite3\';',
            1,
        ),
    )
    result = run('--file', str(target))
    assert result.returncode == 1
    assert '@agentix-e/cortex-storage/sqlite3 is not an export of any workspace package' in result.stderr


def test_an_option_that_no_example_names_is_refused(tmp_path: Path) -> None:
    # A row is a claim; an example is evidence. The asymmetry is why this is a failure and not a
    # warning: an option documented and never exercised is exactly the shape under which an option
    # becomes inert in production while the table still says it does something.
    target = mutated(tmp_path, lambda text: text.replace("  turnCutMarker: 'ellipsis',\n", '', 1))
    result = run('--file', str(target))
    assert result.returncode == 1
    assert 'documented but demonstrated by no example: CortexMemoryOptions.turnCutMarker' in result.stderr


def test_every_documented_option_is_demonstrated_in_the_real_manual() -> None:
    # The same property, stated as a number, so a regression in the manual's coverage is visible in
    # the summary line rather than only in a failure.
    result = run()
    assert result.returncode == 0, result.stdout + result.stderr
    match = re.search(r'\((\d+)/(\d+) option\(s\) demonstrated', result.stdout)
    assert match is not None, result.stdout
    demonstrated, documented = int(match.group(1)), int(match.group(2))
    assert demonstrated == documented, f'{demonstrated} of {documented} options have an example'
    assert documented >= 20, f'only {documented} options are documented; the surface shrank silently'


def test_the_storage_root_is_named_but_never_imported() -> None:
    # The manual explains the empty-root rule (§5.1); it must not then demonstrate an import from it,
    # because that example would be the one thing the rule forbids. The check above cannot catch this
    # -- the root *is* an export -- so the page's own text is held instead.
    text = MANUAL.read_text(encoding='utf8')
    assert "import { SqliteStorage } from '@agentix-e/cortex-storage';" not in text
    assert 'does not exist, on purpose' in text
