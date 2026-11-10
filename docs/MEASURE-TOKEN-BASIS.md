# MEASURE — What each cost number counts, and the 2.8% that settled the argument

## 0. One paragraph

Every cost claim this repository made about a competitor divided two numbers that counted different
things, and the last one of them was published in round 58 as **1.31x against Synap** and **1.40x
against Mem0**. The natural repair is a sentence saying so, and §13.340.3 already tried that once: it
retracted a 1.64x and published "~1.0x all-in", and the mixed ratio came back a round later wearing a
different competitor's name. So this round does it as arithmetic instead. The prompt is divided into
the part a competitor's number also counts and the part it does not — **97.18% of this arm's prompt
is evidence**, so the basis error was worth 2.8% and not the 24% the mixed rows implied — and the
division is committed as a projection that `pnpm check` re-derives, with every document quoting a
ratio through a marker that the same check verifies. Three rows keep pointing the same way, one
changes direction (Synap), and **the efficiency claim does not become true: on the only basis where
all five competitors can be placed, this arm is 1.21x to 3.19x dearer.**

## 1. This arm's bill, divided

`42533236864` — the registered configuration, 500 questions, four repetitions, 91.05%
([`MEASURE-CONFIGURATION-IDENTITY.md`](MEASURE-CONFIGURATION-IDENTITY.md) explains why this run and
not its predecessor is the one to divide).

| quantity                            |               value | what it is                                                   |
| ----------------------------------- | ------------------: | ------------------------------------------------------------ |
| prompt tokens per question          | <!-- token-figure:cortex/prompt -->9,201 | everything the reader is handed                |
| evidence tokens per question        | <!-- token-figure:cortex/context -->8,941 | the retrieved evidence alone                  |
| overhead tokens per question        |                 260 | instructions, session header, question                       |
| evidence share                      |              97.18% | `meanEvidenceChars / meanPromptChars`                        |
| mean prompt characters              |              35,447 | per question, all four repetitions                           |
| mean evidence characters            |              34,447 | `AssembledPrompt.evidenceChars`, already recorded per record |
| characters per token                |             3.8528 | measured on this run, not assumed                            |

The two per-question numbers are the same measurement under two names, and which one is "the" cost
depends on who is asking. A memory system publishes the second, because it is what the memory layer
controls. A buyer pays the first, because the instructions and the question are billed too. `basis`
in the ledger has exactly those two values for that reason, and a ratio across them is not a ratio.

The decomposition is proportional rather than a second measurement: the artifact records characters
per question and tokens per run, so the split is taken at the run's own measured 3.8528
characters-per-token. It is committed as those three primitives, and `evidenceTokens` is a derived
field that `--check` recomputes — which is what makes a hand edit of the derived number fail.

### 1.1 The overhead is not the lever, and that is the first finding

2.8% is the whole of the basis question. There is no 24% hiding in the instructions; the prompt is
evidence, and the cost of a correct answer is the cost of the evidence. So the two facts that
already existed in this repository — the room is filled to 98.4% of its cap, and 63.5% of the
delivered characters are turns no relevance signal ever scored ([`MEASURE-COST-LEVER.md`](MEASURE-COST-LEVER.md)
§1) — are the only two that can move the number, and neither is a prompt-engineering question.

| capability |  n | evidence chars | prompt chars | evidence share | room  | room used |
| ---------- | -: | -------------: | -----------: | -------------: | ----: | --------: |
| `IE`       | 150 |        22,476 |       22,981 |         97.8% | 24,000 |     95.8% |
| `MR`       | 121 |        46,096 |       48,311 |         95.4% | 48,460 |  **99.7%** |
| `KU`       |  72 |        22,483 |       23,084 |         97.4% | 24,000 |     96.2% |
| `TR`       | 127 |        47,145 |       47,841 |         98.5% | 48,000 |  **99.7%** |
| `ABS`      |  30 |        22,276 |       23,099 |         96.4% | 24,000 |     96.2% |

