/**
 * `candidates` makes the inclusion test a written step instead of an implied one.
 *
 * ## The population this is written against, and why it is a change of ask
 *
 * §13.204 read the multi-session route's remaining thirty-two failures and falsified both
 * retrieval explanations before writing a line of prompt: the gold is inside the window on
 * **32 of 32** (and on 20 of 20 of the temporal route's), and the failing window has the same
 * session count, turn count and turns-per-session as the succeeding one. What is left is the
 * reading, and three read by hand are one shape:
 *
 * | question | gold | answered | what the reader did |
 * | --- | ---: | ---: | --- |
 * | `0a995998` | 3 | 2 | listed the same item twice and merged it, never listing the third |
 * | `6d550036` | 2 | 1 | fourteen mentions in the window, at most two of them "led by me", found one |
 * | `9d25d4e0` | 3 | 2 | ten jewelry mentions, two acquisitions found, three exist |
 *
 * `enumerated` says *"list every item in the evidence that matches the question"*, which
 * presupposes the inclusion decision has already been made correctly. It has not: the
 * discrimination these three need is which of fourteen mentions satisfies *led by me*, and a
 * list of the ones that obviously do stops at the first few. `candidates` moves that decision
 * into the transcript — every mention gets a line, and the line carries the verdict and the
 * clause that produced it — so Step 2 counts a screen instead of recalling one.
 *
 * ## What is asserted here, and what is deliberately left to the registration test
 *
 * This file asserts the block's **content and position**: both verdicts are named, the
 * completeness demand is present, the rule that decides is the last line, and the response the
 * contract asks for is the response the parser scores (§13.36 — the prompt may not import the
 * reader, so the guard is a real prompt driven through the real reader).
 *
 * The reach — that flat and temporal keep the control's bytes on **both** question shapes — is
 * asserted by `ask-changes.test.ts`, which renders all six routes under every ask and compares
 * against `ASK_CHANGES`. Restating it here would be a second oracle for one claim, and the
 * four fallthrough defects in this campaign (§13.104, §13.123, §13.124, §13.132) were all
 * cases of a second statement of a claim outliving the first.
 */

import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import type { AdmittedTurn } from '../admission.js';
import type { AdmittedSession } from '../sessionize.js';
import { CortexMemory } from '../memory.js';
import { ABSTAIN_TOKEN, parseAnswer } from '../parse.js';
import { buildSessionPrompt, type EvidenceAsk } from '../prompt.js';

const NOW = 1_759_470_000_000;

const GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  sourceTrust: 0.5,
} as const;

const TEXT = 'I picked up the Zara boots on Tuesday and returned a coat on Thursday.';

const COUNT = 'How many items of clothing did I pick up or return?';
const DERIVATION = 'How many days after the pickup did I return the coat?';

function turn(content: string): AdmittedTurn {
  return {
    id: content,
    content,
    value: 0.5,
    confidence: 1,
    source: 'unknown',
    sourceTrust: 0.5,
    type: 'episodic',
    tags: [],
    createdAt: 0,
    lastAccessedAt: 0,
    stability: 1,
    difficulty: 5,
    ordinal: 0,
  };
}

function session(): AdmittedSession {
  return {
    index: 0,
    size: 2,
    turns: [turn('I picked up the Zara boots on Tuesday.'), turn('I returned a coat on Thursday.')],
  };
}

function recorder(seen: string[]): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return '2';
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

