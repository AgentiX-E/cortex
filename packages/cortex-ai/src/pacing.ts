/**
 * Client-side pacing: a floor on how fast requests *leave*, as opposed to how long we wait after
 * one is refused.
 *
 * ## The run that made this necessary
 *
 * `41553176719` and `41552258320` are the same smoke twice. Both were the second provider, both
 * reached 55 of 60 questions and then died on
 * `429 {"code":"1302"} — not retried (budget-exhausted) after 8 attempt(s) and 0 s was left`, with
 * `retryAfterHonoured: 0` in the artifact's transport block. The provider publishes no `Retry-After`,
 * so every retry was this client's computed backoff: 1, 2, 4, 8 … seconds against a window measured
 * in minutes. The ladder was not too short — it had nothing to aim at.
 *
 * What the counters do say is the rate: 1.41 questions per minute at a width of four, roughly 42 s
 * per request once the provider had slowed to a crawl, and 140 of 279 requests refused over 50%.
 * A provider that refuses half the traffic is not asking for a longer wait after a refusal; it is
 * asking for fewer requests. Nothing in this repository could express that. `retryBudgetMs` bounds
 * what happens *after* a rejection, and a run that never rejects is exactly the run that ignores it.
 *
 * ## Why the schedule is a gate and not a delay before each call
 *
 * `await sleep(interval)` before each request would be pacing that doubles as a per-call latency
 * floor, correct only when requests are serial. The pool runs `CORTEX_MEMORY_WORKERS` readers, so a
 * delay carried by each of them still lets four requests leave in the first four seconds. A gate
 * hands out *slots* from one shared schedule, so the width of the pool changes how much work is in
 * flight and not the rate at which it hits the provider — which is the property the experiment in
 * §13.224 needs and could not otherwise have.
 *
 * ## Why the gate is process-wide by default
 *
 * `sharedRequestGate` exists because the sharing must not depend on a caller remembering it. The
 * arms of an A/B are built by different factories, the workers by another; every one of them would
 * have to be handed the same object, and the day one is constructed without it the run goes out at
 * a rate the artifact does not claim. A registry keyed by interval makes the default correct and
 * the mistake unavailable. It is the same argument `recordUsage` makes one layer over: one hop
 * every request passes through, rather than N call sites that each have to get it right.
 */
class RequestGate {
  /** The minimum wall-clock gap between two request starts, in milliseconds. */
  readonly intervalMs: number;

  /** The earliest instant the next request may start. Monotone within the process. */
  #nextSlotAt = 0;

  constructor(intervalMs: number) {
    // Zero and negative are refused rather than interpreted. A zero-interval gate is a schedule
    // with no schedule in it, and the caller who wants no pacing has a clearer way to say so: pass
    // no gate. Accepting it here would mean an operator typo disables the protection while the run
    // reports it as configured.
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new RangeError(
        `RequestGate needs a positive interval in milliseconds, got ${String(intervalMs)}. ` +
          'A run that wants no pacing passes no gate at all.',
      );
    }
    this.intervalMs = intervalMs;
  }

  /**
   * Claim the next slot, returning how long the caller must wait before issuing its request.
   *
   * Synchronous on purpose: `reserve` runs to completion before any `await`, so two callers in the
   * same tick cannot read the same `#nextSlotAt`. Reserving inside an async function with an
   * `await` ahead of the read would reopen exactly the race the gate closes.
   *
   * The slot is `max(now, nextSlotAt)` rather than an accumulation of intervals. Idle time is
   * forgiveness, not credit: a process that has been quiet for an hour does not owe an hour of
   * slots, and a schedule computed from the last slot instead of from `now` would come back from a
   * pause owing thousands of them.
   */
  reserve(now: number = Date.now()): number {
    const slotAt = Math.max(now, this.#nextSlotAt);
    this.#nextSlotAt = slotAt + this.intervalMs;
    return slotAt - now;
  }
}

/**
 * One gate per interval, per process.
 *
 * The map is keyed by the interval because two rates are two schedules: a caller that asks for a
 * slower rate must not inherit the faster one's slots, and folding them together would make the
 * stricter setting govern and the artifact state a number neither party ran at.
 *
 * Growth is bounded by the number of distinct intervals a process ever configures — one per run in
 * practice, since the interval arrives from the environment at start-up. A reset door is therefore
 * absent: it would be an export with no caller but a test, and a test can pick an interval nothing
 * else uses.
 */
const gates = new Map<number, RequestGate>();

/**
 * The shared gate for `intervalMs`, or `undefined` when the caller asked for no pacing.
 *
 * `0` is the one value that means off, because it is what an environment variable says when the
 * operator has decided there is no limit to respect. Negative values are refused rather than
 * clamped: the environment parser rejects them first, so one arriving here is a caller defect, and
 * a gate that quietly became "no pacing" would run at precisely the rate the provider throttles.
 */
export function sharedRequestGate(intervalMs: number): RequestPacer | undefined {
  if (intervalMs === 0) return undefined;
  const existing = gates.get(intervalMs);
  if (existing !== undefined) return existing;
  const created = new RequestGate(intervalMs);
  gates.set(intervalMs, created);
  return created;
}

/**
 * What the retry loop needs from a schedule: how long to wait before the next attempt.
 *
 * A structural type rather than {@link RequestGate} so a test can hand the loop a scripted wait
 * without a clock, and so a caller with a different admission rule (a token bucket, a semaphore
 * around a paid endpoint) can plug into the same seam.
 */
export type RequestPacer = {
  reserve(now?: number): number;
};
