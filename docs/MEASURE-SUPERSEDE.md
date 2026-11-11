# The supersession pass failed, and the reason is two of its own rules

**Read from:** `42976296380` (the `supersede` arm, 500 questions × 4 repetitions, completed 08:30Z, 08:30 of
runner time) against `42533236864` (its control, same dataset, same job, byte-identical prompt on every route but
`KU`).

**Cost:** 14.26 CNY dispatched, ~3.9% more provider calls than the control (5,936 against 5,707).

## 0. One paragraph

`K1` **fails**: **1 of 8** of the control's stable `KU` failures converted (the bar was six), with three damages on
the column, and on the eight questions the pass actually touched it repaired two and damaged two — a coin flip at
`p = 1.0`. The mechanism is inert and stays off by default. But this is not a null result, because the census and
the artifact together locate the failure precisely, and it is **not** in the premise: the correction was in the
window for 72 of 72 questions (`MEASURE-STALE-EXPOSURE.md`), the guard never saw a fabricated quote (zero
`no-quote`, zero `not-in-evidence`, zero `date-not-on-line`), and every one of the ten questions the reader did
identify was identified **correctly** — span in the evidence, date on the same line. The failure is in two rules I
wrote: an instruction that told the reader a wrong `yes` is worse than a wrong `no` (it answered `no` on 62 of 72),
and a quote ceiling meant to stop a sentence from being substituted (it refused 6 of the 10 correct identifications
on length alone, two of them gate targets).

## 1. The gates

| # | verdict | reading |
| --- | --- | --- |
| `K1` | **fails** | 1/8 converted (bar 6), 3 regressions on the `KU` column — exact `p = 1.0`, flip-floor `p = 0.187` |
| `K2` | holds | no other capability outside its own 2 sd |
| `K3` | holds | 0 non-`KU` `promptDigest` differences |
| `K4` | holds | replaced 19, refused 269 — the pass fired and the guard fired |
| `K5` | holds | prompt **+6.6%**, completion **+1.8%** |

`K4` and `K5` are the interesting passes: the mechanism ran on every `KU` question (288 consultations, four
repetitions of 72), it substituted 19 times, and it cost almost nothing because the second call shares a
byte-identical evidence prefix — 21.77M of 22.92M prompt tokens were cache hits.

## 2. Where the movement came from

| population | n | repairs | damages | net |
| --- | ---: | ---: | ---: | ---: |
| questions the pass touched (≥1 replacement) | 8 | 2 | 2 | 0.00 |
| questions it did not touch | 64 | 1 | 1 | 0.00 |

The one repair and one damage among the untouched are the flip floor: 4.1% of 72 questions is three, and this is
two. So **the entire net effect of the pass is a wash on its own population**, and the column-level `+0.35` points
is the arithmetic of two coin flips.

Per question, on the eight it touched:

| question | control | treatment | replacements |
| --- | ---: | ---: | ---: |
| `830ce83f` | 1.00 | 1.00 | 4 |
| `2698e78f` | 1.00 | 1.00 | 4 |
| `9bbe84a2` | 1.00 | **0.25** | 3 |
| `4b24c848` | 1.00 | 1.00 | 2 |
| `852ce960` | 0.50 | **1.00** | 2 |
| `a1eacc2a` | 0.00 | **0.50** | 2 |
| `031748ae` | 1.00 | **0.75** | 1 |
| `e493bb7c` | 1.00 | 1.00 | 1 |

## 3. The census

```
attempted 288   replaced 19   refused 269
refusals: no-change 242, too-long 27, no-quote 0, agrees 0,
          not-in-evidence 0, date-not-on-line 0, unreadable 0
```

`19 + 269 = 288` — the identity holds, and it is the first time this campaign has read a pass's own guard as a
*measurement of the reader* rather than as a bookkeeping check. Three of its four checks never fired: the reader
never invented a span, never quoted one that was not in the evidence, never attached a date from another line. The
fourth — "is there a later version at all" — fired **242 times**.

## 4. Cause one: the instruction argued for the wrong answer

The prompt ends with:

