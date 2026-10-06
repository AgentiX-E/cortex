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

## 4d. The fifth recurrence: the mechanism already worked, and cost was the whole defect

The class recurred once more, as `Bad substitution: String`, while a ceiling
measurement was being improvised inline. §4c's conclusion held — no mechanism was
missing — and this section records what was done differently, because "strengthen the
rule again" had already been tried and had already failed.

### What was verified before anything was changed

Two candidate **push** mechanisms were tested rather than assumed, because §4b already
established that a remedy nobody consults is documentation:

| Candidate | Test | Result |
| --- | --- | --- |
| a `preexec` hook in `~/.zshrc` | installed a hook body that appends to a log, then ran `zsh -i -c 'echo hello'` | **no log written** — the hook does not fire for `-c`, which is how commands are actually run here |
| git hooks | `ls .git/hooks/` | none installed, and hooks fire on git operations, not on arbitrary commands |

So **no mechanism can intercept a command before it runs in this environment.** That
finding is what makes the response different from a sixth detector, and it should be
recorded as a negative result rather than rediscovered next time.

The existing tooling was then verified end to end, and it already worked:

```
$ echo 'console.log("stdin path ok")' | python3 tools/run-program.py --lang js -
stdin path ok                       # rc=0

$ printf '%s\n' 'console.log("x" + "${String(t)}")' \
      | python3 tools/run-program.py --lang js -
rc=1                                # refused, correct message, NOTHING executed
```

### The actual defect: a cost asymmetry

Every recurrence is a case where the safe path existed and was not taken. The reason is
not forgetfulness in the ordinary sense. It is that the two paths have different prices:

| Path | Cost |
| --- | --- |
| inline one-liner carrying the hazard | **one** call |
| write a probe file, then run it | **two** calls |

Under improvisation the cheaper path wins, and it won five times. Detection cannot fix
that — a detector the operator does not consult has no effect on which path is chosen.

### What was changed

1. **`tools/run-program.py --keep FILE`** writes the program to a file and runs it in
   **one** call, so the safe path is no longer more expensive than the hazard. It creates
   parent directories, and it checks the program against the interpolation rule **before**
   writing — a kept hazard would put the exact bytes that break delivery onto disk, where
   the next edit inherits them, which is the loop §4b describes.
2. **`pnpm probe`** as the short form: `python3 tools/run-program.py --lang mjs --keep
   probe/latest.mjs -`.
3. **`probe/` is git-ignored**, for the same reason the benchmark artifacts are: a probe
   is evidence *for* a conclusion, not the conclusion, and a tracked probe would make a
   discarded line of investigation look like a supported claim.

The change is deliberately small. Adding a fourth detector would have repeated §4b's
recorded failure mode — a verified fix against a failure it could not observe.

### Why this is the fix that holds

The new property is not that detection is better. It is that **the safe path is no longer
more expensive than the hazard, and is strictly more capable.** An inline command cannot
preserve its own text; `--keep` can, which means a probe worth re-reading survives the
session instead of being retyped from scrollback. A remedy that is also an improvement has
no reason to be bypassed, and that is the only kind that holds when nobody is checking.

### What is not claimed

**The class is not eliminated, and this document does not say it is.** No mechanism can
intercept a command in this environment, so an operator who chooses the inline form can
still lose an invocation. The honest claim is narrower and is the only one the evidence
supports: the cost advantage that made the inline form rational has been removed, and a
hazard routed through the new path is refused at run time with the guard's own message.

The ceiling measurement that the interrupted probe was performing was re-run from a file
and is recorded in [`PREREGISTRATION-CORTEX-MEMORY-ARM.md`](PREREGISTRATION-CORTEX-MEMORY-ARM.md)
§7.5 and §40.2: the value function is pinned at exactly `0.5`, the ceiling is structural
rather than incidental (releasing the recency pin still caps it at `0.5`), and the
accessible boundary is `(0.5, 0.5000001]`. The rule in §3 turned a lost invocation into a
deciding number for the third time.

## 4e. The sixth recurrence: the safe path was cheap but not *reachable*

