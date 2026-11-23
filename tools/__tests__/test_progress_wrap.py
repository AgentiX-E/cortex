"""The progress wrapper, and the private-field failure that made it delegate.

## What this test is for

`withProgress` used to be `Object.create(provider, {...})`. That is an inheritance trick: the wrapper's prototype
is the instance, so a method's `this` is the *wrapper*. JavaScript checks private-field access against the
receiver, so `#installation` was unreachable from `reset()` and every product question threw
`Receiver must be an instance of class CortexProductProvider` -- discovered on run 45089801550, after the corpus
had been embedded and one question had already been paid for.

The property that has to hold is therefore not "the wrapper prints lines". It is: **a wrapped provider with
private state still works**, and the two value-carrying members still read live values.

## Why the assertions are about the wrapper and not about a score

A run that printed a table would look identical whether `usage` was a live getter or a snapshot taken at
construction -- except that the snapshot reports a cheaper arm. `usage` is read here after the counter moves, which
is the only way that difference shows up.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "progress-wrap-smoke.mjs"


def test_a_wrapped_provider_keeps_its_private_state_and_its_live_counters() -> None:
    node = shutil.which("node")
    assert node is not None, "node is not on PATH"
    result = subprocess.run(
        [node, str(FIXTURE)],
        cwd=REPO,
        env={"PATH": f"{Path(node).parent}:/usr/local/bin:/usr/bin:/bin", "HOME": str(Path.home())},
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    # The wrapper writes one progress line per operation to stderr, so a non-empty stderr is expected; a non-zero
    # status is not.
    assert result.returncode == 0, result.stderr

    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["answer"] == "Lisbon", payload
    assert payload["name"] == "cortex-product", payload
    assert payload["build"] == "embedding", payload
    # Forwarded, not copied: the fixture moves the counter after construction and before this read.
    assert payload["usage"] == {"calls": 7, "promptTokens": 900, "completionTokens": 40}, payload
    # A self-answering arm still has a `search`, and the wrapper must not drop it: the harness calls it
    # unconditionally, and a missing method reads as a retrieval arm with nothing to show.
    assert payload["hits"] == 0, payload
    # The product has no driver manifest; a wrapper that invented one would make the artifact claim a process.
    assert payload["manifest"] is None, payload
