# The prompt room: one quantity, two spellings, and the characters a prefix throws away

Requirement 8 asks whether the tokens are earned. This audits the *denominator* of that question: how big the
prompt is allowed to be, how much of the allowance is evidence, and how much of it is neither spent nor
available.

Three numbers frame it, all from `42355323615` (500 questions, four repetitions, `cortex-memory` arm):

| | |
| --- | --- |
| median prompt | 47,830 of 48,460 characters -- **98.70% of the room** |
| median evidence inside it | 46,926 characters = **11,558 tokens**; the instruction block is **1.41%** of the prompt |
| median room left unspent | **630 characters**, and **1,247** on the extraction route with an 11,533-character worst case |

The first two say the prompt is almost entirely evidence and almost exactly as large as it is allowed to be. The
third says the allowance is not fully reachable, and that is where the rest of this document goes.

## 1. A capped run that read as uncapped

`42355323615` was dispatched with `cortex_memory_max_prompt_chars=multi-session:48460`. That input carries two
grammars -- digits are a scalar, anything with a colon is a route map -- and this value took the second branch.
So the artifact recorded:

```json
"maxPromptCharsByRoute": { "multi-session": 48460 }
```

and no `maxPromptChars`. Five routes then took the product default. `tools/cost-ledger.py` read the scalar
field, found nothing, and reported **no room** -- on a run that had filled 98.7% of one.

The same artifact produced the finding in `PREREGISTRATION` §13.298.3, where the registration gate printed
`declared but unchanged: ['cortex_memory_max_prompt_chars'] -- the departure names a field this run did not
move`. One root cause, two instruments, blind in the same direction: **a quantity with two spellings where only
one is read.**

There was a third reader with the same blind spot, and it is the one that makes the other two unsurvivable: four
docstrings in `cortex-eval` still said the product default was **24,000**, including the docstring on the field
that records the room. `DEFAULT_MAX_PROMPT_CHARS` has been 48,000 since §13.82. So an artifact's absence was
readable as 24,000 or as 48,000 depending on which comment the reader trusted, a factor of two, and the number
that would have settled it was nowhere in the file.

## 2. The repair, and why it is one function

`memoryArmConfig.effectivePromptChars` records the room each of the six routes assembled under, always:

```
byRoute[route] ?? maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS
```

It is the only computed field in that block, and the reason is that the third term is not in the artifact. The
two request fields say what was asked for; this one says what the prompt was built under.

Both cost instruments resolve through one function (`prompt_rooms`) rather than each parsing the block, because
the failure being repaired was two readers disagreeing about one quantity.

| source field | what it means | how the fill is read |
| --- | --- | --- |
| `effectivePromptChars` | resolved, per route | at the **narrowest** room -- filling it fills every route |
| `maxPromptChars` | one scalar, every route | at that room |
| `maxPromptCharsByRoute` | a redistribution, and the rest unrecorded | at the **widest named** room, and printed as a *ceiling*, because the unnamed routes took a default this artifact does not state |

The narrowest-versus-widest asymmetry is not pedantry. `per_call` is one mean over routes that may have
different rooms, so "the window filled" is only well defined one-sidedly: testing the mean lets a run that
deepened one route and starved another read full, and testing the widest lets the reverse pass.

`PROMPT_ROOM_DEFAULT` in `cortex-eval` mirrors the product constant because the dependency arrow does not allow
an import. Two tests keep the copy honest: a comparison against the product's constant, and a scan that fails
on any present-tense claim that the default is 24,000. The scan was verified by restoring the phrase in
`report.ts` and watching it name the file and line.

## 3. The instrument, and the density it measures rather than assumes

`tools/evidence-budget.py` reads `questions[]` -- where `promptChars` is the evidence the prompt carried and
`deliveredPromptChars` is the whole prompt -- and reports the median of each.

The characters-to-tokens factor is **measured** from the same artifact: mean delivered characters per call over
`promptTokens / calls`. On `42355323615` that is 47,542 over 11,721 = **4.06**. §13.293.2 had derived 4.11 from
`48000 / 11690`, a ratio of the cap to a mean, which is an inference; the two agree to 1.2%, and the agreement
is what makes the inference usable rather than merely plausible.

The tool refuses to convert outside 2.5-6.0 characters per token, and the refusal exists because the first
draft printed **0.98**: it divided the character side, which covers one repetition, into the token side, which
covers four. Nothing about 0.98 announces itself -- it is a plausible density for a short-token dataset -- and
every median below it would have been converted 4.14x wrong. That is the third appearance of this campaign's
recurring defect, and the first one caught before it shipped.

## 4. The characters a prefix throws away

`chooseEvidence` takes the **largest prefix of the relevance order that fits**. A turn larger than the remaining
room ends the selection rather than being skipped past, which is a deliberate choice with a stated cost
(`prompt.ts`: "a turn larger than the whole room ends the selection instead of being skipped past"). The cost
has never been priced. Median unspent room, by capability:

| capability | median | worst | per-turn width capped at 400 |
| --- | ---: | ---: | --- |
| MR | **126** | 386 | yes |
| TR | 610 | 852 | yes |
| ABS | 884 | 4,363 | no |
| KU | 974 | 3,491 | no |
| IE | **1,247** | **11,533** | no |