> `CHANGED: no` when the evidence never restates this fact with a different value. **That is the common case and a
> wrong `yes` is worse than a wrong `no`.**

Read against the measurement that mattered — the correction is present in **72 of 72** windows — that sentence is
false about this population, and it was written to be conservative about a cost that the arm had already priced.
The reader obeyed the emphasis: **62 of 72** questions came back `CHANGED: no` in the last repetition's recorded
output, on windows that provably contained a later version of the fact.

This is not a hypothesis about the model's temperament. It is the only way to read 242 `no-change` refusals on a
population where the structural instrument says the correction is in the window every single time.

## 5. Cause two: the ceiling refused the answers that arrived

Ten questions came back `CHANGED: yes`. In all ten the span was a character-for-character substring of the evidence
and the date was on the same line — so all ten reached the length check, and six of them failed it:

| question | first answer | span | ceiling | refused | gate target |
| --- | --- | ---: | ---: | --- | --- |
| `9bbe84a2` | `level 150` | 9 | 20 | no | |
| `2698e78f` | `I see Dr. Smith every week` | 26 | 52 | no | |
| `a1eacc2a` | `seven short stories …` | 35 | 70 | no | ✓ |
| `830ce83f` | `My friend Rachel …` | 62 | 80 | no | |
| `ed4ddc30` | `20 dozen` | 22 | **20** | **yes** | **✓** |
| `a2f3aa27` | `1250` | 29 | **20** | **yes** | **✓** |
| `0ddfec37` | `15` | 75 | **20** | **yes** | |
| `10e09553` | `7` | 36 | **20** | **yes** | |
| `dad224aa` | `7:30 am` | 41 | **20** | **yes** | |
| `7401057b` | `Two free night's stays …` | 80 | **44** | **yes** | |

For the four rows that passed, the artifact's recorded answer **is** the substituted span, so the ceiling shown is
derived from the span itself and those rows are here for completeness rather than as evidence. The six refused rows
are the evidence: for them the answer never changed, so the recorded answer is the first one.

`quoteCeiling = min(80, max(20, 2 × len(first answer)))`. On a four-character answer the ceiling is twenty
characters, and a clause is longer than twenty characters. `ed4ddc30` was refused by **two characters** —
`30 dozen at the moment` against a ceiling of twenty — and `a2f3aa27` was refused while answering
`I think I'm close to 1300 now` against a gold of `1300`.

**So two of the eight gate targets were identified correctly and then thrown away by the guard**, and one of the
eight converted.

The census agrees with the table to within three: six questions refused on length, four repetitions each, is
twenty-four of the twenty-seven `too-long` refusals, and the remaining three are repetitions of questions whose
last recorded output happened to say `no`. `K1` did not fail because the reader could not find the update; it failed because the pass is
built so that finding it is not enough.

## 6. Why the ceiling existed, and why it is the wrong instrument

The ceiling was added for a real defect: an earlier draft let a 47-character sentence replace a four-character
answer, which is a different answer *shape* graded against a value. The repair was to bound the length. The repair
was wrong in kind: the defect is that **the substituted thing should be the value, not the quotation**. A span is
how the reader demonstrates it copied; it is not what should become the answer.

`dad224aa` shows the second face of the same mistake: its span is `I like to wake up at 7:30 am on Saturdays`,
which restates the first answer's own value. A length rule cannot tell a restatement from an update — both are
long, and one of them is not a change at all. Only comparing the **value inside the span** to the first answer can.

## 7. What this does and does not say

- **It does not refute the premise.** The correction is in the window 72/72 and 8/8 of the gate's population. The
  family of mechanisms the pass belongs to is still unrefuted; this member's implementation is refuted.
- **It does not say the reader cannot do the comparison.** Every `CHANGED: yes` was correct. The reader's
  precision on the ten it answered is 10/10 for the two checkable fields, which is the strongest statement any
  increment in this campaign has produced about a reader's ability to audit its own substitution.
- **It does say the pass is inert as built**, and per this campaign's rule a mechanism that moved nothing is not
  enabled. `reviewPass: supersede` stays an experimental mode; nothing ships it.

