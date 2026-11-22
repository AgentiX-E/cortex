"""Stand-in for MemCog's `src/core/llm_client.py` -- which, at the pinned commit, is a client that returns `{}`.

This fixture is the thing being tested from the driver's side: the driver replaces `call_llm` on this module *before*
anything imports it by name. Two properties of the real file are reproduced because both are what make the patch
load-bearing:

* `call_llm` exists here with the real signature and would return an empty dict -- so a driver that forgot to patch
  would produce a `KeyError` rather than a plausible answer;
* callers import it by name (`from core.llm_client import call_llm`), which is why the patch has to happen first.
"""

# Records every call the pipeline makes, so the test can assert that the driver's patch is what ran.
CALLS: list[dict] = []


def call_llm(messages, tools=None, max_tokens=4096, temperature=0.2, base_model="gpt", model=None):
    CALLS.append({"messages": messages, "tools": tools, "model": model})
    return {}


def call_llm_simple(system_prompt, user_prompt, max_tokens=4096, temperature=0.2, base_model="gpt", model=None):
    CALLS.append({"messages": [system_prompt, user_prompt], "model": model})
    return ""
