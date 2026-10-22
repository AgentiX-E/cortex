/**
 * The output side: a draft answer is checked before anyone sees it.
 *
 * ## Why this exists, stated as a failure
 *
 * Everything up to here protects the *stores*. None of it protects the *sentence a model writes*.
 * A reader in a shared task can restate a private fact it saw five turns ago, or one it learned
 * from a weight, and no amount of care at the write boundary changes that: the fact is not in the
 * window, it is in the answer. `docs/02` section 6.3 called this the one uncovered leak surface and
 * left it there; this file is the cheap half of closing it.
 *
 * ## Two checks, and what each one can actually claim
 *
 * **O1, scope scan.** The same rule table the write path uses is run over the draft. A private rule
 * firing in a *shared* task is a finding. Using one table for both is the point: "may this be
 * stored" and "may this be said" are the same policy question, and two tables would drift apart
 * precisely where nobody looks.
 *
 * **O2, attribution.** A citation that does not resolve to a row in the window is a claim with no
 * source, which in a shared answer is worse than no claim at all. A shared draft with no citations
 * at all is flagged too -- not because prose must be footnoted, but because "here is what the team
 * knows" without a single source is unfalsifiable.
 *
 * ## What it cannot do, in the same breath
 *
 * Paraphrase. "My card ends in 4111" is not "my card number is 4111", and neither O1 nor a citation
 * check will catch the former. So the claim this layer supports is **"some leaks are stopped"**,
 * never "leaks are stopped". `[POC-5]`'s numbers are about stores; they say nothing about here, and
 * quoting them as if they did would be the exact substitution this project keeps catching.
 *
 * ## The one idea that makes O1 usable rather than annoying
 *
 * A shared answer may legitimately quote a shared fact -- including one that mentions money. So a
 * finding is **excused** when the window contains a shared row whose text says the same thing. The
 * guard does not get to have an opinion about whether a sentence is safe; it asks whether the write
 * side already decided, and shows its work either way. Without that, the first draft that says "we
 * agreed the budget" over a shared budget fact would be blocked, someone would turn the guard off,
 * and the layer would be gone.
 */

import type { ScopedRow } from '../federation/federated-storage.js';
import type { TaskScope } from '../federation/read-side.js';
import { RULE_TABLE, type TriageRule } from './rules.js';

/** What a check objected to. Each kind is a different instruction to the reader. */
export type FindingKind = 'private-scope' | 'never-retained' | 'unknown-citation' | 'unattributed';

export type OutputFinding = {
  kind: FindingKind;
  /** The rule that produced the finding, or `null` for the attribution checks. */
  rule: string | null;
  policy: string | null;
  /** The text that tripped the rule, trimmed to a readable length. */
  excerpt: string;
  /** Byte offsets in the draft, so a caller can highlight rather than describe. */
  span: readonly [number, number];
  /**
   * Set when an allowed row already says this, naming that row.
   *
   * An excused finding is kept in the report: the reader is entitled to see that a sentence looks
   * like a scope violation and why it is not one, and a guard whose reasoning is invisible is a
   * guard people learn to route around.
   */
  excusedBy?: string;
};

export type OutputScan = {
  /** `blocked` when at least one finding is unexcused. */
  readonly verdict: 'clear' | 'blocked';
  readonly findings: readonly OutputFinding[];
};

export type OutputScanRequest = {
  task: TaskScope;
  /**
   * The window the draft was supposed to be written from.
   *
   * Optional, and its absence is not neutral: without it no finding can be excused, so a shared
   * draft that quotes a shared fact will be blocked. That is the correct default for a caller that
   * has no window (nothing to appeal to) and a loud one for a caller that forgot.
   */
  window?: readonly ScopedRow[];
  /**
   * Whether a shared draft must cite anything. Defaults to `true` for a shared task: an answer
   * about what a team knows, with no source, is unfalsifiable by the person reading it.
   */
  requireCitation?: boolean;
};

/** How a citation is written. Deliberately unlikely to occur in prose. */
const CITATION = /\[\[([^\]]+)\]\]/g;

/** How much of a match is quoted back. Enough to recognise, short enough to read. */
const EXCERPT_LIMIT = 120;

export class OutputGuard {
  private readonly rules: readonly TriageRule[];

  constructor(rules: readonly TriageRule[] = RULE_TABLE) {
    this.rules = rules;
  }

  /**
   * Scan a draft against the rules and the window it was built from.
   *
   * `task: 'private'` drops the scope findings, because a private answer repeating the user's own
   * facts is the product working. It keeps `never-retained` findings: a credential is not echoed
   * back even to its owner, because the draft is stored, logged and pasted, and none of those are
   * the owner.
   */
  scan(draft: string, request: OutputScanRequest): OutputScan {
    const findings: OutputFinding[] = [];

    for (const rule of this.rules) {
      if (rule.scope !== 'private') continue;
      const match = this.firstMatch(rule, draft);
      if (match === null) continue;

      const never = rule.retention === 'never';
      if (!never && request.task === 'private') continue;

      // The unit a person has to look at is the sentence, not the token that matched: the money
      // rule fires on "spent", and "this answer contains: spent" tells a reader nothing.
      const span = sentenceAround(draft, match);
      const finding: OutputFinding = {
        kind: never ? 'never-retained' : 'private-scope',
        rule: rule.id,
        policy: rule.policy,
        excerpt: excerptOf(draft, span),
        span,
        ...(never ? {} : this.excuse(span, draft, request.window)),
      };
      findings.push(finding);
    }

    findings.push(...this.attribution(draft, request));

    return {
      verdict: findings.some((finding) => finding.excusedBy === undefined) ? 'blocked' : 'clear',
      findings,
    };
  }

