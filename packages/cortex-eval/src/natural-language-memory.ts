/**
 * A natural-language retrieval-augmented QA memory system for LongMemEval-style
 * benchmarks. It retrieves the most relevant conversational turns by embedding
 * similarity, generates an answer with an LLM grounded in the retrieved context,
 * and abstains either when retrieval confidence is too low or when the LLM
 * reports the answer is absent from the context.
 *
 * Retrieval and embedding are delegated to the shared `retrieval.ts` module so
 * the system and the diagnostics harness use identical logic.
 */
import type { EmbeddingModel, JsonSchema, LLM } from '@agentix-e/cortex-core';
import type { Answer, SessionAwareMemorySystem } from './types.js';
import {
  expandContextWindow,
  retrieveByQueries,
  retrieveSessionsByTurns,
  retrieveTopKByQueries,
  retrieveTopKByQueriesHybrid,
  retrieveTopKSessions,
  type RetrievalHit,
  type SessionHit,
} from './retrieval.js';
import {
  classifyTemporalQuestion,
  computeTemporalAnswer,
  type TemporalEvent,
  type TemporalKind,
} from './temporal-engine.js';
import {
  classifyKnowledgeUpdateQualifier,
  currentObject,
  previousObject,
  type ExtractedFact,
} from './fact-store.js';

export { clearEmbeddingCache } from './retrieval.js';

export type AbstainReason = 'empty' | 'threshold' | 'llm' | 'answered';

export type DecisionTrace = {
  question: string;
  top1Score: number;
  abstained: boolean;
  reason: AbstainReason;
  /** Context actually injected into the LLM (empty when abstained pre-LLM). */
  retrieved?: string;
  /** Raw LLM response (undefined when the LLM was not called). */
  llmRaw?: string;
  /** Final answer returned to the benchmark. */
  answer?: Answer;
  /** Query-expansion phrases used for targeted recall (single-session and MR). */
  expansionQueries?: string[];
};

export type NaturalLanguageMemorySystemOptions = {
  embedding: EmbeddingModel;
  llm: LLM;
  /** Number of retrieved turns passed to the LLM (default 15). */
  topK?: number;
  /** Number of retrieved sessions passed to the LLM in session mode (default 10). */
  sessionTopK?: number;
  /** Number of neighbouring turns to include around each turn hit (default 1). */
  contextRadius?: number;
  /** Per-session character budget when aggregating sessions (default 2000). */
  maxSessionChars?: number;
  /** Per-turn character budget for the single-session path (default 2000). */
  maxTurnChars?: number;
  /** Total character budget for the injected multi-session evidence (default 20000). */
  maxAggregationChars?: number;
  /** When true, expand the question into concrete phrases before MR recall (default true). */
  enableQueryExpansion?: boolean;
  /**
   * Shared cache for query-expansion results, keyed by `<builder>:<question>`.
   * The benchmark runs several systems (baseline vs feature, ablation variants)
   * over the SAME questions, so expansion is deterministic at temperature 0 and
   * can be reused across those instances instead of re-calling the LLM per
   * system. Injected (rather than module-global) so tests stay isolated.
   */
  queryExpansionCache?: Map<string, string[]>;
  /** Top sessions recalled per expansion phrase (default 3). */
  queryExpansionTopKPerQuery?: number;
  /**
   * Extra sessions the turn-level recall channel may ADD to the multi-session
   * (MR) result; 0 disables the channel (default 3).
   *
   * A session is normally represented by the mean of its turn vectors, so a
   * short evidence turn buried in a long session is diluted out of the top-k.
   * The turn channel scores turns individually and admits the best sessions it
   * found that the centroid channel did not. See `retrieveSessionsByTurns`.
   */
  turnRecallSessions?: number;
  /**
   * Turns retrieved per query by the turn-level recall channel (default 50).
   *
   * A search scores every indexed turn regardless of this number — it only caps
   * how many are returned — so a deeper search is free. Depth matters because
   * the already-retrieved sessions' turns occupy the very top of the ranking; a
   * shallow search would return only sessions already in hand, leaving the
   * channel nothing to add.
   */
  turnRecallTurnsPerQuery?: number;
  /** Abstain before calling the LLM when the best similarity is below this value. */
  abstainThreshold?: number;
  /**
   * Similarity threshold for the multi-session (MR) path only. Defaults to
   * undefined, which disables threshold abstention on the session path: a
   * multi-session answer aggregates evidence across sessions, so the top-1
   * session similarity is a poor abstention signal and would discard answerable
   * questions. The LLM's own `abstainToken` response remains the session path's
   * abstention mechanism.
   */
  sessionAbstainThreshold?: number;
  /** The LLM's abstention marker (default UNANSWERABLE). */
  abstainToken?: string;
  /** When false, the system never abstains (baseline behavior); default true. */
  enableAbstention?: boolean;
  /**
   * When true (default), temporal questions are answered through the
   * deterministic temporal engine first: the LLM extracts event dates and the
   * elapsed-time / interval / ordering arithmetic is computed exactly. When
   * false, every temporal question falls back to the LLM date-reading prompt, so
   * an ablation can isolate the deterministic engine's contribution.
   */
  enableDeterministicTemporal?: boolean;
  /**
   * When true (default), knowledge-update questions with a previous/current time
   * qualifier are answered through a bitemporal path first: the LLM extracts the
   * subject's (object, date) history and exact date order picks the current vs
   * previous value. When false, every such question falls back to the CoT prompt,
   * so an ablation can isolate the bitemporal selection's contribution.
   */
  enableBitemporalKnowledgeUpdate?: boolean;
  /**
   * Prompt builder for multi-session aggregation (default buildAggregationQaPrompt).
   * Overridable so an ablation can hold abstention constant while swapping only
   * the aggregation prompt (e.g. legacy inline-counting vs CoT enumeration).
   */
  aggregationPrompt?: PromptBuilder;
  /** LLM sampling temperature; default 0 for deterministic evaluation. */
  temperature?: number;
  /** Optional callback for per-question decision tracing (diagnostic). */
  onDecision?: (trace: DecisionTrace) => void;
};

const DEFAULT_ABSTAIN_TOKEN = 'UNANSWERABLE';
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_TOP_K = 15;
const DEFAULT_SESSION_TOP_K = 10;
const DEFAULT_CONTEXT_RADIUS = 1;
const DEFAULT_MAX_SESSION_CHARS = 2000;
const DEFAULT_QUERY_EXPANSION_TOP_K = 3;
const DEFAULT_MAX_TURN_CHARS = 2000;
const DEFAULT_MAX_AGGREGATION_CHARS = 20_000;
const DEFAULT_TURN_RECALL_SESSIONS = 3;
const DEFAULT_TURN_RECALL_TURNS_PER_QUERY = 50;

/** Structured output schema for the temporal event-extraction prompt. */
const TEMPORAL_EVENTS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          date: { type: 'string' },
        },
        required: ['name', 'date'],
      },
    },
  },
  required: ['events'],
};

/** Structured output schema for the bitemporal fact-extraction prompt. */
const FACTS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          predicate: { type: 'string' },
          object: { type: 'string' },
          date: { type: 'string' },
        },
        required: ['subject', 'object', 'date'],
      },
    },
  },
  required: ['facts'],
};

type PromptBuilder = (question: string, context: string, abstainToken?: string) => string;
type AnswerParser = (raw: string, abstainToken?: string) => Answer;

export class NaturalLanguageMemorySystem implements SessionAwareMemorySystem {
  readonly name: string;
  private readonly options: NaturalLanguageMemorySystemOptions;

  constructor(name: string, options: NaturalLanguageMemorySystemOptions) {
    this.name = name;
    this.options = options;
  }

  /**
   * Turn-level answering for the flattened `MemorySystem.answer` contract. The
   * question is expanded into concrete phrases first so dispersed evidence turns
   * (a specific object or event named only once in a large haystack) are recalled
   * even when the abstract question alone ranks them below unrelated distractors.
   * Retrieval is restricted to user turns because the facts live in the user's
   * statements; assistant turns are verbose generated chatter that dilutes the
   * answer signal (and for temporal questions, drown the date-bearing turns).
   */
  async answer(question: string, context: string[]): Promise<Answer> {
    const { hits, retrieved, expansionQueries } = await this.retrieveTurns(question, context);
    return this.respondWith(
      question,
      hits[0]?.score ?? 0,
      retrieved,
      buildQaPrompt,
      parseQaAnswer,
      expansionQueries,
      this.options.abstainThreshold,
    );
  }

