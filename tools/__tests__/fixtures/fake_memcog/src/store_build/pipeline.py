"""Stand-in for MemCog's `store_build/pipeline.py`.

The real `process_session` runs five steps and makes several model calls per session. This one makes exactly one call
through the same imported name and writes the one file the navigation step needs, so the driver's behaviour is
testable without a corpus, a key or a bill:

* it calls `call_llm` **by the name it imported at module import time** -- the property the driver's patch depends on;
* it prints to stdout, as the real modules do in a dozen places -- the property the driver's channel redirection
  depends on;
* it returns `{}` on failure rather than raising, which is what the real pipeline does and what the driver has to
  treat as "this session did not enter the store".
"""

from __future__ import annotations

from config.settings import get_store_root
from core.llm_client import call_llm

USER_ID = "user"
ASS_ID = "assistant"


def process_session(session, user_id, ass_id, verbose=False, lang="en", base_model="qwen", model="glm"):
    session_id = session.get("session_id", "")
    if not session.get("messages"):
        return {}

    # A stdout print, exactly like the real pipeline's progress lines. If the driver did not redirect the channel,
    # the parent would receive this instead of a JSON response and fail on the first ingest.
    print(f"[fake-memcog] processing session {session_id} with {len(session['messages'])} messages")

    response = call_llm(
        [{"role": "user", "content": f"Summarise session {session_id}"}],
        max_tokens=64,
        temperature=0.0,
        base_model=base_model,
        model=model,
    )
    # A patched client returns `{"choices": ...}`; the fixture's own returns `{}`. That difference is how a test can
    # tell "the driver patched the module" from "the driver imported the package and hoped".
    if not response.get("choices"):
        return {}

    store = get_store_root() / user_id / ass_id
    store.mkdir(parents=True, exist_ok=True)
    index = store / "index.md"
    existing = index.read_text(encoding="utf-8") if index.exists() else "# Index\n"
    index.write_text(existing + f"- [{session_id}]({session_id}.md)\n", encoding="utf-8")
    return {"session_id": session_id, "memory_pages": [str(index)]}
