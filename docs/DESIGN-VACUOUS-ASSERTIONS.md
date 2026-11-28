# Vacuous Assertions: A Test That Cannot Fail Is Not a Test

## Summary

Three tests asserted propositions that held regardless of whether the implementation was correct.
Two were strengthened into assertions that a mutation of the implementation actually fails; the
third was removed because its only non-vacuous assertion was already covered elsewhere. No product
code changed: the defects were in the tests, which is precisely why four rounds of product-side
fixes could proceed while these gaps remained green.

## 1. Sinkhorn: `cost >= 0` and `iterations > 0` prove nothing

`edge-cases.test.ts` checked that `sinkhorn` returned a non-negative cost and a positive iteration
count. Optimal transport cost is non-negative by construction and any run performs at least one
iteration, so an implementation that returned a wrong coupling — one with the wrong marginals, or a
coupling the two inputs never admitted — would still pass.

The test now asserts what the solver actually promises: the returned coupling has the requested row
and column marginals (to six decimal places), the solver reports `converged: true`, and the cost is
strictly between zero and one for a matrix whose only entries are zero and one. Mutation check:
forcing `converged = false` in the implementation fails the test with `expected false to be true`.

## 2. Retrieval hit index: all-zero vectors make every ranking identical

`retrieval.test.ts` embedded every turn as a zero vector, then asserted that the hit indices sorted
to `[0, 1, 2]`. With all scores tied, that holds for a correct ranking and for a reversed one — the
test could not distinguish `index: rank` from an implementation that assigned indices from input
order, duplicated them, or shifted them.

`index` is deliberately the rank (`retrieval.ts` documents why the old id-map lookup was removed),
so the meaningful assertion is that ranks are in score order and each rank names the right turn. The
test now embeds distinguishable vectors — the query aligns with `c`, is orthogonal to `b`, and
opposes `a` — and asserts both `index === [0,1,2]` and `text === ['c','b','a']`. Mutation check:
changing `index: rank` to `index: 5 - rank` fails with `expected [5,4,3] to deeply equal [0,1,2]`.

## 3. Reader identity: a dead assertion on a local variable

`reader-identity.test.ts` contained `expect(() => metrics).not.toThrow()` where `metrics` was a local
object literal; reading a variable cannot throw, so the assertion was always true. Its other
assertion — that `TEMPERATURE=0` resolves to a pinned value — was already covered verbatim, and the
rendering claim in the test title was already asserted precisely elsewhere in the same file
(`line(pinned)` contains `temp=0` and not `temp=default`). The test was removed rather than
duplicating existing coverage; no assertion was lost.

## Why this belongs in the test layer

Each change is pinned to the test's own title. A test that claims to verify convergence must check
the coupling; one that claims to report hit order must produce a non-degenerate order; one that
claims to render a value must render it. The mutation checks are the evidence that the new
assertions are stronger: each one fails when the specific behavior it names is broken. Product code
was left untouched, so there is no behavioral or cost risk, and coverage still clears every gate.