  /**
   * Temporal-reasoning answering for single-session questions. It first tries a
   * deterministic path: the LLM extracts the event(s) and copies their turn
   * dates, then the temporal engine computes the elapsed time, interval, or
   * ordering exactly. Only when that path cannot produce an answer does it fall
   * back to the LLM date-reading prompt (the previous behaviour).
   */
  async answerTemporal(
    question: string,
    context: string[],
    questionDate?: string,
  ): Promise<Answer> {
    const kind = classifyTemporalQuestion(question);
    const { hits, retrieved, expansionQueries } = await this.retrieveTurns(
      question,
      context,
      false,
      buildTemporalQueryExpansionPrompt,
      true,
    );
    const supportsDeterministic = kind !== 'other' && kind !== 'eventLookup';
    if (
      this.options.enableDeterministicTemporal !== false &&
      questionDate &&
      supportsDeterministic &&
      retrieved !== ''
    ) {
      const deterministic = await this.tryDeterministicTemporal(
        question,
        questionDate,
        kind,
        retrieved,
        expansionQueries,
      );
      if (deterministic !== null) {
        return deterministic;
      }
    }
    // Event-lookup questions ("What was the event two weeks ago?") ask for the
    // entity at a time anchor, not for a date computation, so they use a lookup
    // prompt instead of the date-arithmetic prompt (which would make the model
    // try to compute an elapsed time that the question never asked for).
    const temporalPrompt: PromptBuilder =
      kind === 'eventLookup'
        ? (q, c, t) => buildTemporalEventLookupPrompt(q, c, questionDate, t)
        : (q, c, t) => buildTemporalQaPrompt(q, c, questionDate, t);
    return this.respondWith(
      question,
      hits[0]?.score ?? 0,
      retrieved,
      temporalPrompt,
      parseQaAnswer,
      expansionQueries,
      this.options.abstainThreshold,
    );
  }

  /**
   * Deterministic temporal answering: ask the LLM to report the question's
   * event(s) and their evidence-turn dates, then compute the answer with exact
   * date arithmetic. Returns `null` to signal the caller to fall back to the LLM
   * temporal prompt (e.g. when the extraction fails or is unanswerable).
   */
  private async tryDeterministicTemporal(
    question: string,
    questionDate: string,
    kind: TemporalKind,
    retrieved: string,
    expansionQueries: string[],
  ): Promise<Answer> {
    let extracted: { events?: TemporalEvent[] };
    try {
      extracted = await this.options.llm.completeStructured<{ events?: TemporalEvent[] }>(
        buildTemporalEventExtractionPrompt(
          question,
          retrieved,
          questionDate,
          expansionQueries,
          kind,
        ),
        TEMPORAL_EVENTS_SCHEMA,
        { temperature: this.options.temperature ?? DEFAULT_TEMPERATURE },
      );
    } catch {
      // Structured extraction failed (e.g. the provider returned non-JSON);
      // fall back rather than guessing from an unparseable response.
      return null;
    }
    const events = Array.isArray(extracted?.events) ? extracted.events : [];
    const answer = computeTemporalAnswer(question, kind, questionDate, events);
    if (answer === null) {
      return null;
    }
    this.emitTrace(question, 0, false, 'answered', {
      retrieved,
      answer,
      expansionQueries,
    });
    return answer;
  }

  /**
   * Single-session answering for `single-session-assistant` questions. The
   * evidence for these questions lives in an assistant turn, so retrieval runs
   * over ALL turns instead of the user-turn-only filter used by `answer`.
   */
  async answerAssistant(question: string, context: string[]): Promise<Answer> {
    const { hits, retrieved, expansionQueries } = await this.retrieveTurns(question, context, true);
    return this.respondWith(
      question,
      hits[0]?.score ?? 0,
      retrieved,
      buildQaPrompt,
      parseQaAnswer,
      expansionQueries,
      this.options.abstainThreshold,
    );
  }

  /**
   * Single-session answering for abstention questions. Their expected answer is
   * to abstain because the context offers no answer at all, which is the
   * opposite of knowledge-update/extraction questions where the answer is
   * present and must be selected among candidates. It therefore uses the
   * conservative prompt (looser abstention wording) and retrieves over ALL turns
   * so no evidence is missed before the model decides whether to abstain.
   */
  async answerAbstention(question: string, context: string[]): Promise<Answer> {
    const { hits, retrieved, expansionQueries } = await this.retrieveTurns(question, context, true);
    return this.respondWith(
      question,
      hits[0]?.score ?? 0,
      retrieved,
      buildConservativeQaPrompt,
      parseQaAnswer,
      expansionQueries,
      this.options.abstainThreshold,
    );
  }

  /**
   * Single-session answering for preference/recommendation questions. Their
   * expected answer is a suggestion that reflects the user's stated preferences
   * (brands, products, topics, styles), NOT a single extracted fact. The
   * extractive `answer` prompt therefore fails on them: it demands a short fact
   * phrase and abstains when none is present, even though the evidence turn was
   * retrieved. Retrieval runs over ALL turns (a preference can be restated in an
   * assistant turn) and the generative prompt asks for a concrete, specific
   * recommendation instead of a bare fact.
   */
  async answerPreference(question: string, context: string[]): Promise<Answer> {
    const { hits, retrieved, expansionQueries } = await this.retrieveTurns(question, context, true);
    return this.respondWith(
      question,
      hits[0]?.score ?? 0,
      retrieved,
      buildPreferencePrompt,
      parseRecommendationAnswer,
      expansionQueries,
      this.options.abstainThreshold,
    );
  }

  /**
   * Single-session answering for knowledge-update questions. These ask which
   * value a time qualifier selects: "previous/before" selects the earlier value,
   * "currently/now/most recent" selects the later value, and Yes/No comparison
   * questions compare turns. The generic extractive prompt only says "choose the
   * most recent", which the model applies unreliably when both old and new values
   * are present. The dedicated prompt makes the mapping explicit so the model
   * picks the version the qualifier asks for instead of abstaining.
   */
  async answerKnowledgeUpdate(question: string, context: string[]): Promise<Answer> {
    const { hits, retrieved, expansionQueries } = await this.retrieveTurns(
      question,
      context,
      false,
    );
    const qualifier = classifyKnowledgeUpdateQualifier(question);
    if (
      this.options.enableBitemporalKnowledgeUpdate !== false &&
      qualifier !== 'other' &&
      retrieved !== ''
    ) {
      const bitemporal = await this.tryBitemporalKnowledgeUpdate(
        question,
        retrieved,
        qualifier,
        expansionQueries,
      );
      if (bitemporal !== null) {
        return bitemporal;
      }
    }
    return this.respondWith(
      question,
      hits[0]?.score ?? 0,
      retrieved,
      buildKnowledgeUpdatePrompt,
      parseQaAnswer,
      expansionQueries,
      this.options.abstainThreshold,
    );
  }

  /**
   * Bitemporal knowledge-update answering: ask the LLM to report the subject's
   * (object, date) history, then select the current or previous value by exact
   * date order. Returns `null` to fall back to the CoT prompt when the extraction
   * fails or yields too few facts for the requested qualifier.
   */
  private async tryBitemporalKnowledgeUpdate(
    question: string,
    retrieved: string,
    qualifier: 'previous' | 'current',
    expansionQueries: string[],
  ): Promise<Answer> {
    let extracted: { facts?: ExtractedFact[] };
    try {
      extracted = await this.options.llm.completeStructured<{ facts?: ExtractedFact[] }>(
        buildFactExtractionPrompt(question, retrieved),
        FACTS_SCHEMA,
        { temperature: this.options.temperature ?? DEFAULT_TEMPERATURE },
      );
    } catch {
      return null;
    }
    const facts = Array.isArray(extracted?.facts) ? extracted.facts : [];
    const subject = facts[0]?.subject;
    if (!subject) {
      return null;
    }
    const answer =
      qualifier === 'previous' ? previousObject(facts, subject) : currentObject(facts, subject);
    if (answer === null) {
      return null;
    }
    this.emitTrace(question, 0, false, 'answered', {
      retrieved,
      answer,
      expansionQueries,
    });
    return answer;
  }