The class recurred once more, as `Bad substitution: typeof`, while a diagnostic probe was
being improvised around `node -e`. §4d's conclusion still holds and is worth restating,
because it is now the third consecutive time it has held:

| §4d remedy | status at the time of the failure |
| --- | --- |
| `tools/run-program.py` — run the program from a file | existed, verified working |
| `tools/run-program.py --keep FILE` — one call, write and run | existed, verified working |
| `pnpm probe` — the short form | existed |
| Refusal at run time, with the guard's message | existed; the exact fragment returns `rc=1` |

So the mechanism was present and the guard caught the fragment. What was missing was
**reachability, not cost**. §4d removed the two-call penalty, but `--keep FILE` still
required the caller to name the extension (`--lang mjs`) alongside the file. A probe being
improvised does not know its own extension in advance — that is what "improvised" means —
so at the moment of the failure the `--keep` form still had a decision in it that the
inline form did not.

The distinction is small and decides the response. §4d's diagnosis was *price*; this one is
*preconditions*. A path can be cheaper than the hazard and still lose if it demands
something the hazard does not, because the hazard's requirements are always satisfiable:
`node -e "<anything>"` has exactly one argument, and it is always writable.

### What was changed

1. **`--keep` now infers the interpreter**, so the flag stands alone. Precedence is
   explicit and pinned by a table-driven test: a known extension wins; otherwise a
   shebang decides; otherwise an extensionless name is JavaScript. An unrecognised
   extension with no shebang is a diagnosed usage error rather than a confident guess —
   because a wrong guess that silently ran the wrong interpreter would be worse than the
   requirement it replaces.
2. **The two stdin failures are diagnosed separately.** Naming a `.zig` file and naming
   nothing are different problems, and collapsing them would send a caller who did name a
   file hunting for a missing `--lang` that would not have helped.
3. **The guard's refusal names its own remedy.** It now ends with
   `See docs/OPS-SHELL-INTERPOLATION.md. Write the program to a file and run the file, or
   quote the here-doc delimiter.` A refusal that only says "this is wrong" leaves the
   operator to rediscover the right form under exactly the time pressure that produced the
   mistake; naming the next action makes the refusal self-correcting.

### Verified end to end, on the fragment that actually failed

```
$ printf '%s\n' 'const e = new Error("x");' \
      'console.log(`cause type: ${typeof e}, name: ${e.name}`);' \
  | python3 tools/run-program.py --keep probe/latest.mjs -
probe/latest.mjs:2: ${typeof e} is not a shell parameter expansion; ...
probe/latest.mjs:2: ${e.name} is not a shell parameter expansion; ...
rc=1                                    # nothing executed, nothing written

$ python3 tools/run-program.py --keep probe/latest.mjs - < clean.txt
cause type: object, name: Error       # rc=0, and probe/latest.mjs now holds the program
```

### What is not claimed, again

**The class is still not eliminated**, and this document has said so since §4d. What is
claimed is narrower and is what the two measurements above support: at the moment of this
failure both a refusal (`rc=1`, nothing written) and a one-flag safe path (`rc=0`, program
preserved) were reachable, and the friction that had made the inline form rational is now
gone rather than merely reduced. A seventh recurrence would be evidence that the binding
constraint is neither price nor preconditions, which is a different diagnosis than either
of the last two — and it would be recorded as such rather than answered with a fifth
mechanism.

### The measurement this recurrence interrupted

The probe was reading `typeof err` in the `rerank-factory` non-`Error` rejection arm,
while reproducing a **CI-only** failure. That work is independent of this section and is
recorded in the progress report; the tool failure cost one invocation and the finding was
one this document's rule exists to protect, since the whole question was what type the
rejection's cause actually has.



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

## 4f. The seventh recurrence: the diagnosis was wrong, and the guard was pointing away from the cause

The class recurred once more, in two consecutive reported forms:

```
Failed to run function tools: Error: Bad substitution: String
Failed to run function tools: Error: Bad substitution: cut.toFixed
```

§4e closed by predicting that a seventh recurrence would mean the binding constraint
is **neither price nor preconditions**, and that it should be recorded as a different
diagnosis rather than answered with a fifth mechanism. This section is that record,
and the prediction was right in a way the table below makes concrete.