/** The instruction block the multi-session route reads under one ask, from a real call. */
async function multiSessionPrompt(ask: EvidenceAsk, question = COUNT): Promise<string> {
  const seen: string[] = [];
  const memory = new CortexMemory({
    llm: recorder(seen),
    now: NOW,
    name: 'cortex-memory',
    gate: { ...GATE },
    ask,
  });
  await memory.answerSessions(question, [[TEXT]]);
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

/** What follows `Answer the question`, which is where the instruction block begins. */
function instructionsOf(prompt: string): string {
  const at = prompt.indexOf('Answer the question');
  return at === -1 ? prompt : prompt.slice(at);
}

describe('the multi-session block becomes a screen that is counted', () => {
  it('asks for two steps, in order, and names both verdicts', async () => {
    const block = instructionsOf(await multiSessionPrompt('candidates'));
    const first = block.indexOf('Step 1');
    const second = block.indexOf('Step 2');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    // Both verdicts are literal tokens the transcript can be read for, which is what makes
    // the screen observable at all: a Step 1 that only lists inclusions is what the reader
    // already produces (`0a995998`, `6d550036`, `9d25d4e0`), and it is the thing that stops
    // early.
    expect(block).toContain('INCLUDE');
    expect(block).toContain('EXCLUDE');
  });

  it('demands every mention, and says an exclusion is a line rather than an omission', async () => {
    // The load-bearing sentence. `enumerated` asks for the items that MATCH, so leaving a
    // mention out is indistinguishable from its not existing -- which is exactly the state
    // the three hand-read failures are in. This makes the omission visible in the transcript.
    const block = instructionsOf(await multiSessionPrompt('candidates'));
    expect(block).toContain('every mention');
    expect(block).toContain('A mention the question rules out is a line reading EXCLUDE');
  });

  it('counts the inclusions at Step 2 and forbids re-reading the evidence there', async () => {
    const block = instructionsOf(await multiSessionPrompt('candidates'));
    expect(block).toContain('answer from the INCLUDE lines alone');
    expect(block).toContain('Do not re-read the evidence at this step');
  });

  it('keeps the duplicate rule that `enumerated` measured, in both directions', async () => {
    // `0a995998` failed by listing one event twice and merging it, so the "one event, one
    // line" rule is kept -- but the second half is what the failure needed and `enumerated`
    // also carries: two different events are two lines.
    const block = instructionsOf(await multiSessionPrompt('candidates'));
    expect(block).toContain('One event described in several turns is one line');
    expect(block).toContain('two different events are two lines');
  });

  it('makes the decline depend on zero inclusions rather than on an empty list', async () => {
    // The predicate is the point. `enumerated`'s close declines when the Step 1 list is
    // EMPTY, and §13.204's 32 failures include 7 abstentions taken over a non-empty list --
    // the reader found things, listed them, and declined anyway because the list was not the
    // number. Here declining requires every line to read EXCLUDE, so a list with one
    // inclusion in it has an answer by construction.
    const block = instructionsOf(await multiSessionPrompt('candidates'));
    expect(block).toContain(`Do not reply ${ABSTAIN_TOKEN} while any Step 1 line reads INCLUDE`);
    const lastLine = block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .at(-1)!;
    expect(lastLine).toContain('every Step 1 line reads EXCLUDE');
    expect(lastLine).toContain(ABSTAIN_TOKEN);
  });

  it('states the rule in the position that decides, which §13.56 measured', async () => {
    // A rule placed above the close lost to the close (run `39035438120`), and `withReplacedClose`
    // is the position the two sends that worked used. This is the structural half of the claim:
    // the last line the reader reads is the close, and the close is the conditional one.
    const block = instructionsOf(await multiSessionPrompt('candidates'));
    const lastLine = block
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .at(-1)!;
    expect(lastLine.startsWith('Reply with the Step 2 answer alone.')).toBe(true);
  });
});

describe('it is enumerated with the contract and the close replaced, and nothing else', () => {
  it('keeps the licence to combine that the control carries', async () => {
    // The merging sentence is in the control's block and it is load-bearing: §13.132's twelve
    // declines all quote it back as the reason they cannot answer. A new ask that dropped it
    // would be a second variable against an `enumerated` control.
    const block = instructionsOf(await multiSessionPrompt('candidates'));
    expect(block).toContain(
      'The answer may require combining evidence from more than one turn or session',
    );
  });

  it("does not contain enumerated's Step 1 sentence or its close", async () => {
    // Replacement rather than addition. If the control's contract survived, the model would
    // read two Step 1 instructions and follow whichever came last -- which is §13.56's finding
    // about position, arriving as an accident instead of an experiment.
    const block = instructionsOf(await multiSessionPrompt('candidates'));
    expect(block).not.toContain('list every item in the evidence that matches the question');
    expect(block).not.toContain('If the Step 1 list is empty because the evidence does not');
  });

  it('reads the same block on a derivation question as on a counting one', async () => {
    // Unlike `operands`, this ask does not consult the question's shape: the screen is about
    // the mentions, not about what Step 2 does with them. The consequence is stated where it
    // matters rather than tested here -- against an `operands` control the derivation
    // questions read a different block, so the control this ask is registered against is
    // `enumerated` (§13.205.4), and the population is entirely counting questions.
    const counted = instructionsOf(await multiSessionPrompt('candidates', COUNT));
    const derived = instructionsOf(await multiSessionPrompt('candidates', DERIVATION));
    expect(derived).toBe(counted);
  });
});

describe('the response the contract asks for is the response the reader scores', () => {
  it('the reader and the prompt cannot drift apart', async () => {
    // §13.36 applied to a pair that cannot share a constant: `prompt.ts` imports `ABSTAIN_TOKEN`
    // from `parse.ts`, so the reader may not import the contract back. The guard builds the REAL
    // prompt, takes its own headings, and drives `parseAnswer` with a response that echoes them --
    // stronger than comparing literals, because it also fails if the contract stops reaching the
    // route at all.
    const { prompt } = buildSessionPrompt(COUNT, [session()], { ask: 'candidates' });
    const headings = prompt.split('\n').filter((line) => /^\s*Step\s/i.test(line));
    expect(headings).toHaveLength(2);

    const echoed = [
      headings[0]!,
      '',
      '2023/05/21 | I picked up the Zara boots | INCLUDE | picked up',
      '2023/05/21 | the boots I collected from Zara | EXCLUDE | already listed, same event',
      '2023/05/23 | I returned a coat | INCLUDE | returned',
      '2023/05/24 | a friend returned a book | EXCLUDE | not mine',
      '',
      headings[1]!,
      '',
      '2',
    ].join('\n');
    expect(parseAnswer(echoed)).toBe('2');
  });

  it('reads a decline the contract licenses, list and all', async () => {
    // The precedence the parser already pins: the sentinel outranks any reading of the parts, so
    // a response that writes a screen full of EXCLUDE lines and then declines is an abstention.
    const { prompt } = buildSessionPrompt(COUNT, [session()], { ask: 'candidates' });
    const headings = prompt.split('\n').filter((line) => /^\s*Step\s/i.test(line));
    const declining = [
      headings[0]!,
      '',
      '2023/05/24 | a friend returned a book | EXCLUDE | not mine',
      '',
      headings[1]!,
      '',
      ABSTAIN_TOKEN,
    ].join('\n');
    expect(parseAnswer(declining)).toBeNull();
  });
});

describe('the ask pays for itself in prompt characters or it does not ship', () => {
  it('costs at most fifteen percent more than the block it replaces', async () => {
    // Measured on the multi-session route with an empty window, so the number is the instruction
    // block and nothing else: `enumerated` 1,415 characters, `candidates` 1,582, both 8 lines. The
    // difference is 167 characters -- about 42 tokens per MR prompt, and MR is 121 of a 500-question
    // run over four repetitions, so the whole experiment pays roughly 20k prompt tokens for a screen
    // that is 180 characters wide. That is inside any budget this arm has, and it is stated as a
    // ceiling rather than as an equality because a legitimate re-wording should not fail a test while
    // a block that doubles still should.
    const control = instructionsOf(await multiSessionPrompt('enumerated'));
    const block = instructionsOf(await multiSessionPrompt('candidates'));
    expect(block.length).toBeGreaterThan(control.length);
    expect(block.length).toBeLessThanOrEqual(Math.ceil(control.length * 1.15));
    // A screen that costs nothing would be a screen that says nothing: the assertion above is only
    // meaningful beside this one.
    expect(block.length - control.length).toBeGreaterThan(100);
  });
});