  /**
   * User-turn retrieval shared by `answer`, `answerAssistant`, and
   * `answerTemporal`. The temporal path passes an event-level expansion builder
   * because temporal questions ask WHEN an event happened, so the answer turn is
   * recalled by matching the event (verb + object), not a bare object noun that
   * also occurs in unrelated turns. `includeAssistant` selects all turns for the
   * `single-session-assistant` sub-type whose evidence is an assistant turn.
   * `enableLexicalRecall` additionally guarantees keyword-bearing turns a place
   * in the result; the temporal path enables it because its evidence turns are
   * concrete events that the question names, while embedding similarity alone
   * ranks them below semantically-close distractors.
   */
  private async retrieveTurns(
    question: string,
    context: string[],
    includeAssistant: boolean = false,
    expansionPromptBuilder: (question: string) => string = buildQueryExpansionPrompt,
    enableLexicalRecall: boolean = false,
  ): Promise<{ hits: RetrievalHit[]; retrieved: string; expansionQueries: string[] }> {
    const topK = this.options.topK ?? DEFAULT_TOP_K;
    const factTurns = includeAssistant ? context : context.filter(isUserTurn);
    const searchable = (factTurns.length > 0 ? factTurns : context).map((turn) =>
      truncateText(turn, this.options.maxTurnChars ?? DEFAULT_MAX_TURN_CHARS),
    );
    const expansionQueries = await this.expandQuestion(question, expansionPromptBuilder);
    const queries = [question, ...expansionQueries];
    const hits = enableLexicalRecall
      ? await retrieveTopKByQueriesHybrid(this.options.embedding, queries, searchable, topK)
      : await retrieveTopKByQueries(this.options.embedding, queries, searchable, topK);
    const retrieved =
      hits.length === 0
        ? ''
        : expandContextWindow(
            searchable,
            hits.map((h) => h.index),
            this.options.contextRadius ?? DEFAULT_CONTEXT_RADIUS,
          );
    return { hits, retrieved, expansionQueries };
  }

  /**
   * Multi-session aggregation answering: expand the abstract question into
   * concrete retrieval phrases, recall evidence sessions for both the question
   * and each phrase, then inject their (bounded) content so the LLM can aggregate
   * evidence spread across sessions.
   */
  async answerSessions(question: string, sessions: string[][]): Promise<Answer> {
    // Multi-session questions ask about facts the user stated across sessions,
    // so assistant replies are pure noise: they dilute the session centroid and
    // the aggregation context. Filter them out before retrieval so the LLM
    // aggregates over clean user facts only.
    const factSessions = sessions.map((session) =>
      session.filter((turn) => !isAssistantTurn(turn)),
    );
    const { hits, expansionQueries } = await this.retrieveSessionsForQuestion(
      question,
      factSessions,
    );
    const maxChars = this.options.maxSessionChars ?? DEFAULT_MAX_SESSION_CHARS;
    const retrieved = truncateText(
      hits.map((h) => truncateSession(h.text, maxChars)).join('\n\n'),
      this.options.maxAggregationChars ?? DEFAULT_MAX_AGGREGATION_CHARS,
    );
    // A derivation question (percentage/average/difference/min-max) needs a
    // prompt that identifies operands, not one that enumerates items; the
    // enumeration framing makes the model look for items to list, find none,
    // and abstain. Only the default path routes this way — a custom
    // `aggregationPrompt` (the MR ablation) must be used verbatim.
    const promptBuilder =
      this.options.aggregationPrompt === undefined &&
      classifyAggregationKind(question) === 'derivation'
        ? buildDerivationQaPrompt
        : (this.options.aggregationPrompt ?? buildAggregationQaPrompt);
    return this.respondWith(
      question,
      hits[0]?.score ?? 0,
      retrieved,
      promptBuilder,
      parseAggregationAnswer,
      expansionQueries,
      this.options.sessionAbstainThreshold,
    );
  }

  private async retrieveSessionsForQuestion(
    question: string,
    sessions: string[][],
  ): Promise<{ hits: SessionHit[]; expansionQueries: string[] }> {
    const sessionTopK = this.options.sessionTopK ?? DEFAULT_SESSION_TOP_K;
    const baseHits = await retrieveTopKSessions(
      this.options.embedding,
      question,
      sessions,
      sessionTopK,
    );
    const merged = new Map<string, SessionHit>();
    for (const hit of baseHits) {
      merged.set(hit.id, hit);
    }

    const expansionQueries = await this.expandQuestion(
      question,
      buildMultiSessionQueryExpansionPrompt,
    );
    if (expansionQueries.length > 0) {
      const perQueryK = this.options.queryExpansionTopKPerQuery ?? DEFAULT_QUERY_EXPANSION_TOP_K;
      const expandedHits = await retrieveByQueries(
        this.options.embedding,
        expansionQueries,
        sessions,
        perQueryK,
      );
      // Merge base and expanded hits, keeping the highest score per session.
      for (const hit of expandedHits) {
        const existing = merged.get(hit.id);
        if (!existing || hit.score > existing.score) {
          merged.set(hit.id, hit);
        }
      }
    }
    const hits = [...merged.values()].sort((a, b) => b.score - a.score);

    // Turn-level recall runs last and only ADDS sessions. Two properties make
    // this a clean, low-risk channel:
    //   1. Sessions already in hand are excluded before the cap, so the few
    //      slots this channel owns are never spent on duplicates.
    //   2. New sessions are APPENDED rather than merged by score. Turn cosines
    //      are systematically higher than centroid cosines, so re-sorting would
    //      promote an added session to hits[0] and silently move the abstention
    //      signal. Appending keeps hits[0] — and therefore abstention — exactly
    //      as the centroid channel produced it, so an A/B isolates the effect of
    //      the extra evidence instead of conflating it with a threshold shift.
    const turnRecall = this.options.turnRecallSessions ?? DEFAULT_TURN_RECALL_SESSIONS;
    if (turnRecall > 0) {
      const turnHits = await retrieveSessionsByTurns(
        this.options.embedding,
        [question, ...expansionQueries],
        sessions,
        this.options.turnRecallTurnsPerQuery ?? DEFAULT_TURN_RECALL_TURNS_PER_QUERY,
        turnRecall,
        new Set(merged.keys()),
      );
      hits.push(...turnHits);
    }
    return { hits, expansionQueries };
  }

  /**
   * Expand an abstract question into concrete phrases for targeted recall. The
   * single-session, temporal, and multi-session paths all use it, but each may
   * pass a different prompt builder: object phrases for general/MR recall and
   * event phrases (verb + object) for temporal recall. Returns [] when expansion
   * is disabled or the LLM produces no phrases.
   */
  private async expandQuestion(
    question: string,
    promptBuilder: (question: string) => string = buildQueryExpansionPrompt,
  ): Promise<string[]> {
    if (this.options.enableQueryExpansion === false) {
      return [];
    }
    const cache = this.options.queryExpansionCache;
    // The builder name distinguishes object-level expansion (general/MR) from
    // event-level expansion (temporal), which produce different phrases for the
    // same question.
    const cacheKey = `${promptBuilder.name}:${question}`;
    const cached = cache?.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const expansionRaw = await this.options.llm.complete(promptBuilder(question), {
      temperature: this.options.temperature ?? DEFAULT_TEMPERATURE,
    });
    const parsed = parseQueryExpansion(expansionRaw);
    cache?.set(cacheKey, parsed);
    return parsed;
  }

  private async respondWith(
    question: string,
    top1Score: number,
    retrieved: string,
    promptBuilder: PromptBuilder,
    parser: AnswerParser,
    expansionQueries: string[] = [],
    abstainThreshold?: number,
  ): Promise<Answer> {
    const abstentionEnabled = this.options.enableAbstention !== false;
    if (retrieved === '') {
      const answer = abstentionEnabled ? null : 'unknown';
      this.emitTrace(question, 0, answer === null, 'empty', {
        retrieved,
        answer,
        expansionQueries,
      });
      return answer;
    }
    if (abstentionEnabled && abstainThreshold != null && top1Score < abstainThreshold) {
      this.emitTrace(question, top1Score, true, 'threshold', {
        retrieved,
        answer: null,
        expansionQueries,
      });
      return null;
    }

    const prompt = promptBuilder(question, retrieved, this.options.abstainToken);
    const raw = await this.options.llm.complete(prompt, {
      temperature: this.options.temperature ?? DEFAULT_TEMPERATURE,
    });
    const parsed = parser(raw, this.options.abstainToken);
    if (parsed === null) {
      if (!abstentionEnabled) {
        this.emitTrace(question, top1Score, false, 'answered', {
          retrieved,
          llmRaw: raw,
          answer: 'unknown',
          expansionQueries,
        });
        return 'unknown';
      }
      this.emitTrace(question, top1Score, true, 'llm', {
        retrieved,
        llmRaw: raw,
        answer: null,
        expansionQueries,
      });
      return null;
    }
    this.emitTrace(question, top1Score, false, 'answered', {
      retrieved,
      llmRaw: raw,
      answer: parsed,
      expansionQueries,
    });
    return parsed;
  }

