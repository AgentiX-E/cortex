/**
 * `CortexMemory` — `cortex-core`'s value gates composed into one conformant
 * `MemorySystem`.
 *
 * This is the file that closes `AUDIT-CODE-VS-DOCS.md` §6. Before it existed,
 * `decideWrite` and `decideRetrieval` had no production caller, so the
 * cognitive layer was unreachable and every claim about it was untestable.
 *
 * The flow per question is:
 *
 *   turns -> admitSessions (decideWrite, per session) -> selectSessionBudget
 *         -> buildPrompt (per answer contract) -> LLM.complete -> parseAnswer
 *
 * Two properties are deliberate:
 *
 * 1. **No evidence means no LLM call.** When the gates admit nothing the answer
 *    is `null`. The reference pipeline reaches abstention by asking the model to
 *    notice an absence; here the absence is detected before the model is
 *    consulted, which cannot hallucinate and does not cost a request.
 * 2. **The contract is structural.** Plain object literals satisfy it, no class
 *    hierarchy is required, and `answerPreference` is deliberately absent.
 */
import type { LLM, MemoryValue, ValueFunction } from '@agentix-e/cortex-core';
import { decideRetrieval } from '@agentix-e/cortex-core';
import type { Answer, SessionAwareMemorySystem } from '@agentix-e/cortex-eval';
import { admitSessions, selectSessionBudget, type AdmittedSession } from './sessionize.js';
import {
  admissionOptionsFrom,
  admitTurns,
  clockAwareValueFunction,
  type AdmittedTurn,
} from './admission.js';
import {
  RENDERING_BY_CONTRACT,
  buildPrompt,
  buildSessionPrompt,
  type PromptContract,
  type PromptOptions,
  type AssembledPrompt,
} from './prompt.js';
import { parseAnswer } from './parse.js';
import type { CortexMemoryOptions, TurnCapRoute } from './types.js';

/**
 * The offer's size, counted the way the record counts the delivery.
 *
 * ## Why this is a module function and not two lines inside the method
 *
 * Because the unit is a decision and it is stated once. `§13.16.6` repaired it: this
 * counted **lines of the joined context** -- a turn whose content spans newlines
 * counted as several -- because the record derived its own count from a joined string
 * the same way, and the offer has to be counted on the same unit as the delivery for
 * the two to be comparable. Now that the capture is a turn list, both sides count
 * turns, and the offer's count is the admission layer's own list length rather than a
 * second derivation that could drift from it. Two call sites counting independently is
 * how units drift apart, which is the same argument `#admit` makes for applying the
 * session budget in one place.
 *
 * `chars` is unchanged and still the size of the same evidence: the sum of the turn
 * contents plus the separators a join would have inserted between them. It is computed
 * arithmetically rather than by joining, because joining builds the whole string -- up
 * to 506,338 characters on this arm -- to call `.length` on it.
 */
/**
 * The role filter, resolved once at construction.
 *
 * Resolved rather than read from the options per call because "roles without a classifier" is
 * a state the constructor refuses: keeping the three fields together is what lets the filter
 * be a total function of a turn and a route instead of a sequence of presence checks.
 */
type RoleFilter = {
  /** The roles whose turns may reach the prompt. */
  readonly roles: ReadonlySet<string>;
  /** How a turn's role is read. `undefined` means the format could not be read at all. */
  readonly roleOf: (turn: string) => string | undefined;
  /** The routes the filter reaches. Absent means all six. */
  readonly routes?: readonly TurnCapRoute[];
};

function admittedEvidenceOf(admitted: readonly AdmittedTurn[]): { turns: number; chars: number } {
  let chars = 0;
  for (const turn of admitted) chars += turn.content.length;
  return { turns: admitted.length, chars: chars + Math.max(0, admitted.length - 1) };
}

/**
 * A `MemorySystem` whose retrieval is decided by `cortex-core`'s value gates.
 *
 * Declares five of the six optional routing paths. `answerPreference` is
 * omitted on purpose: a value gate filters *evidence*, while a preference
 * question asks for a *suggestion*, so declaring it would route those questions
 * into a path with no mechanism behind it. The flat path receives them, and the
 * conformance test asserts that it does.
 */
export class CortexMemory implements SessionAwareMemorySystem {
  readonly name: string;

  readonly #llm: LLM;
  readonly #now: number;
  readonly #options: CortexMemoryOptions;
  /** The resolved role filter, or `undefined` when no roles were named. */
  readonly #roleFilter: RoleFilter | undefined;

