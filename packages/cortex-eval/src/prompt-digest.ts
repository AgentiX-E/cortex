import { createHash } from 'node:crypto';

/**
 * A fingerprint of a prompt, truncated to 64 bits.
 *
 * `§13.168.8` registers this as the field that decides whether the four passes of a
 * dispatch sent the same request. The measurement it settles is the provider's cache
 * credit: `§13.147.3` predicted 60-80% from the premise that passes 2-4 resend
 * byte-identical prompts, and two artifacts read 6.47% and 11.16% instead. Equal
 * fingerprints leave the provider as the explanation; unequal ones mean the passes
 * were never repetitions, which is an arm defect and would be the cheaper finding.
 *
 * ## Why this lives here and not in `cortex-memory`
 *
 * `cortex-memory` imports no host API -- no `crypto`, no `fs` -- which is the property
 * the browser feasibility study rests on. It therefore exposes the prompt text
 * (`lastPromptText`) and this module, which is already Node-only, hashes it.
 *
 * ## Why sixteen hex characters
 *
 * Five hundred questions produce about a thousand records, and at 64 bits the chance
 * of any collision among them is on the order of 1e-14 -- far below the chance that
 * two prompts differ in a way this run would never notice. A full 64-character digest
 * would spend four times the artifact bytes to move a probability that is already
 * unmeasurable. The truncation is an assertion in the tests, because it is part of
 * what "equal" means to a reader comparing two artifacts.
 *
 * ## Why the digest is not a length
 *
 * `promptChars` already exists and is one arm's evidence characters. A length cannot
 * distinguish "the same prompt" from "a prompt that changed within its budget", and
 * distinguishing those is the whole question.
 */
export function promptDigest(prompt: string | null): string | null {
  if (prompt === null) return null;
  return createHash('sha256').update(prompt, 'utf8').digest('hex').slice(0, 16);
}