## 8. The next arm, pre-registered before the fix

Two changes, both mine, both zero-cost to implement, and the same `6/0` bar — one arm, ~14 CNY:

1. **Delete the asymmetry sentence.** The instruction states the question and the output format and says nothing
   about which error is worse. The population fact (the correction is present 72/72) is the reason.
2. **Replace the ceiling with a value rule.** The substituted answer becomes the numeral the span shares with
   nothing in the first answer: the span must contain at least one numeral that the first answer does not, and that
   numeral is what gets substituted. `I think I'm close to 1300 now` then yields `1300`, and `30 dozen at the
   moment` yields `30`. A span with no new numeral is refused as `restates` — a new reason, counted separately,
   because `dad224aa` is not a fabrication and not a length problem.

Registered criterion, unchanged from §13.366.1 in shape: **≥ 6 of the control's 8 stable `KU` failures convert, and
no `KU` regression**. If the two changes together do not clear it, the mechanism is refuted as a member of its
family and the queue moves to `assemble()` — that decision is written here so that a second inert arm cannot be
read as "one more tweak away".

## 9. Reproducing

```
python3 tools/supersede-reading.py \
  --treatment art-42976296380/benchmark-cortex-memory-ablation-report.json \
  --control   art-42533236864/benchmark-cortex-memory-ablation-report.json
python3 tools/stale-exposure.py \
  --artifact art-42533236864/benchmark-cortex-memory-ablation-report.json \
  --dataset data/longmemeval_s_cleaned.json
```

The first prints the five gates and the per-capability table; the second prints the premise the first one's
diagnosis depends on. Neither dispatches anything.

## 10. The amendment, as implemented (registered as §13.370 before dispatch)

§8 registered "the numeral the span shares with nothing in the first answer". Written as a function, that
sentence needed three decisions §8 did not cover, and each one is stated here rather than discovered in the
reading:

| decision | rule | why |
| --- | --- | --- |
| which numeral, when the span carries several | the **last** new one | a span that states two counts states the second about the first — the ordering rule the pass already applies across turns |
| what travels with it | the unit word that follows, unless it is a function word | `30 dozen`, `1300 followers`, `7:30 am`; a graded answer that contains `30` but not `dozen` is not the answer, and the containment judge reads characters |
| what a span with **no** numeral does | substituted whole iff **value-shaped** | `ce6d2d27`'s gold is `Friday` and `9ea5eabc`'s is `Paris`; a numeral-only rule cannot represent either, and two of the gate's eight targets would be structurally unreachable |

The third is an **amendment to §13.369, not a discretionary widening**, and the reason is the failure this whole
document is about: a guard that can eat a known-correct answer *shape* is the defect `42976296380` was lost to.
Value-shaped means three tokens or fewer after the comparison key and no `,` `;` `!` `?` — so `Friday`, `Paris`,
`6:00 pm` and `$3,750` pass, and `I moved it, it is on Friday from now on` does not.

Two consequences that are not refinements but removals:

- **The newline refusal is gone.** It existed because the span became the answer and an answer with a line break is
  malformed. The value is one token of the span, so a wrapped quotation no longer costs a correct identification.
- **`too-long` is gone from the census and `restates` takes its place.** `42976296380` published `too-long 27` and
  could not say whether any of the 27 carried a new value, because the reason was stated about the length of a
  string instead of about the relation between two answers. `dad224aa` — whose span restates its own answer — is
  now countable as what it is.

Nothing else moves: the same three lines, the same substring and same-record date checks, the same `6/0` cell, and
the same stopping rule. The arm's bar is not softened by the amendment; the amendment exists so that the bar can be
reached by a correct answer.

## 11. Correction: one refusal that looked like the guard eating an answer was the guard saving one

§5 and §13.369 count `ed4ddc30` among the six correct identifications the ceiling refused, and §13.369 counts it
among the two that were gate targets. **Both are wrong**, and the dataset says so in four lines:

