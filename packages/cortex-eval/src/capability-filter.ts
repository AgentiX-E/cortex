/**
 * The population selector: run one capability instead of the whole file.
 *
 * ## Why this exists
 *
 * Every registration in this campaign that targets one capability is unreadable at screening scale.
 * The sampler round-robins over seven buckets -- `IE` is three sub-types and the other four
 * capabilities are one each -- so `LIMIT=200` gives `MR` 29 questions, and a 4-point `MR` effect is
 * 1.2 questions. §13.342.8 measured that and had to move two bars to `limit=400` to escape it.
 *
 * The cost of reading one capability the whole way down is not a bigger sample. `MR` is 121
 * questions in the file, so a run over `MR` alone at two repetitions is **242 graded passes instead
 * of 1,000**, which is a fifth of a full pass and enough resolution to see a 4-point effect at
 * 4.8 questions. That is the difference between a capability arm being affordable and being
 * registered and never dispatched, and it is why this is one flag rather than a wider `limit`.
 *
 * ## Why the filter is applied after the sample and before the arm
 *
 * After `sampleInstances`, because the two are different questions: `limit` asks *how many* and this
 * asks *which*. Composing them in one place would make `LIMIT=200,capability=MR` mean "29 MR
 * questions" or "200 MR questions" depending on the order of two lines nobody reads together.
 * Before the arm, for the reason §13.274's restore restriction sits there: the relevance index and
 * the graded passes both read this dataset, and a run whose index was built over 500 questions while
 * the arm graded 121 would report a pool the questions never had.
 *
 * ## Why an absent value is the identity rather than "no questions"
 *
 * Unset, blank and `all` all answer `undefined`, and `restrictDatasetToCapability` returns the
 * **same object** for `undefined`. That is what keeps every archived artifact reproducible: an
 * unfiltered run must be byte-identical to the run before this file existed, and a filter that
 * returned a copy with the same contents would still be a second code path through the dataset.
 */

import type { BenchmarkDataset, Capability, Question } from './types.js';

/**
 * The variable the harness reads.
 *
 * Module-local rather than exported: the harness spells the name at its one call site (the census
 * refuses an export with no caller), and the three messages below are the only other place it
 * appears -- so a caller that imported it and a harness that read it would be two statements of one
 * name with nothing checking they agreed.
 */
const CAPABILITY_FILTER_VARIABLE = 'CORTEX_CAPABILITY';

/** The five names this dataset's questions are filed under, in the order the report prints them. */
export const CAPABILITIES: readonly Capability[] = ['IE', 'MR', 'KU', 'TR', 'ABS'];

/**
 * Read the selector, or `undefined` when the run is unfiltered.
 *
 * Case and surrounding space are folded before the name is checked, and that is deliberate: the
 * value is typed by hand into a workflow dispatch, `MR` is what the report prints and `mr` is what
 * a person writes, and a run that dies on the difference spends a dispatch slot to teach nothing.
 * An **unknown** name still throws, because that is the case where a run would silently grade a
 * population nobody registered -- and the message lists the five, since the usual mistake is the
 * `knowledge-update` label rather than the `KU` code.
 */
export function readCapabilityFilter(raw: string | undefined): readonly Capability[] | undefined {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'all') return undefined;
  const names = trimmed
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part !== '');
  const chosen: Capability[] = [];
  for (const name of names) {
    if (!CAPABILITIES.includes(name as Capability)) {
      throw new Error(
        `${CAPABILITY_FILTER_VARIABLE} does not name a capability: got ${JSON.stringify(name)}. ` +
          `The five are ${CAPABILITIES.join(', ')} -- the codes the report prints, not the dataset's ` +
          'question types (`knowledge-update` is `KU`). A value that named nothing would grade an ' +
          'empty population and report an accuracy of `null`, which reads as a failed arm rather ' +
          'than as a failed dispatch.',
      );
    }
    // Deduplicated rather than rejected: the filter is a set membership test and `MR,MR` expresses
    // one capability twice. Rejecting it would fail a dispatch over a spelling that changes nothing.
    if (!chosen.includes(name as Capability)) chosen.push(name as Capability);
  }
  return chosen;
}

/**
 * The dataset with only the selected capabilities' questions, in file order.
 *
 * Returns its argument when the filter is absent, and refuses when the filter would grade nothing.
 * The second is not a convenience: `questions.length === 0` would reach the harness as a run over
 * zero questions and publish `0/0`, and every downstream reader of an artifact has to distinguish
 * that from a run whose arm failed on all of them. Refusing here keeps "the dispatch was wrong"
 * out of the artifacts.
 */
export function restrictDatasetToCapability(
  dataset: BenchmarkDataset,
  filter: readonly Capability[] | undefined,
): BenchmarkDataset {
  if (filter === undefined) return dataset;
  // An empty dataset is refused before the filter is applied, rather than folded into the
  // selection's own refusal. The two have different causes and different repairs -- one is a
  // `limit` of zero, the other a `limit` too small to reach a bucket -- and a message that said
  // "it carries nothing" for both would send the reader looking at the wrong input.
  if (dataset.questions.length === 0) {
    throw new Error(
      'the sampled dataset is empty, so there is no population to select from. `LIMIT=0` means ' +
        'the full file and any other value must admit at least one question per bucket.',
    );
  }
  const wanted = new Set<string>(filter);
  const questions: Question[] = dataset.questions.filter((question) =>
    wanted.has(question.capability),
  );
  if (questions.length === 0) {
    const present = [...new Set(dataset.questions.map((question) => question.capability))].sort();
    throw new Error(
      `${CAPABILITY_FILTER_VARIABLE} selected ${filter.join(', ')} and the sampled dataset carries ` +
        `none of them (it carries ${present.join(', ')}). The selector runs after ` +
        '`limit`, so a sample small enough to reach only some buckets can exclude the capability a ' +
        'run asked for; raise `limit` or drop the filter.',
    );
  }
  return { name: dataset.name, questions };
}
