# The B7 annotation has no producer in the production path

**Status:** measured. This is the second and larger half of the defect that
`VERDICT-B7-NULL-WITHOUT-ADMINISTRATION.md` opened.

**Evidence:** the caller census in §2, the probe in §3, and six tests in
`packages/cortex-eval/src/__tests__/b7-main-path-wiring.test.ts`.

## 1. The finding in one paragraph

B7 adds an instruction telling the reader to choose between **labelled**
candidates. The thing that writes those labels, `renderDiscriminatedContext`, and
the thing that decides which turns to label, `discriminateContext`, have **no
production caller anywhere**. Every reference to them outside their own module and
this package's barrel is a comment. So with the switch on, the reader is
instructed to do something the context does not support: the labels it is told to
consult are never written.

## 2. The caller census

```
$ grep -rn "discriminateContext\|renderDiscriminatedContext" packages/*/src/*.ts packages/*/src/**/*.ts \
    | grep -v "__tests__" | grep -v "^packages/cortex-eval/src/candidate-context.ts"

packages/cortex-eval/src/b7-cohort.ts:40:          * ... the three inputs `discriminateContext` takes ...
packages/cortex-eval/src/index.ts:145:               discriminateContext,          <- barrel re-export
packages/cortex-eval/src/index.ts:148:               renderDiscriminatedContext,   <- barrel re-export
packages/cortex-eval/src/natural-language-memory.ts:146:   * ... labels `renderDiscriminatedContext` adds ...
packages/cortex-eval/src/natural-language-memory.ts:1623:  * ... which `renderDiscriminatedContext` adds.
```

Two barrel re-exports and three comment mentions. **No call sites.**

The same census run over the whole repo shows the only callers are
`candidate-context.test.ts` and `b7-cohort.ts`'s docstring. A module with tests and
no callers has 100% statement coverage and 0% integration coverage, and the
coverage report cannot tell the difference.

## 3. The producer is correct, and that is the point

A direct probe, using the two sides and two dated turns:

```
sides:    [["4172"],["9930"]]
clusters: [{"id":1,"indices":[0],"terms":["4172"]},
           {"id":2,"indices":[1],"terms":["9930"]}]
rendered: "...4172 for the north entrance [candidateCluster: 1]\n
           ...9930 for the south entrance [candidateCluster: 2]"
```

The producer identifies the pair, assigns distinct cluster ids, and the renderer
writes the label. Nothing is broken. **The gap is entirely in the wiring**, and
this is worth stating explicitly because it changes what the fix is: not a bug
fix, a connection.

## 4. Why this was invisible

Three independent reasons, each sufficient on its own:

1. **Unit tests call the producers directly.** `candidate-context.test.ts` drives
   `discriminateContext` and `renderDiscriminatedContext` with well-formed inputs
   and asserts on their output. Every assertion passes. The suite never asks who
   calls them.
2. **The coverage gate cannot see it.** Both functions are executed by tests, so
   their lines count as covered. An unreachable function that is directly tested
   is indistinguishable, in every coverage metric this repository gates on, from
   one that is wired in.
3. **The switch reaches the prompt.** `candidateDiscrimination` genuinely changes
   the prompt text, so an investigator checking "is the option plumbed" finds that
   it is: it is read, forwarded, and consumed. The missing link is one step
   further out, in the context-building path the prompt consumes.

## 5. The structural reason it cannot be fixed by a spread

`discriminateContext` requires **both** sides:

```ts
export function discriminateContext(
  turns: readonly TurnLike[],
  options: DiscriminatedContextOptions,   // { question, groundTruth?, answer? }
): DiscriminatedContext
```

Without `groundTruth` it returns `{ clusters: [], annotated: false }` — asserted
in the test suite. And `NaturalLanguageMemorySystem`, the class that builds the
context and calls the prompt builder:

```
$ grep -n "groundTruth" packages/cortex-eval/src/natural-language-memory.ts
(no matches)

async answer(question: string, context: string[], sessions?: string[][]): Promise<Answer>
```

**The system never receives the ground truth.** It has no field for it and no
parameter that carries it. So the annotation path is not blocked by a missing
spread one layer down; it is blocked by a **missing data channel** from the
dataset to the context-building layer.

That is a design decision, not a mechanical fix, and it is why this document
stops at the audit rather than completing the feature: the choice of how the truth
reaches the system determines what the A/B can mean.

## 6. The obvious channel is probably the wrong one

The tempting fix is to thread `groundTruth` into `answer()`. It is worth naming why
that may be wrong before someone does it, because the mistake would be expensive
and hard to see afterwards:

**Using the ground truth to build the context makes the arm oracle-assisted.**
`discriminateContext` uses truth and answer as the two sides to cluster on. If the
production path supplies them, then the feature's benefit is measured under a
condition no deployment can reproduce: at inference time the correct answer is
unknown, which is the entire reason the question is being asked. An A/B run that
way would report a gain attributable to information the system would not have.

A non-oracle variant needs the sides to come from somewhere else — the retrieved
candidates as the reader might identify them, or the question's own qualifiers
against the turns. That is a different clustering input, and `discriminateContext`
as written does not take it.

**This is a hypothesis about the right design, not a measurement.** It is recorded
here so the decision is made deliberately rather than by whichever wiring is
shortest.

## 7. What has been fixed, and what has not

### Fixed

`runner.ts` now forwards `candidateDiscrimination` into the main benchmark's
feature system. Before this, the option was declared on `BenchmarkRunnerOptions`,
documented with a paragraph saying the switch "was set nowhere outside" the memory
class, and then not passed — the documentation of the previous fix and the code had
drifted apart. The four TDD tests for this are in the new test file; the first two
failed before the change with `expected 0 to be greater than 0`.

This fix is **necessary and not sufficient**. It removes one reason the feature was
inert. The feature remains inert for the reason in §2.

### Not fixed

The annotation data path. Per §5 and §6 it needs a decision that this audit does
not make.

### Explicitly not claimable

- **Not** "B7 has no effect." B7 has no *producer*. The distinction matters: the
  first is a claim about a method, the second about a missing component.
- **Not** "the annotation implementation is broken." It is correct and tested;
  §3 shows it working.
- **Not** that the previous audit's fix was pointless. It wired the switch into
  the rerank arm, which was the arm that existed. This audit shows that arm also
  could not have shown an effect, for an independent reason.

## 8. What would settle it

A caller census in CI. The defect class here is "exported function with tests and
no production caller", and it is mechanically detectable: for each exported symbol
in `src/**` excluding `index.ts`, require at least one non-test reference. Such a
check would have caught this at the moment the option was first declared, and it
would have caught the four functions the previous audit found uncalled, and the one
those two audits did *not* find because they were looking at the switch rather than
at its dependency.

Until that exists, the census in §2 is a command a reader has to remember to run,
which is a weaker guarantee than a test. It is recorded as a command here for that
reason.
