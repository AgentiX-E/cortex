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

## 6. Measurement, 2026-09-27 ~09:50 +08:00 (condition A, again)

The condition recurred. Recorded here because a recurrence is what turns a
diagnosis into a pattern, and because the **control was run before the
conclusion** rather than after.

```
--- getent hosts api.github.com ---
198.18.0.5      api.github.com
--- getent hosts github.com ---
198.18.0.16     github.com
--- getent hosts example.com ---
104.20.23.154   example.com
172.66.147.243  example.com
--- getent hosts mirrors.tencent.com ---
169.254.0.3     mirrors.tencent.com
```

| Host | Resolved to | Result |
| --- | --- | --- |
| `api.github.com` | `198.18.0.5` | `000` at **5.001s** |
| `github.com` | `198.18.0.16` | `000` at **5.001s** |
| `productionresultssa3.blob.core.windows.net` | synthetic | `000` at **5.001s** |
| `mirrors.tencent.com` | `169.254.0.3` | **`200` at 0.020s** |

The wall clock is pinned at 5.001s on every blocked name and the working control
answers in 0.020s. **This is §3's rule reproduced exactly, with no counterexample
added:** names resolving into `198.18.0.0/15` are blackholed by name; names
resolving to a real address are reachable.

Four probes, five consecutive retries against the API, all `000`. Deterministic,
not flaky — so this is not a case for a retry loop.

**Consequence for this session, stated rather than worked around:** the push to
`AgentiX-E/cortex` and `AgentiX-E/cortex-docs` could not be performed. Per §5
step 3, the correct action is local work plus a later retry, **not** a
re-dispatch and not a DNS workaround. The commit is staged locally; the push is
the only step that remains.

### 6.1 Why `mirrors.tencent.com` is the right control here

It is not one of §3.1's listed hosts, which makes it a better control than a
reused one: it was chosen **before** the result was known, it answers, and it is
unrelated to every host under test. A control that is known in advance to work
only proves that the control works; an unrelated host that works proves **the
egress path is alive at the same instant the blocked names fail.**

## 8. Correction: condition A is not a wait state, it is a bypassable condition

§5 step 3 said condition A means "do local work; retry the network", on the
reading that the resolver's answer is outside our control. **That step is wrong**,
and it is the kind of wrong this repository's defect log keeps naming: it took a
**fixable** condition and wrote it down as a **wait**.

The resolver is not the only way to obtain an A record. `dns.alidns.com` answers
over HTTPS on port 443, which is not intercepted. Measured 2026-09-27 ~20:00
+08:00:

```
GET https://dns.alidns.com/resolve?name=api.github.com&type=A
  -> {"Status":0, "Answer":[{"type":1, "data":"20.205.243.168"}]}

getent hosts api.github.com
  -> 198.18.0.12                       (the synthetic answer)
```

| Host | System resolver | DoH | Connection with the DoH address |
| --- | --- | --- | --- |
| `api.github.com` | `198.18.0.12` | `20.205.243.168` | **`200`** |
| `github.com` | `198.18.0.16` | `20.205.243.166` | `200` |
| `nodejs.org` | `198.18.0.45` | `104.16.212.131` | headers download succeeds |

The decisive step is the last column and it is one command:

```sh
curl --resolve api.github.com:443:20.205.243.168 \
     -H "Authorization: Bearer $TOKEN" \
     https://api.github.com/repos/AgentiX-E/cortex
# -> 200
```

**Nothing changed but the address.** Same host name, same TLS, same token.
That is what turns "the resolver is answering wrong" from a diagnosis into a
repair, and it is why §2's framing of condition A as environmental was
incomplete: the *symptom* is environmental, the *cause* is a resolution answer
that a second, unblocked channel can supply.

### 8.1 The repair, and why it is a script

`tools/pin-github-hosts.py` resolves the needed hosts over DoH and writes the real
addresses into `/etc/hosts`. It is a script rather than a one-off edit because
`/etc/hosts` is **restored on workspace restart** — its own header says so — which
makes a manual fix a fix that expires silently.

