# What the score is short by, and which part of it a mechanism can reach

Round `§203`. Zero model calls. Read from `45760081761` — the two-repetition `layered` arm the product
ships, 500 questions, `93.40%` — with `tools/paired-flip.mjs`, whose headroom table this round added.

## 1. The question the campaign was not asking

Every mechanism in this repository before this round was chosen by the column that looked worst. The
worst column is `MR`, and the arithmetic behind that choice was always the same subtraction: `MR` reads
`88.43` where the strongest published system reads `95.6`, so `MR` is where the eight points are.

That subtraction is not a population. It is two means, and this artifact has carried one correctness
mask per repetition per question since `§13.118.5` specifically so that the difference could be taken
apart. Taken apart, `MR`'s `7.2`-point gap is:

| `MR`, paired against the reference pipeline | questions | worth on `MR` | worth on the 500 |
| --- | ---: | ---: | ---: |
| `durable-miss` — control right in both repetitions, this arm in neither | **4** | 3.31 | 0.80 |
| `durable-win` — the reverse | 7 | — | — |
| `agreed-wrong` — neither arm ever | 5 | — | — |
| `contested` — the same bytes decided differently | **12** (8 on this arm) | 2.07 | 0.50 |

The population a mechanism can convert is **four questions**. The other twelve cannot be converted by
anything aimed at `MR`, because they are not wrong — they are undecided, and a mechanism that makes them
*decide* still has to make them decide **right**.

## 2. The reading, on all five capabilities

`tools/paired-flip.mjs --artifact <report>` now prints this, after the partition and before the census:

```
headroom: what the score is short by, and what the control demonstrated about it
capability            n   answered  unstable   never  demonstrated   ceiling
ABS                  30         30         0       0             0   100.00
IE                  150        141         3       6             0    96.00
KU                   72         67         0       5             0    93.06
MR                  121        103         8      10             5    95.87
TR                  127        119         3       5             1    96.85
suite              500        460        14      26             6    96.00
```

- **answered** — right in every repetition. `460` of `500`.
- **unstable** — right in some repetitions and wrong in others. `14`. These contribute
  `7.0` to the mean, which is why the mean is `467` and not `460`.
- **never** — wrong in every repetition. `26`. This is the whole of the headroom.
- **demonstrated** — of those 26, the number the **control answers at least once**. `6`.
- **ceiling** — `1 - (never - demonstrated) / n`. The score a fix could reach if it converted every
  question either arm has ever answered and nothing else: **`96.00`**.

Four things follow, and each of them contradicts something this campaign believed.

**The ceiling is 96.00, not 100.** Twenty of the twenty-six questions this arm never answers are
questions the reference pipeline never answers either. They are a ceiling of the *harness* — a
retrieval reach, a gold nobody can decide, or a corpus fact that is not in the corpus — and no amount of
work on this arm moves them.

That last sentence is **one witness's** statement and it was read as the only one. `tools/ceiling-witnesses.mjs`
(`§205`) counts the second: of the same twenty-six, **nine** had their gold's operand delivered into this
arm's own prompt and **one** has no searchable operand at all, so the prompt's ceiling is `96.60` and the
eight questions on which the two witnesses disagree are questions the evidence *reached*. What survives is
weaker and still true: neither witness promises a mechanism. A projection that quotes `100` as the ceiling of a 500-question benchmark is
quoting the corpus, not the system.

**The largest reachable block is not the one every mechanism was aimed at.** Fourteen unstable questions
are worth **1.40** points if every one of them were decided correctly, and six demonstrated questions are
worth **1.20**. The `MR` durable misses that `MEASURE-MR-CEILING.md` and every dispatch after it named as
the target are **four questions, 0.80 points** — the fourth-largest of the five blocks.

**`MR` cannot deliver SOTA, and that is arithmetic rather than opinion.** `MR` is `121` of `500`
questions, so a question converted there is worth `0.242` of a point on the suite. `MR`'s entire
demonstrated reachable set is **five questions** — everything else the route is short by, the control is
short by too. Five questions is **`1.00` point**, against a gap of `2.2`. The worst-looking column cannot
supply a quarter of what is missing, whatever is done to it.

**Both reachable blocks have already been measured and both are closed.** This is the part that makes the
above a roadmap rather than an excuse:

| block | size | points | the mechanism that targets it | what it read |
| --- | ---: | ---: | --- | --- |
| `contested` | 14 | **1.40** | `selfConsistency: 3` — three consultations and a strict majority vote, the only mechanism in this repository aimed at flapping | **`MR` 86.2 against a floor of 89** (`§13.102`, run `39529234665`) |
| `never` **and** demonstrated | 6 | **1.20** | the numeric institution on `MR` — `enumerated`, `aggregation`, `candidates`, `operands` on the multi-session route | ten readings, every one within a question of break-even (`MEASURE-SUPERSEDE.md` §14.4–14.10) |
| `never` and **not** demonstrated | 20 | 4.00 | nothing in this harness reaches them | — |

