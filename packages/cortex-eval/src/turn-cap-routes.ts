/**
 * The six route names, in one place inside `cortex-eval`.
 *
 * ## Why this module exists rather than a constant in `bench-memory-arm.ts`
 *
 * `cortex-eval` cannot import the product's `TurnCapRoute`: the dependency runs the other way, so
 * the arm carries its own copy and validates every string against it at parse time. That copy was
 * fine while it had one reader. The route-scoped thinking value (§13.197.4) gives it a second --
 * `llm-factory` has to reject a route name it does not recognise, and it cannot import a 4,000-line
 * benchmark module to get six strings. Two copies in one package is the drift the copies exist to
 * prevent, so the table moved down and both read it.
 *
 * ## Why a table and not an array
 *
 * The value is a **set membership test**, and a table keyed by the name makes a lookup the same
 * operation as the validation. An array would need `includes` at one site and `find` at another,
 * and the two would eventually disagree about case -- `readRouteReach` compares exactly, and that
 * is the rule the dispatch inputs have always followed.
 */
export const TURN_CAP_ROUTES: Record<string, true> = {
  'multi-session': true,
  temporal: true,
  flat: true,
  'knowledge-update': true,
  abstention: true,
  assistant: true,
};

/** Every route, in the order the product declares them. */
export const ALL_TURN_CAP_ROUTES: readonly string[] = Object.keys(TURN_CAP_ROUTES);
