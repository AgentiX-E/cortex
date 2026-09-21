/**
 * Minimal type surface for the optional `@xenova/transformers` peer dependency.
 * Declared here so cortex-llm typechecks without the optional peer installed;
 * when the real package is installed, its own (richer) declarations take
 * precedence over this ambient module declaration.
 *
 * Deliberately left at `Promise<unknown>` for the return type. Both loader shims
 * (`embedding/transformers-pipeline.ts`, `rerank/transformers-rerank-pipeline.ts`)
 * narrow the result through a locally-declared parameter type at the call site,
 * which is what keeps this file from having to track the package's real — and
 * version-dependent — pipeline overloads for two different tasks.
 */
declare module '@xenova/transformers' {
  export function pipeline(task: string, model: string): Promise<unknown>;
}
