# OPS — Sandbox Egress State and How It Presents

## 1. What this document is for

The sandbox intermittently loses all outbound HTTPS. Because the symptom is
identical at the socket level to one specific Azure blob-host failure we
diagnosed earlier, the two were easy to conflate. This document separates them,
so that neither a re-dispatch nor a DNS workaround is chosen for the wrong
reason.

## 2. The two conditions and how to tell them apart

Both present as `http=000` with a **5.001s** wall clock. The discriminator is
what **other** hosts do in the **same** check.

| Condition | `api.github.com` | known-good Azure host (`sa3`) | Meaning |
| --- | --- | --- | --- |
| **A — sandbox egress down** | TLS fails, `000`, 5.00s | **also fails, `000`, 5.00s** | nothing on our side can be fetched; wait and retry |
| **B — one blob host intercepted** | **works** | `sa3` works, `409` | a single host assignment is unusable; re-dispatch |

**The control is the whole method.** A 5-second TLS failure on one host means
nothing on its own; the same failure on *every* host means the sandbox, not the
target.

### 2.1 Measured state, 2026-09-21 ~00:00 +08:00 (condition A)

```
--- api.github.com ---
  dns: 198.18.0.15
  tcp: ok (0.00s)
  tls FAILED: SSLZeroReturnError: TLS/SSL connection has been closed (EOF) (5.00s)
--- productionresultssa3.blob.core.windows.net ---
  dns: 198.18.0.38
  tcp: ok (0.00s)
  tls FAILED: SSLZeroReturnError (5.00s)
--- github.com ---
  dns: 198.18.0.14
  tcp: ok (0.00s)
  tls FAILED: SSLZeroReturnError (5.00s)
```

Three consecutive `curl` retries against `/rate_limit` gave `http=000` at
5.001s, 5.002s, 5.001s — deterministic, not flaky.

### 2.2 What the layers say

- **TCP succeeds in 0.00s.** So it is not a routing blackhole and not a firewall
  drop; something is accepting the connection locally.
- **TLS never negotiates.** Both Python's `ssl` and curl's OpenSSL backend report
  the same class of error, with curl's `SSL_ERROR_SYSCALL` and Python's
  `SSLZeroReturnError` agreeing.
- **The connect time is 0.00s but the failure takes exactly ~5s.** That gap is a
  proxy answering immediately and then timing out, which is why the wall clock is
  pinned to a constant rather than varying with network latency.

**Conclusion:** the DNS answers in `198.18.0.x` (RFC 2544 benchmarking range) and
the TLS-level refusal are two views of the same thing — the sandbox routes egress
through a resolver and proxy pair, and when the proxy is unavailable every host
presents identically.

## 3. Condition A is not uniform — the blocklist is by host, and the rule is exact

The write-up above treats condition A as "egress down". A later measurement shows
it is more specific than that, and the extra structure is what makes it
diagnosable instead of merely annoying.

### 3.1 Two disjoint sets, with no exceptions

Measured 2026-09-21 ~08:10 +08:00:

| Host | Resolved to | Result |
| --- | --- | --- |
| `api.github.com` | `198.18.0.15` | `000` at 5.001s |
| `github.com` | `198.18.0.14` | `000` at 5.001s |
| `codeload.github.com` | `198.18.0.35` | `000` |
| `objects.githubusercontent.com` | `198.18.0.40` | `000` |
| `registry.npmjs.org` | `198.18.0.13` | `000` at 5.001s |
| `pypi.org` | `198.18.0.4` | `000` at 5.001s |
| `files.pythonhosted.org` | `198.18.0.41` | `000` |
| `www.google.com` | `198.18.0.8` | `000` |
| — | — | — |
| `example.com` | real | **`200` at 0.57s** |
| `www.baidu.com` | real | **`200` at 0.03s** |
| `open.bigmodel.cn` | real | **`200` at 0.10s** |
| `api.deepseek.com` | real | **`401` at 0.21s** |
| `api.cohere.com` | real | **`403` at 1.06s** |
| `api.voyageai.com` | real | **`404` at 1.01s** |

