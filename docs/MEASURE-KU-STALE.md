# Where the nine knowledge-update failures go

Control artifact `42533236864`, 500 questions, 44 wrong. Nine of the 44 are `KU` — knowledge update, the capability
whose defining property is that the corpus states a value, then states a different one later. This file reads those
nine, because every previous round read the 44 as one population and the aggregate hid the only subgroup that has a
single cause.

## 0. One paragraph

**All nine answered with the superseded value.** Not a paraphrase of it, not an average of the two — the value that
was true earlier in the corpus. Nine of nine. The gold for five of them was in the delivered prompt at the same time
as the answer they gave, so the reader had both versions in front of it and chose the older one; for the other four
the newer value never arrived at all. That is two mechanisms, not one, and the split is 5 / 4 — which is also the
first failure population in this campaign whose cause is stated by the answer itself rather than inferred from the
score.

## 1. The nine

| question | gold | answered | newer value in the window | older value in the window |
| --- | --- | --- | :---: | :---: |
| `852ce960` mortgage pre-approval | `$400,000` | `$350,000` | yes | yes |
| `a1eacc2a` short stories written | `seven` | `Four` | yes | yes |
| `59524333` usual gym time | `6:00 pm` | `7:00 pm on Mondays, Wednesdays, and Fridays` | yes | yes |
| `a2f3aa27` Instagram followers now | `1300` | `1250` | yes | yes |
| `c7dc5443` current volleyball record | `5-2` | `3-2` | yes | yes |
| `f9e8c073` bereavement group sessions | `five` | `Three sessions.` | **no** | yes |
| `e66b632c` previous personal best 5K | `27 minutes and 45 seconds` | `26 minutes and 30 seconds` | **no** | yes |
| `69fee5aa` pre-1920 American coins | `38` | `37` | **no** | yes |
| `07741c45` where the old sneakers are kept | `in a shoe rack in my closet` | `Under my bed` | **no** | yes |

"Older value in the window" is not an assumption: the string the reply gave is present in the delivered text in all
nine (`norm(answer) in norm(window)`), so the reader did not invent it. It read it.

`goldOverlap` says the same thing from the retrieval side and says it uniformly: **all nine are partial coverage**
(10–20 of 20–24 gold turns), **none is full, none is zero**. Compare the 484 answers that are not this shape: 243 full,
240 partial, 1 zero. A population that is entirely partial and entirely wrong is not a sample of the population that is
entirely partial and 92.8% right; something selects it.

## 2. The split, and what each half needs

**Five are stale twins.** Both versions in the prompt, the older one returned. Nothing retrieval can do — the newer
value is in the window, at a later date, in a turn the reader was given. This is the case `MemoryAgentBench` measured
across 22 systems and it is not specific to this arm: an obsolete twin in the retrieved set pulls the answer to the
obsolete value even when the current one is present, and the pull gets **stronger** as the evidence budget grows
(a 64→512-token budget moved single-hop accuracy 45% → 32% on Qwen2.5-7B, and the conflict questions 25.7% → 12.2%,
while a gold-assisted audit found the current statement in **all 100** retrieved sets at every budget). The mechanism
the authors name is the one visible here: the stale value is often the one that matches ordinary world knowledge, and
the reader follows the version it recognises.

**Four are undelivered.** The newer value is not in the window at all, and the older one is. These are retrieval
failures and they are the only four of the nine a wider window or a better ranking can reach.

| half | n | what can reach it | what cannot |
| --- | ---: | --- | --- |
| stale twin | 5 | evidence **representation** — the window has to stop presenting two versions as equals | any re-ask, any prompt sentence, any wider window |
| undelivered | 4 | retrieval — the newer turn has to reach the prompt | anything on the read side |

