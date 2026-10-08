/**
 * One prompt builder, parameterised by answer contract.
 *
 * The reference pipeline carries eleven separate builders — `buildQaPrompt`,
 * `buildConservativeQaPrompt`, `buildPreferencePrompt`,
 * `buildKnowledgeUpdatePrompt`, `buildTemporalQaPrompt`, plus the aggregation
 * family. That is one builder per capability, and each duplicates the context
 * formatting. This package carries one builder and a contract table, because
 * the difference between the paths is *what is asked for*, not *how context is
 * laid out*.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  formatEvidence,
  truncateCodePointSafe,
  type PromptContract,
} from '../prompt.js';
import type { AdmittedTurn } from '../admission.js';

function admitted(content: string, value = 0.8): AdmittedTurn {
  return {
    id: `id-${content}`,
    content,
    value,
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

describe('formatEvidence', () => {
  it('numbers turns so the model can cite them', () => {
    const formatted = formatEvidence([admitted('alpha'), admitted('beta')]);

    expect(formatted).toContain('1.');
    expect(formatted).toContain('2.');
    expect(formatted).toContain('alpha');
    expect(formatted).toContain('beta');
  });

  it('keeps chronological order', () => {
    const formatted = formatEvidence([admitted('first'), admitted('second')]);
    const firstAt = formatted.indexOf('first');
    const secondAt = formatted.indexOf('second');

    expect(firstAt).toBeLessThan(secondAt);
  });

  it('labels session boundaries when sessions are supplied', () => {
    const formatted = formatEvidence([admitted('a1')], { sessionIndex: 0 });
    const other = formatEvidence([admitted('b1')], { sessionIndex: 1 });

    expect(formatted).toContain('Session 1');
    expect(other).toContain('Session 2');
  });

  it('returns an empty string for no turns', () => {
    expect(formatEvidence([])).toBe('');
  });

  it('returns an empty string for no turns under the sourced rendering too', () => {
    // The empty guard sits at the top of this function and runs before the rendering
    // split, so both renderings produce the empty string by the same early return.
    // The sourced renderer's own guard was removed in §12.9 once this path was the
    // only way to reach it -- the assertion is unchanged, which is what makes the
    // removal safe.
    expect(formatEvidence([], { rendering: 'sourced' })).toBe('');
    expect(formatEvidence([], { sessionIndex: 0, rendering: 'sourced' })).toBe('');
  });

  it('labels the source of each turn under the sourced rendering', () => {
    const turns = [admitted('alpha'), admitted('beta')];
    const formatted = formatEvidence(turns, { rendering: 'sourced' });

    for (const turn of turns) {
      expect(formatted).toContain(`[${turn.id}]`);
    }
    // The numbering survives the addition, so the two renderings still agree on
    // positions and differ only in provenance.
    expect(formatted).toContain('1.');
    expect(formatted).toContain('2.');
    expect(formatEvidence(turns)).not.toContain(`[${turns[0]!.id}]`);
  });

  it('composes the session label with the sourced rendering', () => {
    // The case MR actually needs, and the reason the rendering is a parameter of this
    // function rather than two separate renderers: a boundary drawn *and* each turn's
    // origin inside it. Splitting the renderers would have made this combination
    // unexpressible.
    const turn = admitted('a1');
    const formatted = formatEvidence([turn], { sessionIndex: 0, rendering: 'sourced' });

    expect(formatted).toContain('Session 1');
    expect(formatted).toContain(`[${turn.id}]`);
    expect(formatted.indexOf('Session 1')).toBeLessThan(formatted.indexOf(`[${turn.id}]`));
  });

  it('separates turns with a blank line so the model does not merge them', () => {
    const formatted = formatEvidence([admitted('alpha'), admitted('beta')]);

    expect(formatted).toContain('\n\n');
  });
});

describe('buildPrompt', () => {
  it('includes the question verbatim', () => {
    const prompt = buildPrompt('What did the user say?', [admitted('alpha')], 'extractive');

    expect(prompt).toContain('What did the user say?');
  });

  it('includes the formatted evidence', () => {
    const prompt = buildPrompt('Q?', [admitted('the unique token')], 'extractive');

    expect(prompt).toContain('the unique token');
  });

  it('differs between contracts, because the ask differs', () => {
    // The contracts are the replacement for per-capability builders: if the
    // prompt were identical for all of them, the routing decision would be
    // inert and `runBenchmark`'s per-capability arms would measure nothing.
    const evidence = [admitted('alpha')];
    const extractive = buildPrompt('Q?', evidence, 'extractive');
    const abstention = buildPrompt('Q?', evidence, 'abstention');
    const temporal = buildPrompt('Q?', evidence, 'temporal');
    const knowledgeUpdate = buildPrompt('Q?', evidence, 'knowledge-update');
    const assistant = buildPrompt('Q?', evidence, 'assistant');

    const distinct = new Set([extractive, abstention, temporal, knowledgeUpdate, assistant]);
    expect(distinct.size).toBe(5);
  });

  it('states the abstention contract explicitly, because that is its purpose', () => {
    const prompt = buildPrompt('Q?', [admitted('alpha')], 'abstention');

    // The reference pipeline uses a "conservative" wording so the model
    // recognizes the absence of an answer instead of being pushed to choose a
    // candidate. The wording must name the abstention path, not merely be
    // shorter.
    expect(prompt.toLowerCase()).toContain('not');
    expect(prompt.toLowerCase()).toMatch(/abstain|no answer|insufficient/);
  });

  it('passes the question date to the temporal contract only', () => {
    const evidence = [admitted('alpha')];
    const temporal = buildPrompt('Q?', evidence, 'temporal', { questionDate: '2023-05-01' });
    const extractive = buildPrompt('Q?', evidence, 'extractive', { questionDate: '2023-05-01' });

    expect(temporal).toContain('2023-05-01');
    // Handing a date to the extractive path would be a routing leak: the flat
    // path is chosen precisely when the caller wants no date reasoning.
    expect(extractive).not.toContain('2023-05-01');
  });

  it('omits the date placeholder entirely when no date is known', () => {
    const prompt = buildPrompt('Q?', [admitted('alpha')], 'temporal');

    expect(prompt).not.toContain('undefined');
    expect(prompt).not.toContain('null');
  });

  it('states the assistant-turn contract so an assistant turn is not read as user speech', () => {
    const prompt = buildPrompt('Q?', [admitted('alpha')], 'assistant');

    expect(prompt.toLowerCase()).toContain('assistant');
  });

  it('states the knowledge-update contract so a time qualifier is resolved', () => {
    const prompt = buildPrompt('Q?', [admitted('alpha')], 'knowledge-update');

    expect(prompt.toLowerCase()).toMatch(/previous|current|most recent/);
  });

  it('carries the no-evidence case without inventing evidence', () => {
    const prompt = buildPrompt('Q?', [], 'extractive');

    expect(prompt).toContain('Q?');
    // An empty evidence block must be visibly empty. A prompt that silently
    // loses the section lets the model answer from the question alone while the
    // caller believes it answered from memory.
    expect(prompt.toLowerCase()).toMatch(/no evidence|nothing|empty/);
  });

  it('respects a character budget by truncating evidence, not the question', () => {
    const long = admitted('x'.repeat(10_000));
    const prompt = buildPrompt('Q?', [long], 'extractive', { maxChars: 500 });

    expect(prompt.length).toBeLessThanOrEqual(500);
    expect(prompt).toContain('Q?');
  });

  it('keeps every contract available as a value, so routing can be exhaustive', () => {
    const contracts: PromptContract[] = [
      'extractive',
      'abstention',
      'temporal',
      'assistant',
      'knowledge-update',
    ];

    for (const contract of contracts) {
      expect(buildPrompt('Q?', [admitted('a')], contract)).toBeTypeOf('string');
    }
  });
});

/**
 * True when `text` contains an unpaired surrogate code unit.
 *
 * Written by hand rather than with `String.prototype.isWellFormed`, which is
 * ES2024 and not in this project's `lib`.
 */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (isHigh) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (isLow) {
      return true;
    }
  }
  return false;
}

