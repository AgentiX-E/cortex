# AUDIT-COVERAGE-ANNOTATION-BLIND-SPOT

**Scope:** the coverage-suppression annotation set, the gate that pins it, and the six
annotations the gate could not see.
**Verdict:** the gate was real but **scoped and spelled too narrowly to be load-bearing**.
Six annotations carried the `istanbul` prefix, which the gate's pattern did not match, and
which vitest's v8 provider **does not honour** — so they suppressed nothing while reading as
reviewed decisions. All six are deleted. The gate now scans every workspace package and
matches every prefix, and three defect injections confirm it fires.

Measured at revision `b19bd39`, corrected in the change that adds this document.

---

## 1. What the gate claimed, and what it actually covered

`packages/cortex-core/src/__tests__/coverage-annotations.test.ts` makes one narrow but
valuable promise, stated in its own docstring:

> **the set cannot grow silently**, so a new suppression necessarily reaches a reviewer.

Two things defeat that promise, and both were measured rather than suspected.

### 1.1 Scope: one package of four

The scan root was a single expression:

```ts
const SRC = join(__dirname, '..');   // packages/cortex-core/src
```

So "the set" meant *the set inside `cortex-core`*. Two block suppressions live in
`cortex-llm`:

```
packages/cortex-llm/src/embedding/transformers-pipeline.ts:1
    /* c8 ignore start -- optional-peer loading shim; ... */
packages/cortex-llm/src/rerank/transformers-rerank-pipeline.ts:1
    /* c8 ignore start -- optional-peer loading shim; ... */
```

These are the **strongest** annotations in the repository — a `start` block removes
statements from the coverage denominator, so the reported percentage stops being a statement
about tested code and becomes a statement about what was excluded. The one gate whose
subject is suppressions did not read them.

### 1.2 Prefix: two spellings of four

The pattern was:

```ts
const ANNOTATION = /(?:\/\/|\/\*)\s*(?:c8|v8)\s+ignore\b[^\n]*/g;
```

`istanbul` is not in the alternation. Six files carried an annotation with that prefix:

```
packages/cortex-core/src/domain/provenance.ts:1
packages/cortex-core/src/interfaces/embedding.ts:1
packages/cortex-core/src/interfaces/llm.ts:1
packages/cortex-core/src/interfaces/storage.ts:1
packages/cortex-core/src/interfaces/vector.ts:1
packages/cortex-eval/src/types.ts:1
```

Compared directly, the two patterns disagree on five files inside the very directory the gate
scanned:

```
CURRENT regex sees : {'graph/memory-graph.ts': 2, 'math/stats.ts': 6}
FIXED   regex sees : {'domain/provenance.ts': 1, 'graph/memory-graph.ts': 2,
                      'interfaces/embedding.ts': 1, 'interfaces/llm.ts': 1,
                      'interfaces/storage.ts': 1, 'interfaces/vector.ts': 1,
                      'math/stats.ts': 6}
```

### 1.3 The gate also forbade what five of its files did

The file contained this assertion:

```ts
it('does not suppress a whole file or block', () => {
  for (const [file, matches] of scan()) {
    for (const annotation of matches) {
      expect(annotation, `${file}: blanket suppression is not allowed: ${annotation}`)
        .not.toMatch(/\bignore\s+(?:file|start)\b/);
    }
  }
});
```

Five of the six invisible annotations were **exactly** `ignore file`. The rule and the
violations coexisted in one file, and neither could see the other: the rule because the
scanner returned an empty set for them, the violations because the rule was written in a
double negative that read as satisfied.

---

## 2. The second finding: the annotations had no effect at all

Before deciding whether to *enumerate* or *delete* the six, the question worth answering was
what they actually did. The answer came from deleting them and re-running.

**Experiment.** Strip the five `cortex-core` annotations, run `vitest run --coverage`,
compare to the unmodified baseline.

```
WITH annotations    (baseline)    All files | 98.74 | 98.67 | 100 | 98.74
raw statement counters: 946/958 = 98.7474%
WITHOUT annotations (measured)    All files | 98.74 | 98.67 | 100 | 98.74
```

**Bit-identical.** Not "close", not "within the ±0.8 pp band the config documents" — the same
946 of the same 958 counters.

The explanation is in the raw artifact. `coverage/coverage-final.json` for `cortex-core`
contains 20 files, and exactly five of them have an empty statement map:

```
src/domain/provenance.ts      statements: 0
src/interfaces/embedding.ts   statements: 0
src/interfaces/llm.ts         statements: 0
src/interfaces/storage.ts     statements: 0
src/interfaces/vector.ts      statements: 0
```

These files contain only `export type` and `export interface` declarations. They compile to
no JavaScript, so there is no statement for a coverage provider to miss — and they do not
appear in the rendered text table at all.

