# Measure: what a pair of dispatches has to reproduce, and the control that decides the answer

The width axis was registered with one internal control: *the four routes the cap cannot reach must
reproduce their prompts.* Run `45340177345` failed it, and the failure was established by reading two
artifacts by hand. Both the reading and the verdict turned out to be about the **control**: the artifacts
it compared were four days and several commits apart, and against a control dispatched at the same commit
the same 252 questions reproduce **byte for byte**. A comparison is only as single-variable as its two
files, and a 500-record comparison done by eye cannot say which files it read. This is the instrument
that can.


## 0. One paragraph

`node tools/prompt-identity.mjs <a.json> <b.json>` pairs two archived reports by `questionId`, files
every question into `reachable` (a route the cap reaches) or `unreachable`, and gives each pair one of
five verdicts from the two records alone. It prints two gates: the one
`docs/PREREGISTRATION-TURN-WIDTH.md` §4 wrote, which is about **evidence characters**, and the one every
later comparison needs, which is about the **prompt**.

Run on the pair the gate was about — the 600 run `45340177345` against the same-commit control
`45367733613` — the unreached routes reproduce **252 of 252**. Run on the pair the hand reading used —
the same 600 run against `44017278305`, which is four days and several commits older — it reproduces the
hand reading **exactly**: 220 identical, 26 with a 125-character frame delta, 6 with a different
delivered set. Both statements are measurements of the same dispatch. The gate's verdict depends on
which control it is read against, and only one of the two controls makes the comparison single-variable.


## 1. Why a digest decides identity and a length decides only the verdict

Each record already carried three length-and-hash fields and they answer different questions:

| field | what it counts | what it cannot see |
| --- | --- | --- |
| `promptChars` | the evidence characters this arm delivered | the frame around them |
| `deliveredPromptChars` | the whole prompt that was sent | anything inside the budget |
| `promptDigest` | 64 bits of the prompt text | nothing, at the probability stated in `prompt-digest.ts` |

A length comparison can say *the evidence moved* or *the frame moved*, and that split is the useful
part: the frame is instructions, a contract header and the question, so when the frame moves on a route
the cap cannot reach, the explanation is a code difference rather than a retrieval difference. A length
comparison cannot say *the same prompt* or *a prompt edited inside its budget*, and that is the whole
question, so identity is decided on the digest and the lengths decide only where a difference lives.

The five verdicts are ordered by what they can prove:

| verdict | evidence | frame | digest | what it means |
| --- | --- | --- | --- | --- |
| `identical` | equal | equal | equal | the same prompt, as far as 64 bits can say |
| `overhead` | equal | **differs** | differs | the evidence reproduced and the frame did not |
| `evidence` | **differs** | any | differs | the delivered set, its order or its width changed |
| `unattributed` | equal | equal | **differs** | same lengths, different bytes: a same-length edit |
| `unmeasured` | any | any | one side absent | nothing can be said, and it is not a pass |

`unattributed` is not a curiosity. It is the only cell in which a length-based control passes and the
prompt was edited, and a control that cannot see it is the control that would have passed the pair this
file was written for.

## 2. Why the partition is cap reachability and not capability

A cap that cannot reach a route has no business changing that route's prompt on any question, so on
`unreachable` *any* difference is a confound and *no* difference is a statement about the instrument. On
`reachable`, a difference is the treatment. That is the only partition on which the same table supports
both claims, and it is why the tool takes the reachable list as an argument rather than hard-coding it:
a dispatch that moved the cap to another route must be read with another list, and a tool that could not
express that would silently file its differences as confounds.

The reachable list is not free to choose, either. `multi-session` and `temporal` are what the registered
arm names, and the tool's default is that pair; a dispatch that changed it has departed from the
registration and the departure is the thing to read first.

## 3. The precondition the tool prints first

A pair's identity number is about **one repetition of each run**. Each record carries the digest of the
first repetition, and the number of distinct prompts that question cost *inside its own run* is
`promptVariants`. Both artifacts the tool was written for report `2` on some questions, so on those the
four passes were not four repetitions and a between-run difference there cannot be attributed to the
configuration.

