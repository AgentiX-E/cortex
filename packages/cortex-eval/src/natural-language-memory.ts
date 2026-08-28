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
import type { EmbeddingModel, LLM } from '@agentix-e/cortex-core';
import type { Answer, SessionAwareMemorySystem } from './types.js';
import {
  expandContextWindow,
  retrieveByQueries,
  retrieveTopKByQueries,
  retrieveTopKSessions,
  retrieveTurnsPerQuery,
  type RetrievalHit,
  type SessionHit,
} from './retrieval.js';
import {
  classifyTemporalQuestion,
  computeTemporalAnswer,
  type TemporalEvent,
  type TemporalKind,
} from './temporal-engine.js';
import { extractDate } from './temporal.js';

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
  /** Top sessions recalled per expansion phrase (default 3). */
  queryExpansionTopKPerQuery?: number;
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
   * deterministic path: each query-expansion event phrase is matched to its own
   * evidence turn by embedding similarity, the turn date is extracted, and the
   * temporal engine computes the elapsed time, interval, or ordering exactly.
   * Only when that path cannot produce an answer does it fall back to the LLM
   * date-reading prompt (the previous behaviour).
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
    );
    if (
      this.options.enableDeterministicTemporal !== false &&
      questionDate &&
      kind !== 'other' &&
      retrieved !== ''
    ) {
      const deterministic = await this.tryDeterministicTemporal(
        question,
        questionDate,
        kind,
        context,
        expansionQueries,
      );
      if (deterministic !== null) {
        return deterministic;
      }
    }
    const temporalPrompt: PromptBuilder = (q, c, t) => buildTemporalQaPrompt(q, c, questionDate, t);
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
   * Deterministic temporal answering: match each event phrase to its evidence
   * turn (by embedding similarity), extract the turn date, then compute the
   * answer with exact date arithmetic. Returns `null` to signal the caller to
   * fall back to the LLM temporal prompt (e.g. when no event turn carries a
   * date or the question cannot be answered deterministically).
   */
  private async tryDeterministicTemporal(
    question: string,
    questionDate: string,
    kind: TemporalKind,
    context: string[],
    expansionQueries: string[],
  ): Promise<Answer> {
    const factTurns = context.filter(isUserTurn);
    const searchable = (factTurns.length > 0 ? factTurns : context).map((turn) =>
      truncateText(turn, this.options.maxTurnChars ?? DEFAULT_MAX_TURN_CHARS),
    );
    const phrases = expansionQueries.length > 0 ? expansionQueries : [question];
    const perPhrase = await retrieveTurnsPerQuery(this.options.embedding, phrases, searchable, 1);

    const events: TemporalEvent[] = [];
    const matchedTurns: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < phrases.length; i++) {
      const hit = perPhrase[i]?.[0];
      if (!hit) {
        continue;
      }
      const date = extractDate(hit.text);
      if (!date) {
        continue;
      }
      if (seen.has(hit.id)) {
        continue;
      }
      seen.add(hit.id);
      events.push({ name: phrases[i]!, date });
      matchedTurns.push(hit.text);
    }

    const answer = computeTemporalAnswer(question, kind, questionDate, events);
    if (answer === null) {
      return null;
    }
    this.emitTrace(question, 0, false, 'answered', {
      retrieved: matchedTurns.join('\n'),
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
   * User-turn retrieval shared by `answer`, `answerAssistant`, and
   * `answerTemporal`. The temporal path passes an event-level expansion builder
   * because temporal questions ask WHEN an event happened, so the answer turn is
   * recalled by matching the event (verb + object), not a bare object noun that
   * also occurs in unrelated turns. `includeAssistant` selects all turns for the
   * `single-session-assistant` sub-type whose evidence is an assistant turn.
   */
  private async retrieveTurns(
    question: string,
    context: string[],
    includeAssistant: boolean = false,
    expansionPromptBuilder: (question: string) => string = buildQueryExpansionPrompt,
  ): Promise<{ hits: RetrievalHit[]; retrieved: string; expansionQueries: string[] }> {
    const topK = this.options.topK ?? DEFAULT_TOP_K;
    const factTurns = includeAssistant ? context : context.filter(isUserTurn);
    const searchable = (factTurns.length > 0 ? factTurns : context).map((turn) =>
      truncateText(turn, this.options.maxTurnChars ?? DEFAULT_MAX_TURN_CHARS),
    );
    const expansionQueries = await this.expandQuestion(question, expansionPromptBuilder);
    const hits = await retrieveTopKByQueries(
      this.options.embedding,
      [question, ...expansionQueries],
      searchable,
      topK,
    );
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
    const { hits, expansionQueries } = await this.retrieveSessionsForQuestion(question, sessions);
    const maxChars = this.options.maxSessionChars ?? DEFAULT_MAX_SESSION_CHARS;
    const retrieved = truncateText(
      hits.map((h) => truncateSession(h.text, maxChars)).join('\n\n'),
      this.options.maxAggregationChars ?? DEFAULT_MAX_AGGREGATION_CHARS,
    );
    return this.respondWith(
      question,
      hits[0]?.score ?? 0,
      retrieved,
      this.options.aggregationPrompt ?? buildAggregationQaPrompt,
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

    const expansionQueries = await this.expandQuestion(question);
    if (expansionQueries.length === 0) {
      return { hits: baseHits, expansionQueries: [] };
    }

    const perQueryK = this.options.queryExpansionTopKPerQuery ?? DEFAULT_QUERY_EXPANSION_TOP_K;
    const expandedHits = await retrieveByQueries(
      this.options.embedding,
      expansionQueries,
      sessions,
      perQueryK,
    );

    // Merge base and expanded hits, keeping the highest score per session.
    const merged = new Map<string, SessionHit>();
    for (const hit of [...baseHits, ...expandedHits]) {
      const existing = merged.get(hit.id);
      if (!existing || hit.score > existing.score) {
        merged.set(hit.id, hit);
      }
    }
    return {
      hits: [...merged.values()].sort((a, b) => b.score - a.score),
      expansionQueries,
    };
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
    const expansionRaw = await this.options.llm.complete(promptBuilder(question), {
      temperature: this.options.temperature ?? DEFAULT_TEMPERATURE,
    });
    return parseQueryExpansion(expansionRaw);
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

/** Build a grounded QA prompt with an explicit abstention instruction. */
export function buildQaPrompt(
  question: string,
  context: string,
  abstainToken: string = DEFAULT_ABSTAIN_TOKEN,
): string {
  return [
    'You are answering questions based on a conversation memory.',
    'Read the context carefully and extract the answer to the question.',
    'Answer with ONLY the answer phrase (a word, name, number, or short phrase), with no explanation.',
    'If the context offers more than one possible answer, choose the one that best matches the question (the most recent, the most specific, or the one matching any qualifier in the question). Choosing between candidates or combining several turns is NOT a reason to abstain.',
    `Respond with exactly "${abstainToken}" ONLY when the context offers no answer to the question at all.`,
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
    'To answer: identify the relevant event turn(s), read their dates, compute the elapsed days/weeks/months or the event ordering, then answer with ONLY the final answer (a number, date, or short phrase).',
    `Respond with exactly "${abstainToken}" ONLY if the context contains no relevant information at all.`,
    '',
    'Context:',
    context,
    '',
    `Question: ${question}`,
    '',
    'Answer:',
  ];
  return lines.join('\n');
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
    'Given a question, list the SPECIFIC CONCRETE OBJECTS or ITEMS whose names would appear in the evidence for the answer.',
    'List only specific named things (not verbs, not abstract categories).',
    'Output ONLY a comma-separated list of short noun phrases, with no explanation and no numbering.',
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

/** Parse a comma/newline/semicolon-separated list of phrases into a clean list. */
export function parseQueryExpansion(raw: string): string[] {
  return raw
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parse the LLM response; returns null when it abstains or returns empty. */
export function parseQaAnswer(raw: string, abstainToken: string = DEFAULT_ABSTAIN_TOKEN): Answer {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toUpperCase() === abstainToken.toUpperCase()) {
    return null;
  }
  return stripWrappingQuotes(trimmed);
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
