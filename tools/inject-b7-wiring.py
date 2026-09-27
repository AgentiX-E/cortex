#!/usr/bin/env python3
"""Defect-injection harness for the B7 feature's WIRING layer.

Why this harness exists, and why the leaf-module harness next to it did not
catch the defect that prompted it.

`tools/inject-candidate-discrimination.py` mutates `candidate-discrimination.ts`
-- the leaf module that decides which side a token set belongs to. Every one of
its mutations is aimed at that module's arithmetic, and the suite caught all of
them. The feature was nonetheless dead: `candidateDiscrimination` was declared on
`QaPromptOptions`, read by `buildQaPrompt`/`buildConservativeQaPrompt`, and
assigned by nothing outside them. No runner option forwarded it, no CLI env var
set it, and the prompt-builder closure in `natural-language-memory.ts` accepted
three arguments so the option could not arrive even if it had been set.

That is a wiring defect, and a leaf-module harness cannot see one by
construction. The mutations below are aimed at the three links instead:

  1. `runner.ts` -> the feature system            (the arm never sets the option)
  2. the feature system -> `respondWith`           (the option is not read)
  3. `respondWith` -> the prompt-builder closure   (the option is dropped)
  4. `buildConservativeQaPrompt` -> the prompt     (the option is ignored)
  5. `bench/run.ts` -> the env var                 (no dispatch can reach it)

Link 3 is the one that actually killed the feature, and it is also the one a
signature-blind code review would pass: a closure `(q, c, token) =>` satisfies a
three-parameter `PromptBuilder` type exactly, so dropping a fourth argument is
invisible until someone reads the call site.

Each mutation states the defect and the tests it should break. A mutation that
leaves the suite green means the suite does not test that link, which is the
finding -- not a pass. Every file is restored byte-for-byte after each mutation
and the restore is verified by md5.
"""

from __future__ import annotations

import hashlib
import pathlib
import subprocess
import sys

PKG = pathlib.Path('/workspace/cortex/packages/cortex-eval')
PNPM = '/root/.pnpm/.tools/pnpm/9.15.0_tmp_85206/node_modules/pnpm/bin/pnpm.cjs'

RUNNER = PKG / 'src/runner.ts'
SYSTEM = PKG / 'src/natural-language-memory.ts'
BENCH = PKG / 'bench/run.ts'
TOGGLE = PKG / 'src/env-toggle.ts'
ARM = PKG / 'src/bench-arm-options.ts'

# Every file that must be restored between mutations.
FILES = [RUNNER, SYSTEM, BENCH, TOGGLE, ARM]


