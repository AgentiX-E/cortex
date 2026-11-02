# A `429` ended a run, and the ceiling meant to outlast it was never reached

**Found 2026-11-02, reading the artifact of `41346610318`.** That run was a 20-question probe of
the cortex-memory arm. It stopped at question 13 with `LLM request failed: 429`, uploaded a
partial measurement holding twelve graded answers, and reported nothing anywhere about a rate
limit — not in the artifact, not in the error file, not in a counter. The counters exist.

> `retry.ts`: "a retried request is a fact about the run and belongs in the run's artifact, and a
> counter is only useful if the thing it counts is separable."

That sentence had been true of the code and false of every artifact this campaign produced.

## 1. Two defects, and the second is why the first mattered

### 1.1 The ladder reached 31 seconds, not 120

`DEFAULT_RETRY_BUDGET_MS` is 120 s. Its docblock gives the reason: *"a throttle window measured in
minutes has to be reachable, and a budget at or below one minute would reproduce the original
defect with the code nominally fixed."* Measured against a fetch that answers `429` forever, with
no options:

```text
status 429  attempts 6  retried 5  rateLimited 6  elapsedMs 31051
```

Six attempts, 31,051 ms. The backoff sequence is `1+2+4+8+16 = 31 s`, and the sixth attempt is the
last one because `DEFAULT_MAX_RETRIES` was 5. The ceiling was **3.9× the ladder**: no input could
reach it, so no run ever tested it.

This is the defect the budget itself was introduced to fix, one layer down. The old code counted
retries; the fix replaced the count with a duration and argued — correctly — that *"what has to be
exceeded is a duration, and an attempt count implies a different duration for every
`baseDelayMs`."* The count stayed. It bound first. The duration was never exceeded.

### 1.2 The counters were written to the channel that expires first

`retryStats()` is a process-level aggregate with nine fields and an asserted partition. In the
memory arm's entry point it appears exactly once, inside the `catch`:

```ts
console.error('=== transport retry accounting (process-wide) ===');
console.error(JSON.stringify(retryStats()));
```

So a run that retried 400 times and completed successfully produced an artifact identical in this
respect to a run that retried zero times, and a run that died said so only to stderr. GitHub's logs
expire; artifacts are collected. The number that decides whether the next dispatch is affordable
was stored in the shorter-lived of the two.

Contrast `bench/run.ts`, the reference pipeline's entry point: it writes
`transportRetry: transportRetryReport(retryStats(), { provider: 'embedding' })` into
`benchmark-diagnostics.json`. The instrument, its types, its tests and its renderer all existed. The
arm simply never called them.

## 2. What was measured, and what it means at this scale

| reading | value | source |
| --- | --- | --- |
| ladder reach at the old defaults | 31,051 ms | `retryableFetchWithStats` against an always-429 fetch |
| ladder reach the docblock claims | 120,000 ms | `DEFAULT_RETRY_BUDGET_MS` |
| ratio | 3.9× | — |
| provider calls per 500-question dispatch | ~5,650 | `llmUsage.calls` in `41284575092` |
| job ceiling | 360 min | `benchmark-cortex-memory.yml` |

Against a per-minute window, 31 s straddles at most one reset and 120 s spans two. The difference
is not a delay; it is a dispatch. A pass that dies at question 13 of 500 loses four hours of
grading, and there is no resume path — the next run starts from zero.

## 3. The repair

### 3.1 The count stops binding before the ceiling

`DEFAULT_MAX_RETRIES` 5 → 8, the smallest count whose geometric sum (`1+2+…+128 = 255 s`) exceeds
the 120 s ceiling. A caller that names a count still gets exactly that count; the defect was the
default, and the test pins the old 31 s reach as the control.

### 3.2 The last wait is truncated to the remainder

Doubling rarely spends a budget exactly: 40 ms then 80 ms against a 100 ms budget stopped at 40 ms
with 60% of the window unused. The final computed backoff now waits whatever remains, so the last
attempt lands **on** the deadline.

The asymmetry is the design, not an oversight:

| source of the wait | longer than what remains | why |
| --- | --- | --- |
| `Retry-After` (the server's window) | declined in full, return at once | retrying inside a window the server just said is closed is a request we know will be rejected |
| computed backoff (our own estimate) | truncated to the remainder | it is a guess, and the budget is its ceiling |

### 3.3 The artifact carries the counters, and renders the reading

`AblationReport.transportRetry` is attached unconditionally, which is the opposite of
`attachLlmUsage`'s rule and deliberately so: `llmUsage` omits the field when the provider reported
no `usage` block, because a run that called and was not priced is a real state. The retry counters
increment **before** the provider answers, so a graded run cannot have zero. `calls: 0` therefore
means the counters were not wired — a defect the artifact should be able to state — and absence
means the artifact predates the field.

The Markdown does not print eight counters and leave the reader to interpret them. Three states are
separable and each implies a different next action:

| counters | reading | next action |
| --- | --- | --- |
| `retried: 0` | nothing was throttled | none |
| `retried > 0, rateLimited: 0` | transport failures or `5xx` | the network or the endpoint, not quota |
| `rateLimited > 0` | the provider throttled | wall clock, not tokens; the next dispatch inherits it |

Two failure shapes are printed as failures rather than as numbers: a partition that does not close
(`cleanCalls + retriedCalls + exhaustedCalls ≠ calls`, which means the counters were read across a
boundary) and a non-zero `exhaustedCalls` on a completed run (impossible: exhaustion throws).

`resetRetryStats()` runs immediately before the passes, because the aggregate is process-wide. A
counter that includes an embedding preflight is a number nobody can attribute, and it looks like a
measurement.

## 4. What this does not claim

- **Not that the run would have survived.** A `429` outlasting 120 s kills a pass exactly as one
  outlasting 31 s does. What changed is that the ladder now has the reach it documented, and that
  the next failure carries the counters that decide whether 120 s is the right number.
- **Not that 120 s is right for this provider.** It is the registered value; `rateLimited` against
  `retriedCalls` in the next artifact is the measurement that would replace it.
- **Not that 8 is "more retries is better".** With the ceiling unbound, eight retries would spend
  255 s per failing call inside a 340-minute run. The count earns its value only together with the
  ceiling that now binds.

## 5. Acceptance

Eight assertions, all in the suite rather than in this document:

| # | property | where |
| --- | --- | --- |
| 1 | the ladder reaches the ceiling at the defaults | `retry.test.ts`, attempt timestamps `[0, 1k, 3k, 7k, 15k, 31k, 63k, 120k]` |
| 2 | a short budget is spent exactly | `[0, 40, 100]` against `retryBudgetMs: 100` |
| 3 | a named count still binds | `maxRetries: 5` reproduces 31 s |
| 4 | a negative budget disables the ceiling | three attempts, nothing truncated |
| 5 | the counters attach even at zero, and say `NOT WIRED` | `report-transport.test.ts` |
| 6 | the three readings are separable in the document | `report-transport.test.ts` |
| 7 | the counters describe the arm, not the process before it | `bench-memory-arm-transport.test.ts`, seeded retry absent |
| 8 | the partition closing is checked where a reader can see it | `report.ts`, `COUNTERS DO NOT PARTITION` |

Mutation check, run before the change was committed: disabling the render call in
`formatAblationReport` fails seven of the eight `report-transport` tests and leaves only the
"omits the section" case passing, which is the correct pair.
