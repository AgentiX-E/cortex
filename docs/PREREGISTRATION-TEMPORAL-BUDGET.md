# A route-scoped window: `temporal` at 48,000, and nothing else moved

> **STATUS: REGISTERED, dispatch pending.** The population below is counted on the archived arm, not
> estimated; §5 fixes the dispatch and §6 the decision rules. Nothing in this file changes a string —
> the treatment is one key of the per-route budget table.

## 1. The population

`S16`, the archived 500-question arm the shipped configuration still reproduces, read for this file
with `tools/evidence-completeness.py`:

| | n |
| --- | ---: |
| `TR` questions | 127 |
| correct | 120 (94.5%) |
| wrong | **7** |
| wrong with every gold turn delivered (`carried == total`) | **0** |
| wrong whose gold turns are partly missing | **7** |
| wrong whose gold turn was never in the retrieval pool (`pool < total`) | **0** |

All seven are delivery failures with a small gap, which is what makes them worth one route's budget:

| question | gap `total − carried` | delivered chars | what the reply said |
| --- | ---: | ---: | --- |
| `gpt4_59149c78` | 1 of 11 | 23,873 | `Museum of Modern Art` for a gold of `The Metropolitan Museum of Art` |
| `gpt4_7f6b06db` | 2 of 18 | 23,963 | a list of outings, none of them the day hike the question names |
| `gpt4_7abb270c` | 2 of 30 | 23,928 | four museums in the wrong order |
| `370a8ff4` | 2 of 11 | 23,971 | a date for a gold of `15` |
| `gpt4_f420262c` | 2 of 27 | 23,889 | the four airlines with `American` counted twice |
| `eac54add` | 5 of 12 | 23,872 | the surrounding activity instead of the contract |
| `gpt4_8279ba03` | 5 of 6 | 23,894 | `No kitchen appliance purchase is mentioned in the evidence.` |

Every one of the 127 sits between 22,886 and 23,341 characters. The route is not under-filled because
the sessions are short; it is under-filled because the table says 24,000 and the allocator spends to
the number.

## 2. Why this is not the experiment `§13.177` already ran

`§13.177` raised `maxPromptChars` from 48,000 to 96,000 **as a scalar**, and read:
`MR` 89 → 87, `TR` **+12**, `KU` **64 → 56**, overall 417 → 420 at 1.618× the prompt tokens. It was
reverted, and `docs/FAILURE-ANATOMY.md` §3 records why the revert was right: a scalar forces every
route to accept both sides of the swap it creates.

The per-route table (`maxPromptCharsByRoute`) is the instrument that separates them, and it already
exists — this dispatch moves **one key**. `temporal` is the route that `§13.177` bought twelve
questions on, the twelve questions are the whole of the positive side of that run, and no dispatch has
ever aimed at them alone.

The `KU` mechanism in `§13.177.2` is also why this is the right route and not that one: a larger
window admits more low-value turns, and `knowledge-update` is the capability whose answer depends on
*which* of two contradictory turns is in the window. Leaving `knowledge-update: 24000` untouched is
not an omission to be tidied later; it is the control that makes the `TR` reading attributable.

## 3. The treatment, stated as bytes

| route | before | after | moves? |
| --- | ---: | ---: | --- |
| `temporal` | 24,000 | **48,000** | yes |
| `multi-session` | 48,460 | 48,460 | no |
| `flat` | 24,000 | 24,000 | no |
| `knowledge-update` | 24,000 | 24,000 | no |
| `assistant` | 24,000 | 24,000 | no |
| `abstention` | 24,000 | 24,000 | no |

`maxTurnChars` stays `400` on `multi-session,temporal`, so the unit being bought is *more turns*, not
longer ones: at 232 characters per delivered turn, 24,000 characters is ~100 turns and 48,000 is ~200.
`TR`'s sessions carry 96–115 delivered turns today, so the larger room is enough to reach the turns
the gap table names without changing the per-turn truncation.

## 4. What the dispatch has to show

Four criteria, fixed before the run, and the first two are the ones that decide.

| id | claim | threshold | why this threshold |
| --- | --- | --- | --- |
| **C1** reach | the five routes outside `temporal` read byte-identical prompts | 373 of 373 identical digests, and `TR`'s median `promptChars` rises above 40,000 | an ask that claims a treatment it does not administer publishes a delta about nothing; a `TR` median that does not move means the allocator did not spend the budget |
| **C2** conversion | `TR` correct rises | **≥ 125 of 127**, paired by question against `S16` | the gap table names 5 winnable questions at gap ≤ 2; 125 is +5 and it is the count the population can pay |
| **C3** cost | bounded | `TR` prompt tokens ≤ **2.2×** its own, roster ≤ **1.25×** | 25% of the roster doubling is 1.25× overall; anything above that is the budget leaking into routes C1 says did not move |
| **C4** guard | the four untouched capabilities hold | `IE ≥ 137`, `MR ≥ 102`, `KU ≥ 67`, `ABS = 30`, each paired | a `TR` gain bought with `KU` questions would be `§13.177` again, one route smaller |

