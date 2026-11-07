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

/**
 * The product's default prompt room, mirrored for the same reason the six route names are.
 *
 * `cortex-eval` cannot import `DEFAULT_MAX_PROMPT_CHARS` from `@agentix-e/cortex-memory` -- that
 * package is not a dependency, and making it one would invert the arrow `bench-memory-arm.ts`
 * spends 400 lines of comments keeping straight. So the number is copied, and the copy is what
 * makes the artifact readable: `memoryArmConfig.maxPromptChars` is absent on every run that took
 * the default, and "absent means the product default" is only a statement about a run if the
 * default at the time is written down somewhere the artifact can be compared against.
 *
 * ## Why this constant has to exist at all
 *
 * It was 24,000 until §13.82 raised it to 48,000, and four docstrings in this package still said
 * 24,000 eighteen months of sections later -- including the one on the field that records the
 * room. An artifact therefore had two readings, 2x apart, and no byte in it chose between them.
 * `tools/__tests__/test_prompt_room_mirror.py` pins this copy against the product's constant and
 * fails on any present-tense claim that the default is 24,000, so the number cannot drift away
 * from the comments again without a red test naming the file.
 */
export const PROMPT_ROOM_DEFAULT = 48_000;
