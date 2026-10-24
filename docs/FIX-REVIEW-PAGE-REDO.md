# FIX — the review page could not be redone, and its finish screen never appeared

> Found by the person the instrument exists for, on their first attempt at the A3 review. Two
> defects, both in `packages/cortex-eval/src/review-page.ts`; both now pinned by a unit test and by a
> real-browser probe (`packages/cortex-eval/test/review-page/probe.mjs`, 17 checks).

## The report

> "I don't understand when to Accept and when to Dismiss, and I can't redo or reset the questions I
> have already done."

The first half is a usability defect of the same kind the repository keeps finding: the rubric was in
`evidence/a3-review/README.md`, and the page said only one sentence about it. The second half was
worse than a missing button.

## Defect 1 — the finish screen was never displayed

The stylesheet carried `.done{display:none}`, and the script revealed the section with
`el.done.hidden = false`. Removing an attribute does not beat a class rule, so the section stayed
`display:none`. After the fortieth judgement the script cleared the card body and showed a section
nobody could see: **a blank page**, with the download button inside the invisible section.

Why the existing test missed it: the end-to-end run in step 16 drove forty clicks and then read
`#a3-json`. A textarea is scriptable while its ancestor is hidden, so the export was filled, the
assertion passed, and the person got an empty screen. **Reading a value is not clicking a button.**

## Defect 2 — `Start over` existed only after finishing

`#a3-reset` lived inside `<section id="a3-done">`. So the only control that discards a run was inside
the part of the page that appears when the run is over, and which — see defect 1 — was not appearing.
A person who wanted to start again at card seven had no route back except clearing site data by hand.

## The fix

| Change | Reason |
| --- | --- |
| Removed `.done{display:none}` | The `hidden` attribute already hides it; a second rule that cannot be un-set is not a style, it is a trap |
| `Undo last` and `Start over` moved into the sticky bar | A control that undoes a run has to be reachable **during** the run. `Undo` was not asked for and is the more useful of the two: a mis-click costs one card, not twenty |
| `Undo` works for skips as well | A skip is a decision about the instrument, so it is counted and persisted; it must be reversible by the same button |
| Skips are persisted, and reported when they shrink N | They are counted in the progress and **not** written to the JSONL (the scorer reads judgements; a skip is the absence of one). A count that shrinks silently is how twenty pairs becomes sixteen |
| The saved shape is read in both versions | `{trials, skipped}` now; a bare array was the old format. Twelve existing judgements are unrepeatable, so a version bump must not drop them |
| A `How to judge` panel on the page, with one example per button | The rubric has to travel with the instrument; nobody opens the README before clicking |

The undo cursor needs no history array: the cursor only moves forward, so the last action is the
recorded step with the highest index. Recomputed from what is stored, which means it is also correct
after a reload.

## Evidence

- `probe.mjs` drives a real Chromium over a loopback origin and measures `offsetHeight`, not text.
  17 checks: controls reachable at start, undo restores count and card, undo removes the line from the
  export, skip counted but not exported, undo takes back a skip, start over empties both, finish
  screen visible (263 px), export parses as six JSONL lines, summary lists both arms.
- Injecting `.done{display:none}` back turns exactly one check red ("the finish screen is visible —
  0px"); removing the two controls from the bar turns two red. Both were confirmed, then reverted.
- Four unit tests added to `review-page.test.ts`: the stylesheet must not hide a section the script
  reveals with the `hidden` attribute; the reset and undo controls must precede `#a3-done` in the
  document; the client script must parse as JavaScript (a backtick in a comment truncates the
  `String.raw` template — I repeated that mistake in this very change and the compiler caught it); the
  panel must name all four buttons and say that a skip costs the pair.

## What this does not fix

The measurement is still not blind: a reviewer can see whether they are judging a paragraph or a
list. Hiding that needs a different interface, not a flag, and it is recorded as a limit of A3 rather
than papered over.
