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
import { buildPrompt, buildSessionPrompt, type PromptContract } from './prompt.js';
import { parseAnswer } from './parse.js';
import type { CortexMemoryOptions } from './types.js';

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

  /**
   * Why each abstention happened, on the ABSTENTION ROUTE, accumulated across calls.
   *
   * ## The scope, which is narrower than the name suggests
   *
   * The four keys name the four mutually exclusive outcomes of
   * `answerAbstention`, and they cover every call to it exactly once.
   * `empty` and `threshold` are machine-derived and consume no request; `llm` and
   * `answered` are the model's two outcomes.
   *
   * `#reasons` is written in that one method and nowhere else, and
   * `runBenchmark` dispatches `answerAbstention` **only** for
   * `capability === 'ABS'`. So this is a census of the abstention route, **not of
   * the run**: a question declined on the session, temporal, assistant,
   * preference or knowledge-update route is invisible here. Three tests in
   * `abstention-reasons.test.ts` pin that boundary.
   *
   * ## Why the scope is written down
   *
   * It was misread, and the misreading cost a whole round. The §12.5 artifact
   * carries `abstentionReasons.llm = 120`, and §55 read it as "the model declined
   * 120 times". §55.4 then made the next investigation "read the 30 ABS outputs
   * for a common decline pattern". Both readings are wrong in the same way:
   * `30 ABS questions x 4 runs = exactly 120`, ABS gold **is** abstention, and ABS
   * scored **30/30 correct** -- so those 120 calls are the capability passing, and
   * the artifact's own per-capability table said so all along
   * (`ABS: total=30 base=30 feat=30 b+f-=0`).
   *
   * Meanwhile the real loss is invisible to this field: 449 of 470 non-ABS
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
   * `empty` is counted here rather than folded into `threshold` because the two
   * are repaired differently: `threshold` means the arming chose to decline, while
   * `empty` means the arm supplied no evidence to decline *from*, which is a
   * dataset- or write-gate-level problem and not a retrieval-gate result.
   */
  readonly #reasons: { empty: number; threshold: number; llm: number; answered: number } = {
    empty: 0,
    threshold: 0,
    llm: 0,
    answered: 0,
  };

  constructor(options: CortexMemoryOptions) {
    this.name = options.name ?? 'cortex-memory';
    this.#llm = options.llm;
    this.#now = options.now;
    this.#options = options;
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

    if (admitted.length === 0) return null;

    // `selectSessionBudget` never returns empty for a non-empty input: when no
    // session fits the budget it admits the highest-value one anyway, because
    // answering from no evidence is worse than exceeding a prompt budget. An
    // earlier version carried a `selected.length === 0` guard here that no test
    // could reach, which is how the redundancy was found.
    const selected = selectSessionBudget(admitted, this.#options.gate.sessionBudget);

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
    if (turns.length === 0) return null;

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
    if (turns.length === 0) {
      this.#reasons.empty += 1;
      return null;
    }

    if (!this.#retrievalAdmitted(turns)) {
      this.#reasons.threshold += 1;
      return null;
    }

    // Recorded as `llm` when the prompt comes back as a decline, and `answered`
    // otherwise. The three non-`answered` outcomes are the ones a reader has to
    // be able to separate; the distinction between "the model declined" and "the
    // model answered" is what makes the tally a complete census of the path
    // rather than a census of its failures only.
    const answer = await this.#prompt(question, turns, 'abstention');
    this.#reasons[answer === null ? 'llm' : 'answered'] += 1;
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
    if (turns.length === 0) return null;

    return this.#prompt(question, turns, 'assistant');
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
    if (turns.length === 0) return null;

    return this.#prompt(question, turns, 'knowledge-update');
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
    if (turns.length === 0) return null;

    return this.#prompt(question, turns, contract);
  }

  async #prompt(
    question: string,
    turns: AdmittedTurn[],
    contract: PromptContract,
  ): Promise<Answer> {
    // The abstention route is the one §12.5's experiment moves, and it is the only
    // route the override is allowed to touch. Applying it to every contract would
    // change the prompts of routes the registration does not name, which would make
    // the run a test of the rendering across all capabilities rather than of the
    // abstention path's evidence presentation.
    const resolved =
      contract === 'abstention' && this.#options.promptContract !== undefined
        ? this.#options.promptContract
        : contract;
    const prompt = buildPrompt(question, turns, resolved, this.#promptOptions());
    const raw = await this.#llm.complete(prompt);
    return parseAnswer(raw);
  }

  async #promptWithDate(
    question: string,
    turns: AdmittedTurn[],
    contract: PromptContract,
    questionDate: string | undefined,
  ): Promise<Answer> {
    const base = this.#promptOptions();
    const prompt = buildPrompt(question, turns, contract, {
      ...base,
      ...(questionDate === undefined ? {} : { questionDate }),
    });
    const raw = await this.#llm.complete(prompt);
    return parseAnswer(raw);
  }

  /** Render selected sessions with their boundaries intact. */
  async #promptSessionAware(
    question: string,
    sessions: readonly AdmittedSession[],
  ): Promise<Answer> {
    const prompt = buildSessionPrompt(question, sessions, this.#promptOptions());
    const raw = await this.#llm.complete(prompt);
    return parseAnswer(raw);
  }

  #promptOptions(): { maxChars?: number } {
    return this.#options.maxPromptChars === undefined
      ? {}
      : { maxChars: this.#options.maxPromptChars };
  }
}
