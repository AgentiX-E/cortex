/**
 * Which judge an artifact was graded with, and which judge a re-reading will use.
 *
 *     import { judgeEnvFor, artifactJudgeIdentity } from './judge-identity.mjs';
 *
 * ## Why this is a module and not four functions inside one tool
 *
 * Because two tools ask two different questions about **one** instrument. `judge-audit.mjs` asks how
 * often the judge accepts an answer that is wrong by construction (its bias); `judge-regrade.mjs`
 * asks how often it changes its mind about the same bytes (its variance). A bias and a variance
 * measured on different models are not two readings of one judge, and §13.312 is the round where
 * exactly that happened: both tools built the judge from the reader factory, the workflow named the
 * model in a variable neither factory reads, and the temperature was never sent at all. Three
 * silent substitutions, and the number they produced was read as a finding about a memory arm.
 *
 * The repair has two halves and both are here: the identity is **read back from the artifact**
 * (`memoryArmConfig.judge`, or `memoryArmConfig.reader` for artifacts written before the judge was
 * recorded separately) instead of being typed by an operator, and the comparison between the
 * recorded and the chosen judge is a value the reading carries rather than a line in a log that
 * expires.
 *
 * The one import is the provider declaration, and the docblock of `credentialForJudge` says why this
 * module could not render that value itself.
 */

import { resolveReaderProvider } from '../packages/cortex-eval/dist/index.js';

/**
 * The variable the judge is pinned in, mirroring `llm-factory.ts`'s `JUDGE_MODEL_VARIABLE`.
 *
 * Deliberately not `DEEPSEEK_MODEL`: that one names the *reader*, so a tool that pinned its judge
 * through it would be changing the thing the artifact's arm was measuring. Two roles, two variables.
 */
export const JUDGE_MODEL_VARIABLE = 'CORTEX_JUDGE_MODEL';



/**
 * The judge an artifact was graded with, as the artifact recorded it.
 *
 * `judge` first, `reader` second. The order is the section: before §13.312 there was no separate
 * record, because the judge was always the reader and nothing could tell them apart. An artifact
 * written since says which of the two its judge was; an artifact written before says only which
 * model answered, and using that as the judge is the best reconstruction available rather than a
 * claim that the two were the same.
 *
 * Every field can be `null`, and `null` is not "the default": it means this artifact does not say. A
 * re-grade of an artifact that does not say cannot claim to describe its judge, and the reading
 * records that as unknown rather than as a match.
 */
export function artifactJudgeIdentity(report) {
  const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
  const recorded = report?.memoryArmConfig?.judge;
  if (recorded !== undefined && recorded !== null) {
    return {
      provider: text(recorded.providerId),
      model: text(recorded.model),
      temperature: typeof recorded.temperature === 'number' ? recorded.temperature : null,
      source: text(recorded.source),
    };
  }
  const reader = report?.memoryArmConfig?.reader;
  return {
    provider: text(reader?.providerId),
    model: text(reader?.model),
    temperature: typeof reader?.temperature === 'number' ? reader.temperature : null,
    // Not `'reader'`: this artifact never said which it was, and claiming the reconstruction was the
    // record would erase the only fact that distinguishes it from a run written after the field.
    source: null,
  };
}

/**
 * The `DEEPSEEK_MODEL` grammar: a bare id means the default provider, `provider:id` names both.
 *
 * Reimplemented here rather than imported from `reader-provider.ts`, because that module's
 * `readModelSelection` is a *resolution* -- it validates the provider and throws -- where this is a
 * render of a value this module built. A tool that had to import a validator to print a string would
 * be one refactor away from printing a string it had not validated.
 */
export function selectionFor(provider, model) {
  if (model === null) return null;
  if (provider === null || provider === 'deepseek') return model;
  return `${provider}:${model}`;
}