`MR` and `TR` sit against their cap to within 0.3%, which is the direct evidence for the sentence
`MEASURE-COST-LEVER.md` §1 states from one run's `windowComposition`: **the cost is the cap, not the
selection.** A ranker that got better at choosing would change *what* fills the room and would not
change the bill by one token.

## 2. The table, on both bases

Five competitors publish a token figure. Their row, this arm's figure **on their basis**, and the
per-correct-answer axis computed with the accuracy multiplier applied to **both** sides:

| id                     | basis   | their tokens | ours  | ratio | per-correct | caveat |
| ---------------------- | ------- | -----------: | ----: | ----: | ----------: | ------ |
| `contextier-context`   | context | <!-- token-figure:contextier-context -->2,807 | 8,941 | <!-- token-ratio:contextier-context -->3.19x | <!-- token-ratio:contextier-context@correct -->3.20x | counted under o200k, this arm under the reader's own |
| `mem0-v3-context`      | context | <!-- token-figure:mem0-v3-context -->6,787 | 8,941 | <!-- token-ratio:mem0-v3-context -->1.32x | <!-- token-ratio:mem0-v3-context@correct -->1.35x | tokenizer undeclared |
| `mem0-apr2026-context` | context | <!-- token-figure:mem0-apr2026-context -->6,800 | 8,941 | <!-- token-ratio:mem0-apr2026-context -->1.31x | <!-- token-ratio:mem0-apr2026-context@correct -->1.36x | tokenizer undeclared |
| `synap-context`        | context | <!-- token-figure:synap-context -->7,400 | 8,941 | <!-- token-ratio:synap-context -->1.21x | <!-- token-ratio:synap-context@correct -->1.27x | tokenizer undeclared; content-only |
| `zep-context`          | context | <!-- token-figure:zep-context -->4,408 | 8,941 | <!-- token-ratio:zep-context -->2.03x | <!-- token-ratio:zep-context@correct -->2.01x | theirs is a median, ours a mean |
| `synap-allin`          | prompt  | <!-- token-figure:synap-allin -->13,400 | 9,201 | <!-- token-ratio:synap-allin -->0.69x | <!-- token-ratio:synap-allin@correct -->0.72x | our recomputation, not their number |

Two things are visible in that table and only one of them is about us.

1. **On the context basis this arm is dearer than all five**, by 1.21x to 3.19x. The efficiency claim
   in `SOTA-LANDSCAPE.md` does not survive, and re-basing did not rescue it: 8,941 against 2,807 is
   3.19x, which is the same order as the 3.28x the uncorrected pair printed.
2. **On the prompt basis there is exactly one comparison available**, and it is the one competitor
   whose all-in count this repository measured rather than read: `synap-allin` is ≈13,400 and we are
   0.69x of it. That row is `kind: ours` in the ledger, and the tool prints the provenance beside the
   number because a recomputation of somebody else's prompt is not their published figure.

**The honest summary is a split verdict, not a ranking.** We are cheaper than the only competitor
whose full prompt anyone has measured, and dearer than every competitor's own published content
count. Both are true; which one a buyer believes depends on whether the omitted instructions are real
cost, and they are. What keeps this from being self-serving is that the split is stated as a split,
with the basis named on every row, rather than resolved in whichever direction the round needed.

## 3. What the basis error was worth, exactly

The retracted values, next to the corrected ones on the same competitor:

| claim as published in round 58 | numerator | denominator | corrected, one basis |
| ------------------------------ | --------- | ----------- | -------------------- |
| "10,105 against 7,740 = 1.31x" | prompt per correct | context per correct | 1.27x (context) / 0.72x (prompt) |
| "10,105 against 7,203 = 1.40x" | prompt per correct | context per correct | 1.36x (context) |
| "9,201 against 7,400 = 1.24x"  | prompt per question | context per question | 1.21x (context) |