| fact | source |
| --- | --- |
| gold is `20` | `longmemeval_s_cleaned.json`, `ed4ddc30` |
| `30 dozen at the moment` is at **session 1**, 2023/01/11 | the same record |
| `20 dozen stocked up in the fridge right now` is at **session 40**, 2023/03/15 | the same record |
| the control's answer is `20 dozen`, **correct in all four repetitions** | `42533236864`, per-question roster |

So the span this pass offered was the value the corpus **supersedes**, not the one that supersedes it, and the
ceiling's refusal on that row did not eat a correct identification — it prevented a damage. `20 dozen` was already
right; substituting `30 dozen` would have made it wrong. The remaining five refusals are unchanged by this: the
census records a length, not a direction, so which of them were saves and which were losses cannot be recovered
from `42976296380`'s artifact at all.

**Correction to this section, written after `43001135439` was read (§12.2).** The arm that admitted the spans the
ceiling refused damaged **three** of them (`ed4ddc30`, `0ddfec37`, `10e09553`) and repaired **one** (`a2f3aa27`), so
the ceiling's net on the four that can now be priced was **+2 questions**. The sentence below — "a guard built from
those two checks authorises a substitution in the wrong direction" — is right; the framing above it, that the ceiling
mostly ate correct identifications, was wrong about three of six.

**The reading that survives is sharper and worse for the mechanism.** Every `CHANGED: yes` was correct on both
checkable fields — span in the evidence, date on the same record — and the two fields are **necessary but not
sufficient**: `ed4ddc30`'s span passes both and states the *earlier* value. A guard built from those two checks
authorises a substitution in the wrong direction, and on this question it would have converted a correct answer
into a wrong one.

### 11.1 The hole, and the check that closes it

The instruction asks for "a turn dated **after** the turn the answer came from", and nothing verified the ordering.
§13.371 adds the check: the record carrying the span must be later than the record carrying the answer's own
statement, compared on the stamp (`YYYY/MM/DD (Ddd) HH:MM`, minutes included, because `a2f3aa27`'s two statements
are on the same day). Two cases are deliberately not ordered:

- **the same record**, because two values stated in one turn have an order no stamp records, and refusing there
  would make the guard's reach depend on how the corpus happened to be segmented;
- **an answer whose own statement is not in the evidence**, because a composed answer has no turn to be later than,
  and refusing those would make the guard's reach a property of the answer's phrasing.

Both fail open, and the reason is the asymmetry this document is about: a check that fails closed on a
*composed* answer would refuse substitutions on questions whose evidence never restates the answer's phrasing,
which is most of them.

### 11.2 What this costs the previous arm's reading

Nothing about the gates, and one sentence of the diagnosis. `K1` failed at 1 of 8 for two reasons, and the corrected
statement of the second is: the ceiling refused ten identifications, **at least one of which was a damage avoided
and at least one of which (`a2f3aa27`, `I think I'm close to 1300 now` against a gold of `1300`) was a repair
destroyed**. The first reason — an instruction that argued for `no` on a population where the correction is present
72 of 72 — is untouched, and it is the one the census put 242 answers behind.

The mechanism's own premise is also unchanged: the correction is in the window 72/72. What changed is that the
authorization was missing a third check, and the failure mode that check prevents is not "the pass does nothing" but
"the pass makes a right answer wrong".

## 12. The corrected arm: `K1` fails again, and the ceiling it replaced was right twice as often as it was wrong

**Read from:** `43001135439` (the value rule, 500 × 4, 10:08Z → 11:39Z) against `42533236864` (its control).

| # | verdict | reading |
| --- | --- | --- |
| `K1` | **fails** | **2 of 8** converted (bar 6); the `KU` column carries **4** regressions; exact `p = 1.0` |
| `K2` | holds | no capability outside its own 2 sd (`TR` +0.79, `MR` +0.21, `IE` −0.33, `ABS` 0.00) |
| `K3` | holds | 0 non-`KU` prompt differences |
| `K4` | holds | `replaced 18` / `refused 270`, `18 + 270 = 288` |
| `K5` | holds | prompt **+6.7%**, completion **+0.7%** |