### 2.1 Why the annotation was inert rather than merely redundant

Two independent reasons, and either one alone would have been enough:

1. **There was nothing to suppress.** A file with zero statements contributes zero to both
   the numerator and the denominator. `ignore file` on it changes no number.
2. **The prefix is not the provider's.** `istanbul ignore` is read by **nyc**, not by
   vitest's v8 provider. The v8 provider honours `v8 ignore` and `c8 ignore`; a file-level
   `istanbul` comment is not in its vocabulary.

The consequence is what makes this worth a document. The annotation's effect on the measured
number was **exactly zero**, while its effect on a reader was *"this was considered and
exempted."* That is the same shape as
[`AUDIT-B7-DEAD-SWITCH.md`](AUDIT-B7-DEAD-SWITCH.md) — a mechanism that is set and never
consumed — with the difference that here the inert mechanism is a **comment about the
measurement**, in the one file whose job is to police comments about the measurement.

---

## 3. Why the remedy is deletion, not enumeration

The obvious repair is to widen the pattern and add the six entries to `EXPECTED`. That was
rejected, for two reasons that point the same way.

**It would pin an empty set of consequences.** `EXPECTED` is a reviewed-change register: each
entry says "this suppression exists, and here is why it is correct". For these six there is no
"why it is correct" to state, because there is no suppression. The reason text would have to
be *"this annotation does nothing"* — a register entry whose content is an admission that it
should not be in the register.

**It would leave the rule and its exceptions in contradiction.** The file asserts that blanket
suppression is not allowed. Keeping six `ignore file` annotations would require either
deleting that assertion or adding a carve-out, and a carve-out for the specific no-op case is
a rule that says "no blanket suppression, except where it is pointless".

**Deletion also makes the rule honest.** With the six gone, the blanket-suppression ban is not
weakened — it is *implemented*, and the two real block suppressions are held to a stronger
standard than before (§4).

### 3.1 What replaces the exemption for those files

Nothing. The files need no exemption, and the property that makes that true is now asserted
rather than assumed — see `leaves the type-only files unannotated because they compile to no
statements` in §4.

---

## 4. The corrected gate

Three changes, and one deliberate non-change.

### 4.1 Scope: derived from the workspace, not from the test's location

```ts
function repoRoot(): string {
  let dir = join(__dirname, '..');
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('pnpm-workspace.yaml not found above this test; ...');
}
```

The scan walks up to the workspace manifest, then walks **every** `packages/*/src`. It fails
loudly rather than silently scanning a subtree if the marker is ever removed. `dist` is not
scanned — it is build output, and an annotation there is a copy of one in `src` that would be
double-counted.

A dedicated assertion pins the scope itself:

```ts
it('scans every workspace package, not only the one this file lives in', () => {
  const packages = new Set(sourceFiles().map(packageOf));
  expect([...packages].sort()).toEqual([
    'cortex-core', 'cortex-eval', 'cortex-llm', 'cortex-node',
  ]);
});
```

Without it, a regression to single-package scanning would shrink both the scan and the
expectation together, and the count assertion would still pass.

### 4.2 Prefix: match more than the runtime honours

```ts
const ANNOTATION = /(?:\/\/|\/\*)\s*(?:c8|v8|istanbul)\s+ignore\b[^\n]*/g;
```

`istanbul` is matched **even though the provider ignores it**. A pattern restricted to the
prefixes known to work is blind to exactly the annotations most likely to be mistaken — which
is how six of them accumulated. Seeing more than the runtime honours is the safe direction:
the surplus reaches an assertion and must be justified or deleted.

```ts
it('uses no `istanbul` prefix, because the v8 provider does not honour it', () => {
  expect(counts(scan().istanbul)).toEqual({});
});
```

### 4.3 Blanket suppressions: a separate register, a stronger standard

`next` and `start`/`file` are now collected separately and pinned separately, because they
make different claims. A `next` asserts one statement cannot execute. A `start` block asserts
an entire file's worth of statements cannot execute **in any configuration the suite runs
under**. The second is far stronger and gets its own `EXPECTED_BLOCK`:

| Site | Count | Reason |
| --- | --- | --- |
| `cortex-llm: embedding/transformers-pipeline.ts` | 1 | Optional-peer loading shim; dynamically imports `@xenova/transformers`, an `optionalDependency` absent in CI. The tested path is the injectable `pipelineFactory`. |
| `cortex-llm: rerank/transformers-rerank-pipeline.ts` | 1 | Same peer, same reason. The tested path is the injectable `pipeline` on `CrossEncoderReranker`. |

Both directions are asserted: an undeclared blanket site fails, and a declared site that no
longer carries one also fails — because that means the file became testable, which is a change
worth reviewing rather than a number that quietly improved.

### 4.4 The type-only files: the property, checked by the compiler

