# Design — the session-as-document estimator, productised after it had already lost

**Status:** implemented (`relevanceUnits: 'session-text'`), **not registered**, and deliberately so. This file
exists to stop it being registered a second time.

## 1. What was measured before this file was written

`PREREG-MR-SESSION-CHANNEL.md` registered exactly this mechanism — *score a session as one unit, its joined
turns and one embedding, and project that score onto every turn it contains* — as a new `retrieval-session`
signal, and `§6. Result` records what happened: run `40498191604`, gate line
`relevanceSignal=retrieval-session`, **MR 83/121 against the control's 84**. `MEASURE-PAIRED-FLIP.md` §6 lists
it under "what this withdraws", and `§6.2` closed the retrieval-unit axis on two lines: the paired loss, and
the fact that the gold turn reaches the rendered prompt for 500 of 500 questions.

So the estimator is not a hypothesis. It is a **refuted** one, and the refutation is one question wide.

## 2. The argument that has to be refused, because it was made

An offline census in the round this file was written in read `MEASURE-MR-UNITS.md` (−28 questions for
`relevanceUnits: 'session'`) as the verdict on session units, noticed that the unit scores a session by the
**maximum** of its turns while the reference pipeline embeds the **joined text**, and concluded that the
verdict belonged to maximum pooling and the document estimator had never been measured. Every step of that
is true except the last: the document estimator was measured four weeks earlier, under the name
`retrieval-session`, in a file that has a Result section. The reasoning was reconstructed from the two
documents that *quoted* the negative result instead of from the one that *produced* it.

`tools/prereg-status.mjs` is the mechanism that answers this class of mistake rather than the instance:
`PREREG-MR-SESSION-CHANNEL` now declares `decided`, and any paragraph that names it as a plan fails
`pnpm guard:prereg`.

## 3. What the product gained anyway, and why it is not nothing

The estimate being refuted does not make the option worthless, because the option is not an accuracy claim.
Two things it is:

**It closes a representation gap the product could not express.** `PREREG-MR-SESSION-CHANNEL.md` §2 said the
arm "cannot express" the reference pipeline's session unit, and that stayed true of the *product* after the
harness grew the signal: the harness supplies a `relevanceFor` callback and can rank anything it likes, while
`CortexMemory`'s own index scored turns and only turns. A caller who wants a session scored as a document had
to build the index themselves and inject it.

**It costs fewer embeddings.** One per session instead of one per turn, on a corpus whose sessions hold four
to five turns. That is a cost property of a configuration, not a reading: it says the option is cheap to
leave on, not that turning it on improves an answer.

## 4. The implementation fact that made this more than a forwarding

`SearchIndex.lookup()` returns `(_question, text) => byText.get(text) ?? 0`, keyed by the texts the index was
given. A projection that wrote a session's score onto its turns therefore cannot come from a scoring
callback alone: the **index** has to be built over documents first, or every joined text scores zero, every
session ties, and the selector silently falls back to arrival order while the artifact says
`relevanceUnits: 'session-text'`. That is the inert-configuration class `§10.10` recorded, and it is why the
unit reaches two places rather than one — and why a route without boundaries **refuses** instead of
degrading:

```
relevanceUnits: 'session-text' scores a whole session as one document, so it needs the session
boundaries this call did not receive. It is reachable from answerSessions(), which has them, and not
from the flat routes, which flatten the corpus before ranking.
```

The selector itself is untouched. `'session-text'` and `'session'` share `selectBySession`, because with
every turn carrying its session's score "the best turn of a session" *is* the session score — which is the
sentence `PREREG-MR-SESSION-CHANNEL.md` §3 wrote, now executable.

## 5. What pins it

`session-text-unit.test.ts`, ten assertions, on a hand-written three-dimensional space rather than a bag of
words: the assertion is about which text the index was asked to embed, and a real embedder would make the
vectors a second explanation for any disagreement.

| text | cosine to the question |
| --- | --- |
| `b0` — the best single turn in the corpus | 0.90 |
| `join(B)` — the same session as a document | 0.30 |
| `a0` | 0.50 |
| `join(A)` | **0.95** |

B arrives first, so maximum picks B, the document picks A, and a **missing projection** — every score zero,
ties broken by arrival — picks B as well. The three failure modes therefore land on different answers:

| change | assertions that turn red |
| --- | ---: |
| delete the projection | **2** |
| index turns instead of documents | **3** |
| drop the `'session-text'` branch in `chooseEvidence` | **3** |

The third mutation did **not** fail on the first fixture: at 400-character turns the room held three turns
either way, so the two units agreed by coincidence. The turns were widened to 600 and the band itself became
an assertion (`the room binds between one session and two`), because a contrast that cannot fail is not a
contrast. A tenth assertion covers a text that arrives twice — the projection keys on the text, so adopting
`SearchIndex`'s first-occurrence rule must not turn a scoring rule into a de-duplication of the delivered
evidence — and it is also what the third mutation now breaks.

`bench/run-ablation.ts`'s `Record<RelevanceUnits, RelevanceUnits | undefined>` failed to compile the moment
the union grew, and that is the table doing what its docstring claims: a new unit cannot arrive without
someone deciding what the arm forwards. `cortex-eval`'s own `RELEVANCE_UNITS` carries the name for the same
reason, and its absence fails loudly at `readRelevanceUnits` rather than defaulting to `turn`.

## 6. What this file does not claim

1. **That the option improves accuracy.** It was measured at −1 question and is not registered.
2. **That the reference pipeline's 88.43% is explained.** It is not, and the closed axis in §6.2 of
   `PREREG-MR-SESSION-CHANNEL` says the retrieval side of `MR` is not where the remaining gap lives.
3. **That `'session-text'` is reachable by the dispatcher and therefore should be dispatched.** It is
   reachable — `cortex_memory_relevance_units=session-text` parses — and reachable is not a reason.
4. **That the estimator family is exhausted.** Three estimators have now been tried (turn, session-max,
   session-document). What is exhausted is the claim that *a different unit of the same scores* moves `MR`.
