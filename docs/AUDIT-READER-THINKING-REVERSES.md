# The reader's thinking routes are worth +23.50 questions, and §13.197 measured −12

Two runs, one variable, a result that reverses the number this campaign has been acting on for
several rounds.

```
control  41222844945   reader.thinking = "disabled",  thinkingRoutes = absent        85.75%  (428.75 / 500)
run      41254359622   reader.thinking = "enabled",   thinkingRoutes = [multi-session, temporal]
                                                                                      90.45%  (452.25 / 500)
```

`--config` between them reports **2 fields differ and 31 the same**: `reader.thinking` and
`reader.thinkingRoutes`. Those are two fields and **one knob** -- the route list has no meaning while
the mode is `disabled`, which is exactly the grammar `readThinkingReach` was built to express
(`PREREGISTRATION` §13.197.4). So this is a single-variable pair, and the pair is the whole argument.

`--null` confirms the other half:

```
prompt identity: 500/500 byte-identical, 0 differ
stratum               n  control      run   delta  flips       p    sd  unanim  E[unanim]
identical-prompt    500   428.75   452.25  +23.50    166    8.3%  6.17      16   2.97e-03
null: a change of up to 12.3 question(s) on the identical stratum is the reader, not the treatment
      (observed +23.50, 2 sd = 12.34)
```

Every prompt was byte-identical, so **nothing in the prompt moved**; the entire +23.50 is the reader
answering the same question under a different mode. Fourteen questions converted in four repetitions
out of four, two in the other direction.

---

## 1. What §13.197 said, and why the difference is not a mistake in either reading

§13.197 measured this same knob as a **net loss**: `TR` +4, `IE` −16, net −12 questions, which is why
`disabled` shipped as the default and `enabled` remained a dispatch input.

| capability | 41222844945 (disabled) | 41254359622 (routes) | delta |
| ---------- | ---------------------: | -------------------: | ----: |
| ABS        |                  30/30 |                30/30 |     0 |
| IE         |                 144/150 |               143/150 |    −1 |
| KU         |                  60/72 |                61/72 |    +1 |
| MR         |                 89/121 |                97/121 |    **+8** |
| TR         |                107/127 |               120/127 |   **+13** |

The **sign** agrees with §13.197 on both axes: `TR` up, `IE` down. The **magnitude** does not:
`TR` gains 13 where §13.197 gained 4, and `IE` loses 1 where §13.197 lost 16. The net moves from
−12 to +23.5.

Three explanations are possible, and the data separates them:

1. **§13.197 measured a different baseline.** Its pair ran under the configuration of that round;
   this pair runs under `ask=operands+operand-gap`, `relevanceTopK=256`,
   `promptContract=abstention-evidence-blocks`. An interaction between the ask and the reader mode
   is the likeliest cause, and it is not visible from either reading alone.
2. **§13.197's `IE` loss was itself an interaction.** Sixteen questions lost on `IE` is a large,
   specific failure; under this baseline the same mode costs **one**. A reader mode whose cost drops
   by 16× when the prompt changes is measuring the prompt, not the mode.
3. **One of the two readings is wrong.** Nothing here supports this, and both are pre-registered
   runs with `--null` applied, so it is listed for completeness rather than as a hypothesis.

What is **not** available is the sentence "this contradicts §13.197, so §13.197 was wrong". Both
readings are real; what has been measured is that **the same knob has different values on different
baselines**, which is precisely the property that makes a single-configuration effect size
un-extrapolable.

---

## 2. Why this cannot be quoted as a new headline today

Because the configuration the pair runs under is itself **not the registered one**, and the gap has
been recorded as undeclared three times without being closed:

```
$ readout-arm-run.py <41254359622> --registration
UNDECLARED  maxPromptChars:   48000 (registered) -> 96000 (ran)
UNDECLARED  turnCutMarker:    "none" (registered) -> "ellipsis" (ran)
UNDECLARED  reader.thinking:  "disabled" (registered) -> "enabled" (ran)
UNDECLARED  reader.thinkingRoutes: <-absent-> (registered) -> ["multi-session","temporal"] (ran)
```

`PREREGISTRATION` §13.202.6 says of the first two: **"Not adopted: `maxPromptChars 96000` and
`turnCutMarker ellipsis`."** So the family of runs from `41185512391` onward -- including both sides
of this pair -- runs under a configuration the registration explicitly has not adopted, while every
published reading in the campaign was produced under it.

That is the same defect as `AUDIT-SCORING-RULE-AS-CONDITION.md` one level up: the register says
48,000 and every run does 96,000, and **no artifact field compares the two**, so the reading is
quoted without the condition it was taken under.

Two ways to close it, and the choice is a plan decision rather than a measurement:

| option | what it costs | what it buys |
| ------ | ------------- | ------------ |
| **Adopt 96,000 + `ellipsis`** | the register changes, and §13.202.6's refusal is reversed with a reason | the shipped number becomes **90.45%**, which is above memoricai's 85.8% |
| **Refuse them and re-measure** | a 5-hour run at 48,000 with `thinking=multi-session+temporal` | comparability with every pre-96k reading, at whatever the 48k budget gives |

Neither is taken here. The +23.50 is real **within the configuration that ran**, and stating it as
the product's accuracy would be quoting a condition the register does not yet contain.

---

## 3. What this changes about the portability work

This round's other deliverable argued that a deployment on an unmeasured reader loses questions to
two causes, and that only the second is Cortex's to fix. A **reader mode** is a third thing, and it
just measured 23.50 questions:

| cause | who owns it | how it shows up | what can be done |
| ----- | ----------- | --------------- | ---------------- |
| the reader's knowledge | the operator | answers parse, and are wrong | report it |
| Cortex's adaptation to a reader | **Cortex** | the answer never reaches the scored field | probe, configure, guard |
| **a reader mode Cortex did not turn on** | **Cortex** | answers parse and are wrong, on a capability the provider supports and the product does not use | **detect the capability, turn it on** |

The third row is new and it is the largest effect any of these tables has recorded. It also gives the
`latency-thinking` probe a second job: it was written to catch a reader whose plain path already
needs the thinking deadline, and it turns out the same probe is the one that tells a deployment
**whether the +23.50 is available to it at all**. A provider without a reasoning mode gets the shipped
configuration and a number that is not comparable to this one -- which is a fact the matrix has no row
for yet, and now needs one.

---

## 4. What would make this a headline

Three things, in order, and the first is free:

1. **Decide the 96,000 question.** Until the register and the runs agree, every reading in this
   campaign carries an undeclared condition. That is a one-line plan decision, and it is the highest
   value-per-minute item in this repository right now.
2. **Re-measure `IE`.** One run at 48,000 with the routes on, paired against `41222844945`'s 48k
   neighbour if one exists. If `IE` really costs 1 rather than 16 at both budgets, §13.197's effect
   was a prompt interaction and should be retired rather than cited.
3. **Register the interaction.** "Thinking routes on `multi-session`+`temporal` is worth +23.50 with
   this ask and −12 with the previous one" is a stronger and more defensible sentence than either
   number alone, and it is the sentence the next round should be built on.

Until then the only sentence this document licenses is: **on the configuration both runs actually
used, turning the reader's thinking routes on for `multi-session` and `temporal` gained 23.50
questions out of 500, with prompts byte-identical on all 500 and a null of 12.34.**