  private emitTrace(
    question: string,
    top1Score: number,
    abstained: boolean,
    reason: AbstainReason,
    extra: {
      retrieved?: string;
      llmRaw?: string;
      answer?: Answer;
      expansionQueries?: string[];
    },
  ): void {
    this.options.onDecision?.({ question, top1Score, abstained, reason, ...extra });
  }
}

/**
 * The Step 2 directive, reply shape, and length bound a chain-of-note prompt
 * commits the model to. The extractive reading prompts (QA and temporal) and the
 * generative preference prompt share the same two-step skeleton but need
 * DIFFERENT terminal contracts: an extracted answer is a fact already present in
 * the context, so the model must restate only what it identified, in a short
 * phrase; a recommendation is COMPOSED from those facts, so the model must be
 * allowed to build on them and to answer in a few sentences instead of a single
 * short phrase.
 */
interface AnswerContract {
  /** The Step 2 directive, placed after the shared silent Step 1. */
  step2: string;
  /** The lines pinning the exact shape of the reply. */
  reply: readonly string[];
  /** Longest unlabelled answer admitted before the runaway safety net fires. */
  maxUnlabelledChars: number;
}

/** Restate an identified fact as a single short phrase. */
const EXTRACTIVE_CONTRACT: AnswerContract = {
  step2: 'Step 2 — Answer the question using ONLY those identified facts.',
  reply: [
    'Your entire reply is one line in exactly this form, with nothing before or after it:',
    'Answer: <a word, name, number, or short phrase>',
  ],
  maxUnlabelledChars: 200,
};

/**
 * Compose a concrete recommendation from the identified preferences. The
 * extractive contract is wrong for preference questions: their ground truth
 * reads "the user would prefer responses that build upon ...", so "answer using
 * ONLY those identified facts" and "a word, name, number, or short phrase" both
 * tell the model to add nothing, which it reads as having nothing to say and
 * abstains. Measured on LongMemEval-S, the extractive contract pushed abstention
 * on the 29 single-session-preference questions from 3.45% to 21.84%.
 */
const RECOMMENDATION_CONTRACT: AnswerContract = {
  step2: 'Step 2 — Recommend something concrete that builds on those identified preferences.',
  reply: [
    'Your entire reply is one line in exactly this form, with nothing before or after it:',
    'Answer: <a specific recommendation, one to three sentences, naming the exact options>',
  ],
  maxUnlabelledChars: 400,
};

/**
 * Chain-of-Note (CoN) instruction shared by the single-session reading prompts.
 * LongMemEval's CP4 control point decomposes long-context reading into two
 * simpler subtasks — first pick out the relevant user details, then reason over
 * them — which the paper reports as up to +10 absolute points over a direct
 * read-and-answer prompt.
 *
 * Two halves of the wording are load-bearing, both added after the `7a349da`
 * benchmark showed the model writing out its Step 1 notes and never reaching
 * Step 2 on 7.5% of the diagnosed questions (up from 5.2% on `da4fe96`), which
 * leaked the entire narration — in one case 33 KB of self-talk — into the parsed
 * answer:
 *
 * 1. Step 1 must be SILENT. Asking the model to "identify" without saying so
 *    reads as an invitation to produce the notes, and a structured JSON context
 *    makes excerpting them nearly free, so the model stops there.
 * 2. The reply's shape is fixed to one `Answer:` line. Without an explicit
 *    terminal contract the model treats the notes themselves as the answer.
 *
 * Identifying first still forces the model to re-read each turn for the
 * question's signal before committing, which is what keeps an evidence turn from
 * being buried by semantically-close distractors. The extractive contract is the
 * default; `buildPreferencePrompt` passes the recommendation contract instead.
 */
function conInstruction(contract: AnswerContract = EXTRACTIVE_CONTRACT): string[] {
  return [
    'Work in two steps, but write ONLY the final answer.',
    '',
    "Step 1 — Silently read each turn and identify the user's facts, events, values, or preferences relevant to the question. Keep those notes to yourself; do NOT write them out.",
    contract.step2,
    '',
    ...contract.reply,
  ];
}

/**
 * Render a flat retrieved-context string (one "[date] role: content" turn per
 * line, as produced by `expandContextWindow`) as a JSON array of turn objects.
 * LongMemEval's CP4 reports that, combined with chain-of-note, a structured JSON
 * format helps the reader tell an evidence turn apart from semantically-close
 * distractors: each turn's date/role/content boundaries become explicit data
 * fields instead of prose. Turns that do not match the "[date] role:" shape are
 * preserved as a bare `content` object so no turn disappears.
 */
export function formatStructuredContext(context: string): string {
  if (context === '') {
    return '[]';
  }
  // Split on the start of a dated turn so a truncated turn's trailing
  // "[truncated]" line stays attached to its own turn instead of becoming a
  // separate item.
  const turns = context.split(/(?=\[\d{4}\/\d{2}\/\d{2})/).filter((t) => t.trim() !== '');
  const items = turns.map((turn) => {
    const dated = turn.match(/^\[(\d{4}\/\d{2}\/\d{2})[^\]]*\]\s*(user|assistant):\s*([\s\S]*)$/);
    if (dated) {
      return JSON.stringify({ date: dated[1]!, role: dated[2]!, content: dated[3]!.trim() });
    }
    const undated = turn.match(/^(user|assistant):\s*([\s\S]*)$/);
    if (undated) {
      return JSON.stringify({ role: undated[1]!, content: undated[2]!.trim() });
    }
    return JSON.stringify({ content: turn.trim() });
  });
  return `[${items.join(', ')}]`;
}

/** Build a grounded QA prompt with an explicit abstention instruction. */
export function buildQaPrompt(
  question: string,
  context: string,
  abstainToken: string = DEFAULT_ABSTAIN_TOKEN,
): string {
  return [
    'You are answering questions based on a conversation memory.',
    ...conInstruction(),
    '',
    'Answer with ONLY the answer phrase (a word, name, number, or short phrase), with no explanation.',
    'If the context offers more than one possible answer, choose the one that best matches the question (the most recent, the most specific, or the one matching any qualifier in the question). Choosing between candidates or combining several turns is NOT a reason to abstain.',
    `Respond with exactly "${abstainToken}" ONLY when the context offers no answer to the question at all.`,
    '',
    'Context (a JSON array of turns, each with date, role, and content):',
    formatStructuredContext(context),
    '',
    `Question: ${question}`,
    '',
    'Answer:',
  ].join('\n');
}

/**
 * Build a conservative QA prompt for abstention questions. Unlike the standard
 * `buildQaPrompt`, which tells the model to choose among candidates (the right
 * move for knowledge-update/extraction questions where the answer IS present but
 * requires selecting the latest/most-specific value), an abstention question's
 * correct answer is to recognize that no candidate exists. The looser wording
 * here preserves that recognition instead of pushing the model to invent an
 * answer from merely topically-related turns.
 */
export function buildConservativeQaPrompt(
  question: string,
  context: string,
  abstainToken: string = DEFAULT_ABSTAIN_TOKEN,
): string {
  return [
    'You are answering questions based on a conversation memory.',
    'Read the context carefully and extract the answer to the question.',
    'Answer with ONLY the answer phrase (a word, name, number, or short phrase), with no explanation.',
    `Respond with exactly "${abstainToken}" ONLY if the context contains no relevant information at all.`,
    '',
    'Context:',
    context,
    '',
    `Question: ${question}`,
    '',
    'Answer:',
  ].join('\n');
}

/**
 * Build a generative preference/recommendation prompt. Unlike the extractive QA
 * prompts, which ask for a single short fact and abstain when none is present,
 * preference questions ask for a suggestion that reflects the user's stated
 * preferences. The prompt therefore asks the model to (1) read the user's
 * stated brands/products/topics/styles, and (2) produce a concrete, specific
 * recommendation naming those options. Specificity is what the judge grades, so
 * a generic answer ("watch a documentary") loses to one that names the options
 * the user already expressed interest in.
 */