That table is the reason this file exists. The campaign has spent eight mechanisms (supersede, room, contract,
`audit`, `tally`, `spec`, `selfConsistency`, `deepseek-v4-pro`) on the read side and every one landed within a
question of break-even. Five of these nine are read-side **but not prompt-side**: the defect is that the prompt
renders `[2023/05/24] … $350,000` and `[2023/06/02] … $400,000` as two equally-weighted lines, and the reader has to
notice that one is later than the other and that the question asks for *now*. Every prompt sentence tried so far asks
the reader to do that noticing. None of them removes the need for it.

## 3. What the external record says, read for this arm

Four results from the 2026 literature that this measurement lines up with, each cited because it changes a decision
rather than because it is related:

1. **`MemoryAgentBench` (ICLR 2026, arXiv 2507.05257), FactConsolidation.** The best dedicated memory system reaches
   54% single-hop; every one of 22 systems is at most 28% multi-hop. Deterministic aggregation — extract candidates,
   take the highest serial number in code — reaches **78.0%** single-hop (gpt-4o-mini) and **94.8%** (gpt-4o), against
   a best published 54%. The same substitution with timestamps instead of serials holds on LongMemEval's knowledge
   update split. The finding is not "use code"; it is that **the current value is a property of the store, not a
   judgement for the reader**.
2. **Separating extraction from policy execution** (Reddy & Challaram, arXiv 2606.01435) lifts multi-hop from 7% to
   27–41%, and swapping the final executor from an LLM to deterministic code adds only **2.0 points**. The gain is the
   separation, not the executor — which is the argument for a rendering layer that hands the reader one version rather
   than for a resolver that decides for it.
3. **`WorldMemArena` (NeurIPS 2026).** Recall 86.83% with QA accuracy 50.14% on `M2A`; 85.20% / 57.81% on MemGPT. High
   recall does not imply the correct evidence is used. This arm's own version of that sentence is `14.11.1`: 40 of 44
   failures carried their gold, 13 carried all of it.
4. **`AMA-Bench` (ICML 2026).** Existing memory systems underperform because they fail to capture causal and objective
   information and rely on lossy similarity retrieval; the reported system reaches 57.22%, +11.16 over the strongest
   baseline, from a causality graph plus tool-augmented retrieval. That is the same diagnosis from the agentic side:
   retrieval similarity is not representation.

None of the four says a prompt can fix this, and this arm has eight null results agreeing.

## 4. Why nothing on the prompt axis can reach the five

The five stale twins have a property that makes them a clean test: **the evidence contains the right answer and the
wrong answer, and the question asks for the current one.** A prompt that adds *"prefer the most recent value"* is
asking the reader to compare two dates and pick — which is exactly the operation that failed, now requested more
loudly. `MEASURE-SUPERSEDE.md` 14.11.3 states the general form: the reader is not short of evidence, it is short of a
place to do the judging.

So the five are reachable only by changing what the window **is**, and the smallest such change is the one that leaves
the reader's job alone: render the superseded turn as superseded. `conflict.ts` already decides pairs; the rendering
does not use it. `03-execution-plan.md` 14.121 registers the arm.

## 5. What this file does not claim

- It does not claim the nine are the campaign's biggest loss. `MR` has 20 wrong of 121 and `IE` has 9 of 150; the nine
  are the **most attributable** loss, which is a different and more useful property.
- It does not claim the older value is always world knowledge. The test above is presence in the delivered text, and
  presence is what it measures.
- It does not claim the 5 / 4 split generalises beyond this artifact. It is 500 questions, one reader, one repetition.
  The arm in 14.121 is registered to convert the five and is expected to move the total by at most 5.

## 6. Reproducing

```sh
python3 - <<'PY'
import json, re
d = json.load(open('benchmark-cortex-memory-ablation-report.json'))
norm = lambda s: re.sub(r'[^a-z0-9]', '', str(s).lower())
for q in [x for x in d['questions'] if x['capability'] == 'KU' and not x['correct']]:
    win = norm(' '.join(t['text'] for t in q['turns']))
    print(q['questionId'], norm(q['answer'])[:20] in win, norm(q['groundTruth'])[:20] in win)
PY
```

Every row prints `True` in the first column. That is the whole of section 1's third column, and it needs no model
call, no re-run and no key.
