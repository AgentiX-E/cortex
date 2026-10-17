"""Every tool must be importable from a directory that is not a checkout.

## The two failures this exists to prevent, and they were both real

`dispatch-cortex-memory-ab.py` read its PAT at module level, so importing it required a
checkout with an oauth2 token — which no runner has, and `Verify` failed with ten tests
erroring at `SystemExit: no oauth2 token in .git/config` (§13.47).

Then the sweep that fixed it found **two more**: `push-via-api.py` ran
`git remote get-url origin` at import, and `dispatch-b7-ab.py` read `.git/config` the same
way. Neither had a test that imported it, which is the only reason neither had failed.

So the property is checked over the whole directory rather than per script: **import must
not depend on the working directory, a credential, or a git repository.** A tool whose top
level does any of those is a tool that cannot be tested anywhere but a developer's machine,
and the next person to write a test for it will find out by breaking CI.

## Why `sys.modules` is populated before executing

A module using `@dataclass` looks itself up in `sys.modules` while its class body runs, so
loading one through `spec_from_file_location` without registering it raises
`AttributeError: 'NoneType' object has no attribute '__dict__'` — an artefact of the loader,
not a defect in the script. Registering it is what makes this test's failures mean what they
say.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
TOOLS = REPO / 'tools'
SCRIPTS = sorted(TOOLS.glob('*.py'))


def _import(path: Path):  # noqa: ANN202 - the module object
    spec = importlib.util.spec_from_file_location(f'tool_{path.stem.replace("-", "_")}', path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Registered before execution for the `@dataclass` reason the docstring gives.
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop(spec.name, None)
    return module


def test_the_directory_is_not_empty() -> None:
    # A parametrisation over zero files passes vacuously, which is the failure mode a
    # sweep like this is most likely to have.
    assert len(SCRIPTS) >= 20, f'only {len(SCRIPTS)} scripts found under {TOOLS}'


@pytest.mark.parametrize('path', SCRIPTS, ids=lambda p: p.name)
def test_imports_from_a_directory_that_is_not_a_checkout(
    path: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The whole property, one script at a time, with the reason in the failure."""
    monkeypatch.chdir(tmp_path)
    try:
        _import(path)
    except BaseException as error:  # noqa: BLE001 - the point is to report any of them
        pytest.fail(
            f'{path.name} cannot be imported from an empty directory: '
            f'{type(error).__name__}: {error}\n'
            'A module-level call that needs a checkout (git, .git/config, a credential) makes '
            'this script untestable on a runner. Move it behind an accessor and call it where '
            'it is used -- see §13.47.'
        )


class TestTheAccessorsStillWork:
    """Lazy is not optional: the values must still be the right ones in a checkout."""

    def test_the_pusher_finds_its_own_repository(self) -> None:
        module = _import(TOOLS / 'push-via-api.py')
        assert module.repo() == 'AgentiX-E/cortex'
        assert module.branch() == 'master'

    def test_the_pusher_reads_a_token_in_a_checkout(self) -> None:
        module = _import(TOOLS / 'push-via-api.py')
        assert len(module.token()) > 20

    def test_the_pusher_says_which_problem_it_has_outside_one(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        module = _import(TOOLS / 'push-via-api.py')
        module._TOKEN = None
        module._ORIGIN = None
        monkeypatch.chdir(tmp_path)
        with pytest.raises(SystemExit, match='no .git/config'):
            module.token()
        with pytest.raises(SystemExit):
            module.origin()

    def test_the_b7_dispatcher_reads_a_token_in_a_checkout(self) -> None:
        module = _import(TOOLS / 'dispatch-b7-ab.py')
        assert len(module.token()) > 20