Overall **90.4% (452/500)** against the control's **91.2% (456)** — the arm is **0.8 points worse**, which is the
first time in this campaign a mechanism has moved the total in the wrong direction outside the flip floor.

| prediction | stated | read | verdict |
| --- | --- | --- | --- |
| `P2` | `no-change` < 100 | **213** (was 242) | **fails** — deleting the sentence bought 29 of 288 |
| `P3a` | `restates` ≤ 8, `unreadable` = 0 | **57**, 0 | **fails** |
| `P3b` | every unconverted target consulted | all 6 | holds |
| `P3c` | `replaced` > 19 | **18** | **fails** |

### 12.1 The two conversions and the four damages, named

| question | control | treatment | answer it became | what it is |
| --- | ---: | ---: | --- | --- |
| `a2f3aa27` | 0.00 | **1.00** | `1300` | the repair the ceiling destroyed last round, now 4 of 4 |
| `a1eacc2a` | 0.00 | 0.25 | `Four short stories had been written …` | one repetition — and a **judge** question, see below |
| `ed4ddc30` | 1.00 | **0.00** | `30 dozen` | the direction hole: a correct `20 dozen` replaced by the January value |
| `0ddfec37` | 1.00 | **0.00** | `20 autographed` | a span about a different thing; gold `15` |
| `10e09553` | 1.00 | **0.00** | `9 largemouth` | the same, gold `7` |
| `50635ada` | 1.00 | 0.75 | unchanged | one repetition of four |

**`a1eacc2a` is not a mechanism win.** Its gold is `seven`; the control answered `Four` and was graded **wrong**; this
arm answered `Four short stories had been written since starting to write regularly` and was graded **correct**. The
leading value is the same wrong value in both, so the difference is the judge accepting a longer answer that contains
it. That is a judge-consistency question with a known hazard (the same one `judge-audit.yml` exists for), and counting
it as a conversion would credit the mechanism for a leniency. **Genuine conversions: one.**

### 12.2 The column change is the ceiling being right, and this is the round's real finding

Last round's six length refusals were read as the guard destroying correct identifications. Four of the six are now
measured, because the value rule **admitted** their spans and the answers tell us what they were worth:

| question | last round | this round | reading |
| --- | --- | --- | --- |
| `a2f3aa27` | refused, gold `1300` | **converted to `1300`** | a refusal that **cost** a repair |
| `ed4ddc30` | refused, answer correct | **damaged to `30 dozen`** | a refusal that **prevented** a damage |
| `0ddfec37` | refused, answer `15` correct | **damaged to `20 autographed`** | a refusal that **prevented** a damage |
| `10e09553` | refused, answer `7` correct | **damaged to `9 largemouth`** | a refusal that **prevented** a damage |
| `dad224aa` | refused on length | refused as **`restates`** | the same verdict, now stated about the pair |
| `7401057b` | refused | untouched | unknown |

So the ceiling's net on the four we can now price was **+2 questions**: it prevented three damages and cost one
repair. `§11` said "at least one of the six was a damage avoided"; the measurement says **three**, and the sentence
that called the ceiling an instrument that "ate the answers it was built to accept" was wrong about two thirds of
that population. The reason it looked right is the reason this campaign keeps re-deriving readings: the artifact
records that a substitution was *authorised*, never what it replaced the answer with, so a refused substitution is
invisible until a later arm performs it.

**Instrument gap, registered.** `CortexMemory` already computes `lastReview { first, final, changed }` per question
and the artifact persists none of it. Any future substitution mechanism must persist `final`, or its damages can only
be read one arm later — which is exactly what happened here, at 14 CNY per reading.

### 12.2.1 What the census says, and it is not about the instruction

75 of 288 consultations said `CHANGED: yes`, and of those:

- **18** carried a value the answer did not already have (`replaced`);
- **57** carried numerals the answer already had (`restates`).

So when the reader does answer, three times out of four it quotes the **current** value back. On the other 213 it says
nothing changed, about windows where `MEASURE-STALE-EXPOSURE.md` finds the correction present in 72 of 72.