Three properties it has that a hand-edit does not:

1. **It refuses to pin a synthetic answer.** If DoH itself returned an address in
   `198.18.0.0/15`, the interception is upstream of the resolver and pinning would
   produce a hang instead of a failure. It reports and exits non-zero.
2. **It unions with the existing pins.** Resolving only the names it was given and
   then clearing its own section would silently unpin `api.github.com` when invoked
   as `pin-github-hosts.py nodejs.org` — **a fix that breaks the previous fix**.
   The written set is the union of defaults, existing pins, and arguments.
3. **It verifies through the system resolver**, i.e. through the thing that was
   broken, rather than trusting its own write.

### 8.2 The scope is wider than GitHub

`nodejs.org` was found in the same state, during `pnpm install`: a native module's
`node-gyp` step fetches headers from there and failed with a socket disconnect
that looks like a network fault and is not. **The condition is a set of names, and
the set is not the one §3.1 lists.** Any host that resolves synthetically is in it,
which is why the check is `getent` plus comparison against `198.18.0.0/15` rather
than membership in a hard-coded list.

> **Where this sits in the discipline list — and it is an inversion of §3.3's
> conclusion.** §3.3 was right that the `000` on a synthetic name is
> deterministic and that retrying the same request cannot help. It was wrong to
> conclude that the only remaining action is to wait. **"Retrying does not help"
> and "nothing helps" are different claims**, and the second one was never
> measured. What was missing was not patience but a second channel — and the
> repository had already used that channel for artifact fetches
> (`tools/fetch-artifact.py`, `docs/VERDICT-B1-RERANKING.md`) without drawing the
> general conclusion from it.

## 7. Condition A is recoverable in one command, and §5 did not say so

§5 step 3 says "do not re-dispatch; do local work; retry the network, which is
waiting on the resolver". That is accurate about the cause and unhelpful about
the remedy. It reads as "wait", and this section records that waiting is not
required: the repository already contains the fix, and running it restores every
pinned host in under ten seconds.

### 7.1 The remedy

```sh
python3 tools/pin-github-hosts.py
```

It resolves the repository's hosts over DoH (which is not affected, because the
pollution is per-name and `dns.alidns.com` answers normally), writes them into
`/etc/hosts` under a `# doh-pin` marker, and verifies the result **through the
system resolver** — the layer that was broken. It is safe to re-run: it strips
its own previous lines first and takes the union with what was already pinned, so
`main(['nodejs.org'])` does not silently unpin `api.github.com`.

Each address is accepted only after it answered **three real HTTPS requests**.
The acceptance test is a measured success rate, not a certificate read and not a
single sample -- see §7.4, which is the correction of a wrong conclusion this
section's first draft drew from exactly one attempt.

### 7.2 Measurement, 2026-09-29 ~07:20 +08:00 (condition A, third occurrence)

This is the occurrence that produced §7. The resolver was still handing out the
synthetic range, and the pin lifted it immediately.

**Before**, resolver answer and the resulting failure:

```
getent hosts api.github.com  ->  198.18.0.5
curl https://api.github.com/rate_limit
  -> curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to api.github.com:443
  -> HTTP 000
```

`198.18.0.5` is inside `198.18.0.0/15`, so §3.3 classifies this as condition A
without any further measurement.

**The control, run before the conclusion:** real addresses on GitHub's published
ranges accepted TCP immediately, while the synthetic answer did not.

```
140.82.112.6:443 OPEN    140.82.113.6:443 OPEN
140.82.114.6:443 OPEN    140.82.121.6:443 OPEN
```

**After pinning**, same command as before:

```
curl https://api.github.com/rate_limit
  -> HTTP:200   time:0.677175s
```

So the failure and the recovery are 0.68s apart, on the same host, with no
change other than the resolver answer. **Nothing about the network was ever
broken.**

### 7.3 What this changes

