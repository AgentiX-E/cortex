# Design: the queue head cannot name a retracted mechanism

## The failure this prevents

`RETRACTIONS.md` §1 closed the resolution-layering family (`C7`) on 2026-11-19. The pre-registered
consequence table was executed: the repository variable was reset to `raw`, the reading was written down,
and the mechanism was kept only as a documented, non-default option. Yet rounds §217 through §231 — fifteen
consecutive rounds — kept copying the same line into the tracking report:

```
5. **SOTA remaining path** queue head `resolution: raw` ¥3.57/1.5h ... (needs dispatch, not moved this round)
```

A queue head is a plan. A retracted family is not a plan. The stale pointer is self-reinforcing because each
round copies the previous round's line, so it survives as long as nobody cross-reads the retraction ledger.
The cost is not a wrong number — every round correctly said "not moved this round" — but a false belief that
work remains, which is exactly what note 13 ("do not keep digging in the same well") warns against.

`prereg-status.mjs` already refuses a decided registration cited as a plan, but only inside `PREREG*.md`.
The tracking report's queue-head sentence was the uncovered surface: a different file, a different shape.

## The mechanism

A retraction declares a machine-readable key in an HTML comment beside the section that closed it:

```markdown
## 1. resolution layering (C7) — 2026-11-19

<!-- retracted: resolution -->
```

`tools/stale-queue-guard.mjs` then applies five rules:

1. **Retraction set.** Collect every `<!-- retracted: KEY -->` in `RETRACTIONS.md`. An empty set is a hard
   failure — a gate that passes when its input is unmarked can be bypassed by deleting a comment.
2. **Latest round only.** A report is a log. The plan is the text from the last `### NNN.1` heading to the
   end of the file. Older rounds are history and are not checked; citing a closed mechanism in a historical
   round is legitimate. The whole round is taken, not just the last sub-section, because the queue head
   lives in the "six questions" sub-section and a "maturity/SOTA verdict" sub-section often follows it —
   taking the final heading would skip the very sentence under test.
3. **Family key.** A back-ticked token is reduced to the part before `:` and normalized, so
   `resolution: raw` names the family `resolution` — the thing that was closed, not the default that
   replaced it. This is deliberate: qualifying with `raw` is precisely how the stale pointer disguised
   itself as a live configuration.
4. **Acknowledged citations pass.** A queue-head sentence that names a retracted key is a finding _unless_
   it also acknowledges the closure (`result` / `closed` / `retract` / `refut` or the Chinese equivalents).
   A later round must be able to say "that axis closed; here is why" without tripping the gate.
5. **Paired delimiters mark a citation, not a plan.** A token inside quotes or parentheses — `“”`,
   `「」`, `（）`, `()`, `【】`, `[]`, `"…"` — is a citation of, or an aside about, the mechanism under
   discussion. This lets the audit round that _finds_ the bug quote the stale head ("it wrote
   `resolution: raw` as the head", "the stale head (`resolution: raw`)") without becoming a new violation.
   A plan states the head in bare prose. Only matched pairs count, so a lone opening delimiter cannot
   swallow the rest of a line. This rule was added when the round-232 audit itself tripped the gate — the
   guard must not make an honest audit impossible to write.

The finding names the rule, the key, and the back-ticked token, so the failure tells the reader which line
to correct rather than only that something is wrong.

## Test method (red → green → mutation)

`tools/__tests__/test_stale_queue_guard.py` covers six cases over in-memory fixtures plus the real documents:

| case                              | expectation                                         |
| --------------------------------- | --------------------------------------------------- |
| queue head names a retracted key  | rejected, message contains the key                  |
| sentence acknowledges the closure | accepted                                            |
| key absent from the ledger        | accepted                                            |
| stale head in an older round      | accepted (history is not a plan)                    |
| ledger with no markers            | rejected (fail closed)                              |
| real tracking report              | rejected before §232, accepted after the correction |

The pure functions `census`, `retractedKeys`, `latestSection`, `headLines` and `familyKey` are exported, so
`--self-test` exercises each rule without a temporary directory and without the rules seeing the repository
they are normally pointed at. Mutation check: replacing the family-key membership test with `if (true)
continue` makes the stale-head case fail again; restoring it makes all cases pass. The test therefore pins
behavior rather than a vacuous assertion.

## Wiring

`guard:stale-queue` runs the self-test and the real-document check, and is inserted into `check` immediately
after `guard:prereg` — the two guards cover the same defect class (a closed thing cited as a plan) in two
different surfaces.

## What is not covered

Prose that names a mechanism without a back-ticked key is not parsed; this is intentional, because a prose
analyser would produce more false findings than the defect it catches. The 431-question population and
LoCoMo-300 queue entries carry no mechanism key, so they are legitimate pending items and are not touched.
The guard checks _consistency between two documents_, not whether a queue item is worth doing — that remains
a pre-registration decision.