The sizes barely move and the direction of one does. That is worth stating plainly, because the
temptation with a correction like this is to present it as a discovery that changes everything: it
does not. **The arithmetic was wrong by 2–5%, and the conclusion it supported was wrong because it
was a quotient of two different quantities, not because the numerator was stale.** A 24% error would
have been a scandal; a 3% error in the wrong unit is the ordinary kind, and it is the kind that
survives because no gate recomputes it.

## 4. The distance to Contextier, in the unit that decides it

`contextier-context` is the row that matters, because it is the only competitor whose configuration is
both cheaper and higher-scoring: **91.6% at 2,807**, against this arm's 91.05% at 8,941 evidence
tokens. Matching their bill means delivering 34,447 → ≈10,800 characters of evidence per question, a
**0.31x cut**, and the room curve in [`MEASURE-COST-LEVER.md`](MEASURE-COST-LEVER.md) §2 measures what
cuts cost: 0.463x costs 2.65 points, 0.25x costs 3.04.

Interpolating those two measured points puts 0.31x at about **−2.9 points**, i.e. ≈88.2% at their
cost. Their configuration reads 91.6% there. So the 3.3-point gap at equal cost is **not a room we
have not tried** — it is a different pipeline, and no setting of `maxPromptCharsByRoute` reaches it.

That is an interpolation across a measured range and it is labelled as one; it is not a dispatch and
it is not evidence that they achieve what they publish (their figure is `kind: self`, with no
answer model and no judge stated, which is the same caveat `MEASURE-COST-LEVER.md` §3 prices at 38.4
points for Mem0). What it does establish is negative and useful: **the remaining efficiency gap is
architectural, so the next mechanism has to be a selection or extraction change and not a budget
change.** It is the first time that sentence has arithmetic behind it.

## 5. The gate

`tools/token-basis.py`:

| mode                 | what it does                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `--artifact … --run … --write` | projects one artifact onto the two bases and records `tools/token-basis.json`      |
| `--check`            | re-derives the partition and every ratio from the committed primitives plus the ledger, **without the artifact**, and refuses a drift |
| `--check` (docs)     | verifies every `<!-- token-ratio:… -->` and `<!-- token-figure:… -->` marker in `docs/*.md` against those rows |

`pnpm check` runs `token:check` immediately after `registration:check`, and the pairing is deliberate:
`registration:check` refuses a bill measured on a configuration the arm no longer runs, and
`token:check` refuses a ratio whose two sides do not count the same thing. The first defect class was
found in round 57 and the second in round 58; both were found by a person reading two records against
each other, and both are now arithmetic.

The ledger grew a `cost` block with six required fields, and the rule is the one it already applied to
`score`: **a number without its conditions is not evidence.** `basis`, `statistic`, `tokenizer` and
`source` are conditions here, and a cost block missing any of them is refused rather than defaulted —
a default is a guess about what somebody else counted, and the guess would be invisible in every table
that followed it.

## 6. What this licenses

**Licensed.** "97.18% of this arm's prompt is evidence, so the cost of a correct answer is the cost of
the evidence." "On the basis competitors publish, this arm is 1.21x to 3.19x dearer." "On the only
all-in measurement available, this arm is 0.69x of Synap." "The room is filled to 98.4% of its cap, so
a better ranker would not move the bill."

**Not licensed.** "We are at cost parity with the field", which is what the 1.31x/1.40x pair was
quietly implying in one direction and what `SOTA-LANDSCAPE.md`'s "~1.0x all-in" implies in the other.
The truthful statement names the basis and the competitor in the same sentence, which is why the
markers require both.

**Refused.** Converting a competitor's token count into this arm's tokenizer to make the ratio look
tighter. Contextier declares o200k and this arm's count is under the reader's own; the two rates differ
by roughly the 3.19x-to-3.07x band, which is smaller than every other uncertainty in the row, so the
ratio carries the difference as a caveat instead of an invented conversion factor.
