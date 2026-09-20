# OPS — A Completed Run's Artifact and Logs Can Be Unfetchable

**Status:** characterised and diagnosed; not fixable from our side. Workaround is
to re-dispatch. Recorded because the failure mode is indistinguishable from a
permission problem and cost real time to separate from one.

---

## 1. Symptom

Run `35510619912` (A2 full re-measurement, `LIMIT=0`, `RUNS=4`) completed
**success — all 14 steps green**. Its single artifact is listed by the API as
present and unexpired:

```
10606289039 longmemeval-s-report 4053322 bytes expired: False
```

Downloading it returns an HTML/XML error, not the zip:

```xml
<Error><Code>AccountNotFound</Code>
<Message>The specified account does not exist.
RequestId:d783809c-a01e-0090-0f0a-491a6c000000
Time:2026-09-20T14:18:56.6032838Z</Message></Error>
```

The job logs fail identically — same host, same error, different `RequestId`.

**`AccountNotFound` reads like an authentication or permissions failure.** It is
neither. The API call itself is authorised (it returns a valid redirect and a
well-formed `Location`), the DNS resolves to a real public IP, and the host
answers promptly. The problem is downstream of all three.

## 2. Diagnosis

Both artifact and log downloads 302-redirect to a per-run Azure blob host:

```
productionresultssa16.blob.core.windows.net/actions-results/<job-run-uuid>/...
```

The host is **stably** `sa16` for this run — three consecutive requests, minutes
apart, all resolve to `sa16`, and cross-host substitution fails because the SAS
signature is bound to the host.

A probe of the candidate hosts separates "account missing" from "not allowed":

| Host | Response to `GET /?comp=list` | Meaning |
| --- | --- | --- |
| `productionresultssa1` | (used successfully for run `35498421148`) | exists |
| `productionresultssa3` | `409` | exists (`409` = a real front-end reply) |
| `productionresultssa15` | `409` | exists |
| **`productionresultssa16`** | **`404`** | **does not exist** |
| `productionresultssa17..20`, `productionresults` | `000` | do not resolve |

`404 AccountNotFound` is the answer for a hostname with no storage account behind
it; `409` is what an existing account returns to a malformed request. So the
per-run routing pointed this run's outputs at a backend that is not publicly
addressable.

### 2.1 The correlation, with a control

| Run | Artifact host | Fetch |
| --- | --- | --- |
| `35498421148` | `productionresultssa1` | works |
| `35502712132` | `productionresultssa3` | **`http=200`, 538,501 bytes, valid zip** |
| `35510619912` | `productionresultssa16` | `http=404 AccountNotFound` |
| `35510619912` (**re-checked later**) | `productionresultssa16` | `http=404`, same `Code`, fresh `RequestId` |

The control matters: an older artifact fetched from `sa3` **during this
investigation**, successfully, proves the fetch path, the token, and the
sandbox's network are all fine. The variable is the assigned host, not anything
on our side.

### 2.1.1 Independent re-confirmation, and what it rules out

The `sa16` result was re-derived later in the session against the **same
completed run**, to separate a transient incident from a persistent one. It
reproduces exactly:

```
Artifact 10606289039 -> Location host: productionresultssa16.blob.core.windows.net
GET (host pinned to 20.209.113.193) -> http=404, 222 bytes
GET (host pinned to 20.209.226.1)   -> http=404, 222 bytes
GET (host pinned to  57.150.27.1)   -> http=404, 222 bytes
GET (host as DNS resolves)          -> http=404, 222 bytes

<Error><Code>AccountNotFound</Code>
<Message>The specified account does not exist.
RequestId:3c5b2c9b-e01e-0065-5717-498e46000000</Message></Error>
```

Three things follow, each of which narrows the diagnosis:

1. **It is not a transient.** The run had been completed for over an hour and the
   response is identical, with a new `RequestId`. A retry of the *download* will
   never succeed; only a retry of the *run* can.
2. **It is not an IP-pinning problem.** The same `404` comes back from all three
   known-good front-end IPs **and** from whatever the host resolves to natively.
   If the hostname mapped to a real account, pinning to any of those IPs would
   reach it and return either the payload or an authorisation error (as §2.2
   shows for other hosts).
3. **The SAS is host-bound, so cross-host recovery is closed.** Substituting the
   three candidate hosts into the signed URL gives `403` on every one — the
   signature covers the host, so a correctly-signed request to `sa16` cannot be
   replayed against `sa3`:

   | Host substitution into the `sa16` signed URL | Response |
   | --- | --- |
   | `productionresultssa3` | `403` |
   | `productionresultssa15` | `403` |
   | `productionresultssa1` | `403` |

