"""Stand-in for MemCog's `navigation/agent.py`.

Two functions, because those are the two the driver calls and the two its contract depends on:

* `load_context` reads the index the build step wrote. Returning an empty string when the store was never built is
  the real behaviour (`files_missing` in its trace), and the driver turns that into a per-question refusal.
* `answer_question_with_agent` takes the same eight arguments and returns `(prediction, trace)`. It calls `call_llm`
  **twice** -- a tool-using turn and a final turn -- so the test can tell a driver that reported one call from one
  that reported the loop.
"""

from __future__ import annotations

from pathlib import Path

from config.settings import get_store_root
from core.llm_client import call_llm


def load_context(user_id: str, ass_id: str):
    index = get_store_root() / user_id / ass_id / "index.md"
    if not index.exists():
        return "", {"files_loaded": [], "files_missing": [str(index)]}
    return index.read_text(encoding="utf-8"), {"files_loaded": [str(index)], "files_missing": []}


def answer_question_with_agent(
    user_prompt,
    question,
    user_id,
    ass_id,
    context="",
    max_loop=7,
    base_model="gpt",
    model=None,
):
    steps = []
    for step in range(2):
        response = call_llm(
            [
                {"role": "system", "content": context},
                {"role": "user", "content": user_prompt},
            ],
            tools=[{"type": "function", "function": {"name": "mem_search_name"}}] if step == 0 else None,
            max_tokens=256,
            temperature=0.1,
            base_model=base_model,
            model=model,
        )
        if not response.get("choices"):
            raise RuntimeError("the model client returned no choices; the driver did not patch it")
        steps.append(step)
    # The date from the prompt is echoed, because the driver's job includes passing the corpus's own spelling of it
    # rather than a rendering: a fixture that ignored `asked_at` would let that wire be cut without a failing test.
    return f"answered {question!r} as of {user_prompt.splitlines()[0]}", {"steps": steps}
