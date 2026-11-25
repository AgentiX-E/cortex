/**
 * What the provider's `prompt_cache_hit_tokens` is actually counting, asked with five prompts.
 *
 * ## The arithmetic that forces the question
 *
 * Run `45543010618` refused `resolution: 'layered'` on its bill: the credited cache fell from 96.9% to
 * 70.8% and the cache-weighted price rose to **1.55x** the baseline. The same artifact, read against
 * its own per-question evidence, cannot support that counter:
 *
 * | reading | value |
 * | --- | --- |
 * | reader calls on the baseline side, shard 0 | 129 |
 * | prompt tokens those calls billed | 918,259 |
 * | prompt tokens the provider credited as cache hits | 885,375 (**96.4%**) |
 * | longest byte prefix any two of the 63 prompts share | **22 characters** |
 * | sentences of one prompt that appear in any other prompt | the shared instruction line only |
 *
 * A prefix cache cannot credit a token whose 6,800-token prefix has never been sent, and a second run
 * over the same 500 questions can reuse *at most* one copy of each prompt -- which is 50% by
 * construction, not 96%. So the counter is measuring something else, and until this repository knows
 * what, a price ratio built out of it is not a bill and cannot veto a mechanism whose prompt tokens
 * moved +0.07% (`R3`).
 *
 * ## Five prompts, two hypotheses
 *
 * | variant | what changed | position model credits | content model credits |
 * | --- | --- | --- | --- |
 * | `reference` | nothing, it is first | 0% | 0% |
 * | `repeat` | nothing, it is second | 100% | 100% |
 * | `head-changed` | the first 200 characters | 0% | ~97% |
 * | `paragraphs-swapped` | paragraph order, same sentences | 0% | 100% |
 * | `unrelated` | everything but the instruction | 0% | ~2% |
 *
 * `repeat` is the control: a counter that does not read 100% there is not a cache counter at all.
 * `paragraphs-swapped` is the discriminator -- the same sentences in a different order, so a cache that
 * serves a *run from the start* credits nothing and a cache that serves *content wherever it was seen*
 * credits everything. Those are the only two shapes a reuse counter can have, and the two readings
 * differ by a whole prompt on that one variant.
 *
 * The content model is measured in **sentences**, not in fixed-width blocks, and the unit is the
 * generator's: a fixed-width block model scores a reordered text at zero, because every 200-character
 * window that crosses a paragraph join is a window on a join that no longer exists. Sentences survive
 * reordering exactly, so they are the finest unit this probe can move without also destroying the
 * content it means to keep.
 *
 * ## Why the text is nonsense
 *
 * The prompts are generated from syllables (`zor`, `qua`, `vip`, ...) rather than from prose, because a
 * provider cache is shared with every other tenant of the same endpoint and a prompt assembled from
 * English sentences could match text this repository never sent. Determinism matters for a second
 * reason: two dispatches of this probe must be the same experiment, so the generator is seeded and
 * takes no clock.
 *
 * ## What the verdict licenses
 *
 * - `position` or `content`: the credit is a measure of reuse, so a fallen credit is a real cost and
 *   the lever is to make the rendering of a turn independent of the question.
 * - `neither`: the credit is not a reuse measure, so the 1.55x price ratio is not a bill, `R5` cannot
 *   be registered on it, and the axis has to be decided on prompt tokens per answer.
 */

/** Which prompt of the probe, and therefore which hypothesis it tests. */
export type CacheCreditVariant =
  'reference' | 'repeat' | 'head-changed' | 'paragraphs-swapped' | 'unrelated';

/** One prompt, with the variant that names what it is for. */
export interface CacheCreditPrompt {
  readonly variant: CacheCreditVariant;
  readonly text: string;
}

/** What one call billed and what the provider credited. */
export interface CacheCreditSample {
  readonly variant: CacheCreditVariant;
  readonly promptTokens: number;
  readonly cacheHitPromptTokens: number;
}

