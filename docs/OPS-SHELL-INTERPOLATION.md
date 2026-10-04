# OPS — Shell Interpolation Is Not a Templating Language

## 1. What happened

A probe script was passed to `bash -c` as a quoted heredoc body containing
TypeScript template literals. The shape was:

```text
npx vitest ... -e "
const rows = `threshold=${String(t).padEnd(5)} -> ...`;
"
```

(The block above is deliberately `text`, not `sh`, and the literal is shown
without its own interpolation markers. `tools/check-shell-interpolation.py`
scans only ```sh blocks, so a counter-example quoted in prose cannot make the
guard fail on the document that explains the guard. That is not a loophole: the
guard's job is to stop the pattern reaching an executable command, and this
block is never executed.)

The tool layer rejected the call before it ran:

```
Failed to run function tools: Error: Bad substitution: String
```

The command never executed. The failure is not a TypeScript error, a vitest
error, or a repository error — it is the **shell** expanding `${String(t).padEnd(5)}`
as a parameter expansion, finding `String(t).padEnd(5)` is not a valid
substitution, and aborting the whole invocation.

## 2. Why this class of mistake keeps recurring

Two languages were being written in the same token stream, and only one of them
gets to see the text first. The shell expands `$` constructs **before** the
program it launches ever receives them, so anything the inner language spells
with `${...}` is at risk of being consumed by the outer one.

There are two failure directions, and the dangerous one is the quiet one:

| Direction | Result | Danger |
| --- | --- | --- |
| `Bad substitution` | command aborts | **loud** — nothing runs, nothing is believed |
| Silent expansion | `${X}` becomes `""` or a shell variable's value | **quiet** — the command runs and reports a result computed from mangled input |

The quiet direction is why this is worth a document rather than a style note: a
probe that silently interpolates an empty string produces a *plausible* number,
and a plausible number is far more expensive than an error. This repository has
recorded that shape four times already (a mock that agreed with itself, a
coverage gate that measured noise, a denominator that could not move, a symptom
attributed to the wrong layer).

## 3. The rule

> **Code that is not shell is never passed through the shell as text.**

Concretely, for anything longer than a single simple command:

1. **Write the program to a file**, then execute the file.
2. **Prefer a real source file** when the program is JavaScript or TypeScript that
   the repository's own tooling can run — then it is covered by lint, typecheck
   and the test suite, and it survives the session that wrote it.
3. If a here-doc is genuinely the right tool, **quote the delimiter** (`<<'EOF'`,
   not `<<EOF`). A quoted delimiter suppresses expansion inside the body.
4. **Never place a `${...}` belonging to an inner language inside unquoted shell
   quoting.** In TypeScript this means building strings with concatenation or
   with a variable the shell cannot see, rather than with template literals.

## 4. What was done about it, not just recorded

`tools/check-shell-interpolation.py` scans every shell command this project
records in its own scripts and tooling for the pattern, and fails when an inner
language's `${...}` appears inside unquoted shell quoting. It is wired into
`pnpm test:tools`, so the class is checked rather than remembered.

The scanned set is deliberately narrow: this is a guard against a mistake made
while *authoring* commands, not a linter for arbitrary user shell. It looks for
the specific collision — a `${` sequence whose contents are not a valid shell
parameter expansion — inside a double-quoted or unquoted region.

## 4a. The second recurrence, and what the first fix missed

The class recurred after the guard was in place, with
`Bad substitution: lines[l-1].trim`. The guard was correct about
*classification* and wrong about *coverage*, in two independent ways, and both
had to be fixed before the guard was worth anything.

**One: the guard never ran on the thing that failed.** It scanned `tools/*.py`
docstrings and ```sh fences in `docs/*.md` — files on disk. The failing command
was a probe held in a command string, never written to a file, so a filesystem
scan could not see it. A guard that inspects only what was committed cannot see
the mistake at the moment it is made, which is the only moment it is cheap.

**Two: it had a false negative even on the text it did scan.** The original
quoting model handled a backslash-escaped `$` incorrectly, so `echo "\${X}"` —
where the shell does *not* expand — was reported, while the real boundary was
unverified. The rule was re-derived against a real shell rather than reasoned
about, and the five cases below are now pinned by tests:

| Fragment | Shell prints | Expands? |
| --- | --- | --- |
| `echo \${X}` | `${X}` | no — backslash escapes the dollar |
| `echo "\${X}"` | `${X}` | no — the escape works inside double quotes |
| `echo ${X}` | value of `X` | **yes** |
| `echo "${X}"` | value of `X` | **yes** |
| `echo '${X}'` | `${X}` | no — single quotes |

The fix has two parts:

1. **`--fragment` mode**, so a command can be checked *before it is run*, on the
   text that actually failed. `pnpm guard:sh` reads the fragment on stdin.
2. **A quoting model that matches the shell**, with the escaped-dollar case
   handled and each expectation taken from a real `sh` rather than from
   reasoning.

One test written during the fix asserted that `'it'\''s ${X}'` expands. The shell
says it does not — the trailing quote opens a run that swallows the expansion —
so the test was **deleted rather than satisfied**. A test may only pin behaviour
the tool it tests is actually required to match; writing the scanner to agree
with a wrong assertion would have made the guard confidently wrong.

## 4b. The third recurrence, and why the first two fixes could not have worked

The class recurred twice more after §4a, with `Bad substitution: h.join`. The
fixes in §4 and §4a were both *correct* and both *incapable of preventing it*, and
the reason is worth stating plainly because it is a trap any guard of this kind
falls into.

**A guard that inspects the filesystem cannot see a command string.**

Every tool call that failed was a program written *inside a shell command*. The
guard scans `tools/*.py` and `docs/*.md` — files already on disk. The failing text
was never on disk at the moment it mattered, so there was no step at which the
guard could have run. Adding more file-scoped checks (as §4a did) does not change
that, and it produced a worse outcome than doing nothing: three recorded
"fixes", each verified with passing tests, against a failure none of them could
observe.

The second trap is subtler and cost two attempts on its own: **the fix is
delivered through the broken channel.** Writing a test whose fixture contains the
hazard means the edit that carries the fixture dies before the file is written.
The test is right and cannot be saved. Four attempts failed this way, each one
identified, each one fixed by assembling the hazard from `chr(36) + chr(123)`.

### What actually stops it

The precondition is a program living in a command string. Remove the precondition
rather than detect its consequences:

1. **`tools/run-program.py`** runs a program from a file (or stdin) with the
   interpreter chosen by extension. The shell never sees the text. It also refuses
   a program the interpolation guard rejects, so the rule is enforced at *run*
   time and the flag is a lint error rather than a lost invocation.
2. **A stored-hazard rule**, in `check-shell-interpolation.py`, on top of the
   existing classifier: a string literal passed to `write_text` / `write` must not
   contain the hazard, because such a literal is reproduced byte-for-byte into
   whatever carries it. This is the rule that breaks the delivery loop. Prose and
   comments are exempt — naming the hazard is how it gets explained, and this
   document does so throughout.
3. **`pnpm guard:sh`** for a one-off fragment, so a command can be checked before
   it is run rather than after it is lost.

The scope of rule 2 is deliberately narrow and the first draft was wrong: it
flagged every occurrence, producing 69 violations, most of them the guard's own
documentation. A rule violated by the document explaining it is a rule that
measures the wrong thing, so it was rewritten to match only what a copy would
carry.

### The behaviour rule, for the parts no tool can see

Whatever the tooling, the operative discipline is: **do not write a program inside
a shell command.** Write it to a file, then run the file. A single simple command
is fine; the moment a command contains an `=`, a `=>`, a `function`, or a
multi-line program, it belongs in a file — where it is also covered by lint,
typecheck and the suite, and survives the session that wrote it.

## 4c. The fourth recurrence: the tooling was complete and bypassed

The class recurred once more, as `Bad substitution: JSON.stringify`. Unlike §4b,
**no new mechanism was missing.** Both remedies §4b prescribes already existed and
both were skipped:

| §4b remedy | status at the time of the failure |
| --- | --- |
| `tools/run-program.py` — run the program from a file | existed, unused for this probe |
| `pnpm guard:sh` — check a fragment before running it | existed, unused for this probe |
| Stored-hazard rule in the classifier | existed, and passing |

The failing call was a one-liner that embedded `JSON.stringify(...)` inside a
double-quoted `node -e` argument, written inline while a probe fixture was being
searched for. It is detected by the shipped guard, which was verified afterwards
against the exact fragment and returns `rc=1`:

```
$ python3 tools/check-shell-interpolation.py --fragment - # fragment below
node -e "console.error('PROBE ' + ${JSON.stringify(sides)})"
→ 1 shell-interpolation violation(s):
    ${JSON.stringify(sides)} is not a shell parameter expansion; the inner
    language's interpolation would be consumed by the shell
```

So this recurrence is not evidence of an incomplete fix, and adding a fifth
mechanism would be the wrong response — §4b already records that response's
failure mode (three verified "fixes" against a failure none could observe). The
distinct fact here is that **the guard is only as good as the moment it is
consulted**, and the moment it is needed is precisely the moment a command is
being improvised inline rather than written to a file. An improvised one-liner has
no step at which a check runs by default, which is the same structural gap §4b
identified from the other direction.

The operative rule is therefore strengthened from "check before running" to:

> A probe that computes anything the probe's *diagnosis* depends on is a
> **program**, not a command. Write it to a file and run it with
> `tools/run-program.py`. Consult `pnpm guard:sh` only for the residue — genuinely
> single, static commands.

The distinction is not stylistic. Every one of the four recurrences was a probe
whose purpose was to print an intermediate value (`h.join`, `String(t).padEnd(5)`,
`JSON.stringify(...)`) that the next decision depended on — exactly the probes that
must be reproducible and reviewable, and exactly the ones an inline command makes
unreviewable.

### The measurement that was interrupted

The interrupted probe was searching for a fixture in which
`retrievalCandidateSides` returns two sides but `clusterCandidates` yields zero
clusters — the input needed to exercise `annotateWithCandidateSides`'s
`clusters.length === 0` return at `natural-language-memory.ts:1375`. That
reachability question is still open and is resumed below; the probe is now a file
rather than a command string.

## 5. The measurement that this document interrupted, for the record

The probe above was measuring why a repair changed nothing. It was re-run from a
file and gave the answer, which is recorded in
[`PREREGISTRATION-CORTEX-MEMORY-ARM.md`](PREREGISTRATION-CORTEX-MEMORY-ARM.md) §7.5:
the admission value function has a reachable ceiling of `0.5` for the evidence
this arm supplies, so a retrieval threshold of `0` can never close the gate. The
dispatch that used `0` was therefore a no-op on the retrieval path, which is why
`6.45%` matched `6.40%`.

The lesson and the measurement are one story: the tool failure cost one
invocation, and re-running it from a file produced the decisive number
immediately. The rule in §3 is not caution for its own sake — it is what made the
next attempt answer the question.
