"""Tests for tools/readings-census.mjs — every committed reading says what re-derives it.

## What this file protects

`§10.2`'s two browser gates are argued from committed JSON, because a browser suite cannot run inside
`pnpm check`. A committed reading is therefore a claim with no expiry date, and four of them turned
out to be claiming something nothing checked: one was compared by nothing and overwritten by every CI
run, one was the entire content of "a second engine" while no workflow mentioned that engine, one was
compared against another *committed* file, and one environment variable existed to prevent the first
defect and was set nowhere.

Each was repaired by hand, one file at a time, which is how the fifth gets missed. The gate this file
tests asks the question of the whole population: for each committed reading, what turns these bytes
into a fact again? Three answers are allowed -- a job re-derives it, it was measured once and its
bytes are pinned by hash, or it is not a measurement at all -- and each answer has one property that
can be checked mechanically.

## Why the tests are mutations of a real repository

The population is `git ls-files`, so a fixture that is not a repository cannot exercise the tool: the
tool's first act is to refuse, and refusing for the wrong reason would pass a test that asserted "not
ok". Every fixture here is `git init` plus one commit, which is fast, and every mutation after it is
one file. What is asserted in each case is the *sentence*, not the exit code: a gate that fails
without naming the file and the fix is a gate whose reader guesses.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'readings-census.mjs'

WORKFLOW = """name: Verify
on:
  push:
    branches: [master]