/** One model's prediction beside the reading, for one prompt. */
export interface CacheCreditRow {
  readonly variant: CacheCreditVariant;
  /** Share of this prompt the model says could have been served from cache, in [0, 1]. */
  readonly expected: number;
  /** Share the provider credited, in [0, 1]. */
  readonly credited: number;
}

/** How well one reuse model explains the five readings. */
export interface CacheCreditModelFit {
  /**
   * `position` serves a run of bytes from the start of the prompt; `content` serves any sentence it
   * has seen before, wherever that sentence now sits.
   */
  readonly model: 'position' | 'content';
  /** Mean of `|expected - credited|` over the samples. Zero is a model that explains every call. */
  readonly meanAbsoluteResidual: number;
  /** The largest single disagreement, so one bad row cannot hide behind four good ones. */
  readonly worstResidual: number;
  readonly rows: readonly CacheCreditRow[];
}

/** The probe's reading: two models, one verdict. */
export interface CacheCreditFit {
  readonly position: CacheCreditModelFit;
  readonly content: CacheCreditModelFit;
  readonly verdict: 'position' | 'content' | 'neither';
  /** The winning model's mean absolute residual, carried so a reader does not look it up twice. */
  readonly closest: number;
}

/**
 * Residual a model may leave and still be called the explanation.
 *
 * `0.15` is one part in seven of a prompt. The five variants are built so the two models differ by
 * most of a prompt on `paragraphs-swapped`, so a threshold in that gap decides between the models
 * rather than between a model and noise; what it must **not** do is let a model through when it
 * predicts 0% and the provider credits 96%, which is the state this probe exists to detect.
 */
const CLOSE_ENOUGH = 0.15;

/** Characters of `head-changed` that are replaced, counted from the start of the prompt. */
const REPLACED_HEAD = 200;

/** The syllables the generator builds words from. Short, unambiguous, and not English. */
const SYLLABLES = [
  'zor',
  'qua',
  'vip',
  'tam',
  'len',
  'dor',
  'fes',
  'gul',
  'num',
  'pex',
  'rav',
  'sil',
  'tor',
  'wen',
  'yul',
  'zin',
] as const;

/**
 * The instruction every prompt ends with.
 *
 * At the end, and identical in all five, for the reason the product's own prompts put it there: the
 * variable part has to come first for any prefix reuse to be possible at all, so a probe that put a
 * question at the front would measure a prompt shape this repository does not send.
 */
const TAIL = '\n\nReply with exactly one word: OK';

/** A linear congruential generator: seeded, deterministic, and dependency-free. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** `paragraphs` paragraphs of `sentences` pseudo-sentences, joined by blank lines. */
function pseudoText(seed: number, paragraphs: number, sentences: number): string {
  const next = generator(seed);
  const out: string[] = [];
  for (let paragraph = 0; paragraph < paragraphs; paragraph += 1) {
    const lines: string[] = [];
    for (let sentence = 0; sentence < sentences; sentence += 1) {
      const words: string[] = [];
      const length = 8 + Math.floor(next() * 7);
      for (let word = 0; word < length; word += 1) {
        const first = SYLLABLES[Math.floor(next() * SYLLABLES.length)] as string;
        const second = SYLLABLES[Math.floor(next() * SYLLABLES.length)] as string;
        words.push(`${first}${second}`);
      }
      lines.push(`${words.join(' ')}.`);
    }
    out.push(lines.join(' '));
  }
  return out.join('\n\n');
}

/**
 * The five prompts, in the order they must be sent.
 *
 * Order is part of the experiment rather than a detail of the caller: both models' expectations are
 * computed against the prompts already sent, so `repeat` only reads 100% in second position.
 */