describe('truncateCodePointSafe', () => {
  it('returns short text unchanged', () => {
    expect(truncateCodePointSafe('abc', 10)).toBe('abc');
  });

  it('truncates to the limit', () => {
    expect(truncateCodePointSafe('abcdef', 3)).toBe('abc');
  });

  it('does not split a surrogate pair', () => {
    // Slicing a four-byte emoji in half produces a lone surrogate, which is not
    // valid UTF-16 and corrupts the request body on serialisation. The reference
    // pipeline solved this in `sliceCodePointSafe`; the composition layer needs
    // the same guarantee or it reintroduces the bug.
    const emoji = '\u{1F600}';
    const truncated = truncateCodePointSafe(emoji + emoji, 3);

    expect(truncated).toBe(emoji);
    expect(hasLoneSurrogate(truncated)).toBe(false);
    // The counterfactual: a plain slice at the same cut point does split it, so
    // this test is measuring the guard and not a coincidence of the input.
    expect(hasLoneSurrogate((emoji + emoji).slice(0, 3))).toBe(true);
  });

  it('returns an empty string for a non-positive limit', () => {
    expect(truncateCodePointSafe('abcdef', 0)).toBe('');
    expect(truncateCodePointSafe('abcdef', -1)).toBe('');
  });

  it('keeps a combining sequence intact when it fits', () => {
    const combining = 'e\u0301';
    expect(truncateCodePointSafe(combining, 2)).toBe(combining);
  });
});