jobs:
  browser:
    name: Verify the browser suites
    runs-on: ubuntu-latest
    steps:
      - name: Run the suite
        env:
          CORTEX_RESULTS: /tmp/fresh-browser.json
        run: pnpm test:browser
      - name: Compare
        run: node tools/browser-reading-check.mjs --committed test/browser/last-run.json
  postgres:
    name: Verify against PostgreSQL
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test:pg
"""


def git(repo: Path, *args: str) -> None:
    subprocess.run(
        ['git', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', *args],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    )


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def make_repo(tmp_path: Path) -> Path:
    """A repository whose record is green, so every test is one mutation away from it."""
    repo = tmp_path / 'repo'
    (repo / 'tools').mkdir(parents=True)
    (repo / 'docs').mkdir()
    (repo / '.github' / 'workflows').mkdir(parents=True)
    (repo / 'test' / 'browser').mkdir(parents=True)
    (repo / '.github' / 'workflows' / 'verify.yml').write_text(WORKFLOW)
    (repo / 'test' / 'browser' / 'last-run.json').write_text('{"checks": [{"name": "one"}]}\n')
    (repo / 'test' / 'corpus').mkdir()
    (repo / 'test' / 'corpus' / 'input.json').write_text('{"what": "the corpus"}\n')
    # An input is the one kind whose truth is carried by something else, so the fixture has to have
    # that something: a code file that names the path, the way a suite names its corpus.
    (repo / 'src').mkdir()
    (repo / 'src' / 'reader.mjs').write_text(
        "import { readFileSync } from 'node:fs';\n"
        "readFileSync('test/corpus/input.json', 'utf8');\n"
    )
    rows = [
        {
            'path': 'test/browser/last-run.json',
            'kind': 'recomputed',
            'job': 'browser',
            'workflow': '.github/workflows/verify.yml',
            'why': 'The browser job re-runs the suite and compares the two readings.',
        },
        {
            'path': 'test/corpus/input.json',
            'kind': 'input',
            'why': 'The corpus the suite reads; it is not a measurement of anything.',
        },
    ]
    write_record(repo, rows)
    git(repo, 'init', '--quiet')
    git(repo, 'add', '-A')
    git(repo, 'commit', '--quiet', '-m', 'the readings')
    return repo


def write_record(repo: Path, rows: list[dict]) -> None:
    record = {'note': 'test fixture', 'rows': rows}
    (repo / 'tools' / 'committed-readings.json').write_text(json.dumps(record, indent=2) + '\n')


def rows_of(repo: Path) -> list[dict]:
    return json.loads((repo / 'tools' / 'committed-readings.json').read_text())['rows']


def add_one_shot(repo: Path, relative: str = 'test/browser/measured.json', **overrides: object) -> dict:
    """A second reading, measured once, with its hash recorded from the bytes on disk."""
    path = repo / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"checks": [{"name": "measured once"}]}\n')
    row = {
        'path': relative,
        'kind': 'one-shot',
        'sha256': digest(path),
        'why': 'Measured once because re-measuring it costs a model download.',
    }
    row.update(overrides)
    rows = rows_of(repo)
    rows.append({key: value for key, value in row.items() if value is not None})
    write_record(repo, rows)
    # Committed, because the population is the index: a row for an untracked file is refused, and
    # `test_a_row_for_a_file_that_is_gone_is_refused` is what proves that direction.
    git(repo, 'add', '-A')
    git(repo, 'commit', '--quiet', '-m', f'add {relative}')
    return row


def run(repo: Path, *flags: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['node', str(TOOL), '--repo', str(repo), *flags],
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_a_green_record_passes_and_counts_what_it_saw(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    result = run(repo, '--check')
    assert result.returncode == 0, result.stdout
    assert '2 committed readings' in result.stdout
    assert '1 input' in result.stdout
    assert '1 recomputed' in result.stdout


def test_a_reading_with_no_row_is_named_with_the_file_to_add_it_to(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    (repo / 'test' / 'browser' / 'stray.json').write_text('{"checks": []}\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '--quiet', '-m', 'a reading nobody declared')

    result = run(repo, '--check')
    assert result.returncode == 1, result.stdout
    assert 'test/browser/stray.json' in result.stdout
    assert 'tools/committed-readings.json' in result.stdout


def test_a_zero_byte_reading_is_refused_as_declaring_nothing(tmp_path: Path) -> None:
    # The shape a shell redirect produces when the variable holding the name is unset. One such file
    # was committed in `test/mr-census/` and parsed by nothing.
    repo = make_repo(tmp_path)
    (repo / 'test' / 'browser' / 'empty.json').write_text('')
    git(repo, 'add', '-A')
    git(repo, 'commit', '--quiet', '-m', 'an empty reading')
    rows = rows_of(repo)
    rows.append({'path': 'test/browser/empty.json', 'kind': 'input', 'why': 'x' * 40})
    write_record(repo, rows)

    result = run(repo, '--check')
    assert result.returncode == 1, result.stdout
    assert 'test/browser/empty.json is 0 bytes' in result.stdout
    assert 'declares nothing' in result.stdout


def test_an_edited_one_shot_reading_is_refused_and_both_hashes_are_shown(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    add_one_shot(repo)
    path = repo / 'test' / 'browser' / 'measured.json'
    path.write_text('{"checks": [{"name": "measured once"}, {"name": "added later"}]}\n')

    result = run(repo, '--check')
    assert result.returncode == 1, result.stdout
    assert 'is not the file that was measured' in result.stdout
    # The two prefixes are what a reader needs to tell "the probe rewrote it" from "someone edited a
    # number": showing only the recorded hash would leave them with nothing to compare against.
    assert digest(path)[:12] in result.stdout
    assert 're-measure it' in result.stdout


def test_a_one_shot_row_without_a_hash_is_refused(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    add_one_shot(repo, sha256=None)

    result = run(repo, '--check')
    assert result.returncode == 1, result.stdout
    assert 'needs the "sha256" of the bytes that were measured' in result.stdout


def test_a_recomputed_row_naming_a_job_that_does_not_exist_lists_the_jobs_that_do(
    tmp_path: Path,
) -> None:
    repo = make_repo(tmp_path)
    rows = rows_of(repo)
    rows[0]['job'] = 'browser-firefox'
    write_record(repo, rows)

    result = run(repo, '--check')
    assert result.returncode == 1, result.stdout
    assert 'has no job "browser-firefox"' in result.stdout
    # The reader's next question is "then what are the jobs?", and the answer is one line of YAML.
    assert 'browser, postgres' in result.stdout


def test_a_recomputed_row_whose_job_does_not_name_the_file_is_refused(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    rows = rows_of(repo)
    rows[0]['job'] = 'postgres'
    write_record(repo, rows)

    result = run(repo, '--check')
    assert result.returncode == 1, result.stdout
    assert 'no step of job "postgres"' in result.stdout
    assert 'does not re-derive this reading' in result.stdout


def test_a_path_named_only_in_a_comment_does_not_count(tmp_path: Path) -> None:
    # The defect this refuses: `verify.yml` carried a comment describing a comparison step that did
    # not exist, and a grep for the path would have found the comment and called the gate attached.
    repo = make_repo(tmp_path)
    workflow = (repo / '.github' / 'workflows' / 'verify.yml').read_text()
    workflow = workflow.replace(
        '      - name: Run the suite',
        '      # writes test/browser/last-run.json, the comparison reads it back\n'
        '      - name: Run the suite',
    )
    workflow = workflow.replace(
        'node tools/browser-reading-check.mjs --committed test/browser/last-run.json',
        'node tools/browser-reading-check.mjs',
    )
    (repo / '.github' / 'workflows' / 'verify.yml').write_text(workflow)

    result = run(repo, '--check')
    assert result.returncode == 1, result.stdout
    assert 'no step of job "browser"' in result.stdout


def test_a_job_that_never_writes_outside_the_checkout_is_refused(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    workflow = (repo / '.github' / 'workflows' / 'verify.yml').read_text()
    workflow = workflow.replace('          CORTEX_RESULTS: /tmp/fresh-browser.json\n', '')
    (repo / '.github' / 'workflows' / 'verify.yml').write_text(workflow)

    result = run(repo, '--check')
    assert result.returncode == 1, result.stdout
    assert 'never names a path outside the checkout' in result.stdout
    assert 'writes over the reading it is supposed to be compared with' in result.stdout


def test_a_recomputed_reading_may_not_be_hash_pinned(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    rows = rows_of(repo)
    rows[0]['sha256'] = 'a' * 64
    write_record(repo, rows)

    result = run(repo, '--check')
    assert result.returncode == 1, result.stdout
    assert 'a recorded hash would be wrong by the next one' in result.stdout


def test_a_kind_outside_the_three_is_refused(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    rows = rows_of(repo)
    rows[1]['kind'] = 'fixture'
    write_record(repo, rows)

    result = run(repo, '--check')
    assert result.returncode == 1, result.stdout
    assert 'it has to be one of recomputed, one-shot, input' in result.stdout


def test_a_reason_too_short_to_say_anything_is_refused(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    rows = rows_of(repo)
    rows[1]['why'] = 'n/a'
    write_record(repo, rows)

    result = run(repo, '--check')
    assert result.returncode == 1, result.stdout
    assert 'needs a "why"' in result.stdout


def test_an_input_that_no_code_names_is_refused(tmp_path: Path) -> None:
    # The defect this refuses is a corpus left behind by a suite that was deleted: committed, cited
    # by a document, read by nothing, and indistinguishable from evidence.
    repo = make_repo(tmp_path)
    (repo / 'test' / 'corpus' / 'orphan.json').write_text('{"what": "a corpus nobody reads"}\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '--quiet', '-m', 'a corpus nobody reads')
    rows = rows_of(repo)
    rows.append(
        {
            'path': 'test/corpus/orphan.json',
            'kind': 'input',
            'why': 'The corpus a deleted suite used to read, kept in case it comes back.',
        }
    )
    write_record(repo, rows)

    result = run(repo, '--check')
    assert result.returncode == 1, result.stdout
    assert 'no tracked .ts, .mjs or .py file names it' in result.stdout
    assert 'an input nothing reads is not an input' in result.stdout


def test_two_rows_for_one_reading_is_refused(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    rows = rows_of(repo)
    rows.append(dict(rows[1], why='A second opinion about the same file, which is not a second file.'))
    write_record(repo, rows)

    result = run(repo, '--check')
    assert result.returncode == 1, result.stdout
    assert 'has two rows' in result.stdout


def test_a_row_for_a_file_that_is_gone_is_refused(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    rows = rows_of(repo)
    rows.append(
        {
            'path': 'test/browser/deleted.json',
            'kind': 'input',
            'why': 'A corpus that was removed when the suite that read it was removed.',
        }
    )
    write_record(repo, rows)

    result = run(repo, '--check')
    assert result.returncode == 1, result.stdout
    assert 'which is not a committed JSON under a test directory' in result.stdout


def test_a_directory_that_is_not_a_repository_fails_with_a_reason(tmp_path: Path) -> None:
    # The record is present, so the only thing missing is the index. A tool that treated an
    # unreadable index as an empty population would report `ok` over zero readings.
    (tmp_path / 'tools').mkdir()
    write_record(tmp_path, [])
    result = subprocess.run(
        ['node', str(TOOL), '--repo', str(tmp_path), '--check'],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 1, result.stdout
    assert 'cannot read the index' in result.stdout
    assert 'Traceback' not in result.stdout


def test_write_produces_the_document_the_check_agrees_with(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    written = run(repo, '--write')
    assert written.returncode == 0, written.stdout
    document = (repo / 'docs' / 'COMMITTED-READINGS.md').read_text()
    assert '| reading | kind | re-derived by | why this stays true |' in document
    assert '`test/browser/last-run.json`' in document
    assert '`browser` in verify.yml' in document
    # A document that lists a file the check would refuse is a document that lies in the other
    # direction, so the two modes are asserted to agree on the population.
    assert document.count('\n| `test/') == len(rows_of(repo))
    # `--write` twice is a no-op: the document has no column that changes on the commit that touches a
    # reading, which is why the last-commit date is in the terminal table and not here.
    before = (repo / 'docs' / 'COMMITTED-READINGS.md').read_text()
    assert run(repo, '--write').returncode == 0
    assert (repo / 'docs' / 'COMMITTED-READINGS.md').read_text() == before


def test_a_document_that_no_longer_matches_the_record_is_refused(tmp_path: Path) -> None:
    # The generated document is the second artefact from one record, and a hand-edited or stale one is
    # the same defect as a reading with no row: two things that disagree and nothing comparing them.
    repo = make_repo(tmp_path)
    assert run(repo, '--write').returncode == 0
    assert run(repo, '--check').returncode == 0
    document = repo / 'docs' / 'COMMITTED-READINGS.md'
    document.write_text(document.read_text().replace('| input |', '| fixture |'))

    result = run(repo, '--check')
    assert result.returncode == 1, result.stdout
    assert 'is not what the record generates' in result.stdout
    assert 'pnpm readings:write' in result.stdout


def test_the_record_of_this_repository_is_clean() -> None:
    """The shipped record covers every committed reading, and every one-shot hash still matches."""
    result = subprocess.run(
        ['node', str(TOOL), '--check'],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stdout
    assert 'committed readings, each says what re-derives it' in result.stdout