export function buildCacheCreditPrompts(
  options: {
    readonly seed?: number;
    readonly paragraphs?: number;
    readonly sentences?: number;
  } = {},
): readonly CacheCreditPrompt[] {
  const seed = options.seed ?? 20261125;
  const paragraphs = options.paragraphs ?? 6;
  const sentences = options.sentences ?? 8;
  const body = pseudoText(seed, paragraphs, sentences);
  const blocks = body.split('\n\n');
  // Reversed rather than rotated: a rotation leaves one paragraph in place at the front for a
  // two-paragraph text, and a variant that accidentally keeps its head is a variant that cannot
  // separate the models.
  const swapped = [...blocks].reverse().join('\n\n');
  // `Q` first by construction, so `head-changed` shares no prefix with `reference` even by accident.
  const filler = `Q${pseudoText(seed + 7, paragraphs, sentences)}`.slice(0, REPLACED_HEAD);
  return [
    { variant: 'reference', text: `${body}${TAIL}` },
    { variant: 'repeat', text: `${body}${TAIL}` },
    { variant: 'head-changed', text: `${filler}${body.slice(REPLACED_HEAD)}${TAIL}` },
    { variant: 'paragraphs-swapped', text: `${swapped}${TAIL}` },
    { variant: 'unrelated', text: `${pseudoText(seed + 13, paragraphs, sentences)}${TAIL}` },
  ];
}

/** How many leading characters `a` and `b` agree on. */
export function sharedPrefixChars(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return index;
}

/**
 * Share of `prompts[index]` a cache that serves a run from the start could have answered.
 *
 * The longest prefix any earlier prompt shares, over this prompt's length: such a cache serves one run
 * of bytes from the beginning and nothing else, so the maximum is the whole of what is available.
 */
export function positionExpectation(prompts: readonly string[], index: number): number {
  const text = prompts[index];
  if (text === undefined) throw new Error(`positionExpectation: no prompt at index ${index}`);
  if (text.length === 0) return 0;
  let best = 0;
  for (let earlier = 0; earlier < index; earlier += 1) {
    const other = prompts[earlier] as string;
    best = Math.max(best, sharedPrefixChars(text, other));
  }
  return best / text.length;
}

/**
 * Share of `prompts[index]` a cache that serves content wherever it was seen could have answered.
 *
 * Counted in sentences, because that is the unit the five variants move without destroying: a text
 * whose paragraphs are reordered keeps every sentence and loses every window that crossed a join.
 *
 * The answer is never exactly zero for a prompt after the first one -- all five end with the same
 * instruction -- and that is a property of the experiment rather than a defect in it: the shared tail
 * *is* reusable content, and a model that ignored it would be scoring itself generously.
 *
 * Shares are weighted by characters, which is the only weighting a token bill agrees with.
 */
export function contentExpectation(prompts: readonly string[], index: number): number {
  const text = prompts[index];
  if (text === undefined) throw new Error(`contentExpectation: no prompt at index ${index}`);
  const seen = new Set<string>();
  for (let earlier = 0; earlier < index; earlier += 1) {
    for (const sentence of sentencesOf(prompts[earlier] as string)) seen.add(sentence);
  }
  const own = sentencesOf(text);
  const ownChars = own.reduce((sum, sentence) => sum + sentence.length, 0);
  if (ownChars === 0) return 0;
  // Weighted by characters rather than by count: a numbered list's `2.` is a sentence by this file's
  // split and a hundredth of a sentence by the only measure a token bill cares about, and a model that
  // counted them equally would score a prompt as reused because it happened to contain a list.
  const reusedChars = own
    .filter((sentence) => seen.has(sentence))
    .reduce((sum, sentence) => sum + sentence.length, 0);
  return reusedChars / ownChars;
}

/**
 * The sentences of one prompt: a `.` followed by whitespace ends one, and empty ones are dropped.
 *
 * The full stop stays on the sentence it ends. Splitting it away would make `Three` and `Three.` two
 * different sentences, so a prompt whose only change is the order of its paragraphs would score one
 * sentence in three instead of all three -- a unit that disagrees with itself about what a sentence is.
 */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=\.)\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** The reading for one sample: credited share of the prompt, refusing a value that cannot be true. */
function creditedShare(sample: CacheCreditSample): number {
  if (sample.promptTokens <= 0) {
    throw new Error(`cache credit: ${sample.variant} billed ${sample.promptTokens} prompt tokens`);
  }
  if (sample.cacheHitPromptTokens > sample.promptTokens) {
    throw new Error(
      `cache credit: ${sample.variant} credited ${sample.cacheHitPromptTokens} of ` +
        `${sample.promptTokens} prompt tokens, which is more than the prompt`,
    );
  }
  return sample.cacheHitPromptTokens / sample.promptTokens;
}