The claim "these files have no runtime code" was previously a comment. It is now a parse:

```ts
const source = ts.createSourceFile(path, readFileSync(path, 'utf8'),
  ts.ScriptTarget.ESNext, /* setParentNodes */ false);
const runtime = source.statements.filter((node) => !isTypeLevelExport(node));
expect(runtime.map((node) => ts.SyntaxKind[node.kind]), `...`).toEqual([]);
```

**This assertion was written the wrong way first, and the failure is instructive.** The
initial version pattern-matched lines and required each to start with `type` / `interface` /
`import type`. It failed immediately on `answerTemporal?: (` in `cortex-eval/src/types.ts` — a
multi-line function-type member of an interface, which any line-oriented rule reads as runtime
code. That is the same lesson as this file's own `math/stats.ts` section: **a claim about the
code cannot be verified by matching how the code is spelled.** The AST is the compiler's own
answer, so the AST is what asks the question.

A second correction came from the build rather than from a test: `ts.NodeFlags.Declare` does
not exist, and `ts.NodeFlags.Ambient` — the real name — is marked internal in the published
typings and therefore fails `tsc` while passing vitest, which does not type-check. The helper
tests the modifier list instead. Both corrections are recorded here because the pattern of
the mistake is the same in each: **the runtime's answer and the typings' answer are different
questions, and a test that only runs one of them will report on the wrong one.**

---

## 5. Verification: three injections, not an argument

A gate is only worth what it catches. Each new assertion was exercised against a deliberate
defect, and no assertion was accepted on its passing alone.

**Injection 1 — reintroduce `istanbul ignore file`** in `cortex-core/src/domain/provenance.ts`:

```
× contains exactly the declared files, with the declared counts
× declares a reason for every file that carries an annotation
× uses no `istanbul` prefix, because the v8 provider does not honour it
× does not suppress a whole file or block without declaring it
Tests  4 failed | 4 passed (8)
```

Four independent assertions fire, including the one written specifically for this hole.

**Injection 2 — add runtime code to a type-only file** (`export const DEFAULT_K = 10;` in
`cortex-core/src/interfaces/vector.ts`):

```
× leaves the type-only files unannotated because they compile to no statements
  → vector.ts: declares runtime code, so it needs tests rather than an exemption:
    expected [ 'FirstStatement' ] to deeply equal []
Tests  1 failed | 7 passed (8)
```

**Injection 3 — an undeclared block suppression** in `cortex-node/src/storage/pg.ts`:

```
× contains exactly the declared files, with the declared counts
× declares a reason for every file that carries an annotation
  → no declared reason for cortex-node: storage/pg.ts
× does not suppress a whole file or block without declaring it
Tests  3 failed | 5 passed (8)
```

Injection 3 also confirms the scope fix: the defect is in a package the old scanner never
visited.

---

## 6. Result

| | Before | After |
| --- | --- | --- |
| Packages scanned | 1 of 4 | 4 of 4 |
| Prefixes matched | `c8`, `v8` | `c8`, `v8`, `istanbul` |
| `istanbul` annotations | 6 (all invisible) | 0 |
| Line-scoped annotations pinned | 8 | 8 |
| Block suppressions pinned | 0 (unread) | 2 |
| Type-only exemptions asserted by AST | no | yes |
| `cortex-core` tests | 192 | **195** |
| Repository tests | 1843 | **1846** |

Coverage moved by **zero** on every dimension, which is the finding restated as a number:

| Package | Stmts | Branch | Funcs | Lines | Threshold |
| --- | --- | --- | --- | --- | --- |
| `cortex-core` | 98.74 | 98.67 | 100 | 98.74 | 95 ✅ |
| `cortex-node` | 100 | 98.61 | 100 | 100 | 95 ✅ |
| `cortex-llm` | 99.27 | 98.11 | 100 | 99.27 | 95 ✅ |
| `cortex-eval` | 99.88 | 99.05 | 100 | 99.88 | 95 ✅ |

`pnpm check` exits 0 (tools, build, lint, typecheck, census, tests, format).

---

## 7. What this document does not claim

**It does not claim the annotation set is now complete.** It claims the *scanner* is now
scoped and spelled so that a suppression cannot avoid it. Whether a given annotation's stated
reason is **true** remains unverifiable by this test — the `math/stats.ts` history in the
test's own docstring is the standing evidence, where six annotations carried a reason that was
false when written and became true only because two unrelated defects were fixed. Reachability
must be *measured*, by perturbing the code and observing it from outside; a pattern match
cannot do it.

**It does not claim the six deletions changed coverage behaviour.** They did not, by
construction — that is the point of §2, and the unchanged numbers in §6 are the measurement.

**It does not claim `cortex-llm`'s two block suppressions are permanent.** They depend on
`@xenova/transformers` being an optional peer absent from CI. If that dependency becomes
required, the reason field is false and the annotation should go — the register exists so that
this is a reviewed change rather than a silent one.

