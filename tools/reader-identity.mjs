/**
 * How a reading stage names itself in the artifact.
 *
 * ## Why this is a module and not two template literals
 *
 * `comparability()` compares the `reader` and `judge` strings carried in `config`, and it treats a difference as a
 * hard difference. So these strings are not labels -- they are the claim that two runs were the same experiment. A
 * literal assembled at the call site can be edited without any test noticing, and it already was: the string said
 * `deepseek-chat (chain-of-note/con, one request)` for every T1 row ever read, including the rows served at the
 * provider's default temperature because `competitor-retrieval.yml` forwarded no `TEMPERATURE` at all. The run that
 * exposed it is `43178388235`, where the same control arm read twice moved 13 -> 11 on twenty questions.
 *
 * Extracted, the mapping is testable without a dataset, a key or a model: `temperature: null` must render `default`
 * and `temperature: 0` must render `0`, because those are two different requests and the artifact has to say which
 * one was made.
 *
 * ## Why `default` and not `none`
 *
 * `reader-temperature.ts` spells the sentinel `default` in the dispatch input and `temp=default` in the report. One
 * fact, one word: a reader that sent no temperature field was served at the provider's default, and writing `none`
 * here would suggest the request carried a temperature of nothing rather than no temperature at all.
 */

/**
 * The sampling field as it appears in a name.
 *
 * `null` is not coerced to `0`. It is the value `readTemperature` returns when the environment asked for no
 * temperature, and the difference between "we pinned this to zero" and "the vendor decided" is exactly the
 * difference that went unrecorded for every T1 row before round 79.
 */
export function temperatureLabel(temperature) {
  return `temp=${temperature === null ? 'default' : String(temperature)}`;
}

/**
 * The reading half of the instrument.
 *
 * `mode` is the prompt the stage asks with (`con`, `dispatch`, `dispatch2`); it belongs in the name because the
 * prompt is half of what a reader is, and a run that swapped prompts under one arm's name would otherwise compare
 * equal to one that did not.
 */
export function describeReaderIdentity({ model, mode, temperature }) {
  return `${model} (chain-of-note/${mode}, ${temperatureLabel(temperature)}, one request)`;
}

/**
 * The grading half.
 *
 * It carries the temperature too, because the judge is built from the same `createLlmFromEnv` call as the reader and
 * an unpinned judge would sample its verdicts. That is not hypothetical: `MEASURE-JUDGE-SENSITIVITY.md` reads a
 * 0.43% same-judge flip rate on byte-identical input, which is the floor under every paired comparison here.
 */
export function describeJudgeIdentity({ model, temperature }) {
  return `${model} (official per-type templates, ${temperatureLabel(temperature)})`;
}

/** The name a stage that did not read anything carries. One spelling, so a table cannot be half-annotated. */
export const NO_READER = 'none (retrieval only)';
