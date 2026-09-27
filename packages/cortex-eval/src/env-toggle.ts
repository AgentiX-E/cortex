/**
 * Reading a boolean feature toggle from the environment.
 *
 * This is small enough to look like CLI plumbing and is deliberately not in the
 * CLI. `bench/**` is excluded from coverage as an entry point, which means a
 * decision made there cannot be tested -- and defect injection showed the cost:
 * flipping `=== '1'` to `!== '0'`, or to `false`, or dropping the option at the
 * call site, each left the entire suite green.
 *
 * A default and a strictness are the two things this encodes, and both are
 * errors that produce a run which measures nothing:
 *
 *  - The default must be the ABSENCE of the feature. Every arm that does not
 *    measure a feature runs with its variable unset, so an unset variable that
 *    enables one puts it into every run and destroys the control side of the
 *    only arm that measures it.
 *  - Presence must not imply truth. `!== undefined` is the tempting shortcut,
 *    and it reads `off`, `false`, `no` and `''` as enabled. An operator or a
 *    workflow passing any of those would silently switch the feature on.
 *
 * The two toggles in this project have opposite defaults on purpose --
 * `ENTITY_IDENTITY_CLAUSE` unset means "run the shipped configuration", which
 * has the sentence, while `CANDIDATE_DISCRIMINATION` unset means "this
 * measurement was not requested". Both are expressible here, so the two
 * variables can share one reader and one set of tests.
 */
export type ReadToggleOptions = {
  /**
   * Value to return when the variable is absent (default `false`).
   *
   * Only the absent case is affected. A present-but-unrecognised value is always
   * `false`, including when this is true: the caller asked for a default, not
   * for a parser that guesses.
   */
  readonly defaultOn?: boolean;
};

/**
 * Reads `env[name]` as a boolean toggle.
 *
 * Strict on presence: `'1'` is on, `'0'` is off, anything else present is off.
 * The environment is passed in rather than read from `process.env` so the
 * behaviour is testable without mutating global state.
 */
export function readToggle(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  options: ReadToggleOptions = {},
): boolean {
  const raw = env[name];
  if (raw === undefined) {
    return options.defaultOn === true;
  }
  return raw === '1';
}
