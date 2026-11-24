# Measure: what a pair of dispatches has to reproduce, and the two clauses that disagree

The width axis was registered with one internal control: *the four routes the cap cannot reach must
reproduce their prompts.* Run `45340177345` failed it. The failure was established by reading two
artifacts by hand and is correct, but **the clause the registration actually wrote was met**, and the
difference between those two statements is 26 questions. This file is the instrument that separates
them, and it exists because a 500-record comparison done by eye is not a measurement.

## 0. One paragraph

`node tools/prompt-identity.mjs <a.json> <b.json>` pairs two archived reports by `questionId`, files
every question into `reachable` (a route the cap reaches) or `unreachable`, and gives each pair one of
five verdicts from the two records alone. It prints two gates: the one
`docs/PREREGISTRATION-TURN-WIDTH.md` §4 wrote, which is about **evidence characters**, and the one every
later comparison needs, which is about the **prompt**. On the pair that prompted it the first gate fails
on the questions whose delivered set moved and the second fails on those plus every question whose frame
moved — so the same two files support "the dispatch changed one thing" and "the dispatch did not
reproduce", and neither sentence is allowed to stand in for the other.

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
