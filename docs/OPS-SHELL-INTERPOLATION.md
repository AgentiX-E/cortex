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
