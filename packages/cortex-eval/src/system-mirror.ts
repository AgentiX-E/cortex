/**
 * Member delegation for the wrappers this package builds around a `MemorySystem`.
 *
 * Its own module because two wrappers need it -- `traceReviewMechanisms` (the per-question census)
 * and `traceUsage` (the per-side spend split) -- and the defect it exists for is one no wrapper can
 * afford to re-derive: a method reached through a prototype chain is called with `this` set to the
 * wrapper, and a wrapper derived from an instance cannot read that instance's private fields.
 */
import type { MemorySystem } from './types.js';

/**
 * A view of `system` whose members are all **delegated to the instance**, not inherited from it.
 *
 * ## The bug this replaces, and why `Object.create` alone is not enough
 *
 * The prototype chain was the whole implementation, and it produced a wrapper that cannot read a private
 * field. `Object.create(system)` makes an object whose prototype is the *instance*, so a method is found
 * on the chain and called with `this` set to the **wrapper** -- and a private name is installed on the
 * instances of the class, not inherited by objects that derive from one. `run 40984213349` died on its
 * first cortex-memory question with `Cannot read private member #lastRawOutput from an object whose class
 * did not declare it`, at `CortexMemory.lastRawOutput`, for exactly this reason: `runBenchmark` resolves
 * that accessor once as `system.lastRawOutput.bind(system)`, and `system` was the wrapper.
 *
 * ## Why the fix is here and not at the call site
 *
 * Binding the two accessors this harness happens to read would leave the next one broken, and the failure
 * mode is a forty-minute run that dies on question one. So the wrapper owns the problem: every function
 * found anywhere on the chain becomes an own property of the wrapper that calls it with `this` set to the
 * real instance, and every accessor is re-defined to read and write the instance. Non-function values stay
 * on the chain, because reading one does not depend on `this`.
 *
 * ## Why it keeps `Object.create(system)`
 *
 * The chain is what makes the wrapper answer `in` and `instanceof` like the system it wraps, and
 * `runBenchmark` decides which routes exist by exactly those checks (`isSessionAware`). A spread would
 * lose every method; a fresh object would lose the identity. The chain stays and the calls are delegated.
 */
export function mirrorMembers(system: MemorySystem): MemorySystem {
  const traced = Object.create(system) as MemorySystem;
  const target = traced as unknown as Record<string, unknown>;
  const seen = new Set<string>(['constructor']);
  for (
    let owner: object | null = system;
    owner !== null && owner !== Object.prototype;
    owner = Object.getPrototypeOf(owner) as object | null
  ) {
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(owner))) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        // An accessor is re-defined rather than copied: invoked through the chain, its `this` would be the
        // wrapper, which is the same defect in a second form.
        // Built field by field because the project sets `exactOptionalPropertyTypes`: passing `get:
        // undefined` explicitly is a different type from omitting it, and the compiler is right to say so.
        const mirrored: PropertyDescriptor = { configurable: true };
        if (descriptor.enumerable !== undefined) mirrored.enumerable = descriptor.enumerable;
        if (descriptor.get !== undefined) mirrored.get = () => descriptor.get?.call(system);
        if (descriptor.set !== undefined) {
          mirrored.set = (value: unknown) => descriptor.set?.call(system, value);
        }
        Object.defineProperty(traced, name, mirrored);
        continue;
      }
      const value = descriptor.value as unknown;
      if (typeof value !== 'function') continue;
      target[name] = (...args: unknown[]) =>
        (value as (...a: unknown[]) => unknown).apply(system, args);
    }
  }
  return traced;
}
