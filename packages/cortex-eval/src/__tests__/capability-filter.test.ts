import { describe, expect, it } from 'vitest';

import {
  CAPABILITIES,
  readCapabilityFilter,
  restrictDatasetToCapability,
} from '../capability-filter.js';
import type { BenchmarkDataset, Capability, Question } from '../types.js';

/**
 * A dataset with one question per capability plus a second `MR`, so a filter can be shown to keep
 * *all* of one capability and not just the first match.
 */
function dataset(): BenchmarkDataset {
  const question = (id: string, capability: Capability): Question => ({
    id,
    capability,
    question: `question ${id}`,
    expected: 'a',
    context: [],
  });
  return {
    name: 'fixture',
    questions: [
      question('q1', 'IE'),
      question('q2', 'MR'),
      question('q3', 'KU'),
      question('q4', 'MR'),
      question('q5', 'ABS'),
    ],
  };
}

describe('readCapabilityFilter', () => {
  it('treats unset, blank and `all` as the unfiltered run', () => {
    // Three spellings, one state. `all` is not a capability name, so it has to be claimed here or
    // the reader would throw on the value a dispatch uses to say "every capability".
    expect(readCapabilityFilter(undefined)).toBeUndefined();
    expect(readCapabilityFilter('')).toBeUndefined();
    expect(readCapabilityFilter('   ')).toBeUndefined();
    expect(readCapabilityFilter('all')).toBeUndefined();
    expect(readCapabilityFilter('ALL')).toBeUndefined();
  });

  it('reads one name', () => {
    expect(readCapabilityFilter('MR')).toEqual(['MR']);
  });

  it('folds case and space, because the value is typed by hand', () => {
    expect(readCapabilityFilter('mr, tr ')).toEqual(['MR', 'TR']);
  });

  it('deduplicates rather than rejecting a repeated name', () => {
    // A set membership test expressed twice is still one set; failing the dispatch over it would
    // spend a run slot to teach nothing.
    expect(readCapabilityFilter('MR,MR,mr')).toEqual(['MR']);
  });

  it('ignores the empty segment a trailing comma leaves', () => {
    // `MR,` is what a hand-typed list looks like when a name is removed. The empty segment is not a
    // capability, so it is dropped rather than thrown on; the alternative is a dispatch failing over
    // a comma that names nothing.
    expect(readCapabilityFilter('MR,')).toEqual(['MR']);
    expect(readCapabilityFilter('MR , TR')).toEqual(['MR', 'TR']);
  });

  it('throws on a name that is not a capability, and lists the five', () => {
    // The usual mistake is the dataset's label rather than the report's code, so the message has to
    // name both. Asserted on the message because the message IS the repair for this defect.
    expect(() => readCapabilityFilter('knowledge-update')).toThrow(/IE, MR, KU, TR, ABS/);
    expect(() => readCapabilityFilter('XX')).toThrow(/CORTEX_CAPABILITY/);
  });

  it('names every capability the report prints', () => {
    // The union is the authority and this is the one place it is restated; a sixth capability added
    // to `Capability` without being added here would make the filter unable to select it.
    expect(CAPABILITIES).toEqual(['IE', 'MR', 'KU', 'TR', 'ABS']);
  });
});

describe('restrictDatasetToCapability', () => {
  it('returns the same object when unfiltered', () => {
    // Identity, not equality: an unfiltered run must take the code path it always took, and a copy
    // with equal contents would still be a second path through the dataset.
    const source = dataset();
    expect(restrictDatasetToCapability(source, undefined)).toBe(source);
  });

  it('keeps every question of the selected capability, in file order', () => {
    const restricted = restrictDatasetToCapability(dataset(), ['MR']);
    expect(restricted.questions.map((question) => question.id)).toEqual(['q2', 'q4']);
  });

  it('keeps the dataset name, which the artifact carries', () => {
    expect(restrictDatasetToCapability(dataset(), ['KU']).name).toBe('fixture');
  });

  it('unions several capabilities', () => {
    const restricted = restrictDatasetToCapability(dataset(), ['MR', 'ABS']);
    expect(restricted.questions.map((question) => question.id)).toEqual(['q2', 'q4', 'q5']);
  });

  it('refuses an empty dataset before it looks at the filter', () => {
    // A different cause from an unmatched filter and a different repair: `limit` admitted nothing,
    // which is a `limit` problem rather than a selector problem.
    expect(() => restrictDatasetToCapability({ name: 'fixture', questions: [] }, ['MR'])).toThrow(
      /sampled dataset is empty/,
    );
  });

  it('refuses a filter that selects nothing, and says what the dataset carries', () => {
    // The alternative is a run over zero questions publishing `0/0`, which every reader downstream
    // would have to tell apart from an arm that failed. The population is named in the message
    // because the cause is almost always `limit` stopping before the bucket was reached.
    expect(() => restrictDatasetToCapability(dataset(), ['TR'])).toThrow(/carries ABS, IE, KU, MR/);
  });
});