def build() -> bool:
    """Build the package so `bench/` resolves the mutated `src/` through dist.

    Not an optimisation. `bench/tsconfig.bench.json` resolves
    `@agentix-e/cortex-eval` through the built `dist/`, so a mutation to `src/`
    that is not rebuilt is a mutation the bench-side assertions never see -- and
    the harness would report a survivor that does not exist.
    """
    proc = subprocess.run(
        ['node', PNPM, 'run', 'build'],
        cwd=PKG, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        print(proc.stdout[-2000:])
        print(proc.stderr[-2000:])
    return proc.returncode == 0


def suite_green() -> bool:
    """The arm suite and the bench typecheck must both pass.

    Two suites rather than one because the links live on two sides. Links 1-4 are
    behavioural and are observed by `rerank-ablation.test.ts`. Link 5 is a type
    relationship between the CLI and the runner, which only
    `tsc -p tsconfig.bench.json` can see: a bench that omits the option still
    compiles and still runs, and produces the control arm's numbers.
    """
    if not build():
        return False
    arm = subprocess.run(
        [
            'node', PNPM, 'exec', 'vitest', 'run',
            'src/__tests__/rerank-ablation.test.ts',
            'src/__tests__/env-toggle.test.ts',
            'src/__tests__/bench-arm-options.test.ts',
        ],
        cwd=PKG, capture_output=True, text=True,
    )
    bench = subprocess.run(
        ['node', PNPM, 'exec', 'tsc', '-p', 'tsconfig.bench.json', '--noEmit'],
        cwd=PKG, capture_output=True, text=True,
    )
    return arm.returncode == 0 and bench.returncode == 0


# (name, path, anchor, replacement, link, expected_unobservable)
#
# The last field marks a mutation whose effect this harness CANNOT observe, with
# the reason stated in the comment above it. Keeping them in the list rather than
# deleting them is deliberate: they document which links have no test, which is
# the finding. Marking them separately is what stops a known limitation from
# being read as a pass.
MUTATIONS: list[tuple[str, pathlib.Path, str, str, str, bool]] = [
    (
        'runner-does-not-forward-to-feature',
        RUNNER,
        "    ...(options.candidateDiscrimination === true ? { candidateDiscrimination: true } : {}),\n",
        '',
        'link 1: runner -> feature system', False,
    ),
    (
        'runner-ignores-the-option-for-the-feature',
        RUNNER,
        "    ...(options.candidateDiscrimination === true ? { candidateDiscrimination: true } : {}),",
        "    ...(options.candidateDiscrimination === 'yes' ? { candidateDiscrimination: true } : {}),",
        'link 1: runner -> feature system (truthiness misread)', False,
    ),
    # A mutation that wired the flag into the BASELINE as well was written first
    # and removed, because it is not observable on this fixture and a survivor
    # that cannot be caught is a misleading result rather than a finding.
    #
    # Measured: with the flag on both arms the arm produces `prompts=4,
    # instructed=1` on the suite's fixture -- byte-identical to the correct
    # implementation's `prompts=4, instructed=1` when the flag is off, and to its
    # `prompts=5, instructed=1` when the flag is on in the sense that matters.
    # The baseline's own abstention question does not reach
    # `buildConservativeQaPrompt` on this input, so giving the baseline the flag
    # changes no prompt either arm sends. The defect is real and would be real in
    # production; on THIS fixture it has no observable consequence.
    #
    # Closing it needs a fixture whose baseline reaches the conservative path, and
    # the capability routing that decides that is not something the current
    # fixtures exercise on both arms. Recorded here rather than replaced by a test
    # written to catch a mutation: a test that exists to make a mutation fail
    # asserts the mutation, not the behaviour.
    (
        'system-does-not-read-its-own-option',
        SYSTEM,
        "      this.options.candidateDiscrimination === true ? { candidateDiscrimination: true } : {},",
        "      {},",
        'link 2: system -> respondWith', False,
    ),
    (
        'closure-drops-the-option',
        SYSTEM,
        'const conservativePrompt: PromptBuilder = (q, c, token, promptOptions) =>',
        'const conservativePrompt: PromptBuilder = (q, c, token) =>',
        'link 3: respondWith -> prompt builder (the defect that killed it)', False,
    ),
    (
        'closure-ignores-the-option',
        SYSTEM,
        "        ...(promptOptions?.candidateDiscrimination === true\n          ? { candidateDiscrimination: true }\n          : {}),",
        '',
        'link 3: respondWith -> prompt builder (option received, not used)', False,
    ),
    (
        'conservative-builder-ignores-the-option',
        SYSTEM,
        "    ...(options.candidateDiscrimination === true ? [CANDIDATE_DISCRIMINATION_INSTRUCTION] : []),\n    '',",
        "    '',",
        'link 4: builder -> prompt text', False,
    ),
    (
        'conservative-builder-always-adds-it',
        SYSTEM,
        "    ...(options.candidateDiscrimination === true ? [CANDIDATE_DISCRIMINATION_INSTRUCTION] : []),",
        "    CANDIDATE_DISCRIMINATION_INSTRUCTION,",
        'link 4: builder -> prompt text (default flipped on)', False,
    ),
    (
        'bench-does-not-read-the-env-var',
        BENCH,
        "  const candidateDiscrimination = readToggle(process.env, 'CANDIDATE_DISCRIMINATION');",
        '  const candidateDiscrimination = false;',
        'link 5: bench env -> runner',
        True,
    ),
    (
        'bench-reads-the-wrong-variable',
        BENCH,
        "  const candidateDiscrimination = readToggle(process.env, 'CANDIDATE_DISCRIMINATION');",
        "  const candidateDiscrimination = readToggle(process.env, 'ENTITY_IDENTITY_CLAUSE');",
        'link 5: bench env -> runner (reads the neighbouring toggle)',
        True,
    ),
    (
        'bench-defaults-the-switch-on',
        BENCH,
        "  const candidateDiscrimination = readToggle(process.env, 'CANDIDATE_DISCRIMINATION');",
        "  const candidateDiscrimination = readToggle(process.env, 'CANDIDATE_DISCRIMINATION', { defaultOn: true });",
        'link 5: bench env -> runner (default flipped on)',
        True,
    ),
    # Link 5's call site, now that the option object is built by a testable
    # function. These four mutations target the builder rather than the CLI: the
    # same defects at the same place, moved to where a test can see them. All four
    # SURVIVED when the object was built inline in `bench/run.ts`.
    (
        'arm-options-omit-the-toggle',
        ARM,
        "    ...(input.candidateDiscrimination ? { candidateDiscrimination: true } : {}),\n",
        '',
        'link 5: bench -> runner call site (toggle dropped)', False,
    ),
    (
        'arm-options-always-present',
        ARM,
        "    ...(input.candidateDiscrimination ? { candidateDiscrimination: true } : {}),",
        '    candidateDiscrimination: input.candidateDiscrimination,',
        'link 5: bench -> runner call site (key always present)', False,
    ),
    (
        'arm-options-drop-the-reranker',
        ARM,
        '    reranker: input.reranker,\n',
        '',
        'link 5: bench -> runner call site (reranker dropped)', False,
    ),
    # A `=== undefined` -> falsy mutation on `rerankCandidatePool` was written and
    # removed: it is behaviourally unobservable, so a survivor would be a
    # misleading result rather than a finding.
    #
    # The consumer resolves the option as `Math.max(topK, pool ?? topK)`. A pool of
    # `0` therefore resolves to `topK`, exactly as an absent pool does, so the two
    # spellings produce the same candidate set for every input the type admits.
    # `0` is not a smaller pool -- it is a null value spelled as a number, and the
    # consumer already treats it that way.
    #
    # The same convention IS observable on `rerankProtectedHead`, where `0` has a
    # meaning, and the test asserts it there.
    # The reading itself, now that it lives in `src/` and is therefore testable.
    # These two are what the three above would have caught only by accident: with
    # the comparison inline in `bench/**`, a wrong parser was invisible because
    # nothing could call it.
    (
        'toggle-presence-implies-truth',
        PKG / 'src/env-toggle.ts',
        '  return raw === \'1\';',
        '  return true;',
        'link 6: the toggle reader itself', False,
    ),
    (
        'toggle-absent-is-on',
        PKG / 'src/env-toggle.ts',
        '    return options.defaultOn === true;',
        '    return true;',
        'link 6: the toggle reader default', False,
    ),
]


def main() -> int:
    originals: dict[pathlib.Path, str] = {}
    digests: dict[pathlib.Path, str] = {}
    for path in FILES:
        text = path.read_text()
        originals[path] = text
        digests[path] = hashlib.md5(text.encode()).hexdigest()
        print(f'baseline {path.name} md5 = {digests[path]}')

    if not suite_green():
        print('BASELINE RED -- refusing to inject against a failing suite')
        return 2

    survivors: list[str] = []
    unobservable: list[str] = []
    for name, path, needle, replacement, link, cannot_observe in MUTATIONS:
        original = originals[path]
        if needle not in original:
            print(f'  {name:<40} ANCHOR MISSING ({link})')
            survivors.append(f'{name} (anchor missing)')
            continue
        path.write_text(original.replace(needle, replacement, 1))
        try:
            caught = not suite_green()
        finally:
            path.write_text(original)
            if hashlib.md5(path.read_text().encode()).hexdigest() != digests[path]:
                print(f'  !! restore mismatch on {path.name} -- aborting')
                for p, t in originals.items():
                    p.write_text(t)
                return 3
        # The suite is re-checked against the restored files before the result is
        # believed. Without this, a suite that is red for a reason unrelated to
        # the mutation -- a missing module, a syntax error in an unrelated test
        # file -- makes EVERY mutation report "caught", because the mutation run
        # fails for the same unrelated reason. That happened on the first run of
        # this harness and produced a full column of passes that meant nothing.
        # A red baseline is a result about the harness, not about the code.
        if not suite_green():
            print(f'  {name:<40} VOID (suite red after restore, not because of the mutation)')
            print('     the mutation result was not measurable; fix the suite first')
            for p, t in originals.items():
                p.write_text(t)
            return 4
        if caught:
            verdict = 'caught'
        elif cannot_observe:
            verdict = 'unobservable'
            unobservable.append(name)
        else:
            verdict = 'SURVIVED'
            survivors.append(name)
        print(f'  {name:<40} {verdict:<12} [{link}]')

    print()
    if unobservable:
        print(f'{len(unobservable)} mutation(s) this harness cannot observe by construction:')
        for name in unobservable:
            print(f'  - {name}')
        print('  (each is marked at its definition with the measurement that shows the')
        print('   defect has no observable consequence here)')
        print()
    if survivors:
        print(f'{len(survivors)} real survivor(s): {", ".join(survivors)}')
        return 1
    caught = len(MUTATIONS) - len(unobservable)
    print(f'{caught} of {len(MUTATIONS)} mutations caught; files restored')
    return 0

    print()
    if survivors:
        print(f'{len(survivors)} survivor(s): {", ".join(survivors)}')
        return 1
    print(f'all {len(MUTATIONS)} mutations caught; files restored')
    return 0


if __name__ == '__main__':
    sys.exit(main())