Those are `2.60` reachable points and both deposits have absorbed a null result. `MEASURE-SUPERSEDE.md`
§14.11 already drew that conclusion from the failure side — *"a run of eight null results does not say the
mechanisms were badly built; it says the diagnosis they were all built on was never tested"* — and this
reading supplies the missing half of it: the diagnosis was `MR`, and `MR` holds four questions.

## 3. The path to `95.6`, in questions

`95.6` is `478` of `500`. This arm answers `460` in every repetition and half of the other `14`. So:

```
460  answered in every repetition
 14  contested, all decided right   -> 474 = 94.80
  4  of the six demonstrated        -> 478 = 95.60
```

**Eighteen questions: fourteen that have to become decisive and four that have to become right.** Both
blocks are measured and both are closed, so the eighteen questions are reachable only by a **capability**
this repository does not have, not by a version of the ones it does. That is a different kind of project
from the ten dispatches in §14, and the cheapest evidence for it is the one competitor capability never
replicated here — MemCog's agentic multi-step retrieval, which reads `95.80` on this benchmark and whose
implementation has been read and not run.

## 4. What the 26 are

The six classes, from `tools/failure-classes.mjs` on the same artifact. The counts are repetition 0, which
is the pass the artifact's `questions` array describes:

| class | n | routes |
| --- | ---: | --- |
| `derived-number` | 10 | multi-session 8, temporal 1, knowledge-update 1 |
| `number-misselected` | 7 | multi-session 3, temporal 2, flat 1, knowledge-update 1 |
| `text-misselected` | 5 | temporal 2, knowledge-update 2, multi-session 1 |
| `preference` | 5 | flat 5 |
| `number-absent` | 3 | multi-session 3 |
| `text-absent` | 3 | temporal 2, assistant 1 |
| `declined` | 2 | multi-session 1, knowledge-update 1 |

**Corrected in `§205`.** This table first read `text-misselected 8` and no `text-absent` at all, because
`failure-classes.mjs` decided the `absent` / `misselected` split on `goldOverlap.goldTurns`, which
`question-record.ts` writes as *"the text of every gold turn, delivered or not"*. Three questions whose gold
the window dropped were filed as a **decision** fault, and the class that names the delivery institution —
`text-absent` — could not fire. `docs/MEASURE-TWO-WITNESSES.md` §1 records the defect and §3 the two queue
verdicts it was holding up.

And read by hand, the twenty-six are four shapes rather than twenty-six stories:

**The stale anchor, five of five `KU`.** `07741c45` answers *under my bed* where the gold is *a shoe rack
in my closet*; `852ce960` answers `$350,000` and its reply *names the later `$400,000`* before dismissing
it with a caveat the evidence does not support — *"stated by the user in a context where the assistant
notes it has no access to prior conversations"*. The evidence is carried; the reader chose the earlier
value and then wrote a reason for it. This is the `knowledge-update` capability failing on its own
definition, and it is the one shape in the list with a mechanism registered for it (`verbatim-clock`,
`sessionClock`, `factTimeline`) that has never been read on this population.

**The count, ten of ten `MR` numeric.** `gpt4_a56e767c` answers `3` against four festivals, `bf659f65`
answers `2` against three albums, `a11281a2` answers `350` where the increase is `100`, `d851d5ba`
answers `$8,750` against `$3,750` — the last one is a doubling, which is the signature of an amount
counted twice rather than a sum misread. These are the questions `enumerated` was built for, and
`enumerated` was read ten times.