export function buildPreferencePrompt(
  question: string,
  context: string,
  abstainToken: string = DEFAULT_ABSTAIN_TOKEN,
): string {
  return [
    'You are answering a recommendation question based on a conversation memory.',
    ...conInstruction(RECOMMENDATION_CONTRACT),
    '',
    "In Step 1, identify the user's stated preferences, interests, constraints, and dislikes (for example specific brands, products, models, topics, or styles they mention).",
    'In Step 2, produce a CONCRETE, SPECIFIC recommendation or suggestion that directly reflects those preferences.',
    'Name the exact brands, products, topics, or options the user already expressed interest in; do not give a generic answer.',
    `Respond with exactly "${abstainToken}" ONLY if the context contains no information about the user's preferences at all.`,
    '',
    'Context (a JSON array of turns, each with date, role, and content):',
    formatStructuredContext(context),
    '',
    `Question: ${question}`,
    '',
    'Answer:',
  ].join('\n');
}

/**
 * Build a knowledge-update QA prompt. Knowledge-update questions are the one
 * case where the generic "choose the most recent" instruction is not enough: the
 * model must select the value a time qualifier points to, and it abstains or
 * picks the wrong version when both an old and a new value are present and the
 * mapping is left implicit. It therefore forces a two-step enumeration (list
 * every distinct value with its date, then pick the one matching the qualifier)
 * before answering, mirroring the multi-session CoT prompt's enumerate-then-act
 * pattern. Listing the old and new values side by side makes "previous" vs
 * "currently" unambiguous.
 *
 * Step 2 must also cover the question that states NO time qualifier, because
 * enumerate-then-select is unsatisfiable without one: the model lists values it
 * has no rule for choosing between, and the only terminal the prompt defined
 * was the abstain token. Measured on LongMemEval-S that shape is 47 of the 72
 * KU questions (65%), and it abstained at 14.89% against 4.00% for the
 * qualifier-carrying ones (z = 2.801), with 6.8 of every 7 such abstentions
 * holding the gold answer verbatim in the retrieved context. The
 * anti-abstention guardrails below mirror the ones `buildAggregationQaPrompt`
 * already uses to suppress the same failure mode on the MR path.
 */
export function buildKnowledgeUpdatePrompt(
  question: string,
  context: string,
  abstainToken: string = DEFAULT_ABSTAIN_TOKEN,
): string {
  return [
    'You are answering a knowledge-update question based on a conversation memory.',
    'Each turn is prefixed with its date in [YYYY/MM/DD] form; read them in chronological order.',
    'Work in two steps.',
    '',
    "Step 1 — Enumerate every DIFFERENT value the question's subject has had, one per line:",
    '  - <value> | <date>',
    '  - If the user updated a value, list BOTH the old and the new value with their dates.',
    '',
    'Step 2 — Pick the value to report:',
    '  - "previous", "before", "originally", "used to" → the EARLIER (older) value.',
    '  - "currently", "now", "most recent", "latest", "after updating" → the LATER (newer) value.',
    '  - "still", "same", or a Yes/No question → compare the turns and answer Yes or No.',
    // A "how long / how often / where / how much" question frequently states no
    // qualifier at all. Without this branch the model enumerates values it has
    // no rule for choosing between and falls through to the abstain token.
    '  - NO time qualifier at all → report the value as stated. When the subject had several values, report the one from the LATEST turn.',
    '',
    'Answer with ONLY the answer phrase (a word, name, number, Yes, or No), with no explanation.',
    `Respond with exactly "${abstainToken}" ONLY if the context offers no answer to the question at all.`,
    'A question that states NO time qualifier is NOT a reason to abstain: report the value as stated.',
    'Finding only ONE value for the subject is NOT a reason to abstain.',
    '',
    'Context:',
    context,
    '',
    `Question: ${question}`,
    '',
    'Answer:',
  ].join('\n');
}

/**
 * Build a bitemporal fact-extraction prompt. It asks the LLM only to REPORT the
 * question subject's (object, date) history as triples; the previous-vs-current
 * selection is then done deterministically by date order. Leaving that selection
 * to the LLM (as the CoT prompt does) is the exact failure mode this removes —
 * the model mis-maps "previous"/"currently" when both values are present.
 */
export function buildFactExtractionPrompt(question: string, context: string): string {
  return [
    'You are extracting the history of a knowledge-update fact from a conversation memory.',
    'Each turn is prefixed with its date in [YYYY/MM/DD] form.',
    'Identify the ONE subject the question asks about. Normalize its name to a short noun (e.g. "city", "occupation", "shampoo brand").',
    'For every DIFFERENT value that subject has had, report one fact with its date.',
    'Use the SAME normalized subject for every fact, even when the turns phrase it differently.',
    'Do NOT select, compare, or answer the question. Just list the (subject, object, date) triples in any order.',
    'If the subject has only one value, list that single fact.',
    '',
    'Example:',
    'Context:',
    '[2022/01/10] user: I live in Beijing.',
    '[2023/06/20] user: I moved to Shanghai.',
    'Question: What is my current city?',
    '{"facts": [{"subject": "city", "predicate": "resides_in", "object": "Beijing", "date": "2022/01/10"}, {"subject": "city", "predicate": "resides_in", "object": "Shanghai", "date": "2023/06/20"}]}',
    '',
    'Context:',
    context,
    '',
    `Question: ${question}`,
    '',
    'Respond with a JSON object.',
  ].join('\n');
}

/**
 * Build a temporal-reasoning QA prompt. It makes the turn date prefixes and the
 * question date explicit so the model can answer "how many days/weeks/months ago
 * or between" and "which happened first" by reading dates instead of guessing.
 */
export function buildTemporalQaPrompt(
  question: string,
  context: string,
  questionDate?: string,
  abstainToken: string = DEFAULT_ABSTAIN_TOKEN,
): string {
  const lines = [
    'You are answering a temporal-reasoning question based on a conversation memory.',
    'Each turn is prefixed with its date in [YYYY/MM/DD] form.',
    ...(questionDate
      ? [
          `The question was asked on ${questionDate}; use it as "today" for "how long ago" questions.`,
        ]
      : []),
    ...conInstruction(),
    '',
    'In Step 1, identify the relevant event turn(s) and their dates.',
    'In Step 2, compute the elapsed days/weeks/months or the event ordering from those dates, then answer with ONLY the final answer (a number, date, or short phrase).',
    `Respond with exactly "${abstainToken}" ONLY if the context contains no relevant information at all.`,
    '',
    'Context (a JSON array of turns, each with date, role, and content):',
    formatStructuredContext(context),
    '',
    `Question: ${question}`,
    '',
    'Answer:',
  ];
  return lines.join('\n');
}

/**
 * Build a temporal event-lookup prompt for questions whose answer is the entity
 * (event, person, object, place, or time) at a time anchor, not a computed
 * number. `buildTemporalQaPrompt` tells the model to "compute elapsed time or
 * event ordering", which is wrong for "What was the event two weeks ago?": the
 * model tries to compute a duration the question never asked for and abstains.
 * This prompt instead directs the model to locate the time-anchored turn(s) and
 * extract the entity, leaving any counting/arithmetic out of scope.
 */
export function buildTemporalEventLookupPrompt(
  question: string,
  context: string,
  questionDate?: string,
  abstainToken: string = DEFAULT_ABSTAIN_TOKEN,
): string {
  const lines = [
    'You are answering a temporal question based on a conversation memory.',
    'Each turn is prefixed with its date in [YYYY/MM/DD] form.',
    ...(questionDate
      ? [
          `The question was asked on ${questionDate}; use it as "today" for "ago", "last", and "recently" references.`,
        ]
      : []),
    ...conInstruction(),
    '',
    "In Step 1, identify the turn(s) the question's time qualifier points to and the entity each states.",
    'In Step 2, extract the event, person, object, place, or value the question asks about.',
    'Do NOT count, compute elapsed time, or reorder events. Just report the entity the question asks for.',
    'Answer with ONLY the answer phrase (a word, name, number, or short phrase), with no explanation.',
    `Respond with exactly "${abstainToken}" ONLY if the context contains no relevant information at all.`,
    '',
    'Context (a JSON array of turns, each with date, role, and content):',
    formatStructuredContext(context),
    '',
    `Question: ${question}`,
    '',
    'Answer:',
  ];
  return lines.join('\n');
}

