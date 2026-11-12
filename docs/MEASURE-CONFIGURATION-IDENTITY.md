# MEASURE — Which configuration did this number come from?

## 0. One paragraph

Section 13.336 adopted a six-route character-room allocation and moved three files: §10.3 of the
pre-registration, `tools/dispatch-cortex-memory-ab.py`'s `INPUTS`, and `tools/arm-config-baseline.json`. Six
acceptance rows read four generated evidence files, and not one of those files moved with it. The rows were not
wrong in the sense this repository usually means — every file named its run, and every run was real — they were
wrong in the sense that matters more: **a correct record of a configuration the project does not ship**. The bill
was overstated by 24.2% for a round. This document is the playbook for the class, the numbers the repair produced,
and the three things the repair does not reach.

## 1. Why provenance is not identity

§2.1 of `ACCEPTANCE-MATRIX.md` built an attestation for exactly this shape of defect, and it has three clauses:
`shipping.accuracySource == repetition-mean`, `shipping.runs == 4`, `shipping.arm == route-room`. The third one
came with a sentence that is worth quoting because it is the sentence that failed:

> `shipping.arm == route-room` — the shipping arm is a **label** the tool resolves to an artifact on every run, so a
> label that stops existing cannot silently resolve to an older file

The label did not stop existing. `route-room` was still spelled `route-room`, and it resolved — to the
single-route widening (`{multi-session: 48460}`) that the six-route allocation replaced. **A label is a name, and a
name outlives its meaning.** The three clauses answer *how was the number computed* (a mean of four repetitions,
not a first repetition) and *is the artifact well formed*; none of them answers *which configuration*, and the
fourth question is the one the adoption invalidated.

The same failure, one indirection further out, is the one §2.2 records: four rows reading `summary.json` because
the file existed and had the right shape.

## 2. What the adoption actually changed, in the unit each row bills in

| row | printed before | registered configuration | difference |
| --- | ---: | ---: | ---: |
| `C1` prompt tokens per question | 12,137 | **9,201** | **−24.2%** |
| `C1` prompt tokens per correct answer | 13,207 | **10,105** | **−23.5%** |
| `S1` overall | 91.95% | 91.05% | −0.90 |
| `S2` `KU` | 88.54% | 87.15% | −1.39 |
| `S3` `MR` | 83.88% | 83.06% | −0.84 |
| `S4` `TR` | 96.06% | 95.08% | −0.98 |
| `S5` `ABS` | 100.00% | 100.00% | 0.00 |

The two halves have different characters and must not be averaged into one sentence. The accuracy differences are
all smaller than the **0.90-point span three draws of the predecessor configuration produced** (91.95 / 91.65 /
91.05, §13.336.1), so they are not effects and no capability changed. The bill difference is not noise in any
frame; it is the axis the adoption existed for, and the matrix had been reporting the pre-adoption figure.

`C1`'s own text is the part that aged worst. It said, in the sentence that ended the row: *"this row keeps its
12,137 because the registered configuration has not moved."* The registered configuration moved on 2026-11-09.

## 3. The instrument

`tools/registration-attest.py` answers one question — is this artifact a measurement of the configuration the
project registers — and three files had to change for it to be answerable.

| piece | where | what it does |
| --- | --- | --- |
| `canonical()` / `fingerprint()` | `tools/arm-config-record.py` | `sha256:` over `memoryArmConfig` with sorted keys and no whitespace; one implementation, because a second copy of "what is a configuration" is the class of defect this document is about |
| `memoryArmConfigFingerprint` | `tools/arm-config-baseline.json`, written by `--record` | the configuration the project registers, beside the configuration itself |
| `attestation()` / `differences()` | `tools/registration-attest.py` | matched or not, the fingerprint either way, and the dispatch inputs that moved, projected through `PROJECTED` rather than restated |
| `require_registered()` | `cost-ledger.py`, `evidence-budget.py`, `capability-ledger.py` | `--write` refuses an artifact of another configuration and names the field |
| `shipping.configurationFingerprint` | `tools/efficiency-frontier.mjs` | the shipping arm's configuration, computed in Node from the same canonical form |
| `CONFIGURATION_ATTESTED` | `packages/cortex-eval/src/acceptance.ts`, checked by `tools/acceptance-check.mjs` | fails the check when a committed evidence file names a configuration that is not registered; an absent file is printed as skipped, because CI checks out one repository |