/** One model's fit, computed in one place so the two cannot be scored by different arithmetic. */
function fitModel(
  model: 'position' | 'content',
  samples: readonly CacheCreditSample[],
  texts: readonly string[],
  indexOf: ReadonlyMap<CacheCreditVariant, number>,
): CacheCreditModelFit {
  const rows = samples.map((sample) => {
    const index = indexOf.get(sample.variant);
    if (index === undefined) {
      throw new Error(`cache credit: no prompt was sent for variant ${sample.variant}`);
    }
    return {
      variant: sample.variant,
      expected:
        model === 'position' ? positionExpectation(texts, index) : contentExpectation(texts, index),
      credited: creditedShare(sample),
    };
  });
  const residuals = rows.map((row) => Math.abs(row.expected - row.credited));
  return {
    model,
    meanAbsoluteResidual: residuals.reduce((sum, value) => sum + value, 0) / residuals.length,
    worstResidual: residuals.reduce((worst, value) => Math.max(worst, value), 0),
    rows,
  };
}

/**
 * Score both reuse models against what the provider credited, and name the winner.
 *
 * Refusals are structural rather than defensive: no samples is a probe that measured nothing, and a
 * `promptTokens` of zero is a call whose prompt the ledger never saw. Both would otherwise produce a
 * verdict from an empty mean.
 */
export function fitCacheCreditModels(
  samples: readonly CacheCreditSample[],
  prompts: readonly CacheCreditPrompt[],
): CacheCreditFit {
  if (samples.length === 0) throw new Error('cache credit: no samples were measured');
  if (prompts.length === 0) throw new Error('cache credit: no prompts were built');
  const texts = prompts.map((prompt) => prompt.text);
  const indexOf = new Map(prompts.map((prompt, index) => [prompt.variant, index] as const));
  const position = fitModel('position', samples, texts, indexOf);
  const content = fitModel('content', samples, texts, indexOf);
  const winner = position.meanAbsoluteResidual <= content.meanAbsoluteResidual ? position : content;
  const closest = winner.meanAbsoluteResidual;
  return {
    position,
    content,
    // A model that cannot predict the control is not the explanation, however it compares with the
    // other one: two wrong models still have a smaller residual, and picking it would be a choice
    // about which error to display rather than a finding.
    verdict: closest <= CLOSE_ENOUGH ? winner.model : 'neither',
    closest,
  };
}

/**
 * The reading, as a table a person can check against the run log.
 *
 * Printed beside the verdict rather than summarised by it, because the verdict is one word and the
 * five rows are the evidence for it: a reader who disagrees with `CLOSE_ENOUGH` has to be able to
 * recompute the residuals from what is on the page.
 */
export function renderCacheCreditReport(fit: CacheCreditFit): string {
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
  const lines = [
    '| variant | position model | content model | credited |',
    '| --- | ---: | ---: | ---: |',
    ...fit.position.rows.map((row, index) => {
      const contentRow = fit.content.rows[index] as CacheCreditRow;
      return `| ${row.variant} | ${percent(row.expected)} | ${percent(contentRow.expected)} | ${percent(
        row.credited,
      )} |`;
    }),
    '',
    `- Mean absolute residual: position **${fit.position.meanAbsoluteResidual.toFixed(3)}**, ` +
      `content **${fit.content.meanAbsoluteResidual.toFixed(3)}** ` +
      `(worst ${fit.position.worstResidual.toFixed(3)} / ${fit.content.worstResidual.toFixed(3)})`,
    `- Verdict: **${fit.verdict}** at ${fit.closest.toFixed(3)} <= ${CLOSE_ENOUGH}`,
    '',
    'A `neither` verdict means the credit is not a reuse measure: the 1.55x price ratio of run',
    '`45543010618` cannot be a bill, and the `resolution` axis is decided on prompt tokens per answer.',
  ];
  return lines.join('\n');
}