**The preference that was not retrieved, four of five `IE`.** `75832dbd` is asked for AI-in-healthcare
publications and answers about LGBTQ+ allyship; `57f827a0` is asked about bedroom layout and answers about
Wi-Fi signal. Both windows are 500,000 characters. The gold is a rubric (*"the user would prefer
responses that…"*) and the answer is a real recommendation about the wrong subject, which is a selection
failure across a 500k window and not a preference failure.

**The date, five of five `TR`.** `9a707b81` reads 26 days where the gold is 21, `370a8ff4` reads 11.6
weeks where the gold is 15, `gpt4_8279ba03` answers *No evidence provided* for a smoker that is in the
corpus. Every one of them is an anchor or an interval computed from a date the window carries.

## 5. The class that could not fire, found while counting

`tools/failure-classes.mjs` named eight classes and could emit seven. `declined` was
`answer.includes('INSUFFICIENT_EVIDENCE')` on a local copy of the token, and `parseAnswer`
(`parse.ts:87`) maps a reply that decides to abstain onto **`null`** — an abstention is the absence of an
answer — so the field it searched was `null` on every decline the product has ever produced. `empty`
absorbed the population.

The file's own comment predicted it: *"a classification whose `declined` class never fires because the
spelling moved would report an entire cascade as `empty`, and both are silent."* The spelling did not
move. The field did. And the fixture that was supposed to pin the class fed the token **into `answer`**, a
shape no run has ever produced, so the self-test was green over a dead branch.

It was found by reading one question. `c4ea545c` was filed as `empty` — *"the reader produced nothing; a
contract or parse defect"* — and its reply is 533 characters ending in the bare token; `37f165cf` is the
same shape ending in `Answer: INSUFFICIENT_EVIDENCE`. Both are declines, and
`tools/failure-census.json` was pricing `empty: 2` for them.

The repair is the rule that file already states for its other predicates: **import the product's own**,
because a second implementation of "which part of a reply is a decline" is how two layers come to disagree
about the same artifact. `classify` now reads `rawOutput` through `isAbstention`, refuses a record that
carries neither a reply nor a parsed answer, and the fixture is the shape `parseAnswer` actually emits.

The consequence for the queue is a row that changes meaning rather than a row that changes size. `empty`
reply was a target at `2` members and a `refused` verdict; it is now `declined` at `2` members and the same
`refused` verdict, and the difference is the mechanism it prices: the arm has a recovery pass for a **bare**
decline (`isBareDecline`) and both of these are prose, which the pass excludes by design. A target named
`empty` was pricing a repair that does not exist against a population that is not what it named.

## 6. What this changes, and what it does not

**The queue.** `tools/failure-census.json` is re-frozen against `45760081761` with the artifact's SHA-256
recorded, and the `empty` target is replaced by a `declined` one. The certified rows are unchanged:
`numeric institution, bundled (MR)` at 14 class members on 121 questions is the only target with room above
its floor, and `preference (flat)` sits exactly on the line — it printed `certifiable` at six members on
`45543010618` and `refused` at five on this run, which is what a target one question wide looks like.

**The published number.** Nothing moves. `93.40` is the mean of `465` and `469` and this reading agrees with
both.

**The next step.** Not another dispatch against `MR`. The reading says the deposit every previous dispatch
aimed at holds four questions, that the block that actually holds the points is measurable and its one
mechanism has been refuted, and that the remaining twenty questions are outside what this harness reaches.
A dispatch against either reachable block now has a ceiling of `1.40` or `1.20` points and a floor of
`1.20`, i.e. no room — which is the resolution-wall conclusion `MEASURE-RESOLUTION-WALL.md` §2 reached
from the other direction, now with the population filled in.

## 7. What it refuses, and what it does not say

`summarisePaired` refuses an artifact with one repetition (`single`): one repetition has no `unstable`
column and every question is either answered or never, which makes the headroom table read as a full
description of a population it has not seen twice. It refuses masks whose lengths disagree with the
question list (`width`), and it refuses an empty case list. The tool refuses a `--window` it cannot find
and an id set with no window marker, both asserted in `tools/__tests__/test_paired_flip_window.py`.

It does **not** say the 26 are unfixable. It says six of them have a demonstrated answer and twenty do
not, and that "demonstrated by the reference pipeline" is a statement about *this harness* — a different
retrieval could bring a twenty-first question's operand into a window this arm never builds. It also does
not say `95.6` is beyond reach: §3 is eighteen questions and the arithmetic closes. What it says is that
the eighteen are not reachable by any mechanism in §14, and that the next dispatch has to test a
capability rather than a parameter.

## 8. Re-deriving it

```
gh run download 45760081761 -n benchmark-cortex-memory-ablation-report
sha256sum benchmark-cortex-memory-ablation-report.json
#   5e08f353c1b4bac39a7a7fe8f9bc6f4de15eb7ae91e9b69c1c2940965c1f30a1, 207,000,800 bytes
node tools/paired-flip.mjs --artifact benchmark-cortex-memory-ablation-report.json
node tools/failure-classes.mjs benchmark-cortex-memory-ablation-report.json
node tools/failure-classes.mjs benchmark-cortex-memory-ablation-report.json --json   # the census
node tools/queue-floor.mjs --census tools/failure-census.json                        # the prices
```

The artifact is 62,955,757 bytes zipped and is not in the tree. It is re-downloadable from the run while
the run's artifact is retained; the hash is recorded in `tools/failure-census.json` so that a future
artifact claiming the same run can be checked rather than trusted.
