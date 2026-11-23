# DATASET-LOCOMO

What the corpus contains, established by counting it, and the three places it will silently cost a
reading if it is loaded the obvious way.

> **Source.** `snap-research/locomo`, pinned by commit
> `3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376`, `data/locomo10.json`, **2,805,274 B**, sha256
> `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`.
> `tools/locomo-prep.mjs` censuses it; `.github/workflows/data-prep.yml` fetches and asserts the digest.

## 1. Why this corpus is in the campaign at all

`updateAppliesTo` gates a learned fact on its anchor sentence appearing in the question's corpus
(`packages/cortex-memory/src/semantic-facts.ts:394`). LongMemEval gives every question its own haystack,
so a fact learned on one question reaches the next **by construction never** — measured at 6% of
windows, and that 6% is the part of the corpus that happens to repeat an anchor sentence.

That makes the `H2` semantic-carry ablation unmeasurable on LongMemEval: the mechanism is correctly
inert, and an ablation of an inert mechanism has no denominator. LoCoMo is the opposite construction —
ten dialogues, one pair of speakers each, facts introduced early and revised later — which is the shape
the mechanism was built for. The ablation and this corpus are two halves of one experiment.

## 2. What is in it

| dimension | count |
| --- | --- |
| dialogues | **10** |
| session bodies | **272** (plus **16** keys that carry only `session_N_date_time`) |
| turns | 5,882 |
| questions | **1,986** |
| gold evidence ids | 2,815, of which **2,806 resolve** to a `dia_id` in the corpus |
| human annotations | `event_summary`, `observation`, `session_summary` — present on every dialogue |

Shape: a top-level array of samples; each sample has `sample_id`, `conversation`, `qa`, and the three
annotation objects. `conversation` carries `speaker_a`, `speaker_b`, and `session_N` /
`session_N_date_time` pairs; each turn is `{speaker, dia_id, text}`. Each `qa` entry is
`{question, answer, evidence[], category}` where `evidence` holds `dia_id` strings.

## 3. The five categories, read off the data

The published evaluator dispatches on **integers** and the corpus carries no names, so the names below
are not quoted from a paper — they are what the questions and the evidence counts support:

| category | n | evidence ids per question | what the questions look like | reading |
| --- | --- | --- | --- | --- |
| 1 | 282 | mostly 2–3 (134 have 2, 57 have 3) | *"What is Caroline's relationship status?"*, *"What did Caroline research?"* | **multi-hop** — the answer needs several turns joined |
| 2 | 321 | 281 of 321 have exactly 1 | *"When did Melanie paint a sunrise?"*, *"When did Caroline go to the support group?"* | **temporal** — every question asks *when* |
| 3 | 96 | 0–4, spread | *"Would Caroline likely have Dr. Seuss books on her bookshelf?"* | **open-domain** — counterfactual, needs knowledge outside the dialogue |
| 4 | 841 | 795 of 841 have exactly 1 | *"What did the charity race raise awareness for?"* | **single-hop** — one turn states it |
| 5 | 446 | 432 of 446 have exactly 1 | *"What did Caroline realize after her charity race?"* | **adversarial** — see §4.3 |

The distribution itself is evidence for the reading rather than against it: single-hop is the largest
category (841) and open-domain the smallest (96), which is what a benchmark built by sampling real
questions would produce, and the opposite of what a category list read from memory would predict.

Because the mapping is an inference, **it does not live in code**. `tools/locomo-prep.mjs` reports the
integers and refuses to translate them; a per-category table that needs names has to say where the
names came from.

## 4. Three traps, each measured

### 4.1 Sixteen sessions exist only as a date

`session_20_date_time` is present with no `session_20`. Sample 0 declares dates to `session_35` and
carries bodies for 19 sessions. A loader that loops `for (let i = 1; i <= 35; i++)` reads `undefined`
as a conversation, contributes zero turns, and produces **a shorter corpus rather than a broken one** —
the failure mode of §164, where a missing window read as a small population.

Any loader must enumerate the keys that exist and report the gap.

### 4.2 Nine gold evidence ids do not resolve

2,806 of 2,815. An evidence-recall reading whose denominator includes the nine is a reading about a
corpus that does not exist; one that drops them silently is a reading over 99.7% presented as 100%.
`locomo-prep` keeps `evidence` (resolved) and `evidenceMissing` apart, per question, and prints
`2806/2815` as one token.

### 4.3 Category 5 has no gold answer at all

Every one of the 446 adversarial questions has `answer` absent — not empty, absent. `String(q.answer)`
produces the literal `"undefined"`, which a judge will compare against and a loader will happily put in
front of an LLM as the expected value.

The correct reading is the one LongMemEval's abstention template encodes: the right response is to say
the information is not there. That needs an explicit decision per dataset — LoCoMo does not carry the
explanation text the template wants, so a loader has to supply one or exclude the category and say so.

`tools/locomo-prep.mjs` maps the absent answer to `''` rather than to `"undefined"`, and
`tools/competitor-regrade.mjs` skips records with an empty gold **by cause** (`noGold`), so the
population shrinks visibly instead of being graded against a string that is not an answer.

## 5. What is deliberately not used

`event_summary`, `observation` and `session_summary` are human-written summaries of what happens in each
session, sitting in the same file. A system that reads them is not doing retrieval from the dialogue,
and its accuracy is not comparable to a system that reads the turns. The census records that they exist
(`annotationKeys`) so that any future reading can state which of the two it did.

## 6. Reproducing

```bash
# 2.8 MB, five resumed rounds at ~12 KB/s through a constrained proxy
curl -L --retry 3 -o locomo10.json \
  https://raw.githubusercontent.com/snap-research/locomo/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/data/locomo10.json
sha256sum --check <<< "79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4  locomo10.json"

node tools/locomo-prep.mjs --input locomo10.json --out-dir prep/locomo
# dialogues 10 / sessions 272 (+16 date-only) / turns 5882 / questions 1986
# categories {"1":282,"2":321,"3":96,"4":841,"5":446} / evidence 2806/2815 resolved
```