/**
 * Build a temporal event-extraction prompt. Unlike `buildTemporalQaPrompt`,
 * which asks the LLM to read dates AND compute elapsed time (the failure mode
 * the deterministic engine removes), this prompt asks the LLM only to identify
 * the question's event(s) and COPY their evidence-turn dates. The arithmetic is
 * then performed deterministically by `computeTemporalAnswer`, so the LLM's
 * arithmetic ability never affects the result.
 *
 * `eventHints` carries the event phrases already produced by query expansion,
 * so the LLM does not re-derive which events the question refers to — it only
 * has to locate each hint's evidence turn and copy that turn's date. A short
 * worked example anchors the input→output mapping.
 */
export function buildTemporalEventExtractionPrompt(
  question: string,
  context: string,
  questionDate?: string,
  eventHints: readonly string[] = [],
  kind?: TemporalKind,
): string {
  // For ordering questions the expansion phrases are generic verbs ("took trip",
  // "flew with airline") repeated once per event; passing them as hints makes the
  // model copy that generic wording instead of the specific event names (Muir
  // Woods day hike, JetBlue) that only appear in the context. Suppress the hints
  // and instead ask the model to name each event from its evidence turn.
  const isOrdering = kind === 'ordering';
  const hintLines =
    !isOrdering && eventHints.length > 0
      ? [
          '',
          'The question likely refers to these event(s):',
          ...eventHints.map((hint) => `- ${hint}`),
          "For each listed event, find its evidence turn in the Context and copy that turn's date as YYYY/MM/DD.",
          'If a listed event cannot be found in the Context, omit it.',
        ]
      : [];
  const orderingLines = isOrdering
    ? [
        '',
        'This is an ORDERING question: identify EVERY event the question asks to order.',
        'Use each event\'s SPECIFIC name exactly as it appears in the Context (e.g. "Muir Woods day hike", "JetBlue flight"), never a generic phrase like "took trip" or "flew with airline".',
        "Copy each event's date from its evidence turn as YYYY/MM/DD.",
      ]
    : [];
  const example = isOrdering
    ? [
        'Example:',
        'Context:',
        '[2023/03/05] user: I went on a day hike to Muir Woods National Monument.',
        '[2023/04/10] user: I went on a road trip to Big Sur.',
        '[2023/05/20] user: I started a solo camping trip to Yosemite.',
        'Question: What is the order of the three trips I took?',
        '{"events": [{"name": "Muir Woods day hike", "date": "2023/03/05"}, {"name": "Big Sur road trip", "date": "2023/04/10"}, {"name": "Yosemite camping trip", "date": "2023/05/20"}]}',
      ]
    : [
        'Example:',
        'Context:',
        '[2023/01/08] user: I visited the Museum of Modern Art.',
        '[2023/01/15] user: I went to the Ancient Civilizations exhibit.',
        'Question: How many days passed between my visit to MoMA and the Ancient Civilizations exhibit?',
        '{"events": [{"name": "visit Museum of Modern Art", "date": "2023/01/08"}, {"name": "visit Ancient Civilizations exhibit", "date": "2023/01/15"}]}',
      ];
  return [
    'You are extracting event dates from a conversation memory to answer a temporal question.',
    'Each turn is prefixed with its date in [YYYY/MM/DD] form.',
    ...(questionDate ? [`The question was asked on ${questionDate}.`] : []),
    ...hintLines,
    ...orderingLines,
    'Identify the event(s) the question asks about. For each event, report its date.',
    'An event date may be stated absolutely (the [YYYY/MM/DD] turn prefix) or relative to the question date ("a month ago", "two weeks before", "3 days ago").',
    'When a turn states an event relative to the question date, report that relative time VERBATIM as the date (e.g. "a month ago", "two weeks before"). Do NOT convert it to an absolute date; exact date arithmetic converts it later.',
    "If you cannot determine an event's date, omit that event entirely rather than guessing.",
    'Do NOT compute elapsed time, reorder events, or convert relative times to absolute dates. Just report each event name and its date (absolute or verbatim relative).',
    'If the question refers to multiple events, list each one as a separate item.',
    '',
    ...example,
    '',
    'Context:',
    context,
    '',
    `Question: ${question}`,
    '',
    'Respond with a JSON object.',
  ].join('\n');
}

/**
 * Build a multi-session aggregation prompt. Unlike single-session extraction,
 * this forces the LLM to enumerate every matching item with its exact action
 * BEFORE counting. The enumeration serves two purposes: it prevents the common
 * failure mode of collapsing an "exchange" (return the old item AND pick up the
 * replacement) into a single item, and it makes verb precision explicit so the
 * model does not substitute a related-but-different action (e.g. "participated"
 * for "led"). The enumeration is parsed back into a final answer by
 * `parseAggregationAnswer`.
 *
 * The abstention boundary is load-bearing: measured on LongMemEval-S, 53% of the
 * wrong multi-session answers are LLM abstentions, and 15 of those 20 have every
 * evidence session already retrieved. The model reads the facts but abstains on
 * questions whose answer must be DERIVED (an average, percentage, sum,
 * difference, or elapsed time) or combined across sessions, so the prompt names
 * those cases and forbids treating them as an abstention.
 */
export function buildAggregationQaPrompt(
  question: string,
  context: string,
  abstainToken: string = DEFAULT_ABSTAIN_TOKEN,
): string {
  return [
    'You are answering a question based on MULTIPLE conversation sessions.',
    'The answer may require combining information spread across several sessions.',
    'Read ALL context carefully.',
    '',
    'Work in two steps.',
    '',
    "Step 1 — Enumerate every item matching the question's EXACT action, one per line:",
    '  - <item> | <exact action verb from the question> | <session date>',
    '  - Do NOT substitute or infer a different verb: for example "participated", "presented", "planned", and "working on" are NOT "led" or "leading".',
    '  - Treat an "exchange" as TWO items: return the old item AND pick up the replacement.',
    '  - Count the same event mentioned in multiple sessions only once.',
    '',
    'Step 2 — Compute the final answer exactly as the question asks (do NOT re-filter or exclude any of them):',
    '  - "how many distinct X" → count the distinct items.',
    '  - "how many hours/days/weeks/months in total" → sum the durations, NOT the item count.',
    '  - "how much money in total" → sum the amounts.',
    '  - "what time / which happened first / which event" → report that value or event, NOT a count.',
    'End your response with a single line in the exact form:',
    '  Answer: <final answer>',
    '',
    `Respond with exactly "${abstainToken}" ONLY if the context contains no relevant information at all.`,
    'Combining facts across several sessions is NOT a reason to abstain.',
    'If the answer can be computed from facts already in the context — a sum, a difference, an average, a percentage, an elapsed time, or a date read from the context — compute it. Needing to derive the answer is NOT a reason to abstain.',
    '',
    'Context:',
    context,
    '',
    `Question: ${question}`,
    '',
    'Answer:',
  ].join('\n');
}

/**
 * How a multi-session question should be answered. Enumeration questions ask
 * the model to list every matching item and count/sum them; derivation questions
 * ask it to compute a value (a percentage, average, difference, min/max) from a
 * few specific numbers. They need different prompts: "enumerate every item" is
 * wrong for a derivation question, where the model then looks for items to list,
 * finds none, and abstains.
 */
export type AggregationKind = 'derivation' | 'enumeration';

/** Decide which aggregation prompt a multi-session question should use. */
export function classifyAggregationKind(question: string): AggregationKind {
  // The derivation set is the load-bearing complement of the enumeration
  // prompt: every pattern here is a question whose answer is a COMPUTED value
  // (a difference, ratio, average, elapsed time, or future age) that the
  // enumeration prompt's "sum / count" Step 2 cannot express. Routing such a
  // question to enumeration makes the model look for items to list, find none
  // equal to the answer, and abstain even when every operand is in the context.
  // Each addition below corresponds to a measured LongMemEval-S abstention
  // (see the MR aggregation audit): a duration difference, an age difference,
  // a future age, and a difference-by-margin.
  if (
    /\b(percentage|percent|average|mean|difference (?:in|between)|how much (?:more|less|faster|earlier|older)|increase in|decrease in|discount|cashback|minimum|maximum|how old was|how long (?:have|has) [a-z]+ been|how many (?:years|months|weeks|days) older|how many (?:years|months) (?:old )?will [a-z]+ be when|exceed [\w ]+? by)\b/i.test(
      question,
    )
  ) {
    return 'derivation';
  }
  return 'enumeration';
}