### The root cause, measured rather than reasoned about

**The failure is not the sandbox, not zsh, and not the tool layer.** It is the
command itself: a `${...}` belonging to an inner language was written inside shell
quoting, and the outer shell expanded it before the interpreter was reached. Seven
occurrences, seven bodies:

| # | Body | Interpreter | Shell quoting |
| --- | --- | --- | --- |
| 1 | `String(t).padEnd(5)` | node | double |
| 2 | `lines[l-1].trim` | python3 | double |
| 3 | `h.join` | node | double |
| 4 | `JSON.stringify(x)` | node | double |
| 5 | `label.padEnd(5)` | node | double |
| 6 | `p.includes(x)` | node | double |
| 7 | `cut.toFixed(3)` | python3 | **single** |

Rows 1–6 are loud: the shell aborts and nothing runs. Row 7 is the one that exposed
the real gap, because it is **silent**. Measured against a real shell:

```
$ python3 -c 'x = ${cut.toFixed(3)}'
x = ${cut.toFixed(3)}          # the shell passed it through untouched
```

A single-quoted payload is not the shell's business, so the shipped guard was
**correct** not to report it — and therefore reported nothing at all, while Python
went on to fail with a `SyntaxError` about a token that had no business existing.
The guard was pointing at the shell when the shell was innocent.

### The three changes, each aimed at a different question

1. **`scan_payload(text, origin, language)`** — a rule for a program whose shell has
   already been resolved. `scan` derives a payload from a *command line* by anchoring
   on an `-c` token; a payload handed to a shim has no such token, so running `scan`
   over it reported `1 fragment(s) clean` about text Python then refused to parse.
   That false clean is why the function exists, and the first probe of the shim
   produced it.

2. **`_is_shell_expansion_for_a_payload(body)`** — the discriminator, and it needed
   two corrections because the first two attempts were confidently wrong:
   - **Attempt one** reused `VALID_EXPANSION`, which accepts `${cut:.3f}`: `cut` is a
     name, `:` opens an operator, `.3f` is the word. Lexically legal, empirically
     broken.
   - **Attempt two** required a digit anywhere in the tail, which reported
     `${x:offset}` — a substring operation that bash and zsh perform. A guard that
     fights correct shell gets deleted, so that was worse than missing the defect.

   The rule that holds is measured against three shells, and the measurement is the
   specification:

   | body | bash | dash | zsh | verdict |
   | --- | --- | --- | --- | --- |
   | `${cut:.3f}` | syntax error | Bad substitution | bad math expression | **report** |
   | `${v:2.3f}` | invalid arithmetic operand | Bad substitution | bad math expression | **report** |
   | `${label:>5}` | syntax error | Bad substitution | bad math expression | **report** |
   | `${d:%Y}` | syntax error | Bad substitution | bad math expression | **report** |
   | `${x:offset}` | `yz` | Bad substitution | `yz` | quiet |
   | `${a:1}` | `yz` | Bad substitution | `yz` | quiet |
   | `${x:0:5}` | `abcde` | Bad substitution | `abcde` | quiet |

   The split is not "valid vs invalid syntax" but **"does every shell fail on it"**.
   A format mini-language carries a `.`, `%`, `<`, `>`, `^` or `=` where arithmetic
   carries digits and signs, so the operand's indicator decides it. Note `${v:2.3f}`:
   it *starts* with a digit and still fails everywhere, because a decimal point inside
   a substring operand is a precision, not a number.

3. **The `python3` shim** — the first mechanism in this document that sits in the path
   of a *typed command*. Every prior remedy was pull-shaped and lost to whichever path
   was cheaper or more reachable; this one is push-shaped and runs whether or not the
   operator remembers. It is an **environment change**, so it is recorded here and
   asserted by `tools/__tests__/test_shim_guard.py` — an unrecorded environment fix
   disappears on the next re-image, and a missing net that reports nothing looks
   exactly like a net that never fires.

### The instrumentation bug this work found

Adding the shim and its explanatory docstring made the guard report **four violations
against its own documentation**. `_python_command_strings` was returning every
`"""..."""` block — which is every module docstring, and a docstring that explains the
hazard necessarily quotes it.

