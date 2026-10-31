"""Tests for tools/triage-parity.mjs -- the shipped rule table, the frozen snapshot, and the mirror.

## What this file protects

`docs/04` quotes four numbers for the disclosure layer. None of them was computed by
`packages/cortex-core`: they were computed by `cortex-docs/poc/p04-triage-rules/rules.mjs`, a second
implementation written so a probe could run without a build. Checked on the day the parity tool was
written, the two tables had drifted in eight places, and the drift ran in the direction that hides
defects:

  * the probe had `\\bALT\\b` where the product had `alt`, so the probe could not see that the shipped
    table calls "the alt attribute on the logo" a health fact;
  * the probe had no `retention` field, so every number it produced described a layer that stored
    credentials privately.

A published number can therefore be about a program that is not the program. The tool holds three
things together -- shipped, snapshot, mirror -- and this file makes each comparison fail by name.

The snapshot exists because CI checks out one repository. Without it, the only comparison that could
run on a push is the one that needs nothing, which is none of them.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'triage-parity.mjs'
SNAPSHOT = REPO / 'tools' / 'triage-table.json'
SHIPPED = REPO / 'packages' / 'cortex-core' / 'dist' / 'triage' / 'rules.js'


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['node', str(TOOL), *args],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=120,
    )


def snapshot_copy(tmp_path: Path, name: str, mutate) -> Path:
    data = json.loads(SNAPSHOT.read_text())
    mutate(data)
    path = tmp_path / name
    path.write_text(json.dumps(data))
    return path


def test_the_shipped_table_matches_the_snapshot() -> None:
    # The gate itself. If this fails, either a rule changed and the published numbers no longer
    # describe the program, or the snapshot was edited by hand -- both need a decision, and a red
    # test is the cheapest place to have it.
    result = run('--snapshot', str(SNAPSHOT))
    assert result.returncode == 0, result.stdout
    assert 'checked  shipped vs snapshot' in result.stdout
    # The mirror is checked too when the sibling repository is next to this one; the tool prints
    # SKIPPED when it is not, and that line is asserted in its own test below.
    assert 'checked  mirror vs shipped' in result.stdout or 'SKIPPED' in result.stdout


def test_every_field_is_compared_and_the_failure_names_it(tmp_path: Path) -> None:
    # A pattern change is the obvious one. The interesting fields are the two that no test of the
    # rule layer's *behaviour* would notice: the policy sentence (what a disputed row is justified
    # by) and `retention` (whether a credential is stored at all).
    def repolicy(data: dict) -> None:
        data['rules'][1]['policy'] = 'identifiers that are regulated by form, roughly'

    result = run('--snapshot', str(snapshot_copy(tmp_path, 'repolicy.json', repolicy)))
    assert result.returncode == 1, result.stdout
    assert 'strong-pii.policy' in result.stdout

    def drop_retention(data: dict) -> None:
        data['rules'][0].pop('retention')

    result = run('--snapshot', str(snapshot_copy(tmp_path, 'noretention.json', drop_retention)))
    assert result.returncode == 1, result.stdout
    assert 'credential.retention' in result.stdout


def test_a_pattern_change_is_reported_as_source_not_as_a_scope(tmp_path: Path) -> None:
    def relax(data: dict) -> None:
        data['rules'][3]['source'] = data['rules'][3]['source'].replace(
            r'|\b(?:alt|ast|bmi)\b(?=[^.;!?\n]{0,20}\d)', ''
        )

    result = run('--snapshot', str(snapshot_copy(tmp_path, 'relaxed.json', relax)))
    assert result.returncode == 1, result.stdout
    assert 'health.source' in result.stdout


def test_a_rule_that_disappears_is_counted_before_it_is_named(tmp_path: Path) -> None:
    def drop(data: dict) -> None:
        data['rules'] = data['rules'][:-1]

    result = run('--snapshot', str(snapshot_copy(tmp_path, 'dropped.json', drop)))
    assert result.returncode == 1, result.stdout
    assert '8 rules on the left, 7 on the right' in result.stdout
    assert 'exists only on the left' in result.stdout


def test_reordering_is_a_difference_even_when_every_rule_survives(tmp_path: Path) -> None:
    # The ordering is the fail-closed argument: move the one shared rule above a private one and the
    # set of rules is unchanged while the boundary is inverted. A comparison keyed on ids alone
    # would call this identical.
    def swap(data: dict) -> None:
        rules = data['rules']
        rules[0], rules[-1] = rules[-1], rules[0]

    result = run('--snapshot', str(snapshot_copy(tmp_path, 'swapped.json', swap)))
    assert result.returncode == 1, result.stdout
    assert 'rule 1 is' in result.stdout


def test_a_missing_snapshot_fails_with_the_command_that_fixes_it(tmp_path: Path) -> None:
    result = run('--snapshot', str(tmp_path / 'absent.json'))
    assert result.returncode == 1, result.stdout
    assert '--write' in result.stdout


def test_an_absent_mirror_is_reported_as_skipped_and_never_as_agreement(tmp_path: Path) -> None:
    # CI has one checkout. The day the mirror is not there must read as "not checked", because a
    # green run that quietly dropped half its assertions is precisely the defect this repository
    # keeps finding in other people's gates.
    result = run('--snapshot', str(SNAPSHOT), '--mirror', str(tmp_path / 'nope.mjs'))
    assert result.returncode == 0, result.stdout
    assert 'SKIPPED' in result.stdout
    assert 'tables agree' not in result.stdout


def test_write_reproduces_the_committed_snapshot() -> None:
    # `--write` is manual on purpose, so its output has to be stable enough that running it without a
    # change is a no-op. Otherwise every write produces a diff and the snapshot stops being reviewed.
    before = SNAPSHOT.read_bytes()
    result = run('--write')
    assert result.returncode == 0, result.stdout
    assert SNAPSHOT.read_bytes() == before