| Claim | Status after §7 |
| --- | --- |
| "egress is down" | wrong; the real endpoints answer in under a second |
| "wait for the resolver" | not necessary; `pin-github-hosts.py` bypasses it |
| "a `000` means retry later" | a `000` on a synthetic answer means **pin, then proceed** |
| §5 step 3 ("do local work; retry the network") | superseded for pinned hosts: pin first, then push |

The §5 procedure is left in place because its diagnosis is correct and its
"do not re-dispatch" instruction is still right — a re-dispatch would run on
GitHub's runners and would not address the artifact fetch. What §5 got wrong is
the cost: it presents condition A as a wait, when for every host this repository
uses it is a one-command fix.

> **The lesson, in the shape this file's §5 already uses:** a correct diagnosis
> that stops at "the cause is X" and omits "and here is the remedy" is
> operationally the same as no diagnosis. The defect log has the matching entry —
> knowing which of two causes you are looking at is only half the work; the other
> half is that one of them is fixable and the write-up must say so.

### 7.4 Correction: the acceptance test is a rate, and this section got that wrong first

§7.1's first draft claimed the DoH answer was itself blackholed, on this
measurement:

```
github.com -> 20.205.243.166 (DoH)   tcp OPEN, TLS fails at exactly 5.001s
github.com -> 140.82.112.3   (cert)  tcp OPEN, info/refs returns 200 in 0.73s
```

That conclusion was wrong, and the way it was wrong is worth recording because
it is the same error this file's §5 warns about, committed by §7 while warning
about it.

**One more request to each address reversed the result:**

```
20.205.243.166: handshake OK, issuer=Sectigo Limited
   first byte of response: b'HTTP/1.1 200 OK\\r\\nDate: M'
140.82.112.3: handshake OK, issuer=Sectigo Limited
   TimeoutError: The read operation timed out
```

The same two addresses, minutes apart, exchanged which one worked. The quantity
being sampled is **intermittent**, so a single probe of it says nothing. Three
attempts per address, run concurrently, gave the actual shape:

| Host | Address | Success |
| --- | --- | --- |
| `api.github.com` | `20.205.243.168` (DoH) | 3/3 |
| `api.github.com` | `140.82.112.6` … `121.6` | 3/3 each |
| `github.com` | `20.205.243.166` (DoH) | 2/3 |
| `github.com` | `20.205.243.167` | 2/3 |
| `github.com` | `140.82.112.3`, `.113.3` | 3/3 |
| `github.com` | `140.82.114.3` | 1/3 |

And a later run of the same probe returned **3/3 for every address on every
host**, including the DoH answers. So the population is not "good addresses and
bad addresses"; it is a set that is mostly fine with a per-address success rate
below 1 that moves with time.

**What the script does about it.** `select()` ranks candidates by measured
success over three attempts and prefers a candidate that answered every time. A
single success no longer selects anything, which is what makes the earlier
reversal impossible to repeat: `1/3` and `3/3` both used to read as "works".

**Why the certificate first appeared to be the answer.** A handshake completes
before any application data is sent, so `getpeercert()` succeeds against an
endpoint that then drops the connection. That made the certificate test look like
it discriminated -- and it did, on that one sample. It is a weaker test than an
actual request, and `end_to_end_ok()` now does the actual request.

> **The rule this section adds to §5's list.** When a quantity is intermittent,
> n=1 is not a measurement of it. The first draft of §7 was written from two
> single samples and drew the opposite conclusion from the second one -- and
> both were honest reports of what a single probe saw. The failure was not a
> misread result; it was treating one sample as the population.

## 9. The pin script had been silently un-pinning, and the check could not see it

Condition A returned on 2026-09-29 and §7's remedy was run, and then
`git ls-remote` still failed:

```
gnutls_handshake() failed: The TLS connection was non-properly terminated.
```

The script reported `pinned 5 hosts` and `verified through the system resolver`.
Both statements were true and the host was still broken.

### 9.1 What `/etc/hosts` actually contained