That census is printed before the table, the way `turn-width.mjs` prints its replay fidelity before its
sweep, because a number whose precondition is unstated is the defect this campaign has paid for twice.
The most likely cause of a within-run second prompt is the bare-decline retry — the retry removes the
abstention token from the prompt, so a question retried on some passes and not others carries two
texts — and the artifact cannot currently confirm it: there is no per-question retry field, and the
report-level census is a total over 2,000 calls. Naming that cause costs one boolean per ask on
`CortexMemory`, which is the same shape `lastPromptText()` already has, and it is the next
instrumentation this file argues for rather than a defect it fixes.

## 4. What it does not claim

1. **It does not re-open the width axis.** Whether `600` should be adopted is `MEASURE-TURN-WIDTH.md`'s
   question and the answer there was no on significance, not on identity. This file decides only
   whether a pair is single-variable.
2. **It does not attribute a frame difference to a commit.** A constant delta names a block; identifying
   the block still needs `compare/<a>...<b>` on the remote, because the local clone's commit objects do
   not carry the SHAs the artifacts record — the trees are identical and the commit hashes are not, so
   `git cat-file` on a dispatch SHA fails locally and succeeds against the API. That asymmetry is
   recorded here because it makes "check the file list of the two dispatch commits" an API question.
3. **It does not make a difference smaller.** A provider whose noise exceeds the ordering quantum flips
   a boundary no client can recover; `relevance-order.ts` states that bound and this tool inherits it.
4. **It says nothing about accuracy.** Every row here is a property of what was sent.

## 5. What the two pairs read

Both tables are one command each, on the artifacts `45340177345` (600), `45367733613` (400, same code)
and `44017278305` (400, four days older).

### 5.1 The cross-commit pair: the calibration

| partition | identical | overhead | evidence | unattributed | total |
| --- | ---: | ---: | ---: | ---: | ---: |
| `reachable` | 0 | 0 | 247 | 1 | 248 |
| `unreachable` | 220 | **26** | **6** | 0 | 252 |

Frame delta: **26 questions at 125 characters**, one at 0. Registered gate **fails** on 6, strict gate
**fails** on 32. Those are the numbers `MEASURE-TURN-WIDTH.md` §181 obtained by reading the records, so
the instrument is calibrated against the reading it replaces rather than against its own idea of the
question.

### 5.2 The same-commit pair: the gate's actual verdict

| partition | identical | overhead | evidence | unattributed | total |
| --- | ---: | ---: | ---: | ---: | ---: |
| `reachable` | 0 | 0 | 245 | 3 | 248 |
| `unreachable` | **252** | 0 | 0 | 0 | 252 |

**252 of 252 reproduce.** No evidence moved, no frame moved, no digest moved on a route the cap cannot
reach, so the width dispatch is single-variable and the 32 differences above are code drift — which is
what §181.4 inferred from a file list and is now measured.

The frame delta is the part that dies: `+125 characters` is a property of the *older commit*, not a
property of the width, and on the pair that matters it is zero.

### 5.3 The three questions that arrived at the same length and different bytes

`reachable` has three `unattributed` pairs — equal evidence characters, equal delivered characters,
unequal digests:

| question | route | evidence chars (both) | delivered chars (both) |
| --- | --- | ---: | ---: |
| `d23cf73b` | `multi-session` | 45,726 | 48,270 |
| `37f165cf` | `multi-session` | 45,849 | 48,380 |
| `gpt4_a1b77f9c` | `temporal` | 23,186 | 23,930 |

A fixed room filled to a fixed count with a different arrangement is the allocator's boundary: the same
number of characters arrived, and which turn occupied the last slot changed. That is the treatment — the
cap moved from 400 to 600, so a different turn fits — and it is filed as `unattributed` rather than
`evidence` only because the lengths coincide. It is recorded because it is the cell a length-based
control cannot see, and because two of the three are questions the width was supposed to help.

### 5.4 What the pair settles about the placebo

`IE` moved **+3** between these two runs on prompts that are byte-identical on all 150 of its questions.
That was already the reading in §182.4 and it is now the *measured* identity of the pair rather than an
inference: the noise floor of a between-run comparison on this instrument is around three questions, and
`MR`'s +6 sits 1.18 times that floor. The width axis is blocked on power, not on identity, and no further
money spent on the identity question can unblock it.