**The decisive one is C2 read as a pair, not as a mean.** `§13.143.2` measured four passes of one
configuration spanning six questions on `MR`; `TR`'s own four-pass spread in the archived arm has not
been measured at this load, so the pairing is what makes a five-question move visible. The readout is
`readout-arm-run.py --attribution`, and the arm under test declares `capability=TR`.

## 5. The dispatch

`benchmark-cortex-memory.yml` at the commit that carries this file, with the twenty-two inputs of
`S16` restated explicitly and exactly one changed:

| input | value | why |
| --- | --- | --- |
| `cortex_memory_max_prompt_chars` | `abstention:24000,assistant:24000,flat:24000,knowledge-update:24000,multi-session:48460,temporal:48000` | the treatment, one key |
| `capability` | `TR` | the population is the route the key moves; the other four cannot move under C1 |
| `limit` | `0` | full file |
| `ablation_runs` | `4` | the archived control's scale |
| every other input | `S16`'s | unchanged, and stated rather than defaulted |

`S16`'s own dispatch left two inputs to their defaults — `embedding_batch_interval_ms` (`0`, unpaced)
and `cortex_memory_session_budget` (empty) — so the table above has twenty-two rows rather than the
twenty-one `PREREGISTRATION-PREFERENCE-ROUTE.md` §5 counted. They are defaults on both sides here, so
they are the same on both sides; the count is corrected rather than the values changed.

Cost: `127 questions × 4 repetitions = 508` reader calls plus 508 judge calls, at roughly twice `TR`'s
archived prompt tokens per question — **≈ 1.9 M prompt tokens**, about 1.25× of what the same population
costs today, and bounded by C3.

## 6. Decision rules

| outcome | verdict |
| --- | --- |
| C1 holds **and** C2 ≥ 125 **and** C3 holds **and** C4 holds | **adopt** `temporal: 48000` in the shipped per-route table, and file the reading against `S`-series acceptance |
| C1 holds, C2 between 121 and 124, C3 and C4 hold | **keep as a cost-accuracy trade**, recorded but not adopted: five questions is the number the population can pay and four is inside `TR`'s own spread |
| C1 holds, C2 ≤ 120 | **revert**: the room is not the mechanism on `TR` either, and `§13.177`'s +12 is a property of that run's ranking rather than of the route |
| C1 fails | **stop**: the per-route table did not take effect, which is an allocator or plumbing defect and not a result about the budget |
| C4 fails | **revert regardless of C2**: a route-scoped raise that moves another route is not route-scoped |

## 7. What this file deliberately does not do

- **It does not touch `MR`.** `MR`'s failure population is the opposite one — 15 of 19 wrong answers
  have every gold turn delivered — and `docs/FAILURE-ANATOMY.md` §2 records four spent asks on it.
  Aiming a window at `MR` would be aiming the wrong instrument at a population that already has the
  evidence.
- **It does not raise `flat` or `knowledge-update`.** `§13.177` read `IE` at +1 question on a 4×
  budget, and `KU` at −8. Both readings stand until a mechanism other than a window is proposed.
- **It does not add an input.** The workflow declares 24 of GitHub's 25-input ceiling and
  `tools/__tests__/test_dispatch_inputs.py` forbids sitting at it; the per-route table already
  expresses this treatment, which is why the change is a value rather than a surface.
- **It does not re-derive the `TR` threshold from this run.** 125 is written here, before the
  dispatch, at the count the gap table names. A threshold read off the result would be a fit.

## 8. Outcome: the budget landed and bought one question

Run `45323303194`, `capability=TR`, `temporal: 48000`, the other twenty-one inputs as §5 fixes them,
dispatched through `tools/dispatch-cortex-memory-ab.py` at `205b8f65`. It completed `success` in 27
minutes and the registration gate passed with two declared departures (`capability`,
`cortex_memory_max_prompt_chars`).