/**
 * Build a multi-session derivation prompt for questions whose answer is a value
 * computed from specific numbers (a percentage, average, difference, or
 * min/max) rather than an enumeration. It mirrors the aggregation prompt's
 * two-step CoN skeleton and abstention boundary, but Step 1 asks the model to
 * identify the OPERANDS (the few numbers the question compares or combines)
 * instead of enumerating items, and Step 2 spells out the arithmetic the
 * question implies.
 */
export function buildDerivationQaPrompt(
  question: string,
  context: string,
  abstainToken: string = DEFAULT_ABSTAIN_TOKEN,
): string {
  return [
    'You are answering a question based on MULTIPLE conversation sessions.',
    'The answer is a value COMPUTED from specific numbers in the context.',
    'Read ALL context carefully.',
    '',
    'Work in two steps.',
    '',
    'Step 1 — Identify the specific numbers the question needs, one per line:',
    '  - <what the number means> | <the number>',
    '  - Identify ONLY the numbers this question compares or combines; ignore unrelated amounts, dates, and counts.',
    '',
    'Step 2 — Compute the final answer from those identified numbers:',
    '  - "what percentage" → part ÷ whole × 100.',
    '  - "average" → sum of the values ÷ number of values.',
    '  - "how much more/older/faster/earlier" or "how many years older/younger" → larger − smaller.',
    '  - "how long have I been [in/at/working] X" → total tenure − time spent before X.',
    '  - "how many years will I be when X happens" → current age + years until X.',
    '  - "how many … did I exceed … by" → actual − target.',
    '  - "minimum/maximum" → the smallest/largest identified value.',
    '  - "discount/cashback" → the percentage or amount the context states.',
    'End your response with a single line in the exact form:',
    '  Answer: <final answer>',
    '',
    `Respond with exactly "${abstainToken}" ONLY if the context contains no relevant information at all.`,
    'Combining facts across several sessions is NOT a reason to abstain.',
    'If the answer can be computed from numbers already in the context, compute it. Needing to derive the answer is NOT a reason to abstain.',
    '',
    'Context:',
    context,
    '',
    `Question: ${question}`,
    '',
    'Answer:',
  ].join('\n');
}

/**
 * Legacy multi-session aggregation prompt: the pre-CoT inline-counting rules.
 * Unlike `buildAggregationQaPrompt`, it does not force step-by-step enumeration,
 * so the model collapses an "exchange" (return + pick-up) into one item and can
 * over-infer a related verb ("participated" as "led"). It is kept only as the
 * baseline for the MR aggregation ablation so the CoT prompt's contribution can
 * be measured against the exact behavior it replaced.
 */
export function buildLegacyAggregationQaPrompt(
  question: string,
  context: string,
  abstainToken: string = DEFAULT_ABSTAIN_TOKEN,
): string {
  return [
    'You are answering a question based on MULTIPLE conversation sessions.',
    'The answer may require combining information spread across several sessions.',
    'Read ALL context carefully.',
    '',
    'Counting rules:',
    '- Identify the EXACT action the question asks about (e.g. "led" vs "participated"; "pick up" vs "return").',
    '- Count ONLY items matching that exact action.',
    '- "exchange" means returning the old item AND picking up a replacement: count BOTH the return and the pick-up (TWO items total).',
    '- The same event mentioned multiple times counts only once.',
    '',
    'Identify EVERY relevant item, deduplicate, and compute the final answer.',
    'Answer with ONLY the final answer (a number, name, or short list), with no explanation.',
    `Respond with exactly "${abstainToken}" ONLY if the context contains no relevant information at all.`,
    '',
    'Context:',
    context,
    '',
    `Question: ${question}`,
    '',
    'Answer:',
  ].join('\n');
}

/**
 * Slice a string to at most `maxChars` UTF-16 code units without splitting a
 * surrogate pair. A naive slice can leave a lone high-surrogate code unit at the
 * boundary (when the cut lands between the two halves of an emoji or another
 * non-BMP character); JSON.stringify then emits it as a `\uD800`-style escape
 * that a lenient provider parser rejects as "unexpected end of hex escape".
 */
function sliceCodePointSafe(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  let end = maxChars;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return text.slice(0, end);
}

/** Bound a session's length so aggregation injects signal without overflowing. */
export function truncateText(text: string, maxChars: number): string {
  const sliced = sliceCodePointSafe(text, maxChars);
  return sliced.length < text.length ? `${sliced}\n[truncated]` : sliced;
}

/** Matches the start of a `[date] role:` turn prefix. */
const TURN_BOUNDARY = /(?=\[\d{4}\/\d{2}\/\d{2}[^\]]*\] )/;

/** Cap for a verbose assistant turn when a session exceeds its budget. */
const ASSISTANT_HEAD_CHARS = 200;

/**
 * Bound a session's length while preserving user turns, which carry the facts.
 * Simple character truncation can drop later user turns (where dispersed evidence
 * such as an exchanged item lives) because a long assistant reply consumes the
 * budget first. This keeps every user turn complete and caps assistant turns.
 */
export function truncateSession(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const turns = text.split(TURN_BOUNDARY).filter((s) => s.length > 0);
  const kept: string[] = [];
  let used = 0;
  let truncated = false;
  for (const turn of turns) {
    if (/\] user:/.test(turn)) {
      if (used + turn.length > maxChars) {
        truncated = true;
        break;
      }
      kept.push(turn);
      used += turn.length;
    } else {
      const head = sliceCodePointSafe(turn, ASSISTANT_HEAD_CHARS);
      if (head.length < turn.length) {
        truncated = true;
      }
      kept.push(head);
      used += head.length;
    }
  }
  return truncated ? `${kept.join('')}\n[truncated]` : kept.join('');
}

/**
 * Build a query-expansion prompt that asks the LLM to turn an abstract question
 * into the concrete object names whose mention would be evidence for the answer.
 * The expanded phrases are used for targeted recall of dispersed evidence
 * sessions. Emphasizing specific objects (not verbs or categories) is what
 * recovers sessions about e.g. "boots" from a question about "clothing".
 */
export function buildQueryExpansionPrompt(question: string): string {
  return [
    'You are helping retrieve evidence from a conversation memory.',
    'Given a question, list the SPECIFIC CONCRETE PHRASES whose wording would appear in the evidence for the answer.',
    'For a question about a property of an entity (name, breed, speed, brand, occupation, time, place, amount), phrase the entity TOGETHER with that property.',
    'Do NOT list a bare category noun ("cat", "dog", "game", "shampoo") without its property; the bare noun also matches unrelated turns about the same entity.',
    'Do NOT invent names, titles, or terms that are not stated in the question; the evidence names the specific thing, not you.',
    'Output ONLY a comma-separated list of short phrases, with no explanation and no numbering.',
    '',
    'Example:',
    'Question: What is the name of my cat?',
    "name of the cat, my cat's name",
    '',
    `Question: ${question}`,
    '',
    'Specific items:',
  ].join('\n');
}

/**
 * Temporal questions ask WHEN an event happened, so the answer turn must be
 * matched by the event itself (action verb + object + distinguishing detail),
 * not by a bare object noun that also occurs in unrelated turns about the same
 * object. Event-level phrases recover the specific "receive the chandelier from
 * my aunt" turn instead of the "research the chandelier's history" distractor.
 */
export function buildTemporalQueryExpansionPrompt(question: string): string {
  return [
    'You are helping retrieve the evidence event for a temporal question.',
    'Given a question about WHEN something happened, list the SPECIFIC EVENT descriptions whose wording would appear in the evidence turn.',
    'Each event is a short phrase combining the action verb and the object (and any distinguishing detail).',
    'Do NOT list bare object nouns; include the verb so the correct event is matched instead of another mention of the same object.',
    'Output ONLY a comma-separated list of short event phrases, with no explanation and no numbering.',
    '',
    `Question: ${question}`,
    '',
    'Specific events:',
  ].join('\n');
}