Point 3 is why §4's workaround is a **re-dispatch** rather than a cleverer
download. There is no URL that both carries a valid signature and points at a
host that exists.

### 2.2 It is not a DNS block

The earlier dead end in `FIX-REPORT-JSON-ROUNDTRIP.md` §9 was a DNS/proxy issue:
`api.github.com` resolved into the synthetic RFC 2544 range `198.18.x.x` and
needed pinning. This is **not** that.

```
resolved: 20.209.113.193   ->  REAL PUBLIC IP (not 198.18/15)
GET /?comp=list on that IP with Host: ...sa16... -> 404 (a real reply)
```

The host resolves publicly and answers. A DNS block produces `000`/timeout; this
produces a structured `404` with a `RequestId`. Concluding "network problem"
here would have been wrong, and the two failures need different responses: a DNS
block is fixed by pinning, an absent backend is not fixed by anything we can do.

## 3. Impact

**The run's results are not recoverable for this run.** The report set exists
only in:

- the artifact (unfetchable, this run);
- the job log (unfetchable, this run);
- the runner's ephemeral disk (gone).

`bench/run.ts` writes its reports to the workspace and prints the Markdown to
stdout; nothing else persists them. So when the routing lands on a
non-addressable host, **the measurement set is lost even though the run
succeeded.**

This is worth stating plainly because the failure is silent in the one place a
reader looks: the run is green, the artifact is listed, and the data is gone.

## 4. Workaround, and what was done

**Re-dispatch.** Routing is assigned per run (the three runs above landed on
three different hosts, and older artifacts remain fetchable), so a fresh run is
expected to route elsewhere. Applied immediately:

- re-dispatched as run `35516440181` on `05eec97f` with the same inputs
  (`LIMIT=0`, `RUNS=4`, `TEMPERATURE=0`, `DIAGNOSTICS_LIMIT=0`).
- that attempt is itself recorded for completeness: it **failed** in CI, on a
  formatting check, for a reason unrelated to this document — the format gate
  had not been run locally (see `FIX-COVERAGE-GATE-NOISE.md` for the same lesson
  from the other direction: the command used to verify a change must be the
  command that judges it).
- re-dispatched a third time as run `35516794168` on `9eb6b7ee`, which carries
  both the format fix and the second sink from §5.1.

This also satisfies the standing plan item to verify the cohort banner on the
new HEAD, so the re-run is not purely a retry.

## 5. Not claimed, and the durable fix

- **Not claimed:** that re-dispatch succeeds. It is a new draw from the same
  distribution. If several consecutive runs route to `sa16`, the conclusion
  becomes "artifact retrieval for this repository is currently unreliable"
  rather than "one unlucky run".
- **Not claimed:** that `sa16` is permanently absent. The evidence is that it is
  absent *now*, on a public resolver, and returns the same answer from a pinned
  IP.

**The durable fix is not in this document.** It is the observation that this
class of loss is only possible because the artifacts are the *sole* record. A
second, independent sink for the report set — for example having the benchmark
step emit the report as a job summary, which is delivered through a different
channel and survives artifact-routing failures — would convert "the run
succeeded and we have nothing" into "the run succeeded and we have less detail."

### 5.1 That follow-up is now implemented

The second sink exists as of `cortex@98e4a3a`:

| Item | Value |
| --- | --- |
| Implementation | `tools/benchmark-summary.py` |
| Target | `$GITHUB_STEP_SUMMARY` — GitHub's own UI, **not** an Azure blob |
| Wiring | `benchmark.yml`, final step, `if: always()` |
| Tests | 13, running the real script as a subprocess |

Three constraints on it are direct consequences of this document, and each is
pinned by a test:

1. **The renderer must never raise.** It runs `if: always()`, so a crash there
   would turn "a failure that still reported numbers" into "a failure with no
   numbers at all" — the same class of loss this document is about.
2. **`null` renders as `n/a`, never as `0`.** Printing a `null` as `0` would
   fabricate `p = 0` out of "this deterministic arm has no p-value", which is a
   worse failure than losing the number.
3. **The recall curve is a top-level list.** The first implementation printed
   `_Unexpected top-level type: list_` and silently dropped the entire table.
   A renderer that goes quiet on unrecognised input reads as "there was no data",
   which is precisely this document's failure mode wearing different clothes.

So a routing failure can no longer make the measurement set disappear; it can
only reduce its fidelity. The remaining limitation is stated in §3 — the
artifact is still the richer record, and the summary carries the headline
tables, not the full report set.

> **The generalisable point:** the bug was not the routing, which is not ours.
> It was that a **green run had exactly one channel to its numbers**, and a
> channel failure was invisible. Redundancy here is not an optimisation; it is
> what makes the green light mean anything.
