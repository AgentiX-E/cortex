#!/usr/bin/env node
/**
 * The per-question progress line, and the delegation it hides.
 *
 * One stderr line per question per operation, with wall clock and cumulative model use. Run 45002769709 sat
 * inside `memcog/build` for thirty-six minutes and produced an **empty** artifact: the table is written when the
 * last question is graded, the step piped a silent program into `tee`, and the job limit arrived first. Thirty-six
 * minutes and about six yuan bought no evidence at all -- not even which question it was on.
 *
 * That is a reporting failure rather than a competitor failure, and it is cheap to fix: the provider already knows
 * when it is asked a question, and the proxy already knows what that has cost so far. Printed to stderr so `--json`
 * stays parseable and so a caller reading the table on stdout is not interleaved with progress.
 *
 * Money is deliberately **not** printed. The price table lives in `sut-cost-report.mjs`, and a second copy of it
 * here is how two artifacts come to disagree about one run. Tokens are the proxy's own count; the conversion
 * happens once, at the end, against a table with a date on it.
 *
 * ## Why this is a module and why it delegates instead of inheriting
 *
 * It used to be `Object.create(provider, {...})` inside the harness, and that was right for exactly as long as
 * every wrapped provider was a plain object. The product arm is the first one built from a class with `#private`
 * fields, and JavaScript checks private-field access against the *receiver*: an object whose prototype is the
 * instance is not an instance, so `reset()` threw `Receiver must be an instance of class
 * CortexProductProvider` on the first question of run 45089801550 -- after the corpus had been embedded.
 *
 * Delegation states the same thing without that trap: the wrapper holds the provider and forwards, so `this`
 * inside every forwarded method is the real object. The two value-carrying members are getters rather than copies,
 * because a copy is a snapshot -- `usage` read at construction would report the corpus build and none of the
 * answers, which is the direction that makes an arm look cheap.
 */

/**
 * Build the wrapper for one stats endpoint.
 *
 * `statsEndpoint` is `null` in a run with no proxy, which is the synthetic-dataset path: a local provider has no
 * token ledger to read, and the line then reports only elapsed time.
 */
export function createProgressWrapper(statsEndpoint) {
  /**
   * Cumulative calls and tokens for one system, counted from when **this arm** started.
   *
   * The proxy's counter is scoped to the job, and one job runs several arms of the same system. A line that read
   * `11.20M token(s) cumulative` for an arm that had spent 3.5M would be the cost-attribution defect one layer up,
   * so the baseline the provider read at construction is subtracted here too -- the same number, from the same place.
   */
  async function cumulativeUsage(prefix, baseline = null) {
    if (statsEndpoint === null) return '';
    try {
      const response = await fetch(`${statsEndpoint}?prefix=${encodeURIComponent(prefix)}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return ` · stats unavailable (${String(response.status)})`;
      const stats = await response.json();
      const tokens =
        Number(stats['prompt_tokens'] ?? 0) +
        Number(stats['completion_tokens'] ?? 0) -
        (baseline === null ? 0 : baseline.promptTokens + baseline.completionTokens);
      const calls = Number(stats['calls'] ?? 0) - (baseline === null ? 0 : baseline.calls);
      return ` · ${String(calls)} call(s), ${(Math.max(tokens, 0) / 1e6).toFixed(2)}M token(s) since launch`;
    } catch {
      // A progress line is a courtesy, not a measurement: a proxy that is down must not fail the run that is
      // already measuring it.
      return '';
    }
  }

  return function withProgress(provider, planned) {
    const started = Date.now();
    const selfAnswering = typeof provider.answer === 'function';
    // The question index belongs to the *question*, not to the operation: in isolated mode the harness ingests a
    // question's haystack and then asks it, and counting per operation would print `ingest 1, search 2`. Advancing
    // on `ingest` is what makes the two lines that belong to one question share a number.
    let question = 0;
    const at = () => `t+${String(Math.round((Date.now() - started) / 1000))}s`;
    const say = (line) => process.stderr.write(`[sut] ${line}\n`);

    const timed = async (op, call) => {
      if (op === 'ingest') question += 1;
      const index = op === 'ingest' ? question : Math.max(question, 1);
      const scope = planned > 0 ? `${String(index)}/${String(planned)}` : String(index);
      const began = Date.now();
      say(`${provider.name} question ${scope}: ${op} started (${at()})`);
      try {
        return await call();
      } finally {
        const took = ((Date.now() - began) / 1000).toFixed(1);
        const stored = Number(provider.ingestedSessions ?? 0);
        const skipped = provider.ingestSkips?.length ?? 0;
        say(
          `${provider.name} question ${scope}: ${op} returned in ${took}s` +
            `${op === 'ingest' ? ` · ${String(stored)} session(s) stored cumulative, ${String(skipped)} refused` : ''}` +
            (await cumulativeUsage(provider.name, provider.usageBaseline ?? null)),
        );
      }
    };

    return {
      name: provider.name,
      build: provider.build,
      // Ingest is where a store-building system spends everything, so it gets a line of its own -- and it is what
      // advances the question number, because every driver here ingests the haystack of the question it is about
      // to be asked (protocol `mode: isolated`).
      ingest: (sessions) => timed('ingest', () => provider.ingest(sessions)),
      search: (query, options) => timed('search', () => provider.search(query, options)),
      reset: () => provider.reset(),
      // Forwarded as a getter, not as a value: see this file's header. Optional on both kinds of provider, so the
      // wrapper reports exactly what the provider reports rather than inventing a zero.
      get usage() {
        return provider.usage;
      },
      // The driver manifest, when the provider is a competitor process. Absent for the in-process product arm,
      // and absent rather than empty for the reason every other field here is delegated rather than copied.
      ...(provider.manifest === undefined ? {} : { manifest: provider.manifest }),
      ...(selfAnswering
        ? { answer: (query, options) => timed('answer', () => provider.answer(query, options)) }
        : {}),
    };
  };
}