Running the corpus answered the question the counts had been hiding:

| Source | Blocks | Command-like |
| --- | --- | --- |
| Python `"""..."""` literals | 101 | **0** |
| Markdown ```` ```sh ```` fences | 6 | 6 |

The `105 fragment(s) clean` figure reported at earlier milestones was therefore
**measuring documentation**. The extraction now requires a string's first line to
begin with a word the shell would actually run, and to not read as a sentence. Prose
detection runs only over the words *after* the command name and needs **two or more**
matches, because a hazard body is full of short identifiers — `${a.b}` contains a
standalone-looking `a`, and a one-match threshold rejected a real command.

### What is claimed, and what is not

**Not eliminated.** No mechanism can intercept a command before it runs in this
environment (§4d's negative result stands), so an operator who writes the inline form
can still lose an invocation.

**What is claimed** is what was measured: the seventh recurrence now produces the
guard's own message instead of a `SyntaxError`, on the payload that actually failed.

```
$ python3 -c 'x = 1.23456; print(${x:.3f})'
1 shell-interpolation violation(s):
  <c-payload>:1: ${x:.3f} sits inside a `python` payload. That language has no such
  construct, so either it fails to parse or the text is taken literally; use the
  language's own interpolation, or write the program to a file and run the file.
refused: the -c payload carries a ${...} the shell does not treat as text.
  Run it as a file instead, which removes the failure mode:
    python3 tools/exec-python.py -            < program
    python3 tools/exec-python.py program.py
```

and all seven historical bodies are still caught as shell hazards (7/7), with the
previously-silent single-quoted door now reporting through the payload rule.

## 4g. Adding a shim to this environment

The shim is not in the repository, so this is the note that recreates it.

**Where:** `/root/.pyenv/shims/python3`. It is the first `python3` on `PATH` and it is
an editable bash script, which is what makes the insert possible at all.

**Why there and nowhere else:** a `preexec` hook in `~/.zshrc` does not fire — measured
in §4d, and non-interactive zsh does not read the rc file. Git hooks fire on git
operations, not on commands. The pyenv shim is the only point on the path of a typed
`python3`.

**What it does:** if the first argument is `-c` and the payload contains `${`, it calls
`tools/check-shell-interpolation.py --c-payload` before the real interpreter. The guard
exits `1` on a payload whose sequence no language in the pipeline can evaluate, and the
shim refuses with the message above. The payload is passed as an **argument**, never
through a heredoc or here-string: a shim that itself feeds a hazard through a shell
would be the thing it exists to prevent.

**Failure is OPEN.** If the guard file or the real interpreter cannot be located, the
interpreter runs. A net that blocks work when its own file is missing is a net people
route around, and the cost of that exceeds the hazard it prevents.

**Verification:** `python3 -m pytest tools/__tests__/test_shim_guard.py`. The tests
assert the shim's presence, its position on `PATH`, its verdict on the seventh
recurrence's exact shape, and — equally — that it stays quiet on the nine measured
shapes that are real shell expansions. A shim that refuses those would be removed, and
it would take the checks that work with it.

**Companion tool:** `tools/exec-python.py` is what the refusal names. It runs a program
from a file or stdin and warns if the text carries a sequence no shell would have
expanded — the `SyntaxError` Python produces points at the token, while the warning
points at the cause.

## 4h. The eighth recurrence: the layer was never the shell, and detection cannot win

The class recurred as `Bad substitution: q`. This section corrects the diagnosis the
previous seven sections share, because the correction changes what the remedy must be.

### The evidence, and why reasoning from the previous seven would have missed it

Every earlier section assumed a shell was involved. For the eighth, the log says
otherwise. From `.codebuddy/logs/2026-10-06`:

```
[ModelProvider] ... streamingToolName=Bash
[ModelProvider] finish_reason="tool_calls" received, starting grace period
[Interruption] Catch block entered, error: Failed to run function tools:
               Error: Bad substitution: q
[Interruption] functionCallItems count: 0
```

`functionCallItems count: 0` is decisive. The failing call was **never dispatched to a
tool** — it died while the streamed `Bash` argument was still being assembled. No shell
ran, so no shim in `PATH` could have prevented it, and the very same log line as the
sandbox dispatch records `pythonShimPath=false`. §4g's shim is correct for the layer it
targets and was simply not on this path.

### The body inventory settles the strategy question

Ten distinct bodies across every recorded failure, not eight:

| Body | Tagged variants | Shape |
| --- | --- | --- |
| `String` | `String]`, `String'` | identifier |
| `min.toFixed` | `min.toFixed]` | dotted call |
| `cut.toFixed` | `cut.toFixed]` | dotted call |
| `q` | `q]` | **bare name** |
| `"` | — | a quote character |

