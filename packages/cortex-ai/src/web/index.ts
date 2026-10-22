/**
 * The `./web` entry: generation with no provider, no key and no weights of our own.
 *
 * Everything here reaches a platform API (`globalThis.LanguageModel`) rather than a network or a
 * file, so the module has no dependencies at all -- which is what makes it safe to import from a
 * page that must not pull an ONNX runtime. `tools/entry-guard.mjs` checks that: this entry is
 * guarded as portable, so a `node:` import added by accident fails the build rather than the
 * bundler of whoever imports it.
 */
export {
  PlatformLanguageModelAdapter,
  checkAvailability,
  readPlatform,
  type AvailabilityReport,
  type PlatformLanguageModel,
  type PlatformLanguageModelOptions,
  type PlatformSession,
  type PlatformStatus,
} from './platform-language-model.js';