  /**
   * Why each abstention happened, accumulated across every route that can decline.
   *
   * ## The four keys
   *
   * The four keys name four mutually exclusive outcomes of a declined question.
   * `empty` and `threshold` are machine-derived and consume no request; `llm` and
   * `answered` are the model's two outcomes.
   *
   * `threshold` is reachable **only** on the abstention route, because
   * `#retrievalAdmitted` is called from `answerAbstention` and nowhere else. On
   * every other route the key is present and stays `0`, which is a true statement
   * about those routes rather than a missing measurement.
   *
   * ## The scope, and why it changed
   *
   * This used to be a census of the **abstention route alone**:
   * `runBenchmark` dispatches `answerAbstention` **only** for
   * `capability === 'ABS'`, and `#reasons` was written in that one method. A
   * question declined on the session, temporal, assistant, preference,
   * knowledge-update or flat route was invisible here.
   *
   * ## What the narrow scope cost
   *
   * It was misread, and the misreading cost a whole round. The §12.5 artifact
   * carried `abstentionReasons.llm = 120`, and §55 read it as "the model declined
   * 120 times". §55.4 then made the next investigation "read the 30 ABS outputs
   * for a common decline pattern". Both readings are wrong in the same way:
   * `30 ABS questions x 4 runs = exactly 120`, ABS gold **is** abstention, and ABS
   * scored **30/30 correct** -- so those 120 calls are the capability passing, and
   * the artifact's own per-capability table said so all along
   * (`ABS: total=30 base=30 feat=30 b+f-=0`).
   *
   * Meanwhile the real loss is invisible to the narrow field: 449 of 470 non-ABS
   * questions abstained, and `answerAbstention` never ran for one of them. A
   * counter that reads like a run-wide census while measuring one route is how a
   * 95.5% non-ABS abstention rate came to be investigated as an ABS problem.
   *
   * It exists because those four outcomes were indistinguishable in every
   * artifact this project has produced. `docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md`
   * §10.10 records what that cost: an arm at `retrievalThreshold: 0.25` moved
   * abstention `+46.40pp`, the movement was attributed to the retrieval gate, and
   * the gate had never closed once — it could not have, because the value at that
   * arming is the constant `0.5`. The `479` abstentions were all the model's. The
   * run's own output could not contradict the wrong reading, so the reading
   * survived until the gate was probed directly.
   *
   * ## Why the scope was widened rather than only documented
   *
   * §58 documented it: it made the narrow scope legible in the artifact and left
   * the counter alone, because the misreading came from the number and widening a
   * counter to fix a reading is how numbers get tuned. That was right for its
   * round, because nothing was yet measuring the loss the field could not see.
   *
   * §13 is what changed the premise. The ask experiment produced MR `13 -> 0` and
   * TR `16 -> 0` with `b-f+ = 0` on every capability, and every one of those
   * declines happened on a route this census did not cover. The artifact could not
   * say which route declined because the model declined: `turns` is `[]` by design
   * (this arm collects no retrieval trace) and `rawOutput` carries the text but
   * not the decision. Widening the counter is what makes the next hypothesis --
   * retrieval quality -- testable at all.
   *
   * The widening is instrumentation and not a behaviour change: `threshold` stays
   * `0` everywhere it did not already apply, no route gains or loses a gate, and
   * every prior artifact's accuracy numbers keep their meaning.
   *
   * `empty` is separated from `llm` because the two are repaired differently:
   * `empty` means the arm supplied no evidence to decline *from*, which is a
   * dataset- or write-gate-level problem and not a retrieval- or model-level
   * result.
   */
  readonly #reasons: { empty: number; threshold: number; llm: number; answered: number } = {
    empty: 0,
    threshold: 0,
    llm: 0,
    answered: 0,
  };

  /**
   * The model's own output for the most recent call, before `parseAnswer`.
   *
   * ## Why the parsed answer is not enough
   *
   * Dispatch `37792539133` was the first real artifact to carry the
   * per-question roster §57 built. The roster arrived -- 120 records, one per
   * sampled question, with `answer` populated rather than uniformly absent --
   * and the read it was dispatched for still came back empty, because 115 of
   * those 120 records read `null`.
   *
   * `null` is correct and it is also the whole of the information. `Answer` is
   * `string | null`, and `parseAnswer` decides a decline from the **last
   * non-empty line only**, after stripping a label like `Answer:` and comparing
   * case-insensitively. So three distinct model behaviours arrive at the scorer
   * as one value: the bare token, a labelled token, and an explanation followed
   * by the token. The MR route lost 13 baseline-correct questions and the TR
   * route 16 in that run; which shape produced them is not recoverable, because
   * the text that would say so was a local in `#prompt` and died at
   * `parseAnswer`'s return.
   *
   * This is §57's defect one layer down, and §56's below that. §56: a value was
   * computed and never reached the field. §57: a value was computed and
   * discarded before the report layer saw it. Here: a value is computed and
   * then **replaced by its own summary**. `parseAnswer` is not wrong; treating
   * its output as a substitute for its input was.
   *
   * ## Why one slot rather than a list
   *
   * The benchmark asks one question at a time and reads this immediately after
   * the call, so a slot is the whole requirement and an accumulating list would
   * grow without bound on a 500-question run for a reader that never looks
   * backwards. The scope is stated in the name: this describes the **most recent
   * call**, not the run, and a caller that needs the run has to retain it the
   * way the arm retains its answers.
   *
   * ## Why `null` and not `''`
   *
   * `''` is an answer in this package -- a blank, wrong one -- and not an
   * abstention, which is the distinction `parse.ts` opens by naming. A default
   * of `''` would therefore present "no call has happened" indistinguishably
   * from "the model replied with nothing", on the one field whose purpose is to
   * stop two different model behaviours from collapsing into one value.
   */
  #lastRawOutput: string | null = null;

  /**
   * The evidence the reader was shown for the most recent call, or `null`.
   *
   * ## Why this exists
   *
   * §13 measured MR `13 -> 0` and TR `16 -> 0` with `b-f+ = 0` on every
   * capability, and the artifact could not say whether retrieval returned the
   * wrong evidence or none at all. Those are repaired in different places, and
   * the next hypothesis -- retrieval quality -- is untestable while the two
   * collapse into one reading. `QuestionRecord.turns` is `[]` on every record
   * because the arm supplies `retrieved: ''`, which is honest and also the
   * problem: the arm cannot report evidence nobody retained.
   *
   * ## Why one slot, and why `null` rather than `''`
   *
   * The benchmark asks one question at a time and reads this immediately after
   * the call, so a slot is the whole requirement; a list would grow without bound
   * on a 500-question run for a reader that never looks backwards. The scope is
   * stated in the name: the most recent call, not the run.
   *
   * `''` is an answer in this package and not an abstention, and here it would be
   * worse: an empty context is a real, diagnosable outcome -- it is what the
   * census's `empty` counts -- so `''` would present "the reader was shown
   * nothing" indistinguishably from "no call has happened". `null` says the
   * latter only.
   *
   * ## Why a list of turns and not the joined text, since §13.16.6
   *
   * It held `carried.map((turn) => turn.content).join('\n')` -- one string -- and
   * every reader split that string back into turns with `split('\n')`. The round
   * trip is lossy in one direction only: the split cannot tell a turn that contains
   * a newline from two turns. Run `38142407062` measured the cost -- of 17,341
   * roster entries across the MR questions, **14,724 (84.9%)** were continuation
   * lines of a turn whose content spans newlines, and the budget's "~143 turns" was
   * ~143 lines, about 22 turns at 6.6 lines per turn.
   *
   * The unit was wrong, not the measurements, and the repair is to stop destroying
   * the boundary: `assembled.carried` is in hand here, so the turn list is what is
   * stored. Re-encoding the boundary instead -- a sentinel separator, a quoted form --
   * would substitute one implicit encoding for another on content that is
   * model-generated free text, and no sentinel can be shown to be absent from it.
   *
   * `[]` is the old `''`: the reader was reached and carried nothing. `null` is
   * unchanged and still means no reader was reached.
   */
  #lastRetrievedContext: readonly string[] | null = null;

  /**
   * The evidence characters the most recent prompt carried, or `null`.
   *
   * ## Why this is not `#lastRetrievedContext.length`
   *
   * It is the size of what the prompt **carried**, after `fitToBudget` cut the
   * evidence to fit `maxChars`. The captured context is what was **offered** to
   * the builder, and the two differ whenever the budget binds -- which it did on
   * every question of run `38044858147`, where 506,338 characters of evidence met
   * a 24,000-character budget.
   *
   * So the artifact's `evidenceTurns` reports the offer and this reports the
   * delivery, and a reader who has only the first will overstate what the model
   * saw by whatever the budget removed. `§13.11.5`'s ranking question -- was the
   * gold turn inside what the model saw -- is asked of this field, not that one.
   *
   * `null` means no prompt has been built, for the same reason and with the same
   * distinction as `lastRetrievedContext`: a decline before the reader is reached
   * is not a prompt that carried nothing.
   */
  #lastPromptEvidenceChars: number | null = null;

  /**
   * How much evidence admission produced for the most recent call, or `null`.
   *
   * ## Why the offer needs its own slot, and why §13.15 is the reason
   *
   * The roster holds the evidence the prompt **carried** since §13.15, and a size for
   * the delivery travels with it. What was lost in that change is the **offer**: the
   * context `#admit` produced, before any budget. Run `38142407062` showed the
   * consequence -- `evidenceTurns` fell from 3,016-4,528 to a median of 141, because
   * it is derived from the captured context and the captured context is now the
   * carried subset. The artifact could therefore no longer say how much evidence
   * existed, which is what `§13.11.3` reads and what makes the budget's effect
   * legible at all.
   *
   * So the offer is recorded as two numbers rather than as text. Text was what the
   * pre-`§13.15` capture held, and it was the wrong shape twice over: it was
   * unbounded (the 258 MB artifact of `§13.14`), and a *prefix* of it was carried,
   * so the roster could not name what the model read. Two numbers bound the artifact
   * and answer the question that was actually being asked.
   *
   * Counted the same way the record counts `evidenceTurns`, which is **lines** of the
   * joined context and not turns -- see `§13.16`. That unit is a defect and it is
   * registered; measuring the offer in the unit the rest of the artifact uses is what
   * keeps the two comparable until it is repaired.
   *
   * `null` means no call has happened, for the same reason the other slots are
   * nullable: a decline reached the machine and never a reader.
   */
  #lastAdmittedEvidence: { turns: number; chars: number } | null = null;

  constructor(options: CortexMemoryOptions) {
    // A filter that cannot run is refused here rather than silently kept. `evidenceRoles`
    // without a classifier would leave the artifact recording a filter the run never applied,
    // which is the inert-configuration class §10.10 recorded for the retrieval gate; an empty
    // list would admit nothing on every reached route, which is a decline every time.
    if (options.evidenceRoles !== undefined) {
      if (options.roleOf === undefined) {
        throw new Error(
          'evidenceRoles was named without roleOf: the filter has no way to read a role, so ' +
            'it would keep every turn while the configuration said it kept some. Supply the ' +
            'classifier, or drop evidenceRoles.',
        );
      }
      if (options.evidenceRoles.length === 0) {
        throw new Error(
          'evidenceRoles must name at least one role: an empty list admits no evidence on ' +
            'every route it reaches, which spends a decline per question and reads as a ' +
            'dataset with nothing in it. Omit the option to disable the filter.',
        );
      }
      // Resolved once, with `roleOf` narrowed to non-optional by the throw above, so no
      // later reader has to treat "roles without a classifier" as a state. A guard further
      // down would be unreachable through the public type and would cost a branch that no
      // test can enter -- §57.6's rule against safety nets that read as behaviour.
      this.#roleFilter = {
        roles: new Set(options.evidenceRoles),
        roleOf: options.roleOf,
        ...(options.evidenceRolesRoutes === undefined
          ? {}
          : { routes: options.evidenceRolesRoutes }),
      };
    }
    this.name = options.name ?? 'cortex-memory';
    this.#llm = options.llm;
    this.#now = options.now;
    this.#options = options;
  }

  /**
   * The resolved role filter, or `undefined` when this route's evidence is unfiltered.
   *
   * Reach is resolved per route rather than once at construction because one instance serves
   * every route in a run: a filter decided at construction would either reach all six or none,
   * and §13.83 registers two.
   */
  #roleFilterForRoute(route: TurnCapRoute): RoleFilter | undefined {
    const filter = this.#roleFilter;
    if (filter === undefined) return undefined;
    if (filter.routes !== undefined && !filter.routes.includes(route)) return undefined;
    return filter;
  }

  /**
   * The turns a route may build its evidence from: the admitted ones, minus the roles the
   * filter excludes.
   *
   * Applied **after admission and before selection**, which is where the room is spent. A
   * filter applied at admission would move the write gate, and one applied after capture
   * would leave the artifact describing evidence the reader never saw.
   *
   * The order is preserved and no turn is rewritten, so the surviving turns keep their
   * ordinals and the selection sees the same content it would have seen.
   */
  #turnsForRoute(turns: readonly AdmittedTurn[], route: TurnCapRoute): AdmittedTurn[] {
    const filter = this.#roleFilterForRoute(route);
    if (filter === undefined) return [...turns];
    return turns.filter((turn) => {
      const role = filter.roleOf(turn.content);
      return role === undefined || filter.roles.has(role);
    });
  }

  /**
   * The sessions a route may build its evidence from, with each session filtered and any
   * session left empty dropped.
   *
   * `size` is recomputed rather than carried: it is the cached count the session budget spends
   * against, so a stale size would make the budget reserve room for turns the filter removed
   * and spend it on nothing -- a defect that shows up as a window wider than the evidence in it.
   */
  #sessionsForRoute(sessions: readonly AdmittedSession[], route: TurnCapRoute): AdmittedSession[] {
    if (this.#roleFilterForRoute(route) === undefined) return [...sessions];
    const kept: AdmittedSession[] = [];
    for (const session of sessions) {
      const turns = this.#turnsForRoute(session.turns, route);
      if (turns.length === 0) continue;
      kept.push({ index: session.index, size: turns.length, turns });
    }
    return kept;
  }

  /**
   * The model output of the most recent call, or `null` if the model was not
   * consulted for it.
   *
   * `null` covers two cases that a caller must not confuse, and the way to tell
   * them apart is `abstentionReasons()` rather than this field: no call has
   * happened yet, or the last question was declined by the machine before the
   * model was reached. Both mean "there is no model text for the last question",
   * which is what this field reports.
   */
  lastRawOutput(): string | null {
    return this.#lastRawOutput;
  }

  /**
   * The evidence the reader was shown for the most recent call, or `null`.
   *
   * One element per turn the **prompt carried**, in the order the prompt printed
   * them, each element the turn's whole content. It is the same list the assembler
   * selected, so a record built from this agrees with what the reader actually
   * received rather than with a re-rendering of it.
   *
   * ## Why this is a list of turns rather than the joined text, since §13.16.6
   *
   * It returned the carried turns **joined with newlines** until §13.16.6, and every
   * reader of it -- the arm's roster, the coverage measurement, the two offline
   * readers in `tools/` -- split the string back into turns on the same newline. A
   * turn whose content spans newlines is then indistinguishable from several turns,
   * and the caller cannot recover the boundary. Run `38142407062` measured it: 84.9%
   * of the MR roster's entries were continuation lines, and every count named "turns"
   * was a count of lines, by about 6.6 lines per turn on this data.
   *
   * The list is the assembler's own, so the boundary is never destroyed rather than
   * destroyed and re-guessed. It is `readonly` because the caller does not own it and
   * a mutation here would alter the evidence another reader holds.
   *
   * `[]` is "the reader was reached and carried nothing", which the joined form
   * spelled `''`. A turn whose content contains a newline is a single element; that
   * is the whole of the repair.
   *
   * ## "Carried" rather than "admitted", since §13.15
   *
   * This returned the **admitted** turns until §13.15, which is a superset whenever
   * the prompt budget binds -- and it bound on every question of run `38044858147`.
   * The docstring above it claimed the carried set all along ("which turns reached
   * the reader", "the same turns the prompt carried"), so the accessor was the one
   * place where the artifact's roster and the artifact's size described different
   * runs, and a reader comparing the gold turn against the roster was comparing it
   * against evidence the model never saw.
   *
   * The order is the prompt's own, which is chronological. With a relevance signal
   * the selection is not a prefix, so this list is the only place the carried set is
   * nameable at all.
   *
   * `null` means no call has happened, or the machine declined before a reader
   * was shown anything. It does **not** mean an empty context was shown; that is
   * the census's `empty`, and the two are different outcomes this accessor keeps
   * apart. A prompt that carried no evidence reports `[]` -- the reader was reached
   * and shown nothing -- which is a third state and is why this is not `null`.
   */
  lastRetrievedContext(): readonly string[] | null {
    return this.#lastRetrievedContext;
  }

  /**
   * The evidence characters the most recent prompt carried, or `null`.
   *
   * Exactly the field `§13.11.5` needs and `lastRetrievedContext` cannot supply:
   * the size of the evidence the model was actually given, after the prompt
   * builder's character budget was spent. Read alongside
   * `lastRetrievedContext().length`, it makes the budget's cost measurable per
   * question instead of inferred from a constant.
   */
  lastPromptEvidenceChars(): number | null {
    return this.#lastPromptEvidenceChars;
  }

  /**
   * How much evidence admission produced for the most recent call, or `null`.
   *
   * The **offer**, as against `lastPromptEvidenceChars`'s delivery. Two numbers, and
   * both are needed: a reader with only the delivery cannot tell a budget that cut
   * ninety-eight per cent of the context from a retrieval that found almost nothing,
   * and those two runs want opposite repairs.
   *
   * Counted in **lines of the joined context**, which is the unit the record's
   * `evidenceTurns` uses -- and which is a defect, registered as `§13.16`: a turn
   * whose content spans newlines is counted as several. The unit is matched here
   * rather than corrected in one field, because the offer and the delivery have to be
   * commensurable for their ratio to mean anything, and correcting one of them alone
   * would make the ratio a fact about two different units.
   *
   * `null` means no call has happened, or the machine declined before a reader was
   * reached.
   */
  lastAdmittedEvidence(): { turns: number; chars: number } | null {
    return this.#lastAdmittedEvidence;
  }

  /**
   * Record the evidence a reader is about to be shown.
   *
   * Called at every point a route hands admitted turns to a prompt builder, for
   * the reason the model outcome is tallied in one place: the accessor is read as
   * one answer, so a route that forgot to record would report the previous
   * question's evidence as its own -- which is the exact defect
   * `#lastRawOutput`'s docstring records for the capture hook that reads the
   * accessor once after the loop.
   *
   * The value is the TURNS and not the prompt. A prompt carries the instruction
   * block, the question and the evidence, and a reader trying to tell "the wrong
   * turn was retrieved" from "no turn was retrieved" would have to parse the
   * other two back out. The turns are the claim.
   *
   * ## The turns recorded are the ones the prompt CARRIED, and that is the repair
   *
   * This recorded the turns **offered** to the builder until §13.15, and the
   * accessor's own docstring claimed the opposite -- "which turns reached the
   * reader", "the same turns the prompt carried, in the same order". Both sentences
   * were false whenever the budget bound, and it bound on every question of run
   * `38044858147`: 506,338 characters of evidence against a 24,000-character budget.
   *
   * So the artifact could report a size for the delivery while identifying the
   * offer, which made `§13.11.5`'s question -- was the gold turn inside what the
   * model saw -- unanswerable from it. A size cannot answer a question about
   * membership, and the reader's context is the roster every downstream consumer
   * transcribes.
   *
   * `carried` is taken from the builder rather than re-derived here for the reason
   * `AssembledPrompt` gives: the selection is not a prefix, so nothing outside the
   * builder can name the set. And `carried` is a subset of `turns`, so a route still
   * cannot record a turn it never admitted.
   *
   * ## Why the offer is recorded as well, and what went wrong without it
   *
   * Three measurements come out of this one call, and they answer three different
   * questions about the same run:
   *
   *   - the **offer** -- what admission produced (`lastAdmittedEvidence`), which is
   *     what `§13.11.3` asks about and what makes the budget's effect legible;
   *   - the **delivery** -- the turns the prompt carried (`lastRetrievedContext`)
   *     and how many characters of them it printed (`lastPromptEvidenceChars`);
   *   - nothing else. A reader wanting "did retrieval find it" from the delivery
   *     alone would read a budget cut as a retrieval failure.
   *
   * `§13.15` recorded only the delivery, and run `38142407062` showed the cost: the
   * record's `evidenceTurns` is derived from the captured context, so it fell from
   * 3,016-4,528 to a median of 141 and the artifact could no longer say how much
   * evidence had existed. The offer is therefore taken here, where the admitted turns
   * are still in hand, and carried out as **counts** rather than as text -- text was
   * the pre-`§13.15` shape and it was unbounded.
   *
   * Written in one call so a route cannot update one measurement and not the others,
   * which is the shape `#consult` exists to prevent on the model-outcome axis.
   *
   * `carried` cannot name a turn that was never admitted: the builder is handed the
   * admitted turns and can only return a subset of what it was handed.
   *
   * `[]` cannot reach here, and the accessor does not pretend otherwise. All
   * three call sites sit behind a `turns.length === 0` return that hands the
   * decline to `#declinedEmpty`, so an empty list is a decline and never a
   * recorded context. A `turns.length === 0 ? null : ...` guard here would be
   * unreachable code that reads as a safety net -- the shape §57.6 removed one
   * field over -- while leaving `null` and `''` indistinguishable to a reader of
   * the source. The invariant is asserted where it can be reached:
   * `retrieved-context.test.ts` requires an empty admission to report `null` and
   * to never consult the model.
   *
   * An empty `carried` **can** reach here, and it is not the same state: the reader
   * was reached and shown nothing because no turn fitted the room. It records `[]`,
   * which the roster reads as `turns: []` against a non-zero `evidenceTurns` -- the
   * three-state distinction `question-record.ts` registers.
   *
   * The captured list is `carried`'s own contents and not a re-join of them, which
   * is `§13.16.6`'s repair: a turn whose content spans newlines stays one element,
   * so the roster's count is a count of turns rather than of the lines they printed.
   */
  #recordEvidence(
    admitted: readonly AdmittedTurn[],
    assembled: Pick<AssembledPrompt, 'evidenceChars' | 'carried'>,
  ): void {
    this.#lastRetrievedContext = assembled.carried.map((turn) => turn.content);
    this.#lastPromptEvidenceChars = assembled.evidenceChars;
    this.#lastAdmittedEvidence = admittedEvidenceOf(admitted);
  }

  /**
   * The abstention census, as a copy.
   *
   * Returned by value so a consumer that mutates what it reads cannot alter the
   * numbers a later reader sees. The benchmark arm serialises this straight into
   * its artifact, so the returned object is the artifact's payload.
   */
  abstentionReasons(): { empty: number; threshold: number; llm: number; answered: number } {
    return { ...this.#reasons };
  }

  /**
   * Flat answering. Also the fallback for every shape whose dedicated path is
   * absent, and for `single-session-preference`.
   */
  async answer(question: string, context: string[], _sessions?: string[][]): Promise<Answer> {
    return this.#respond(question, context, 'extractive');
  }

  /**
   * Multi-session answering over preserved boundaries.
   *
   * Admission runs per session, then the turn budget decides which sessions are
   * presented. Both steps are what let the budget be spent on a session
   * retrieval already judged relevant instead of on scattered neighbours.
   *
   * The budget is applied by `#admit` rather than here, so this path and the
   * abstention path cannot disagree about it. It used to be applied here only,
   * which left every other session-taking path unbounded; see `#admit`.
   */
  async answerSessions(question: string, sessions: string[][]): Promise<Answer> {
    const admitted = admitSessions(sessions, admissionOptionsFrom(this.#now, this.#options.gate));

    if (admitted.length === 0) return this.#declinedEmpty();

    // §13.83's filter runs **before** the budget, because both spend the same room. With the
    // budget first, a session the filter would empty can win the whole budget on the strength of
    // a turn the reader will never see, and the question is then declined with admissible
    // evidence sitting in the session behind it. The registered configuration's session budget is
    // unbounded, so this order was latent rather than visible -- `evidence-roles.test.ts` found it
    // with a budget of one session and a value function that prefers the excluded turn.
    const eligible = this.#sessionsForRoute(admitted, 'multi-session');
    if (eligible.length === 0) return this.#declinedEmpty();

    // `selectSessionBudget` never returns empty for a non-empty input: when no
    // session fits the budget it admits the highest-value one anyway, because
    // answering from no evidence is worse than exceeding a prompt budget. An
    // earlier version carried a `selected.length === 0` guard here that no test
    // could reach, which is how the redundancy was found.
    const selected = selectSessionBudget(eligible, this.#options.gate.sessionBudget);

    // The boundary label is the reason this path exists. Flattening the
    // sessions here would reproduce exactly the behaviour of the flat path and
    // make the MR route decorative.
    return this.#promptSessionAware(question, selected);
  }

  /** Relative-time answering. The date is the reference point, and only this path gets it. */
  async answerTemporal(
    question: string,
    context: string[],
    questionDate?: string,
    sessions?: string[][],
  ): Promise<Answer> {
    const turns = this.#admit(context, sessions);
    if (turns.length === 0) return this.#declinedEmpty();

    return this.#promptWithDate(question, turns, 'temporal', questionDate);
  }

  /**
   * Abstention answering.
   *
   * This is the path where the cognitive layer has a mechanism rather than just
   * a wording change. `decideRetrieval` returns
   * `{retrieve:false, reason:'below-threshold'}` when the best candidate is
   * below the threshold, and that is a machine-derived abstention: the system
   * declines before the model is consulted. When the gate does admit evidence
   * the conservative contract is still used, because the question may have no
   * answer even though related evidence exists.
   *
   * ## The docstring above described code that did not exist
   *
   * It is kept because it is still the intent, and rewritten below because for
   * a measured period **it was not true**. `decideRetrieval` had no call site in
   * this package -- grepping for it returned docstrings and one barrel comment --
   * so this method abstained only on an empty admission, and every other
   * abstention in a run was the model's response to the `INSUFFICIENT_EVIDENCE`
   * instruction. The layer had a *wording* change and no mechanism.
   *
   * Dispatch `37094200823` is what made it visible, and only because the arm
   * measured against a system that does have a mechanism: 6.40% against the
   * reference pipeline's 85.20%, with abstention at 95.40% and the per-capability
   * table showing ABS at 100% while IE, MR, KU and TR sat between 0.00% and
   * 0.83%. A system that declines everything is indistinguishable from a system
   * whose "abstention mechanism" is an instruction string.
   *
   * The tests in `abstention-decision.test.ts` assert the property that was
   * missing -- the model is **not consulted** when the gate decides to abstain
   * (`seen).toHaveLength(0)`) -- rather than that the name `decideRetrieval`
   * appears in this file. That distinction is load-bearing here: the name
   * appeared in the comments all along, so a textual assertion would have passed
   * on the broken code.
   */
  async answerAbstention(
    question: string,
    context: string[],
    sessions?: string[][],
  ): Promise<Answer> {
    const turns = this.#admit(context, sessions);
    if (turns.length === 0) return this.#declinedEmpty();

    // The only `threshold` in this class, and the reason the key stays `0` on
    // every other route: this is the one method `#retrievalAdmitted` is called
    // from. A reader who sees `threshold` move on a route without a gate is
    // looking at a bug, which is what the widened census's test pins.
    if (!this.#retrievalAdmitted(turns)) {
      this.#reasons.threshold += 1;
      return null;
    }

    // Recorded as `llm` when the prompt comes back as a decline, and `answered`
    // otherwise -- by `#consult`, which every route goes through. The three
    // non-`answered` outcomes are the ones a reader has to be able to separate;
    // the distinction between "the model declined" and "the model answered" is
    // what makes the tally a complete census of the path rather than a census of
    // its failures only.
    //
    // The model outcome is NOT tallied here. It was, and once `#consult` began
    // tallying every route the abstention route counted each decline twice --
    // overstating the one route that was already correct.
    const answer = await this.#prompt(question, turns, 'abstention', 'abstention');
    return answer;
  }

  /**
   * The machine-derived decision, computed before the model is consulted.
   *
   * `decideRetrieval` takes the maximum over candidates, so one strong turn
   * opens the gate for the whole context. That is deliberate and matches the
   * reference pipeline's abstention boundary, which reads `hits[0].score`: a
   * question with one reliable piece of evidence is answerable, and a mean-based
   * aggregate would decline it.
   *
   * The candidates are the admitted turns rather than raw context, so the two
   * gates compose in one direction only: a turn the write gate rejected can
   * never be the evidence that opens the retrieval gate. Reversing that would
   * make `threshold` decorative -- raising it would reject turns from the prompt
   * while still letting them justify answering from the prompt.
   */
  #retrievalAdmitted(turns: readonly AdmittedTurn[]): boolean {
    const candidates: MemoryValue[] = turns.map((turn) => ({ ...turn }));
    const decision = decideRetrieval(
      candidates,
      this.#valueFunctionFor(),
      this.#options.gate.retrievalThreshold,
    );
    return decision.retrieve;
  }

  /** The value function both gates read, so they can never disagree. */
  #valueFunctionFor(): ValueFunction {
    return this.#options.gate.valueFunction ?? clockAwareValueFunction(this.#now);
  }

  /** Single-session answering whose evidence may live in an assistant turn. */
  async answerAssistant(
    question: string,
    context: string[],
    sessions?: string[][],
  ): Promise<Answer> {
    const turns = this.#admit(context, sessions);
    if (turns.length === 0) return this.#declinedEmpty();

    return this.#prompt(question, turns, 'assistant', 'assistant');
  }

  /**
   * Knowledge-update answering.
   *
   * The second path with a real mechanism: a question that asks for a previous
   * versus a current value is a bitemporal query, and `cortex-core` already
   * carries `currentFacts` / `currentValue` / `findContradictions` for it. The
   * prompt therefore names the qualifier explicitly instead of hoping the model
   * infers it.
   */
  async answerKnowledgeUpdate(
    question: string,
    context: string[],
    sessions?: string[][],
  ): Promise<Answer> {
    const turns = this.#admit(context, sessions);
    if (turns.length === 0) return this.#declinedEmpty();

    return this.#prompt(question, turns, 'knowledge-update', 'knowledge-update');
  }

  /**
   * The machine declined before the model was consulted: nothing was admitted.
   *
   * A named method rather than six copies of `this.#reasons.empty += 1`, for the
   * reason the three `#prompt*` methods share `#consult`: the census is read as
   * one number, so every route that can produce `empty` has to produce it the
   * same way. Six independent increments is six chances for one route to be
   * added later and forgotten.
   *
   * `empty` is separated from `llm` because they are repaired differently --
   * `empty` is a write-gate or dataset problem, `llm` is the model's own
   * behaviour. Folding them would make a broken admission path read as a model
   * that declines everything, which is the same collapse §10.10 records for the
   * inert retrieval gate.
   */
  #declinedEmpty(): null {
    this.#reasons.empty += 1;
    return null;
  }

  /** Admit a flat context, or the flattened sessions when the caller supplied them. */
  #admit(context: string[], sessions?: string[][]): AdmittedTurn[] {
    const admissionOptions = admissionOptionsFrom(this.#now, this.#options.gate);
    if (sessions !== undefined && sessions.length > 0) {
      // Sessions are admitted independently, then flattened, because the flat
      // paths receive no boundary information to present.
      //
      // The budget is applied HERE, before flattening, and not only in
      // `answerSessions`. It used to be applied only there, and `selectSessionBudget`
      // had exactly one call site -- so `answerAbstention`, which is the path an
      // arm experiment exercises, ran with its budget silently unapplied while the
      // artifact recorded the budget it believed it was running with. That is the
      // same class of defect as the inert `retrievalThreshold` in
      // `docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md` §10.10: a recorded
      // configuration value that does not reach the decision it names.
      //
      // Ranking is by session, so it must happen on `AdmittedSession[]` and not on
      // the flattened turns; flattening first would lose the boundaries and make
      // "admit a session whole" unexpressible.
      return selectSessionBudget(
        admitSessions(sessions, admissionOptions),
        this.#options.gate.sessionBudget,
      ).flatMap((session) => session.turns);
    }
    return admitTurns(context, admissionOptions);
  }

  /** Admit a flat context and render it as one block. */
  async #respond(question: string, context: string[], contract: PromptContract): Promise<Answer> {
    const turns = this.#admit(context);
    if (turns.length === 0) return this.#declinedEmpty();

    return this.#prompt(question, turns, contract, 'flat');
  }

  async #prompt(
    question: string,
    turns: AdmittedTurn[],
    contract: PromptContract,
    /**
     * Which route is asking.
     *
     * Required rather than defaulted, so a seventh route added later cannot compile without
     * naming itself -- and therefore cannot silently inherit a cap the artifact says reaches
     * something else. The contract is not a route: `#respond` builds the flat prompt with the
     * `extractive` contract, and `#prompt` is the path all four flat-ish routes share.
     */
    route: TurnCapRoute,
  ): Promise<Answer> {
    // `contract` names this route's ASK and is not overridden. Overriding it here
    // is what the first fix did, and §12.9 records why that was wrong: naming the
    // abstention contract on the KU or flat route would replace their instruction
    // block with one that tells the model to decline, which moves the ask and the
    // evidence at once -- two variables in a run whose whole value is that it has
    // one -- and on MR it would invite abstention on questions that must be
    // answered. The rendering is resolved in `#promptOptions` instead, so every
    // route keeps its own ask and only the evidence presentation moves.
    // Filtered here rather than at admission: the gate decides what may be *answered from*,
    // this decides what may be *shown among the turns already kept*, and §13.83 registers the
    // second. An emptied list is the same state as admitting nothing, so it declines before
    // spending a request.
    const kept = this.#turnsForRoute(turns, route);
    if (kept.length === 0) return this.#declinedEmpty();
    const assembled = buildPrompt(question, kept, contract, this.#promptOptions(route));
    this.#recordEvidence(kept, assembled);
    return this.#consult(assembled.prompt);
  }

  async #promptWithDate(
    question: string,
    turns: AdmittedTurn[],
    contract: PromptContract,
    questionDate: string | undefined,
  ): Promise<Answer> {
    const base = this.#promptOptions('temporal');
    const kept = this.#turnsForRoute(turns, 'temporal');
    if (kept.length === 0) return this.#declinedEmpty();
    const assembled = buildPrompt(question, kept, contract, {
      ...base,
      ...(questionDate === undefined ? {} : { questionDate }),
    });
    this.#recordEvidence(kept, assembled);
    return this.#consult(assembled.prompt);
  }

  /** Render selected sessions with their boundaries intact. */
  async #promptSessionAware(
    question: string,
    sessions: readonly AdmittedSession[],
  ): Promise<Answer> {
    const assembled = buildSessionPrompt(
      question,
      sessions,
      // The multi-session route, named here rather than defaulted: this builder is the one
      // §13.72 measured at +13, so a default would make the measurement's route the one route
      // whose reach is never written down.
      this.#promptOptions('multi-session'),
    );
    // Flattened for the two measurements the builder cannot report, which are about
    // the **offer** and not the delivery: the prompt keeps its boundaries, the offer
    // is one list of admitted turns, and the boundary is presentation. A reader
    // comparing this against the carried set wants the same turns the session
    // admission produced, and `lastAdmittedEvidence` counts them in the record's own
    // unit.
    this.#recordEvidence(
      sessions.flatMap((session) => session.turns),
      assembled,
    );
    return this.#consult(assembled.prompt);
  }

  /**
   * Ask the model, retain its text, and tally which of its two outcomes it was.
   *
   * The single place a model outcome is recorded, for the reason `#promptOptions`
   * resolves the rendering in one place: three copies of the `llm` / `answered`
   * branch is three chances for two routes to disagree about the same model
   * behaviour, and the census is only readable if one decline counts once.
   *
   * ## Why this is here and not in `answerAbstention`
   *
   * It was in `answerAbstention` alone, and `runBenchmark` dispatches that method
   * only for `capability === 'ABS'`. So the census covered one route, and the
   * sustained loss this arm exists to explain -- MR and TR, 13 -> 0 and 16 -> 0 in
   * §13 -- never entered it. §58 made that scope legible in the artifact and
   * deliberately left the counter narrow; §13 is what made narrowing untenable,
   * because no other field in the artifact could say which route declined.
   *
   * ## Why `answerAbstention` no longer tallies the model outcome itself
   *
   * It still tallies `empty` and `threshold`, which are decisions made *before*
   * this call and that no other route can reach. Its own `llm` / `answered`
   * branch was removed rather than left in place, because with this method
   * tallying every route the abstention route would otherwise count one decline
   * twice -- and it would overstate exactly the route that was already correct.
   */
  async #consult(prompt: string): Promise<Answer> {
    const raw = await this.#llm.complete(prompt);
    // Retained before the parse, not after: `parseAnswer` returns the summary
    // and the text it summarised is gone by then. See `#lastRawOutput`.
    this.#lastRawOutput = raw;
    const answer = parseAnswer(raw);
    this.#reasons[answer === null ? 'llm' : 'answered'] += 1;
    return answer;
  }

  /**
   * The prompt options every route shares, including the resolved rendering.
   *
   * The run names a **prompt contract** -- that is the published knob, and its
   * name is what prior artifacts and the arm's CLI carry. What the run is
   * actually varying is the **evidence rendering**, and this is the single place
   * the former is translated into the latter. Resolving it here rather than at
   * each call site is what makes the reachable set "every route" rather than
   * "whichever route happens to funnel through one private method": MR and TR
   * build their prompts outside `#prompt`, and previously received no rendering
   * at all -- the 28-question loss at `bcf66463` was on exactly those two routes
   * plus the two flat ones this reaches as well.
   *
   * The translation is total over `PROMPT_CONTRACTS`: every contract either names
   * a rendering or deliberately does not, and the default reproduces the baseline
   * byte for byte so prior artifacts stay comparable.
   */
  /**
   * Whether the per-turn cap reaches this route.
   *
   * One predicate for the six paths, and the reason it is not inlined at each of them is
   * §13.72's result: the same cap is worth **+13 on MR and −30 on IE**, so the reach is not a
   * detail of one call site. Absent means every route (what §13.68 shipped); an empty list
   * reaches none.
   */
  #capReaches(route: TurnCapRoute): boolean {
    const routes = this.#options.maxTurnCharsRoutes;
    return routes === undefined || routes.includes(route);
  }

  #promptOptions(route: TurnCapRoute): PromptOptions {
    // `promptContract` is absent on every pre-switch construction, and an absent
    // contract means the baseline rendering -- which is the same answer as naming
    // `abstention`. The lookup is guarded rather than defaulted so the record stays a
    // partial map: defaulting here would make an unknown name resolve to
    // `abstention`'s (absent) entry instead of failing loudly at the parse boundary,
    // which is where `readPromptContract` already rejects it.
    const named = this.#options.promptContract;
    const rendering = named === undefined ? undefined : RENDERING_BY_CONTRACT[named];
    // The ask is a second, independent axis and is resolved the same way, in the same
    // place, for the same reason. §13 requires them to move separately: the ask
    // experiment holds the rendering at whatever the run named.
    const ask = this.#options.ask;
    return {
      ...(this.#options.maxPromptChars === undefined
        ? {}
        : { maxChars: this.#options.maxPromptChars }),
      // §13.68's width, now reached through §13.73's route list. The decision is made HERE
      // rather than at the six call sites, so a route cannot be added and silently receive a
      // cap that the run's artifact says reaches two routes. `undefined` means "every route"
      // and reproduces §13.68 byte for byte; `[]` reaches none and is how the option is
      // disabled without being removed. Spread conditionally because `prompt.ts` tests
      // `=== undefined` to mean "no cap", and an always-present key holding `undefined` is the
      // state `types.ts` records as indistinguishable from absent.
      ...(this.#options.maxTurnChars === undefined || !this.#capReaches(route)
        ? {}
        : { maxTurnChars: this.#options.maxTurnChars }),
      ...(rendering === undefined ? {} : { rendering }),
      ...(ask === undefined ? {} : { ask }),
      // Forwarded here rather than at each `#prompt*` call site, so the three routes
      // cannot disagree about whether the budget is spent on relevant turns -- the
      // same argument `#admit` makes for applying the session budget in one place.
      // Spread conditionally because `admission.ts` and this class both treat a
      // present-but-undefined key as "configured".
      ...(this.#options.relevanceFor === undefined
        ? {}
        : { relevanceFor: this.#options.relevanceFor }),
      // Forwarded for the same reason and from the same place. Only the multi-session
      // route reads it, and that is a property of the route rather than of this
      // forwarding: `buildPrompt` receives no session boundary, so a selection in
      // sessions cannot be expressed there and the option is inert on flat, temporal,
      // knowledge-update, abstention and assistant. Stated because it is what makes
      // §13.27's dispatch a single-variable one -- MR moves and nothing else can.
      ...(this.#options.relevanceUnits === undefined
        ? {}
        : { relevanceUnits: this.#options.relevanceUnits }),
    };
  }
}
