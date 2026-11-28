# Design: the committed reading must prove its own round trip too

## The failure this prevents

`tools/browser-reading-check.mjs` compares two committed browser artifacts (`last-run.json` and
`last-run-firefox.json`) without launching a browser. It checks, on **both** sides, that the failed count
is zero and that the tier is `opfs` — because a reading taken on the IndexedDB fallback would print 24
passes about the wrong engine. It checks the check names on both sides too.

The digest was the one criterion applied to only one side. Line 172 read `digestHeld(fresh)` alone, while
the success line claimed both files were `both digest-matched`. A committed artifact whose round trip had
never held — `summary.digestMatches: false`, or a bundle reading whose written and read digests differ —
still exited 0, and the verdict asserted a property nobody had verified for that file.

This is the artifact failure mode the test file's own header describes: an artifact can stop describing
the tree while continuing to say `24/24`. The committed file is exactly the artifact that is trusted on
every push, so an unchecked criterion on it is worse than an unchecked criterion on a freshly produced
reading.

## The fix

Apply the criterion symmetrically:

```js
if (digestHeld(committed) !== true) {
  problems.push('the committed reading did not read back the digest it wrote');
}
if (digestHeld(fresh) !== true) {
  problems.push('this run did not read back the digest it wrote');
}
```

The two messages are labeled differently on purpose. The existing fresh-side test asserts the phrase
`this run did not read back the digest it wrote`; keeping it means the fix adds a rule without rewriting
an established assertion. The committed-side message names the file role, so a failure says which of the
two artifacts broke.

`digestHeld` already understands the two shapes these artifacts take: the restart/corpus suites record
`summary.digestMatches`, and the single-launch bundle suite records `facts.roundTrip.written` and `.read`
for the page to compare. Both proofs now run for both sides. Only matched proofs count — `undefined`
(the file says nothing readable) is still a failure, because a gate that skips missing evidence is a gate
that can be passed by deleting a field.

## Test method (red → green → mutation)

`tools/__tests__/test_browser_reading_check.py` gains a case that clones the committed Chromium reading,
sets `summary.digestMatches = false` on the **committed** side, leaves the fresh side intact, and asserts
a nonzero exit plus a message naming the committed reading.

| stage                                     | result                                                         |
| ----------------------------------------- | -------------------------------------------------------------- |
| against the old code                      | red — exit 0, verdict falsely reads `both digest-matched`      |
| after the symmetric fix                   | green — 12 cases pass in the file, real artifacts still exit 0 |
| mutation: remove the committed-side check | the new case fails again                                       |
| restore                                   | 12 pass                                                        |

The mutation is important here because the assertion is about an _absence_ being handled: a test that
only checked the success path could not distinguish the fix from a no-op. Reverting the fix and watching
the test fail proves it pins the committed-side criterion rather than the already-covered fresh side.

## What is not changed

The check-list comparison, the failed-count check, and the tier check were already symmetric and are
untouched. The digest proof readers are unchanged. No browser is launched by this gate and no Runner
secret is involved; the fix is a pure artifact-consistency rule and carries no LLM or embedding cost.