---

## 8. The generalisable finding

> **A gate written in the same terms as the thing it polices inherits the thing's blind
> spots.** This one enumerated suppressions by name, and was therefore blind to every
> suppression spelled differently — including a spelling that suppresses nothing at all.

Two habits follow, and both are cheap:

1. **Scope the scan to the container, not to the file's own location.** A test that says
   "the set is enumerated" and enumerates one directory is making a claim about the
   repository from evidence gathered in a fraction of it.
2. **Match more than executes.** For a *policing* pattern, over-matching is the safe
   direction: a false positive reaches a human, a false negative reaches nobody.

---

## 9. Addendum: the blind spot moved from the annotations to the report itself

This section extends the same audit after the annotation set reached zero. With no
suppressions left to find, the remaining uncovered counters looked like a code problem.
They were three different problems wearing the same `[0]`, and telling them apart required
reading the provider's raw output rather than its table. See `09` §41 for the campaign; what
belongs here is the mechanism, because it is the same lesson as §8 one level down.

### 9.1 The report is a projection that loses the evidence

`coverage-final.json` carries, per branch, a list of *locations*. Istanbul builds a branch
by pairing the sub-ranges the v8 provider emits for a decision. When the provider emits
**one** sub-range, the branch is built with **one** location — and a branch with one location
has no second arm to take, so it can only ever read zero. The table renders that as a missing
branch. Nothing in the table says "this counter was constructed from a single range".

Measured, by reading `NODE_V8_COVERAGE` directly on minimal subjects:

| construct | sub-ranges emitted | branch locations | readable count |
| --- | --- | --- | --- |
| `a?.[i]`, `a?.m()`, `a?.b` | 1 | 1 | always `[0]` |
| `c ? x : y` | 2 | 2 | both arms |
| `cond instanceof E ? a : b` | 2 | 2 | both arms |
| one-line `if (c) return v;` | 1 | 1 | always `[0]` |
| `try { } catch { } finally { }` | 1 (the `finally` line) | 1 | always `[0]` |
| the same function without `try/finally` | 0 on that line | — | — |

The last two rows are the control. The `finally` line emits one range with `count = 0` while
the block demonstrably executes — the statement on the same line counts 5. Remove the
`try/finally` and the line emits nothing at all. So the range exists *because of* the clause,
and a one-location branch cannot be satisfied by any test.

### 9.2 Depth is not a factor, and that inference was falsified

An earlier hypothesis held that attribution degraded with distance from the function head, on
the evidence that the open gaps sat 48, 77 and 641 lines below their heads while every
correctly-attributed synthetic probe sat 1-3 lines below. A probe holding the expression
constant and varying only the padding above it refuted this: the same ternary reported two
arms at distances of 1, 6, 11 and 17 lines, and a variant with five loops and ninety padding
lines still reported two. Distance was never the variable.

### 9.3 One `[0]` was neither an artefact nor a test gap — it was dead code

`truncateSession` ended with `return truncated ? marked : plain`, and the `plain` arm cannot
be reached. Reaching the return at all requires `text.length > maxChars`, and every turn
contributes to either `userChars` or the assistant guards, so a session that drops and clips
nothing forces `textLength <= maxChars` — a contradiction with the premise. Summing the
assistant guards telescopes to exactly that inequality, because the final turn has an empty
suffix. Exhaustively confirming it: 1,225,156 over-budget sessions (up to eight turns, bodies
0-8 characters, budgets 1-300) produced no counterexample. `tsc`'s `noUnusedLocals` supplied
independent evidence by reporting the flag as assigned and never read.

The disposition was to delete the arm, not to test it. **Writing a test for a dead arm
promotes a defect into a contract** — and three attempts were made and discarded before this
was accepted, one of which *passed* while returning at the early exit.

### 9.4 What this adds to §8

§8's finding was that a gate written in the object language inherits the object's blind
spots. This section adds the corresponding rule for measurement:

> **A coverage percentage is a summary of a summary.** The provider emits ranges; a
> transformer derives branches from them; a reporter aggregates branches. A single `[0]` can
> be a gap, an instrument defect, or dead code, and the aggregated table cannot distinguish
> them. Attribution requires going down a level to the ranges, where the count and the number
> of ranges are still separate facts.

The operational form, since this was violated four times in one session:

1. **Never conclude "unreachable" or "artefact" from the table.** Instrument the line, print a
   counter, observe whether the arm runs.
2. **A claim of unreachability needs a proof, not an argument.** Exhaustive search or a
   telescoping argument, as in §9.3 — plus, where available, an independent check such as
   `tsc`'s unused-local report.
3. **A passing test is not evidence it reached the branch.** Assert against the execution
   trace, not against the intent recorded in the comment.