/**
 * Multi-session query expansion. A multi-session question counts or aggregates
 * past ACTIVITIES ("how many projects did I lead", "how many workshops did I
 * attend"), and its evidence sessions are recalled by the activity, not by a
 * bare object noun that also appears in unrelated sessions about the same
 * object. Activity-level phrases ("led a consumer-research project", "attended a
 * machine-learning workshop") therefore recover the specific evidence session
 * instead of the distractors that a bare noun ("projects", "workshops") pulls in.
 */
export function buildMultiSessionQueryExpansionPrompt(question: string): string {
  return [
    'You are helping retrieve evidence sessions for a multi-session question.',
    'Given a question about counting or aggregating past activities, list the SPECIFIC ACTIVITIES whose descriptions would appear in the evidence sessions.',
    'Each activity is a short phrase combining an action and its object (and any distinguishing detail).',
    'Do NOT list bare object nouns; include the action so the correct session is matched instead of another mention of the same object.',
    'Output ONLY a comma-separated list of short activity phrases, with no explanation and no numbering.',
    '',
    `Question: ${question}`,
    '',
    'Specific activities:',
  ].join('\n');
}

/** Parse a comma/newline/semicolon-separated list of phrases into a clean list. */
export function parseQueryExpansion(raw: string): string[] {
  return raw
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse the LLM response; returns null when it abstains or returns empty.
 *
 * The single-session prompts now carry a chain-of-note instruction, so the model
 * may narrate its two steps and finish with an `Answer:` line. Prefer that
 * labelled line (the canonical final answer) and fall back to the whole response
 * only when no label is present, which keeps the pre-CoN "bare phrase" answers
 * working unchanged.
 *
 * `maxUnlabelledChars` bounds the narration safety net. Extractive answers are a
 * word, a name, a number, or a short phrase, so they get the tight default; a
 * generative recommendation may run a few sentences and passes a wider bound via
 * `parseRecommendationAnswer`.
 */
export function parseQaAnswer(
  raw: string,
  abstainToken: string = DEFAULT_ABSTAIN_TOKEN,
  maxUnlabelledChars: number = EXTRACTIVE_CONTRACT.maxUnlabelledChars,
): Answer {
  const trimmed = raw.trim();
  if (trimmed === '' || isAbstentionValue(trimmed, abstainToken)) {
    return null;
  }
  const labelled = trimmed.match(/(?:^|\n)\s*(?:answer|final answer)\s*:\s*(.+?)\s*$/im);
  const candidate = labelled ? labelled[1]!.trim() : trimNarration(trimmed, maxUnlabelledChars);
  if (candidate === '' || isAbstentionValue(candidate, abstainToken)) {
    return null;
  }
  return stripWrappingQuotes(candidate);
}

/**
 * Parse a generative recommendation response. Identical to `parseQaAnswer` except
 * that the narration safety net admits up to `RECOMMENDATION_CONTRACT`'s wider
 * bound: a 1–3 sentence recommendation legitimately exceeds the extractive
 * 200-character cap, and the net exists to stop a runaway generation, not to
 * truncate a good answer.
 */
export function parseRecommendationAnswer(
  raw: string,
  abstainToken: string = DEFAULT_ABSTAIN_TOKEN,
): Answer {
  return parseQaAnswer(raw, abstainToken, RECOMMENDATION_CONTRACT.maxUnlabelledChars);
}

/**
 * Safety net for a reply that ignored the CoN output contract and wrote its
 * Step 1 notes out. The scaffolding lines — step headers, markdown headings,
 * bullets, ordered items — are dropped so the model's concluding sentence becomes
 * the answer, and a runaway generation is capped at a sentence boundary.
 *
 * The prompt-side contract in `conInstruction` is the actual fix; this only limits
 * the damage when the model ignores it. Measured on the `7a349da` run it recovers
 * little: of the 33 leaked responses only 4 contain the ground truth verbatim, and
 * 3 of those 4 carry it in prose (recoverable here) rather than in the notes.
 *
 * When stripping leaves nothing but scaffolding the ORIGINAL (capped) text is
 * returned rather than abstaining, because the one remaining ground truth does
 * live inside a bullet. The cap bounds the cost of that fallback: the production
 * leak it replaces ran to 33,504 characters of self-talk, which the judge cannot
 * grade and the diagnostics artifact cannot usefully store.
 */
function trimNarration(text: string, maxUnlabelledChars: number): string {
  const prose = text
    .split(/\r?\n/)
    .filter((line) => !isNoteLine(line))
    .join('\n')
    .trim();
  // When every line is scaffolding there is no prose to rescue, so fall back to
  // the capped original rather than answering with nothing.
  return capNarrationLength(prose === '' ? text : prose, maxUnlabelledChars);
}

/** True for a scaffolding line of a chain-of-note narration. */
function isNoteLine(line: string): boolean {
  const l = line.trim();
  return (
    l !== '' &&
    (/^\*{0,2}step\s*\d/i.test(l) ||
      /^#{1,6}\s/.test(l) ||
      /^[-*•]\s/.test(l) ||
      /^\d+[.)]\s/.test(l))
  );
}

/**
 * Cut an over-long answer back to its FIRST sentence.
 *
 * The first sentence, not the last: a runaway generation restates and then
 * second-guesses itself (`... the answer is a tie. Alternatively ...`), so the
 * earliest sentence is the closest thing to an answer the model produced before
 * it started talking to itself.
 */
function capNarrationLength(text: string, maxUnlabelledChars: number): string {
  if (text.length <= maxUnlabelledChars) {
    return text;
  }
  const head = text.slice(0, maxUnlabelledChars);
  const boundaries = ['. ', '.\n', '? ', '! ']
    .map((marker) => head.indexOf(marker))
    .filter((index) => index > 0);
  const cut = boundaries.length > 0 ? Math.min(...boundaries) : -1;
  return cut > 0 ? head.slice(0, cut + 1).trim() : head.trim();
}

/**
 * Parse the aggregation response produced by `buildAggregationQaPrompt`. It
 * prefers the explicit `Answer:` label (the prompt's canonical final answer),
 * then falls back to the last non-empty line. The intermediate `Count:` line is
 * deliberately ignored because the prompt can emit it as part of the step-2
 * narration before the final `Answer:` line; matching `Count:` first would leak
 * the verbose narration into the extracted answer. If the last line is an
 * evidence bullet (the model never wrote a final answer), it abstains rather
 * than mistaking an item for the answer.
 */
export function parseAggregationAnswer(
  raw: string,
  abstainToken: string = DEFAULT_ABSTAIN_TOKEN,
): Answer {
  const trimmed = raw.trim();
  if (trimmed === '' || isAbstentionValue(trimmed, abstainToken)) {
    return null;
  }
  const labelled = trimmed.match(/(?:^|\n)\s*(?:answer|final answer)\s*:\s*(.+?)\s*$/im);
  const candidate = labelled ? labelled[1]!.trim() : lastNonEmptyLine(trimmed);
  if (candidate === '' || isAbstentionValue(candidate, abstainToken)) {
    return null;
  }
  return stripWrappingQuotes(candidate);
}

/** True when a value is the abstention marker, with or without wrapping quotes. */
function isAbstentionValue(s: string, abstainToken: string): boolean {
  return stripWrappingQuotes(s).toUpperCase() === abstainToken.toUpperCase();
}

/** Return the last non-empty line, or '' when it looks like an evidence bullet. */
function lastNonEmptyLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  return last && !/^[-*•]/.test(last) ? last : '';
}

/** Remove one layer of surrounding single/double quotes. */
function stripWrappingQuotes(s: string): string {
  return s.replace(/^["']+|["']+$/g, '');
}

/**
 * True when a `turnText`-rendered turn is a user statement. Facts live in user
 * turns (the user narrates their life events); assistant turns are verbose
 * generated responses that dilute retrieval, so the single-session path indexes
 * only user turns. The role follows an optional `[date]` prefix.
 */
export function isUserTurn(turn: string): boolean {
  return /(?:^|\]\s*)user:/.test(turn);
}

/**
 * True when a `turnText`-rendered turn is an assistant reply. Assistant turns
 * are verbose generated responses; for multi-session aggregation questions the
 * answer facts live exclusively in user turns, so assistant turns are removed
 * before retrieval to keep the session centroid and the injected context clean.
 * Turns WITHOUT a role prefix are kept (they carry no assistant marker), which
 * also preserves the plain-text turns used by unit tests and synthetic inputs.
 */
export function isAssistantTurn(turn: string): boolean {
  return /(?:^|\]\s*)assistant:/.test(turn);
}