**The rule has no counterexample across the hosts tested: if the name resolves
into `198.18.0.0/15`, the connection is blackholed; if it resolves to a real
address, it works.**

### 3.2 Why that is the useful statement

`198.18.0.0/15` is the RFC 2544 benchmarking range. It is not routable on the
public internet, so a host resolving into it **cannot** be reached by any client,
regardless of what the client does — the packets have nowhere to go.

This matters for three concrete reasons:

1. **It is a resolver-level condition, not a network-level one.** The sandbox's
   egress path is demonstrably healthy at the same instant: `example.com` answers
   in 0.57s and `api.deepseek.com` completes a TLS handshake and returns `401`.
   So "the sandbox has no internet" is the wrong description, and any procedure
   that waits for *the network* to come back is waiting for something that is not
   the problem.
2. **It is not a routing fault.** TCP connects in 0.00s to the synthetic address,
   because the proxy accepts locally. Nothing about retrying, re-resolving, or
   changing the request will help.
3. **It names the causal direction.** The block is applied by *name*, so the same
   process that could fetch `pypi.org` a minute ago will fail if the resolver
   starts answering `198.18.0.x` for it. That is what makes it intermittent from
   the caller's point of view while being perfectly deterministic per check.

> **The `.x` address is the diagnosis.** A `000` is ambiguous; a `000` on a name
> that resolves into `198.18.0.0/15` is not. Read the resolver answer first, and
> the layer analysis in §2.2 becomes confirmation rather than the primary
> evidence.

### 3.3 Interaction with §2

Condition A remains "do not re-dispatch" — a re-dispatched workflow would run on
GitHub's runners, not here, and so is unaffected; but the *artifact fetch* that
motivated the re-dispatch would still fail. The refinement is only about
**diagnosis**, and it strengthens the §2 conclusion:

| What was thought | What the measurement says |
| --- | --- |
| "egress is down" | egress is up; a set of names resolves into a non-routable range |
| "wait for the network" | the network is fine; wait for the resolver to change its answer |
| "the sandbox has no internet" | false at the same instant, provably (`example.com` `200`) |

**Practical check, before interpreting any `000`:**

```sh
getent hosts api.github.com   # synthetic range => condition A, host-blocked
getent hosts example.com      # real range     => the sandbox itself can reach out
```

## 4. Correction to the earlier `sa18` write-up

`§2.1.2` of this file characterised the `sa18` failure as host-specific, on the
evidence that `sa3` answered `409` **during the same check**. That evidence was
sound, and the conclusion was right **for that measurement**. What this document
adds is the boundary:

> The `sa3` control only discriminates while the sandbox egress itself is up.
> When it is down, `sa3` fails too, and the `sa18` signature is reproduced
> exactly. So "which host is it" is a question that can only be asked in
> condition B.

Practically this matters in one direction: **never conclude "it is that host
again" without re-running the control.** A `000` seen during condition A is not
evidence about any host assignment, and re-dispatching on that basis wastes a run
for a fault that has nothing to do with it.

## 5. Procedure

1. On any `http=000`, resolve the name **first** (§3.3). A synthetic answer is
   conclusive and costs one command.
2. If the answer is real, run the two-host control from §2 — the failure is then
   either host-specific (`B`) or genuinely local to one endpoint.
3. Condition A → do not re-dispatch. Do local work; retry the network. Note that
   "the network" is up, so the retry is waiting on the resolver.
4. Condition B → the named host is unusable; re-dispatch and wait for another
   assignment (§2.1.1, §2.1.2).
5. Record which condition applied, because "the fetch failed" is not a finding
   until it says which of the two it was — and now also *which names* were
   affected, since condition A is a set rather than a switch.

> **Where this sits in the discipline list:** it is the same shape as everything
> else in this repository's defect log — **a symptom that is identical across two
> causes will be attributed to whichever one you already have a story for.**
> The control is what makes the two distinguishable; without it, the diagnosis is
> a guess wearing the clothes of a measurement.
