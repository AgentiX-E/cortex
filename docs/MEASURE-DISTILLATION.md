# MEASURE — Atoms that distil, and the gate that had forbidden it

> `triage-proposer/v2` → `v4`, same model (`deepseek-chat`), same twenty cards, same fixture.
> Run: `40073815898` (workflow `measure-models.yml`), readings on branch `readings/40073815898`.
> Numbers reproduced by `distillationOf` in `packages/cortex-core/src/triage/grounding.ts`.

## The complaint, and why it was not a prompt problem

The first person to use the A3 review page:

> "The atoms did not extract any fact, a preference or a summary — they only cut the sentence into
> segments and printed them separately. For me there was no difference, and the original read better.
> If you had extracted and summarised into the shortest facts or preferences, with a time qualifier,
> that would be perfect."

They were describing gate 1, which required an atom to be `source.includes(candidate)` — a verbatim,
contiguous run. **A summary is never a substring.** So the gate admitted exactly one output shape, and
the prompt could not have asked for anything else. The measurement agrees to the decimal: on the
twenty v2 cards, **39 of 39 atoms were verbatim runs — 100.0%**.

## The change

`grounding.ts` replaces substring identity with **content** grounding: an atom may drop, reorder and
inflect, and may not introduce a number, a name, a content word or a negation the sentence does not
have. Prompt v4 asks for one fact or preference per statement, its subject named instead of a pronoun,
its time kept when the sentence gives one, and nothing invented.

## The reading

| | v2 | v4 |
| --- | --- | --- |
| atoms on the twenty cards | 39 | 34 |
| of which verbatim runs of the sentence | **39 (100.0%)** | **15 (44.1%)** |
| cards whose sentence named a time | 5 | 5 |
| …of which an atom kept one | 5 | **4** |
| A3 dosage (share of cards with ≥2 atoms) | 75.0% | 55.0% |
| proposals on the sixty labelled sentences | 52/60 | **45/60** |

### What the atoms look like

```
source  Each had its own unique charm, but I think my favorite was the Fairmont Orchid.
v2      Each had its own unique charm        |  but I think my favorite was the Fairmont Orchid
v4      My favorite was the Fairmont Orchid.

source  By the way, I've been really enjoying editing my photos in Lightroom - the online
        communities I've joined have been super helpful in learning new techniques ...
v2      By the way, I've been really enjoying editing my photos in Lightroom
        the online communities I've joined have been super helpful in learning new techniques
        getting feedback on my work
v4      I edit my photos in Lightroom.
        I joined online communities that help me learn new techniques.

source  I think personal interests and work-life balance are the most important factors for me.
v4      Personal interests are one of the most important factors for me.
        Work-life balance is one of the most important factors for me.
```

Framing is gone, pronouns are resolved, and one sentence can become two facts. The reader effect the
reviewer asked for — "shorter, self-contained, with the time" — is what v4 returns.

## Two things this cost, neither hidden

**1. Seven fewer proposals on the labelled set (52 → 45).** The reason is in the counts:
`invented:new-word` fired **8** times out of 82 candidates. Distilling invites paraphrase, and
content grounding refuses vocabulary the sentence does not contain. That is the trade, stated as a
trade: v2's 52 proposals were 100% copies and therefore not atoms at all, so the two counts are not
the same quantity — but the drop is real and it is where v5 has to work (prompt compliance with rule
4, not a looser gate).

**2. The first version of this measurement flattered the change.** `isVerbatimRun` folded case,
whitespace, dashes and trailing punctuation but not contractions, so it reported **20.6%**. Two of the
twenty cards differed from their sentence by nothing but `I'll` → `I will`. Expanding a contraction
is a typographic choice, so the fold now includes contractions and the number is **44.1%**. The lower
number is the one quoted, here and in `docs/04`.

## What 44.1% still means, honestly

Half the atoms are still literal spans. Most of them are *good*: "My favorite was the Fairmont Orchid."
is a substring of its sentence and is exactly the fact a colleague could act on — the framing around
it is what got dropped. **Verbatim share is a form measure, not a quality measure**, and it cannot
distinguish "the sentence's own claim, stripped" from "the sentence cut in half". What the samples
show is that the strip is happening; what the number shows is that the words are still the person's.
That is the intended shape for this product — a card that paraphrases freely is a card that can invent
— but it means the metric has a ceiling: 0% verbatim would require synonymy, which the gate forbids.

## Readings this does not establish

- Whether the atoms are *better to a person*. That is A3, and the page has been rebuilt from the v4
  cards (`evidence/a3-review/review-remote-v4.html`, new resume key because a different prompt is a
  different review). Nobody has clicked it.
- Whether the 44.1% is stable. One run, one model, twenty cards, `temperature: 0`.
- Whether time-qualification generalises. The detector is a word list; "the summer I turned nine" is
  in it by accident ("summer") and "after the move" is not.

---

## Second reading: the drop was the gate, not the prompt (runs 40073815898 / 40076070920 / 40077606061)

The 52 → 45 drop in proposals was attributed, in the section above, to prompt compliance. That
attribution was wrong, and the way it was falsified is the useful part.

**v5** added rule 5, "never swap in a synonym", with a rejected/accepted pair, and pre-registered two
criteria: proposals ≥ 50/60 **and** verbatim share ≤ 50%. Neither held — 48 proposals, and the share
moved **44.1% → 52.6%** because every atom v5 added was a copy while one distilled atom disappeared.
It was reverted, and the prompt is byte-identical to v4 again.

**The refutation left a diagnostic behind**, and the diagnostic found the real defect in one line.
`WithheldFact.token` recorded `inventedWords: [["take", 1]]`: the model wrote "I *take* a comedy writing
workshop" for a sentence saying "I've been *taking* a comedy writing workshop", and the gate compared
`take` with `taki` and called a correct inflection an invention. The four-character test could not see
through a vowel-changing inflection, so the gate was taxing the only legitimate rewrite the prompt had.

| Configuration | atoms | verbatim | share | distilled | time kept | proposals /60 |
| --- | --- | --- | --- | --- | --- | --- |
| v4, four-character gate | 34 | 15 | 44.1% | 19 | 4/5 | 45 |
| v5, four-character gate | 38 | 20 | 52.6% | 18 | 5/5 | 48 |
| **v4, root-and-prefix gate** | 36 | 12 | **33.3%** | **24** | 4/5 | 43 |

Same prompt, better gate: **distilled atoms 19 → 24, copied atoms 15 → 12.** One line of comparison did
what a prompt rewrite could not, and did it in the direction the reviewer asked for.

### The measurement's own variance is unmeasured, and that bounds every claim here

The identical v4 prompt produced **45** and **43** proposals on two different days (`temperature: 0`,
same model, same fixture). So 45 → 43 is not a regression from the gate fix; it is inside a variance
nobody has measured. What the table supports is the *within-batch* comparison — an 11 pp move in the
verbatim share against a 2-question move in the proposal count. Until a repeat is run, the proposal
column should not be used to compare configurations, and "two runs agree" moves from optional to
prerequisite.

### One more arithmetic trap, found while rebuilding the page

`prepare --limit 20` yields twenty *cards*, not twenty *pairs*. One card in this run (a sentence with
nothing in it) produced no atoms, so the page had **19 pairs** — below the pre-registered N, which would
have scored as `underpowered`. Requesting 21 cards gives 20 pairs. The page in `evidence/a3-review/` was
rebuilt from that run.