```
$ python3 tools/registration-attest.py <artifact>
registered: sha256:0c6c25e7…480075 (run 42533236864, §13.336)

$ python3 tools/registration-attest.py <the pre-adoption artifact>
this artifact is not a measurement of the registered configuration (tools/arm-config-baseline.json).
  applied    sha256:8c72ad24…0e0d5bd
  registered sha256:0c6c25e7…480075  (run 42533236864, adopted by §13.336)
  cortex_memory_max_prompt_chars: the baseline records 'abstention:24000,assistant:24000,flat:24000,
    knowledge-update:24000,multi-session:48460,temporal:48000' and this artifact applied 'multi-session:48460'
Refusing to write an evidence file from it. …
```

## 4. Three properties, pinned by tests rather than by intent

1. **The fingerprint decides; the difference list only diagnoses.** The two can disagree in one direction — a
   baseline recorded before the projection gained an input — and ANDing them would report a *correct* record as a
   defect, whose repair is to re-record a baseline that was not wrong. `matched` is the fingerprint comparison and
   nothing else.
2. **The refusal has no override.** An artifact of another configuration is still readable — `--json` prints the
   ledger from any artifact, which is what the experiment reports do — it simply may not become the file a
   criterion reads. An override would be the flag that gets passed on the day the build is red.
3. **The fingerprint crosses languages.** `efficiency-frontier.mjs` hashes in Node and `registration-attest.py` in
   Python; `test_the_shipping_fingerprint_matches_the_python_one` runs both on one fixture and asserts equality. A
   gate that fires on every green run is a gate that gets deleted, and this repository has deleted two.

## 5. What the repair does not reach

**`S1`'s gate now has 0.05 points of margin.** The threshold is 91.0%, derived in §2.1 as 2.2 standard errors below
a reading of 91.95%, and the registered configuration reads 91.05%. Re-deriving it would restore the margin and
would be indistinguishable from lowering the bar to stay green, which this file refuses everywhere else — so the
threshold stays and the consequence is written down instead: the next dispatch that reads below 91.0% is reported
as a regression whether or not one occurred, and that is a fact about the population's resolution rather than about
the row. The honest repair is a higher reading, not a lower threshold.

**`C2`'s denominator is still the 48,000-everywhere control.** `room-cut.json` compares two arms that differ in one
field (`maxPromptChars` 48,000 → 24,000), which is a valid experiment and is why its ratio of 0.487 was not touched.
What changed is what the ratio is *of*: the registered configuration already delivers four routes at 24,000, so the
reduced arm is no longer a preview of a budget the project might adopt — it adopted most of it. Re-basing the row
needs a dispatch, because no artifact runs the six-route room at 24,000 everywhere, and inventing the number would
be worse than the wording fix.

**`E3.2` remains unscored, and it is no longer the room.** The repair criterion asks that the 494 non-targets of
`replyRepair=commitment` reproduce their correctness mask against a control. `42791109966` is that control's pair —
`replyRepair=commitment` on the adopted allocation against `42533236864`, one variable apart — and the criterion
still cannot be read, because the artifact records `attempted: 6` and cannot say which six: it is a criterion about
a **set**, and two integers do not name one. That is an instrument defect rather than an archive limitation, and
§13.358.4 repairs it (`replyRepair.<kind>.questions`, summed across pool instances, refused whole when a payload
predates it). The next dispatch that carries the switch can score the mask; this one could not, and the mechanism is
rejected on `E3.1` in the meantime.

**Three defects in this round came from one rule stated in the wrong vocabulary**, and it is worth naming once: an
acceptance row that named the wrong configuration (a label that resolved to a replaced file), a registered
condition written as text where the arm writes a boolean (a control run departing from its own registration), and a
criterion written in counts derived at a room the run does not use (a band that cannot transfer). Each was a record
that described one thing in the dialect of another, and each was found by reading two records against each other
rather than by re-reading either alone.

## 6. The standing rule

> An evidence file may not outlive the configuration it describes. A row that names an artifact must name *which*
> artifact, and "which" means the configuration, not the run and not the label.

The mechanism is the fingerprint. The rule it replaces — "a label cannot silently resolve to an older file" — was
true for an hour in 2026-11 and was the third time in this campaign that a defence was written as a sentence about
why a name is safe.

## 7. The block's vocabulary grew, and the gate called it an adoption

The identity in §3 is the SHA-256 of `memoryArmConfig` as a whole. That block's **key set is not fixed**:
`bench-memory-arm.ts` spells `conflicts: false` "on every run from this point and as a missing field on every run
before it", and `replyRepair` arrived the same way. So a repeat of the *same* configuration, produced after those
two fields appeared, hashes differently from the record written before them, and three things happened at once:

| what a reader saw | what was true |
| --- | --- |
| `--record` refused every artifact produced after the fields appeared | the partition had no class for them: not in `PROJECTED` (no dispatch input carries them) and not in `UNPROJECTED` |
| the attestation refused an artifact of the registered arm | the fingerprint moved on vocabulary, not on configuration |
| the refusal **named nothing** | `differences()` projects onto `PROJECTED`, so it had no field to report and returned `[]` |

The third is the one that matters. §5 of `registration-attest.py`'s own docstring says a refusal that says only
"the configuration differs" sends the reader to diff two JSON files; `refusal()` builds a sentence precisely so it
does not. Against artifact `43140878641` it printed the two hashes, the adoption section, and then nothing —
the strongest possible claim (this is not the configuration) attached to the weakest possible evidence.

### 7.1 Why the guard missed it

`test_every_recorded_field_is_classified` asserts the partition on `arm-config-baseline.json`'s block — the
**record**. A field added to the arm after the record was written cannot appear there, so the reverse direction was
asserted against the one artifact that could not carry the defect. The field `conflicts` was in every artifact
produced since §13.352 and in no artifact the test looked at.

### 7.2 The repair, in three parts

1. **The class is derived, not restated.** `arm-config-record.py`'s `conditions()` is
   `readout-arm-run.py`'s `REGISTERED_CONDITIONS`, which already says three things this file needed: the artifact
   field name, the **registered value**, and the rule that a side omitting the field reads as that value.
   `classification()` is the single predicate the refusal, the diagnosis and the tests now share, so the family is
   total by construction — a fourth condition is classified the moment it enters that table.
2. **Conditions are compared, not skipped.** `condition_differences()` compares each condition verbatim, treating
   absence on either side as the registered value. That is why a control run of `{conflicts: false}` agrees with a
   record written before the field existed, while `{conflicts: true}` against the same record is named with both
   values.
3. **An empty refusal is now impossible.** `unprojected_differences()` runs when the projected inputs and the
   conditions all agree and the hash still differs, and names the three shapes the cause can take: a field the
   artifact carries and the record does not (with its class), a field the record carries and the artifact does
   not, and a value that moved outside the projection. Against `43140878641` it prints:

   ```
   conflicts: this artifact carries False and the record does not -- classified `condition`, so the field
   was added to the arm after the record was written
   replyRepair: this artifact carries 'off' and the record does not -- classified `condition`, so the field
   was added to the arm after the record was written
   ```

Six assertions pin the three parts, and all six were verified red by deleting the code they cover
(`condition_differences` call, the empty-diagnosis fallback, and the `condition` branch of `classification`) before
restoring it.

### 7.3 What was deliberately *not* done: the re-record

The obvious next command is `--record` from `43140878641`, and it was run: the artifact attests, and `C1` moves
**9,201 → 9,168 prompt tokens per question** (−0.36%) with `S1`'s reading moving **91.05% → 91.25%** (+0.20 points,
inside the 91.05 / 91.60 span the same configuration already produces). Both moves are real and neither is
interesting. Both were reverted, because a registration is four files and only three can be rebuilt today:

- `cost.json`, `categories.json` and `evidence-budget.json` regenerate from one artifact;
- `frontier.json` is a **six-rung ladder**, and the run each rung came from is not recorded in the file — only its
  label and its numbers are. Two of the six artifacts exist in this workspace.

Re-recording on those three alone puts `C1` (new artifact, new fingerprint) beside `S1` (ladder, old fingerprint) —
which is §13.336.1's defect with the sign reversed: rows reading two records of one configuration, one of which
cannot be regenerated. The matrix would be right about both numbers and wrong about the thing it promises, so the
re-registration stays queued as its own change, whose first task is to recover the ladder's six artifact ids (the
`provenance` block should have carried them; it does not, and that is a second defect this round found and did not
fix).

**What this costs while it is queued: 33 tokens per question on `C1` and 0.20 points on `S1`** — the difference
between the registered arm's two recorded repetitions. That is small enough to leave for a change that can be
finished, and large enough that it must be written down rather than rounded away.

### 7.4 The standing rule, amended

> An evidence file may not outlive the configuration it describes — and a **field** entering the artifact is not
> the configuration moving. The gate must be able to tell those apart, because a gate that cannot is either deleted
> or obeyed for the wrong reason.