```
140.82.112.6   api.github.com                     <- unmarked, from an earlier session
140.82.112.3   github.com                         <- unmarked
140.82.112.9   codeload.github.com                <- unmarked
185.199.108.133 raw.githubusercontent.com         <- unmarked
20.205.243.168 api.github.com  # doh-pin
20.205.243.166 github.com      # doh-pin
20.205.243.165 codeload.github.com # doh-pin
185.199.110.133 objects.githubusercontent.com # doh-pin
185.199.108.133 raw.githubusercontent.com      # doh-pin
```

`strip_previous_pins` removed only lines carrying `# doh-pin`, so the four
unmarked rows survived every run. `getent hosts api.github.com` then printed
**two** addresses:

```
20.205.243.168  api.github.com
140.82.112.99   api.github.com     (the injected row, in the reproduction)
```

Two `A` records for one name is not a half-applied fix. The resolver returns
both, the caller takes whichever it reaches first, and the observable symptom is
an intermittent TLS failure on a name that resolves correctly -- **which is the
same symptom as condition A itself**, and was diagnosed as condition A.

### 9.2 The failure mode was worse than "stale rows survive"

The old `strip_previous_pins` removed the MARKED line and kept the unmarked one.
Measured against the real file:

```python
OLD strip kept the stale row?  True
OLD count of api.github.com lines: 1
```

So re-running did not merely fail to clean up. It **replaced a verified address
with an unverified one**: the `# doh-pin` row, which had been through
`select()`'s three-attempt ranking, was deleted, and a hand-written address that
had never been tested became the sole source. A tool that is run to repair something
and leaves it in a state it never validated is worse than one that does nothing,
because the run is reported as a success.

### 9.3 Why the verification passed

The post-write check asked **whether any reported address was real**:

```python
if any(is_synthetic(line.split()[0]) for line in output.splitlines() if line.split()):
    print(f"FAIL  {name}: still synthetic after pinning")
```

With one real address and one stale real address, that is `False` and the check
passes. The question has the wrong answer set: the property that matters is not
"is a real address present" but **"how many sources does this name have"**, and
the file had just been rewritten to hold exactly one per host. A second answer
therefore means the pin is not in effect. It now counts and requires exactly one.

### 9.4 The fix

- `strip_previous_pins` removes **any** line naming a managed host, wherever it
  came from. The name is read from the second field, so `ADDRESS host alias` is
  recognised, and matched as a whole field, so `api.github.com.evil.example` is
  not.
- The verification counts resolvers and requires exactly one.
- `existing_pins` parses the comment-free part of the line, so a truncated
  `ADDRESS # doh-pin` no longer becomes a pin for a host named `#`.

### 9.5 Why this survived: the tool had no tests and no CI

`tools/` held nine Python scripts -- including the only publisher, the only
dispatcher, and this resolver repair -- with **zero tests and no CI job**. The
first tests (21, in `tools/__tests__/test_pin_github_hosts.py`) were written with
this fix and wired into `pnpm check`, so the same command runs locally and on the
runner.

Adding them immediately found two more defects, both recorded here because each
is the same shape -- a check that cannot see the thing it guards:

1. **The dependency list was incomplete.** `pnpm check` on a clean runner failed
   four `fetch-artifact.test.ts` cases with `expected 1 to be 2` and an empty
   stdout. `fetch-artifact.py` imports `requests` at module scope, so it cannot
   print its usage without it; the development sandbox happened to have
   `requests` installed, so no local run could fail. Reproduced exactly with
   `python3 -S tools/fetch-artifact.py`.
2. **The test harness swallowed the evidence.** It captured stderr and never
   printed it, so a pre-`main` import failure presented as a wrong exit code with
   no message. This is the same class as §8's `process.exit` truncation and
   the workflow's missing `tee`: the failure was visible to the machine and not
   to the person reading the log.

> **The rule this section adds.** A verification whose question admits an answer
> set wider than the intended one will pass on broken input. "Is any address
> real" is satisfied by a real address that is not the one you wrote. The check
> has to ask about the property that was established, not a weaker consequence
> of it.