  /** The first match of one rule, as offsets. A copy is used: `test()` is stateful on `/g`. */
  private firstMatch(rule: TriageRule, draft: string): [number, number] | null {
    const global = new RegExp(rule.pattern.source, `${rule.pattern.flags}g`);
    const match = global.exec(draft);
    if (match === null) return null;
    return [match.index, match.index + match[0].length];
  }

  /**
   * Whether an allowed shared row already says this, which turns a finding into a citation.
   *
   * The comparison is containment in the row's own text, not similarity: a guard that guessed would
   * either excuse too much (and stop being a guard) or too little (and be turned off).
   */
  private excuse(
    span: readonly [number, number],
    draft: string,
    window: readonly ScopedRow[] | undefined,
  ): { excusedBy?: string } {
    if (window === undefined) return {};
    const said = draft.slice(span[0], span[1]);
    for (const row of window) {
      if (row.origin !== 'shared') continue;
      const text = textOf(row.value);
      if (text !== undefined && text.includes(said)) return { excusedBy: row.key ?? '<no id>' };
    }
    return {};
  }

  /** O2: citations must resolve, and a shared answer must have at least one. */
  private attribution(draft: string, request: OutputScanRequest): OutputFinding[] {
    const findings: OutputFinding[] = [];
    const cited = new Set<string>();
    const known = new Set(
      (request.window ?? [])
        .map((row) => row.key)
        .filter((key): key is string => key !== undefined),
    );

    for (const match of draft.matchAll(CITATION)) {
      // `matchAll` always sets `index`; the type says it may be absent because `RegExp` and
      // `String.match` share the shape. Casting here keeps the dead `?? 0` arm out of the report
      // rather than leaving a branch nobody can execute.
      const at = match.index as number;
      // Group 1 always participates when the pattern matches (it requires one character); the
      // optional type is an artefact of the shared `RegExpMatchArray` shape.
      const id = (match[1] as string).trim();
      cited.add(id);
      if (known.has(id)) continue;
      findings.push({
        kind: 'unknown-citation',
        rule: null,
        policy: null,
        excerpt: id.slice(0, EXCERPT_LIMIT),
        span: [at, at + match[0].length],
      });
    }

    const required = request.requireCitation ?? request.task === 'shared';
    if (required && cited.size === 0) {
      findings.push({
        kind: 'unattributed',
        rule: null,
        policy: null,
        excerpt: '',
        span: [0, 0],
      });
    }
    return findings;
  }
}

/** The text a row carries, when it carries one. */
function textOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const text = (value as { text?: unknown }).text;
  return typeof text === 'string' ? text : undefined;
}

/**
 * Widen a match to the sentence that contains it.
 *
 * A colon counts as a boundary as well as the sentence terminators: "Here is what I remember: X" is
 * a lead-in followed by a claim, and treating the whole line as one unit would compare a shared row
 * against text that also contains the lead-in, so a legitimate quotation would stop being excusable.
 *
 * A newline does **not** count. Drafts wrap at eighty columns, so a line break inside a sentence is
 * an artefact of layout; treating it as a boundary would hand the reader a five-word excerpt and
 * nothing to judge. The excerpt collapses whitespace for the same reason.
 */
function sentenceAround(draft: string, [start, end]: readonly [number, number]): [number, number] {
  const isBoundary = (character: string | undefined): boolean =>
    character === undefined || character === '.' || character === '!' || character === '?';
  let left = start;
  while (left > 0 && !isBoundary(draft[left - 1])) left -= 1;
  let right = end;
  while (right < draft.length && !isBoundary(draft[right])) right += 1;
  // `charAt` rather than indexing: it returns '' outside the string, so the trim needs no `??`
  // whose undefined arm can never happen and would sit in the report as a branch nobody can take.
  while (left < right && /\s/.test(draft.charAt(left))) left += 1;
  while (right > left && /\s/.test(draft.charAt(right - 1))) right -= 1;
  return [left, right];
}

/** Clip a span to something a person can read in a dialog, without splitting a surrogate pair. */
function excerptOf(draft: string, [start, end]: readonly [number, number]): string {
  const raw = draft.slice(start, end).replace(/\s+/g, ' ').trim();
  if (raw.length <= EXCERPT_LIMIT) return raw;
  // `Array.from` splits by code point, so a clipped emoji does not become half a character.
  return `${Array.from(raw).slice(0, EXCERPT_LIMIT).join('')}…`;
}