The previous round attributed this to the instruction's asymmetry sentence. That attribution is now measured and it
was **wrong as a primary cause**: deleting the sentence moved `no-change` from 242 to 213 and `replaced` from 19 to 18.
The behaviour survives its own explanation, which means the failure is in what the reader does with the pair, not in
how the pass asked for it.

### 12.3 The refutation, stated as §13.370 registered it

§13.370's termination condition: *"if those two changes do not clear it, the mechanism is refuted as a member of its
family, and the queue moves to `assemble()` and the reader axis."* Both changes were made; the cell did not clear.
**The supersession family is closed.** Three substitution mechanisms have now been measured on this arm — `tally`
(−9.5 multi-session questions), `spec` (−39), `supersede` (0, then −0.8 overall) — and the family's premise ("the
reader has the evidence and needs the comparison isolated") has been tested in its strongest available form and
failed.

What that does **not** say: that `KU` is unsolvable. The premise holds (the correction is in the window 72/72), and
one question converted at 4 of 4 repetitions, which is proof that the comparison is *possible* on this corpus. What
it says is that asking the same reader, in a second call, to compare two statements it has already read does not
produce the comparison — and the campaign's remaining levers on `KU` are structural (retrieval that puts the two
statements adjacent, or a reader that reasons) rather than another prompt about them.

## 13. The counterfactual: every substitution now ships with the answer it overrode

### 13.1 The gap this closes, priced twice

Run `43001135439` published `replaced 18` beside `refused 270`. The eighteen were unreadable. The record's `answer`
is what the pass **shipped**, so a wrong answer next to a positive count reads identically whether the pass destroyed
a correct answer or replaced one wrong answer with another.

Section 12 recovered the direction by pairing that arm against `42533236864` — a **previous** run's control arm, on
the same 500 questions. That is a second dispatch of the same population, paid for one column, and it worked only
because the earlier artifact happened to exist. A mechanism whose damage is invisible until the next run is a
mechanism whose next reading will be attributed to the wrong change.

### 13.2 What was added, and the four decisions with their counterexamples

| Decision | What it rejects |
| --- | --- |
| `{first, final}` per substitution, not a count | A count says how many and leaves the direction to be re-derived from another artifact |
| A cumulative list on the product, read as a **tail slice** per answer | A slot would report the previous question's substitution on every question after it (§13.145.6's stale beacon) |
| The accessor hands out a **copy** | An array by reference keeps growing underneath a reading that was already recorded |
| The record omits the field when empty | `supersessionReplacements` names the population; an empty list is a third state a reader has to discount |

`first` is the string the route would have returned with the pass switched off on that question. That is the only
counterfactual the mechanism owes, and it is written on the same call that performs the substitution — anything
written later would be a substitution the artifact could report without the text that decided it.

### 13.3 The offline reader, and why its number is a lower bound

`tools/supersede-rewrites.py` classifies each pair by containment: gold in `final` and not in `first` is a
conversion; gold in `first` and not in `final` is a damage; both or neither is neutral.

- A numeral gold is matched with **boundaries**, not as a substring: `20` occurs inside `1200`, and a substring rule
  would score a substitution about a follower count as a conversion on a question about eggs.
- Blind spot one: a string can contain the gold and still be judged wrong — `a1eacc2a` is that shape, and `12.2`
  already records it as a leniency artefact rather than a gain.
- Blind spot two: a string can be judged right without containing the gold. Both blind spots push toward `neutral`,
  so `conversion - damage` is a lower bound and the tool says so rather than calling it a net.

It refuses three states in which a rate would be about the instrument rather than the run: no record carrying the
field (every artifact before this change), pairs that do not sum to the record's own `supersessionReplacements`, and
a record with pairs and no count. On `43001135439` it answers `not scorable`, which is the correct reading of a run
that predates the field.

### 13.4 What this does *not* reopen

The family stays closed. Section 12's `K1` failure stands, and the direction instrument does not change a score — it
changes what a future score can be attributed to. The next arm on `KU` is the structural one §12 names: put the two
statements in one unit, at read time, because this corpus has no write path. That arm must move **position** and not
wording, or it prices two variables at once.