`cortex_memory_max_turn_chars_routes` is `multi-session,temporal`, so two of six routes truncate a turn at 400
characters and four do not. The capped routes leave the least room unspent -- MR, alone, leaves less than one
turn's width -- and the four uncapped routes leave 7x to 10x as much, with one extraction question abandoning
**24% of its window** because a single over-sized turn blocked the prefix.

The reading is that **`maxTurnChars` has a second channel**: it does not only truncate a turn, it makes a turn
that fits, and therefore decides how far the prefix advances. §13.80 measured the first channel and concluded
the room cannot be bought by truncating; nothing in this campaign has stated the second.

### What is not claimed

- **That freeing the room raises accuracy.** §13.291 delivered every gold turn on `MR` -- 98 of 121 questions
  raised to 120 of 121 -- for **+0.00 accuracy points**. Evidence volume is not what the missing points are
  made of, so the predicted effect here is a *coverage* effect, and the accuracy effect is predicted to be below
  the noise floor (1.6-2.2 points).
- **That TR belongs in either group.** It is capped and still leaves 610 characters, which the extra
  non-evidence the temporal block carries would explain. The doc records the fact and not the explanation.
- **That 630 characters is reachable.** Unspent room is bounded by the next turn's size, and the next turn's
  size is not in the artifact. A run with a wider record would be needed to say what the prefix would have
  taken.

## 5. What this changed, and what it did not

| | before | after |
| --- | --- | --- |
| `cap_reading` on a route-map run | `None` (uncapped) | `at-cap`, with the basis and a ceiling caveat |
| the default the artifact states | absent, and 24,000 or 48,000 depending on the comment | `effectivePromptChars`, per route, always |
| `C2`'s source | `unrun`, reason: no tool produces a median | `artifact`, ratio 1.0000, `paired: false` |
| `C2`'s reading | — | **100.0%** against ≤70.0% -- a denominator, not a result |
| acceptance rows | 27: pass 15 / accept 1 / aim 4 / unrun 7 | **27: pass 15 / accept 1 / aim 5 / unrun 6** |
| `C1` | 12,105 from `42310779222` | **12,137** from `42355323615` |
| a hard-coded figure in a test | `12105`, so regenerating the evidence turned it red | the relationship, so it cannot |

The row that moved most is not the row with the new number. `C2` went from "no instrument" to "instrument,
denominator, named arm", and it has not moved at all on the quantity it measures: a ratio of one is the
registered budget measured against itself.

## 6. The negative reading that a redistribution fakes (`43264749133`)

§5 closed this file on `cap_reading` returning `at-cap` with a stated basis, and the repair was correct for the
direction it was written for. It has a second direction, and that one was wrong.

The quotient the ledger tests is `room / (promptTokens / calls)`, and on a run with more than one room the
numerator is **one route's** room while the denominator is a mean **across** routes. So for a delivery that filled
every route,

```
implied = density * narrowest / mean_room
```

`43264749133` assembles under `{multi-session: 48,460, temporal: 48,000, flat: 24,000, knowledge-update: 24,000,
abstention: 24,000, assistant: 24,000}`. 143 of its 200 question-runs are on the 24,000 routes, so `mean_room` is
30,971 and a delivery at 4.15 characters per token with **nothing unspent** scores `4.15 × 24,000 / 30,971 = 3.22`,
outside the 3.5–4.7 band. The ledger printed `below-cap` at 3.29 — a verdict of "the window did not fill" on an
artifact whose own `tools/evidence-budget.py` reading is **99.0% median utilisation, 235 characters unspent**.

The bias is not one-sided. A *high* quotient on a redistribution says the mean prompt is small, which is equally
consistent with every route sitting under its own room. So the band test means nothing on unequal rooms in either
direction.

| | before | after |
| --- | --- | --- |
| rooms equal, quotient in band | `at-cap` | `at-cap` |
| rooms equal, quotient outside | `below-cap` | `below-cap` |
| rooms spanning 24,000–48,460, quotient 3.29 | **`below-cap`** — false, the window is 99% full | **`indeterminate`**, with the spread and the reason |
| rooms 48,000 against 48,460 (1% spread) | `at-cap` | `at-cap` — a spread below the band's own width cannot move a full delivery out of it |
| the instrument that can answer | unstated | named: utilisation per question against the resolved room |

The threshold is `narrowest / widest ≥ low / midpoint`, i.e. the rooms must sit within the band's own 15% for the
quotient to be a fill measurement at all. Testing the *lower bound* `narrowest / widest` (rather than the true
`narrowest / mean_room`, which needs per-route question counts the artifact does not carry) withholds the reading
on a few runs where it would have been fine. That is the direction that costs nothing: `indeterminate` is
refusable in one command by the tool that measures the thing directly, while a false `below-cap` is refuted only
by reading two tools and noticing they disagree — which is how this one was found.

**Why this is worth a section.** `C6`'s verdict in `MEASURE-WIDTH-PLAN.md` §7 rests on "the cap is not in the
quantity being measured". A tool that reports the cap as unfilled when it is full makes that sentence unavailable
in exactly the runs where a redistribution is under test — the ones where the room is being moved on purpose.
