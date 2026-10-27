# System-under-test protocol

A competitor's memory system is not a library this repository can import: it has its own language, its own
dependencies and its own idea of what a store is. What it has in common with ours is three operations. This
protocol is those three, and it exists so that "run their code" is a configuration rather than a rewrite.

## Why a subprocess and not an import

Every competitor worth measuring ships a Python package with pinned transitive dependencies, and two of them
in one environment is a weekend. A process boundary keeps each system in its own interpreter, lets one be a
different Python version from another, and makes a crash a *reported failure* instead of a stack trace that
aborts the whole comparison. The cost is serialisation, and the payloads here are text.

## Transport

Newline-delimited JSON over **stdio**. The parent writes one request object per line to the child's stdin; the
child writes exactly one response object per line to stdout. Anything the system wants to log goes to **stderr**,
which the parent captures and keeps — a system that prints progress to stdout cannot corrupt the channel, and a
system that prints it to stderr does not lose it.

One request, one response, in order. No batch, no pipelining, no request ids: the parent is single-threaded and
the only thing an id would buy is the ability to get the ordering wrong.

## Requests

```jsonc
{"op": "manifest"}
{"op": "reset"}
{"op": "ingest", "sessions": [{"id": "...", "at": 1685000000000, "turns": [{"role": "user", "content": "..."}]}]}
{"op": "search", "query": "...", "limit": 10, "asOf": 1685000000000}
{"op": "shutdown"}
```

## Responses

Success is `{"ok": true, ...}`; failure is `{"ok": false, "error": "<one line>"}`. **A failure is a valid
response**, not a broken pipe: the parent has to be able to record "the system refused this question" separately
from "the system returned nothing", because those are different claims about it.

| op | success payload |
| --- | --- |
| `manifest` | `{"name": "...", "build": "llm" \| "embedding" \| "none", "version": "...", "notes": "..."}` |
| `reset` | `{}` |
| `ingest` | `{"sessions": <int>, "turns": <int>, "skipped": ["<reason>", ...]}` |
| `search` | `{"hits": [{"text": "...", "score": <number?>, "at": <epoch ms?>}]}` |
| `shutdown` | `{}` — the child then exits 0 |

`manifest` is required and is asked once, before anything else. It is what makes a result quotable: the report
prints `name`, `build` and `version` beside the score, so a number never again leaves its system — the failure
this repository has recorded three times.

`ingest` reports what it could not take. An ingest that silently drops a tenth of the corpus produces a score
that reads as a retrieval failure, and the first question anyone asks is whether the history was even loaded.

`search` must return **at most** `limit` hits, best first, and must not generate an answer. Generation belongs to
the one reader every system shares; a system that answers inside `search` would be measured on its prompt as
well as its retrieval and the two would be inseparable.

## Failure semantics the parent enforces

| condition | parent's verdict |
| --- | --- |
| exit code ≠ 0 | the run fails, naming the exit code and the tail of stderr |
| no response within the timeout | the run fails, naming the op and the timeout |
| a line that is not JSON, or has no `ok` | the run fails, quoting the first 200 bytes |
| `{"ok": false}` | recorded per question; **not** a run failure |
| `search` returns more than `limit` hits | the run fails — the contract is the ceiling |

The third row is the one that matters: a driver that prints a banner to stdout is a common shape, and the
parent must say so rather than silently skipping its first line.

## Cost classes, and why they are in the manifest

`build` is `llm` when the store itself is built by a model (extraction, consolidation), `embedding` when only
vectors are computed, `none` when the index is lexical. It is not a quality ranking — it is the cost side of the
ledger, and it is what lets a run be refused before it starts: a `llm` system on 500 questions x ~550 turns is
~275,000 model calls, which is not a comparison, it is a bill.

The driver decides its own class and says so. A parent that guessed would be guessing about someone else's
architecture.