/**
 * Which variable holds the credential the judge this process would build needs.
 *
 * ## Why this function imports the factory's table instead of restating it
 *
 * Every other function in this module avoids the package, because each of them renders a value it
 * built itself. This one does not have that option: "which variable does provider `zhipu` read" is a
 * fact that lives in `reader-provider.ts`'s declaration table, and a second copy here would be a
 * second answer to it. The failure that copy produces is not cosmetic -- it is `judge-audit.yml`
 * exporting `DEEPSEEK_API_KEY` while the judge was pinned to `zhipu:`, which sends one vendor's
 * credential to another and collects a 401 on every question of a 500-question pass, or (worse)
 * sends nothing and dies before the first one.
 *
 * ## Why it takes the artifact
 *
 * Because on the dispatch that matters, `CORTEX_JUDGE_MODEL` is *empty*: the judge is whatever graded
 * the artifact. A check that resolved the credential from the environment alone would answer about
 * `deepseek` -- the default -- on the one run whose whole point was a judge from somewhere else.
 *
 * ## `origin`, and why it is not a boolean
 *
 * "The dispatch pinned it", "the artifact recorded it" and "neither said, so it follows the reader"
 * are three different facts about how confident the name is, and the third one is the state in which
 * a wrong credential is most likely: nothing told the job which vendor it was about to call.
 */
export function credentialForJudge(report, env = {}) {
  const resolved = judgeEnvFor(report, env);
  const identity = artifactJudgeIdentity(report);
  const fromArtifact = selectionFor(identity.provider, identity.model);
  const pinned = (env[JUDGE_MODEL_VARIABLE] ?? '').trim();
  const origin =
    pinned !== '' ? 'the dispatch' : fromArtifact !== null ? 'the artifact' : 'the reader';
  const provider = resolveReaderProvider(resolved, JUDGE_MODEL_VARIABLE);
  const variable = provider.credentialVariable;
  const value = resolved[variable];
  const present = typeof value === 'string' && value.trim() !== '';
  return {
    selection: (resolved[JUDGE_MODEL_VARIABLE] ?? '').trim() || null,
    origin,
    providerId: provider.id,
    variable,
    present,
    // The length, never the value. An operator needs to know that *a* key arrived and that the wrong
    // one did not; both are answered by a number, and neither by the secret.
    length: present ? value.trim().length : 0,
  };
}

/**
 * The environment a re-reading builds its judge from: the dispatch's, with the artifact's identity
 * filled in wherever the dispatch left the question blank.
 *
 * An explicit `CORTEX_JUDGE_MODEL` still wins, because an override is what makes a judge-sensitivity
 * experiment expressible -- "what would `deepseek-chat` say about arm B's answers" is a legitimate
 * and useful measurement, and §13.312's whole finding is that it is a *different* measurement from
 * "did the artifact grade arm B correctly". What the override can no longer do is happen by omission.
 */
export function judgeEnvFor(report, env) {
  const identity = artifactJudgeIdentity(report);
  const resolved = { ...env };
  const selection = selectionFor(identity.provider, identity.model);
  if (selection !== null && (resolved[JUDGE_MODEL_VARIABLE] ?? '').trim() === '') {
    resolved[JUDGE_MODEL_VARIABLE] = selection;
  }
  if (identity.temperature !== null && (resolved.TEMPERATURE ?? '').trim() === '') {
    resolved.TEMPERATURE = String(identity.temperature);
  }
  return resolved;
}

/**
 * Whether the judge this process will use is the one the artifact was graded with.
 *
 * Takes the **resolved** environment, so the question is about the request that will actually be
 * sent rather than about what a dispatch happened to type. Both halves are compared: a model is not
 * a judge without the temperature it read at, which is the half §13.312 found missing entirely.
 *
 * `null` when the artifact does not record a model: "unverifiable" and "verified equal" are different
 * claims, and collapsing them is how the previous round's reading acquired confidence it had not
 * earned.
 */
export function judgeMatchesArtifact(report, resolvedEnv) {
  const identity = artifactJudgeIdentity(report);
  const recorded = selectionFor(identity.provider, identity.model);
  if (recorded === null) return null;
  const chosen = (resolvedEnv[JUDGE_MODEL_VARIABLE] ?? '').trim();
  if (chosen !== '' && chosen !== recorded) return false;
  const temperature = (resolvedEnv.TEMPERATURE ?? '').trim();
  if (
    identity.temperature !== null &&
    temperature !== '' &&
    temperature !== String(identity.temperature)
  ) {
    return false;
  }
  return true;
}
