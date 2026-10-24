/**
 * The one path by which a rule is overridden, and the record it has to leave.
 *
 * ## The gap this closes
 *
 * Step 6 found it and named it: a sentence the rule table judges private is stored privately and
 * **never becomes a card**, so there is no question to answer and no way for the owner to change
 * their mind. `g42` -- a health sentence -- sat in the private store forever. Every other boundary in
 * this product has a door; that one had none.
 *
 * A door is not a hole. Three properties make this one safe, and each is a decision rather than a
 * default:
 *
 * 1. **A token, not a boolean.** `acknowledge` must be the literal string `rule-override`. A `true`
 *    is a value a caller can pass by accident while wiring a form; a string with the rule's name in
 *    it has to be typed on purpose. The token is recorded, so an audit can see what was acknowledged
 *    rather than inferring it.
 * 2. **A separate record, in the private store.** Not a card, not a field on the row: a release is
 *    not an acceptance, and a reader of the card table must not find one there. It lives under
 *    `private/releases`, so a shared task cannot read the audit trail of what was released.
 * 3. **Written before the row moves.** If the process dies between the two, the record says
 *    "released, incomplete" and the row is still private -- a failed release that is visible. The
 *    other order would produce a shared row with no record of why it was allowed to be shared,
 *    which is the one outcome this product exists to prevent.
 *
 * ## What it deliberately refuses
 *
 * A `defer` row and a row with no rule are both refused. A deferral is a *question*, and questions
 * are answered with cards -- overriding a rule that never fired would produce a warning with no
 * policy sentence in it, which is a warning that says nothing.
 */

import { TriageError, type AdmittedFact } from './writer.js';

/**
 * What a caller must type to override a rule.
 *
 * Exported so a test, a CLI help line and the error message cannot disagree about it. The value is
 * written into the record, so changing it is a change to the audit trail rather than to a default.
 */
export const RELEASE_TOKEN = 'rule-override';

/** The durable account of one override. Lives in the private store, never in the cards table. */
export type ReleaseRecord = {
  readonly id: string;
  /** The rule that would have kept it private. */
  readonly rule: string;
  /** That rule's policy sentence, copied at release time: policies change, the record does not. */
  readonly policy: string;
  /** The exact wording that was released. Kept so the record is readable, not just verifiable. */
  readonly text: string;
  /** `algorithm` travels with the value: a digest whose algorithm is assumed is a rumour. */
  readonly digestAlgorithm: 'sha-256';
  readonly digest: string;
  /** The token the caller typed. */
  readonly acknowledged: string;
  /** When the override was recorded. */
  readonly releasedAt: number;
  /** When the row reached the shared store. `null` means the release did not complete. */
  readonly completedAt: number | null;
};

/**
 * The sentence a caller is shown before they can override, and the one an auditor reads afterwards.
 *
 * Built from the row rather than composed at each call site, so the CLI's prompt and the error the
 * writer throws are the same string. A warning that exists in two versions is a warning that will
 * drift into the weaker one.
 */
export function releaseWarning(fact: AdmittedFact, verdict: ReleaseAllowed): string {
  const { rule, policy } = verdict;
  return [
    `releasing ${JSON.stringify(fact.id)}: rule ${JSON.stringify(rule)} would keep this private.`,
    `  policy: ${policy}`,
    '  the override is recorded against this row and is permanent for this wording; after it,',
    '  shared tasks can read the sentence below.',
    `  text: ${fact.text}`,
    `to proceed, pass acknowledge: ${JSON.stringify(RELEASE_TOKEN)}`,
  ].join('\n');
}

/** The rule and its policy sentence, once the row is known to be a legitimate subject. */
export type ReleaseAllowed = { readonly rule: string; readonly policy: string };

/**
 * Whether this row is a legitimate subject for a release, or why it is not.
 *
 * A discriminated union rather than a nullable string, because the allowed case has to carry the
 * rule and the policy *into* the warning. The first version returned `string | null` and the warning
 * then did `fact.triage.rule ?? '(no rule)'` -- two branches no caller could reach, which read as
 * defensive code and were in fact dead. Making the compiler carry the two strings removes them.
 */
export type ReleaseVerdict =
  ({ readonly ok: true } & ReleaseAllowed) | { readonly ok: false; readonly refusal: string };

export function releaseVerdict(fact: AdmittedFact): ReleaseVerdict {
  if (fact.triage.scope === 'defer') {
    return {
      ok: false,
      refusal:
        `${JSON.stringify(fact.id)} was deferred, not judged private: no rule fired, so there is ` +
        'nothing to override. A deferral is a question, and the card queue is how it is answered.',
    };
  }
  const { rule, policy } = fact.triage;
  if (rule === null || policy === null) {
    return {
      ok: false,
      refusal:
        `${JSON.stringify(fact.id)} carries no rule id or no policy sentence, so there is nothing ` +
        'to override and no warning to show. A private row without a rule is a classifier defect, ' +
        'not a decision.',
    };
  }
  return { ok: true, rule, policy };
}

/** A release that has not finished, from the point of view of the row it concerns. */
export function isIncomplete(record: ReleaseRecord): boolean {
  return record.completedAt === null;
}

/**
 * SHA-256 of the released wording, hex.
 *
 * Async because `crypto.subtle` is the only digest available in both Node and a browser, and it is
 * asynchronous everywhere. A runtime without it is **refused rather than downgraded**: a weaker
 * digest would still look like a digest, and the record would claim `sha-256` while holding
 * something else -- which is the substitution this field exists to make impossible.
 */
export async function digestOf(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new TriageError(
      'SHA-256 is unavailable in this runtime: crypto.subtle is missing. A release record needs a ' +
        'digest, and this refuses to record a weaker one under the sha-256 label.',
    );
  }
  const bytes = new TextEncoder().encode(text);
  const hash = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
