# MEASURE — Candidate Discrimination: Why a Grounded TR Failure Happened

**Status:** measured. Of the 14 grounded TR failures, **11 are the reader choosing
between retrieved candidates and picking the wrong one**, 2 are the reader
inventing an answer that was never retrieved, and 1 is not adjudicable from this
record.
**Found by:** the weak-evidence bucket opened in `MEASURE-TR-FAILURES.md` §4. Five
questions were flagged as `grounded` on a token that occurs many times, presented
as unresolved, and left for a better instrument. This is that instrument — and
reading the five showed the weak-evidence framing was describing a symptom.

---

## 1. The five questions the containment classifier could not resolve

`MEASURE-TR-FAILURES.md` split 27 answered-wrong TR failures into 13 ungrounded
and 14 grounded, then used a per-question occurrence count to flag five grounded
ones as resting on weak evidence. It reported them as unadjudicated rather than
assigning them to a bucket.

Reading those five records showed what the occurrence count was actually
detecting. Measured on the real artifact:

| question        | truth's unique token | reader's unique token |
| --------------- | -------------------- | --------------------- |
| `gpt4_76048e76` | `bike` ×10           | `car` ×8              |
| `gpt4_e414231f` | `road` ×6            | `mountain` ×3         |
| `gpt4_59149c78` | `metropolitan` ×1    | `city` ×2             |
| `gpt4_f420262c` | `jetblue` ×3         | (a prose answer)      |
| `gpt4_7abb270c` | —                    | —                     |

The token occurs many times because **the context discusses both the right answer
and a competing one**. `gpt4_59149c78` is the sharpest case: `metropolitan`
occurs **exactly once**, so the evidence for that question is as strong as it
gets, and the reader's wrong answer occurs too. The reader had both candidates in
hand and chose the wrong one.

That is a **discrimination** failure. It is not a retrieval failure — retrieval
delivered the answer — and it is not a plain reader-hallucination failure either,
because the reader was not inventing; it was choosing.

> **Correcting the earlier framing:** "weak evidence" described the token's
> frequency, which was the symptom. The cause is that the context offers more
> than one plausible answer. A term that measures frequency cannot locate a cause
> that is about candidate set size.

## 2. The instrument

`packages/cortex-eval/src/candidate-discrimination.ts`.

The probe is: **do the tokens unique to the truth occur, and do the tokens unique
to the reader's answer occur?** Tokens unique to each side are the right probe
because a token the two share cannot distinguish them — comparing the full sets
would report every shared word as evidence and mark every question as
competing-candidate.

Word-boundary matching, for the same reason as the containment classifier: `car`
must not be satisfied by `cargo`.

| verdict                 | meaning                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `competing-candidates`  | the truth and the reader's answer were both retrieved              |
| `evidence-only`         | the truth was retrieved and the reader's answer was not             |
| `unadjudicable`         | the token sets cannot separate the two sides                        |

## 3. Why it declines rather than guesses

Two inputs are not adjudicable from token sets, and both are reported as such
instead of being assigned to a bucket:

- **A list answer the reader partially reproduced.** Its tokens are a subset of
  the truth's, so nothing is unique to the reader's side and there is no
  competing candidate to detect. Deciding it needs an ordering or set-difference
  term this record does not carry. `gpt4_7abb270c` — six museums in order — is in
  this state and is reported `unadjudicable`.
- **Either side empty of content words.** A truth of grammatical tokens has
  nothing to look for; a reader answer of them has nothing to check for.

Declining is what keeps the instrument's scope stated rather than implied. A
module that always returned one of two buckets would have to guess on the list
case, and **a guess is indistinguishable from a measurement once it is in a
report**.

## 4. The result

Over the 14 grounded TR failures of the A2 artifact:

| adjudication            | count |
| ----------------------- | ----- |
| **competing-candidates** | **11** |
| evidence-only           | 2     |
| unadjudicable           | 1     |

**Four of the five weak-bucket questions resolve to `competing-candidates`** and
the fifth (`gpt4_7abb270c`) is the `unadjudicable` list case. The hypothesis was
formed by reading five records and it holds on all five, with the fifth declining
rather than being forced.

## 5. What this changes about the plan

Combining both instruments gives the TR failure population a shape it did not
have:

| mechanism                              | count | fix                                            |
| -------------------------------------- | ----- | ---------------------------------------------- |
| ungrounded — never retrieved           | **13** | retrieval, query expansion                     |
| **competing-candidates**               | **11** | context must distinguish the right candidate    |
| evidence-only — reader invented        | 2     | reader                                         |
| unadjudicable — list, needs ordering   | 1     | a different instrument                          |

Three consequences:

1. **The largest single reader-side mechanism is discrimination, at 11 of 27.**
   This is a mechanism no previous instrument could see: the containment
   classifier reported these as `grounded` and the occurrence term reported them
   as weak evidence, and neither names the cause.
2. **Work on retrieval addresses 13 of 27; work on discrimination addresses 11.**
   The two are nearly equal in size, so a plan that does only one leaves half the
   population untouched — which is what the earlier 13/14 split already implied
   but could not explain.
3. **The fix for discrimination is neither retrieval nor generation.** Retrieval
   already returned the answer. The reader needs the context arranged so the
   right candidate is identifiable — and that is a prompt or context-assembly
   change, which is a third kind of work this roadmap had not separated.

## 6. Verification

