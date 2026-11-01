/**
 * Content identity for the dataset a run graded.
 *
 * A score is a property of a pair: the pipeline and the file it was scored against.
 * This repository has always recorded the first and never the second -- every
 * artifact names its dataset with a string (`longmemeval`, `longmemeval-mini`) that
 * is a NAME, not an identity, and the workflow fetches that name from
 * `resolve/main`, a reference that can move without a commit here.
 *
 * What that costs was measured rather than feared: the same benchmark reported at
 * 96.6% and at 89.80% is not comparable at any level -- different task, different
 * denominator, different number of LLM calls (`cortex-docs`
 * `05-competitor-analysis.md` §1.6). Half of that gap is specification, and the
 * other half is that neither side can be asked which file it read.
 *
 * The repair has two halves and they ship separately. **Recording** the digest needs
 * no prior knowledge: it costs one pass over a file the run already reads, and it
 * makes every future artifact able to answer "which bytes?". **Refusing** on a
 * mismatch needs a pinned expected value, and pinning one here would be a guess,
 * because the dataset file is not present in this environment. Haki refuses to run
 * on a sha256 mismatch; this harness cannot yet, and
 * `cortex/docs/AUDIT-BENCHMARK-WALLCLOCK.md` §7.2 is where that stays open.
 *
 * Hashing bytes rather than the decoded string is deliberate. `readFileSync(path,
 * 'utf8')` followed by hashing the string would call two different invalid byte
 * sequences identical -- both decode to U+FFFD -- and a fingerprint whose collision
 * set includes "any pair of malformed files" is not a fingerprint.
 *
 * There is deliberately no `fingerprintDatasetFile(path)` beside this. The one caller
 * reads the file for its JSON anyway, and a second read of a 110 MB file to produce a
 * digest the first read could have produced is a way to call the digest of one read and
 * the questions of another the same run. `tools/export-census.mjs` would also have
 * called it an orphan, and it would have been right.
 */
import { createHash } from 'node:crypto';

/**
 * The SHA-256 of `bytes`, as `sha256:<64 hex>`.
 *
 * The algorithm is in the value because a bare hex string is not self-describing:
 * an artifact reader cannot tell it from an md5, or from a truncated sha512, and
 * the tool that verifies it has to be guessed.
 */
export function fingerprintBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