| claim | threshold | measured | verdict |
| --- | --- | --- | --- |
| **C1** reach | `TR` median `promptChars` rises above 40,000 | **23,207 → 47,192**; delivered turns **98 → 207**; delivered characters **23,899 → 47,890** | **the mechanism is real** |
| **C2** conversion | `TR` ≥ **125 of 127** | **121 of 127** (four-pass mean 94.69% against 94.49%) | **met? no — 4 questions short** |
| **C3** cost | `TR` ≤ 2.2× its own characters | delivered characters **2.00×**, prompt tokens per question **12,793.5** | at the ceiling, not over it |
| **C4** guard | `IE/MR/KU/ABS` hold | **not measurable on this dispatch** | see §8.2 |

### 8.1 The paired reading, and the four questions whose gap reached zero

| | n |
| --- | ---: |
| `TR` questions paired | 127 |
| correct, archive → this run | 120 → **121** |
| bought | **3** (`gpt4_59149c78`, `gpt4_7abb270c`, `gpt4_8279ba03`) |
| sold | **2** (`0bc8ad93`, `9a707b81`) |
| net | **+1 question** |

That is the whole effect: one question, at twice the delivered characters. And the interesting
reading is not the net, it is which of the seven failures the budget reached:

| question | gap `total − carried` | correct | what the reply says now |
| --- | --- | --- | --- |
| `gpt4_59149c78` | 1 → **0** | 0 → **1** | the museum the gold names |
| `gpt4_7abb270c` | 2 → **0** | 0 → **1** | the four museums, in order |
| `370a8ff4` | 2 → **0** | 0 → 0 | still a date, for a gold of `15` |
| `gpt4_f420262c` | 2 → **0** | 0 → 0 | still counts `American` twice |
| `gpt4_7f6b06db` | 2 → 1 | 0 → 0 | still the wrong outing |
| `gpt4_8279ba03` | 5 → 1 | 0 → **1** | the appliance instead of the refusal |
| `eac54add` | 5 → 2 | 0 → 0 | still the surrounding activity |

**Two of the four questions whose evidence went from incomplete to complete converted.** The other
two did not, and neither is a delivery problem any more: `370a8ff4` answers a **year** where the gold
is the count `15`, and `gpt4_f420262c` lists the right four airlines with one of them counted twice.
Handing them the missing turn cannot fix either, and this dispatch is the first *causal* evidence for
what `docs/FAILURE-ANATOMY.md` §1 could only infer from the population.

It also prices that document's `TR` headroom. §1 printed **+7.0** as the questions a window repair
would win if partial were lifted to full, and stated at the time that it is an assumption and not a
measurement. The measurement is **+1**. The assumption was seven times too large, which is exactly
the error the tool prints the number to prevent.

The two sold questions are two different things and the difference matters:

- **`0bc8ad93`** ("did I visit with a friend or not", gold `No`) answered **correctly** on 91 turns and
  **wrongly** on 213: the extra evidence contains a friend, so the reader said `Yes`. More evidence
  moved a correct answer to an incorrect one, which is the `KU` mechanism of §13.177.2 appearing on a
  route that is not `knowledge-update`.
- **`9a707b81`** answers `26 days ago` in both arms and is graded correct in one and incorrect in the
  other. That is the judge, not the reader, and it is the second time this campaign has had to read a
  one-question movement through that noise.

### 8.2 Two criteria this dispatch could not read, and why they were written anyway

**C1's byte-level half and C4 are not measurable on a `capability=TR` dispatch.** The other four
capabilities were not run, so "the five routes outside `temporal` read byte-identical prompts" has no
records to compare and "`IE/MR/KU/ABS` hold" has no population. What the run does establish is the
mechanism — the budget reached the route and doubled the delivered characters — and what would
establish the rest is the same treatment at `capability=all`.

That is a defect in the registration rather than in the run: §4 wrote two criteria for a dispatch §5
could not administer. The next registration of this shape states its reach criterion as *"the budget
reached `temporal` and no other route's key moved in the artifact"*, which this artifact does answer,
and reserves the byte comparison for a full-roster dispatch. Writing that down here, after the
reading, is the honest place for it — a pre-registration edited at this point would not be one.

### 8.3 Decision

**Not adopted.** C2 fails at 121 against the registered 125, and the four-pass means differ by a
quarter of a question (94.69% against 94.49%) at **twice the delivered characters** and 12,793 prompt
tokens per question against the roster's 7,447.8. §6's middle row said "keep as a cost-accuracy trade"
for 121–124; that row was written believing four questions could be bought at a price worth paying,
and the measured price of one question is 2.0× the characters, so the row's own condition is not
satisfied either.

`temporal` stays at 24,000. The registration's value is the causal reading in §8.1, not a shipped
change: it converts "the remaining `TR` failures might be a window problem" into "two of them were,
and two of them are not", and it prices the population's headroom at +1 instead of +7.
