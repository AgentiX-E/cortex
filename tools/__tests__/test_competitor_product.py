"""The product arm's wiring, and the two ways it is allowed to refuse.

## Why these assertions and not a run

The product arm needs two credentials for two different reasons: chat through the metering proxy, because
the row's cost column comes from the proxy's count, and embeddings straight from Zhipu, because the proxy
relays chat completions only. A missing first one and a missing second one both produce a system that would
still *run* if the code defaulted -- and would print under `cortex-product` while being a different system:
a product arm that could not reach the proxy would report zero cost, and one that could not embed would be a
lexical index wearing the registered arm's name.

Neither failure is visible in a table, so each is asserted here as a **message**, not as a status code alone.
A future change that turned either into a warning would pass a bare `returncode != 0` check by exiting later
for an unrelated reason, which is the shape of every "the gate was green and the arm was wrong" defect this
campaign has recorded.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HARNESS = REPO / "tools" / "competitor-harness.mjs"


def run_without(env: dict[str, str], *args: str) -> subprocess.CompletedProcess[str]:
    """Run the harness with a clean environment plus `env`, so a developer's shell cannot satisfy a check."""

    base = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": os.environ.get("HOME", ""),
        # The harness builds the synthetic dataset when no `--data` is given, which is what makes this fast:
        # every assertion below fails before a question is asked.
        "NODE_OPTIONS": "--no-warnings",
    }
    base.update(env)
    return subprocess.run(
        ["node", str(HARNESS), "--questions", "2", "--limit", "2", "--product", "cortex-product", *args],
        cwd=REPO,
        env=base,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


def test_a_product_arm_without_a_proxy_is_refused_rather_than_reported_free() -> None:
    result = run_without({"ZHIPU_API_KEY": "unused-in-this-assertion"})
    assert result.returncode != 0
    combined = result.stdout + result.stderr
    assert "needs SUT_LLM_BASE_URL" in combined, combined
    # The reason has to travel with the refusal: an operator reading only the first line should learn why a
    # zero is unacceptable rather than that a variable is unset.
    assert "cost column reports zero" in combined, combined


def test_a_product_arm_without_an_embedder_is_refused_rather_than_silently_lexical() -> None:
    # The registered arm is `self-index` with an injected embedder (`tools/arm-config-baseline.json`). An
    # assembly without one is a different system, and the whole "which mechanism is worth copying" question
    # is answered by comparing the token bill of a system that embeds.
    result = run_without({"SUT_LLM_BASE_URL": "http://127.0.0.1:9/v1"})
    assert result.returncode != 0
    combined = result.stdout + result.stderr
    assert "needs ZHIPU_API_KEY" in combined, combined
    assert "lexical system" in combined, combined
