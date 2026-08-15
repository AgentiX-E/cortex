/**
 * Minimal type surface for the optional `@xenova/transformers` peer dependency.
 * Declared here so cortex-llm typechecks without the optional peer installed;
 * when the real package is installed, its own (richer) declarations take
 * precedence over this ambient module declaration.
 */
declare module '@xenova/transformers' {
  export function pipeline(task: string, model: string): Promise<unknown>;
}