| check                                          | result                                                          |
| ---------------------------------------------- | --------------------------------------------------------------- |
| unit tests                                     | 20 passing, 100% on all four coverage dimensions                  |
| defect injection (11 mutations)                | **11 / 11 caught**, implementation restored byte-identical (md5)  |
| shared token must not count as a candidate     | verified: `bike` shared does not make a competing candidate       |
| one present token of a multi-token side        | enough for `competing-candidates`, not `evidence-only`            |
| repeated token on one side                     | does not change the verdict                                       |
| `car` inside `cargo`                           | not matched                                                        |
| rejected position does not stop the scan       | verified on both sides                                            |
| candidate at position zero / end of string     | found, verified on both                                            |
| null reader answer                             | `unadjudicable`, not a literal `null` search                       |
| real-data run                                  | 14 grounded failures adjudicated; 4 of the 5 weak cases resolve    |

Three injections were **missed on the first pass**, and each marked a place where
the fixtures happened to be insensitive:

- `compare-full-token-sets` survived because no fixture had the truth and the
  reader's answer **sharing** a non-grammatical token. Added one.
- `require-every-token-instead-of-some` survived because no fixture had a
  multi-token side with only **part** of it present. Added one.
- `keep-duplicate-tokens` survived because `distinguishingTokens` de-duplicates
  both sides, so the guard it removed could not change any verdict. **The
  mutation was targeting dead code.** Rather than keep a guard that only looks
  load-bearing, the redundant de-duplication was removed from `contentTokens`, so
  de-duplication now lives in exactly one place where a test can see it.

> **Discipline:** a mutation that survives is a finding about the test suite, but
> the third one above is a finding about the *implementation*: a guard that
> nothing can observe is not safety, it is a second copy of a check. Removing it
> is what made the mutation meaningful.

## 6a. Verification of the intervention layer

The intervention (`candidate-context.ts`) is verified separately, and its first
revision is the reason this section exists: **46 unit tests green, 0 of 17 real
questions annotated.** The tests and the implementation agreed with each other
and both disagreed with the data. The harness now carries the three defects that
run exposed, so a green suite under any of them would reproduce the original
failure inside the harness.

| check                              | result                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------- |
| unit tests                         | 84 passing                                                              |
| coverage on `candidate-context.ts` | **100 / 100 / 100 / 100** (statements / branches / functions / lines)   |
| defect injection (18 mutations)    | **18 / 18 caught**, restored byte-identical (md5 `a1b1bfa5bf98bbb271fd7e69805a7af1`) |
| real-data annotation rate          | 13 of 17 competing-candidate questions annotated; 4 decline             |
| truth and answer in different clusters | **9 of 17**, of which 10 questions report exactly two clusters       |
| label placement                    | the reader's own dated-turn pattern still matches every labelled line    |
| non-candidate turns                | never labelled; no turn deleted or reordered                            |
| repo gate (`pnpm check`)           | green: 1423 tests across four packages, every dimension above 95%       |

Seven mutations were missed across four passes, and the repairs split into three
kinds. Only the first kind is about the tests.

1. **Suite gap -- add a test.** `require-every-token-of-side-literally` was
   unobservable because the narrowed distinctive set is usually a single token,
   so a conjunction over it cannot differ from a disjunction. Re-aimed at a
   multi-token distinctive set, which is the only shape that can see it.
2. **Unobservable mutant -- re-aim the mutation.** `label-before-the-role` was
   first written as a string-concatenation reorder, which turned out to produce
   byte-identical output: the capture group already contained the role. The
   mutation now rewrites the line, which is what a caller can actually observe.
3. **Dead code -- delete the implementation.** Three mutants guarded branches
   that no input could reach:
   - `label-on-empty-context` -- the empty context is already returned by the
     newline/turn disagreement check one line later, so the explicit empty-string
     test could never change the result. Deleted.
   - `accept-out-of-range-index` -- a cluster index past the end never enters the
     membership map, so its turn passes through unlabelled either way. The guard
     that "refused to mislabel" produced exactly the unlabelled output it was
     written to avoid. Deleted.
   - `drop-the-role-preserving-fallback` -- collapsing `appendLabel`'s three
     shape-matching arms into a plain append left **all 75 tests green**. The
     arms were observable-equivalent to the append for every reachable input, so
     they were deleted. This is the strongest form of the finding: the arms made
     the reader's role adjacency look like a property of the code, when the line
     shape was carrying it all along, and they concealed that by looking careful.

> **Discipline (extended):** when a mutation survives, read the *mutated output*
> before touching the suite. Twice in this round the first instinct -- add a test
> for the branch -- would have pinned behaviour that does not exist, and the
> second instinct -- re-aim the mutation -- was needed for one case and wrong for
> three. The mutant decides which: if the mutated code cannot produce different
> output, the implementation is the finding.

## 7. What this does not claim

- **Not a claim about reasoning.** Token presence is not entailment. A context
  containing both candidates adjacent to a disambiguating qualifier is still
  reported `competing-candidates`.
- **Not a count of questions the reader should have answered correctly.** It is a
  count of questions where a competing candidate was retrieved.
- **Not adjudicable for list answers.** One A2 question is declined. Extending
  the instrument to list answers needs an ordering term, and that is a separate
  piece of work rather than a widening of this one.
- **Not generalised beyond TR.** The instrument is applied to TR only. IE and KU
  answers have not had their shapes measured, and the earlier token-length error
  is what happens when that step is skipped.
- **Not a claim that the ungrounded bucket is unaffected.** The two instruments
  are independent and both were run over the same 27 records; the 13 ungrounded
  questions have no grounded verdict to adjudicate, so no verdict was produced
  for them.