Two things follow.

1. **The `]` and `'` variants show a body scan that stops at a delimiter.** The reporter
   prints the prefix it accumulated, which is what a parameter-expansion parser does on
   reaching a character its grammar does not accept.
2. **`q` is the end of the road for detection.** Measured in this image:

   | Sequence | bash | dash | zsh |
   | --- | --- | --- | --- |
   | `${q}` | `x=` (rc 0) | `x=` (rc 0) | `x=` (rc 0) |
   | `${(s:...:)}` | bad substitution | **Bad substitution** | bad substitution |

   The aborting shape is a zsh-only construct. `${q}` is valid POSIX and expands to the
   empty string **silently** in all three. So the eighth failure is not "text the shell
   rejects" — it is text the shell accepts and quietly destroys.

As the reported bodies shrink from `JSON.stringify(x)` toward a bare `q`, a
content-based detector's precision goes to zero, because the failing text becomes
**textually identical to correct shell**. A rule that rejected `${q}` would reject
correct shell everywhere, and §4g already records what happens to such a rule: it gets
deleted, taking the checks that work with it.

**Detection is the wrong strategy and always was.**

### The diagnostic defect this exposed

The eighth failure also showed the guard's message could be **false**. For a live
payload the message read:

> `${q}` is not a shell parameter expansion; the inner language's interpolation would
> be consumed by the shell

The second clause is backwards. The shell *recognises* `${q}` perfectly and replaces it
with an empty string; there is no expansion failure to find. A reader sent looking for a
syntax error would find valid shell and conclude the guard was wrong — and a guard that
can be shown wrong is one people stop running. The message now distinguishes the two
cases: outside a payload the old wording is exactly right (`${a.b}` really is invalid),
and inside one it says what actually happens.

### What was changed, and what it does not claim

1. **`tools/probe.py`** — a probe runs from **stdin, never from an argument**, so the
   program text never enters the path that failed eight times. The command contains a
   path and a delimiter and nothing else:

   ```sh
   python3 tools/probe.py --lang python - <<'PROBE'
   for q in (0.25, 0.5, 0.9):
       print(f'{q:.3f}')
   PROBE
   ```

   The heredoc delimiter must be **quoted**. It checks what it received and warns when
   the text looks like a body the shell already expanded, because `<<PROBE` and
   `<<'PROBE'` differ by two characters and the unquoted one is the default.
2. **`--lang` is required and inference is refused.** A probe on stdin has no extension;
   `run-program.py` already owns inference for real files, and one question with two
   answers can disagree.
3. **The argument form is refused, not treated as a path.** Silently reading a file named
   by the first argument would make `probe.py --lang python 'x = 1'` look like it worked
   and then do nothing.

**What is not claimed.** The class is still not eliminated: the harness's argument
assembly runs before any tool, so a `${...}` written directly into a `Bash` argument can
still be destroyed. What is claimed is what the evidence supports — the strategy has
changed from detecting the body to removing the precondition, and the bodies that used
to be lost are now handled by construction because the program never enters the argument
path.

### The generalisation, which is the part worth keeping

Seven sections diagnosed a shell problem and prescribed shell-shaped remedies. All seven
were addressing the wrong layer, and each was plausible enough to survive review because
each produced a passing test against a real reproduction. The eighth section is the one
that read the log: the failure reported `functionCallItems count: 0`, and a call that was
never dispatched cannot have been affected by anything on `PATH`.

The rule for the next recurrence is therefore not another detector. It is: **read the
dispatch log before choosing a layer.** A worked example is cheaper than a ninth
mechanism.


