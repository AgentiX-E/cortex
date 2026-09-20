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

The control matters: an older artifact fetched from `sa3` **during this
investigation**, successfully, proves the fetch path, the token, and the
sandbox's network are all fine. The variable is the assigned host, not anything
on our side.

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
Recorded as a follow-up rather than done here, because changing the workflow's
output surface is a decision that should not ride along with a diagnosis.
