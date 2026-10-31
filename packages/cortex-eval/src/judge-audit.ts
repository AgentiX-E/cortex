/**
 * Whether the judge can tell a wrong answer from a right one, measured rather than assumed.
 *
 * ## The problem this instrument exists for
 *
 * Every accuracy number in this repository is the judge's opinion. `§10.1` compares arms by counting
 * questions the judge called correct, and the campaign's whole resolution — two or three questions on
 * a 121-question capability — is smaller than the judge's error if that error is large. The published
 * audit of LoCoMo's gold answers puts about 6.4% of them at risk of a scoring error and reports that
 * a standard judge (`gpt-4o-mini`, official prompt) **accepted 62.81% of answers that were topical but
 * wrong**. If this repository's judge behaves like that, every capability reading needs re-labelling,
 * not just the one under study.
 *
 * ## What is measured, and the two controls that make it a measurement
 *
 * The audited population is **answers the judge already accepted** (`correct === true` in an
 * artifact). Each one is perturbed in a way that keeps it on topic and makes it wrong by
 * construction, then re-submitted to the *same* judge with the *same* template:
 *
 *   number-swap   a number the gold states is replaced with a value that appears nowhere in the
 *                 conversation — "in 18 days" becomes "in 139 days".
 *   entity-swap   a capitalised entity the gold names is replaced with another real entity drawn
 *                 from the corpus that appears nowhere in this question's conversation.
 *   cross-gold    the answer is replaced outright by a different question's gold, of the same
 *                 capability. Topically adjacent, entirely wrong.
 *
 * Two invariants make a "yes" unambiguously a false accept, and both are asserted at plan time
 * rather than trusted:
 *
 *   1. The perturbed text no longer contains the gold answer.
 *   2. The token introduced appears **nowhere in the conversation**. A swapped entity that the user
 *      had actually mentioned could be another true fact about them, and then a "yes" would be right
 *      for a reason the instrument cannot see. Excluding it removes that explanation.
 *
 * Two controls run beside it, because a false-accept rate alone is meaningless — a judge that always
 * answers "no" scores zero:
 *
 *   accepted-original   the unperturbed answer, re-judged. It was accepted when the artifact was
 *                       produced, so a rejection here is **judge non-reproducibility**, and it prices
 *                       the noise floor this instrument is measuring against.
 *   rejected-gold-zero  a perturbation whose introduced token is *deleted* rather than replaced is
 *                       not used: deleting changes the shape of the sentence. Instead the third kind
 *                       (`cross-gold`) doubles as the topic-control, since it is wrong while staying
 *                       inside the question's subject.
 *
 * ## What this cannot say
 *
 * ## Why the types are not exported
 *
 * `AuditKind`, `AuditSource`, `AuditCase`, `AuditVerdict`, `AuditRate` and `AuditReading` are used in
 * this module and nowhere else: the tool that runs the audit is plain JavaScript, and the tests derive
 * the one type they need from `planAudit`'s own signature. `export` on them would advertise six
 * consumers that do not exist, which is the claim `tools/export-census.mjs` refuses — and the census
 * caught exactly that when they were first written.
 *
 * It measures one judge against one perturbation family. It does not measure the judge's agreement
 * with a human reader, and a low false-accept rate on substitutions does not transfer to answers that
 * are wrong by *omission* — a plausible half-answer. That gap is named here because the instrument
 * would otherwise read as a general statement about judging.
 */

/** How a wrong answer was manufactured. Each kind is a different failure the judge could have. */
type AuditKind = 'number-swap' | 'entity-swap' | 'cross-gold';

/** One question the audit can draw from: what was asked, what was right, what the model said. */
type AuditSource = {
  readonly questionId: string;
  readonly question: string;
  readonly gold: string;
  /** The whole conversation for this question, joined. Used only to prove a token is absent from it. */
  readonly conversation: string;
  /** What the model answered. The audit perturbs this, or replaces it, never the gold. */
  readonly answer: string;
  /**
   * The capability the question belongs to (`MR`, `TR`, `IE`, …), when the artifact records one.
   *
   * `cross-gold` prefers a neighbour from the same capability: several question types share a topic
   * by construction, and borrowing across them would make "topically adjacent" a claim about the
   * dataset rather than about the audit.
   */
  readonly capability?: string;
  /** The dataset question type, so the audit grades with the same template the artifact used. */
  readonly questionType?: string;
};

/** One planned audit case: an answer that is wrong by construction, with the reason it is wrong. */
type AuditCase = {
  readonly questionId: string;
  readonly kind: AuditKind;
  readonly question: string;
  /** The gold, for the judge to grade against. Unchanged by any perturbation. */
  readonly gold: string;
  /** The answer to submit. Wrong by construction; the invariants below are asserted when it is built. */
  readonly answer: string;
  /** The token or phrase the perturbation introduced. The judge cannot have met it in the conversation. */
  readonly introduced: string;
  /** The answer this case was derived from, so a reader can diff the two without the artifact. */
  readonly original: string;
};

/** What the judge said about one submitted answer. */
type AuditVerdict = { readonly accepted: boolean };

/** Rates for one bucket. `upper` is the Wilson 95% upper bound on `accepted / total`. */
type AuditRate = {
  readonly total: number;
  readonly accepted: number;
  readonly rate: number;
  readonly upper: number;
};

/** The reading: the false-accept rate, split by kind, plus the reproducibility control. */
type AuditReading = {
  readonly cases: AuditRate;
  readonly byKind: Readonly<Record<AuditKind, AuditRate>>;
  /**
   * Answers the judge already accepted, re-submitted unchanged. Anything below 100% here is judge
   * noise, and it is the number the false-accept rate has to be read against rather than on its own.
   */
  readonly control: AuditRate;
};

/** The observed-frequency half of a Wilson score interval, matching `wilsonScoreInterval`'s z. */
function wilsonUpper(accepted: number, total: number, z = 1.96): number {
  if (total === 0) return 1;
  const p = accepted / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return Math.min(1, (centre + margin) / denominator);
}

function rate(accepted: number, total: number): AuditRate {
  return {
    total,
    accepted,
    rate: total === 0 ? 0 : accepted / total,
    upper: wilsonUpper(accepted, total),
  };
}

/**
 * Every number the text states, as written.
 *
 * Deliberately not a full numeric parser: the audit wants the literal surface form so that a swap
 * substitutes a string the judge will read as the same *kind* of value. `1,200` and `1200` are two
 * different surfaces here, and replacing one with a value that does not appear in the conversation
 * keeps the invariant true for both.
 */
function numbersIn(text: string): string[] {
  return text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
}

/**
 * Capitalised words that are not names.
 *
 * Three families are excluded by a list rather than by a heuristic, and each was found by watching an
 * instrument produce a number that was wrong rather than by imagining it:
 *
 *   months and weekdays  capitalised in ordinary English, and substituting one changes a date, which
 *                        the temporal template is allowed to tolerate. `§13.182` excluded these first.
 *   determiners and      capitalised at the start of a sentence, so every sentence-initial word would
 *   function words       otherwise be an "entity". `§13.184.5` added the pronouns after the name screen
 *                        hit it: an answer starting `They adopted a Labrador` extracted `They`, which made
 *                        the answer's name set non-empty, made it disjoint from a gold naming `Rachel`, and
 *                        would have listed a **correct** answer as a false accept.
 *   discourse markers     `However`, `Meanwhile`, `Finally` — same position, same problem.
 *
 * The list is deliberately conservative about ordinary nouns: `Golden` and `Retriever` are both kept
 * from `Golden Retriever`, which makes the screen *less* eager (either half being present counts as a
 * shared name) and an `entity-swap` on the first half still destroys the gold.
 */
const NOT_A_NAME = new Set(
  (
    'January February March April May June July August September October November December ' +
    'Monday Tuesday Wednesday Thursday Friday Saturday Sunday ' +
    'I The A An It This That These Those My Our Your His Her Their There Then When What Where Which ' +
    'Who Why How If So And But Or Not No Yes ' +
    'They Them She He We Us You Him Its Both Each Every All Some Many Most One Two Three ' +
    'However Meanwhile Finally First Second Third Instead Besides Also Even Only Just Still ' +
    'After Before Because Since During Until Unless Though Although While Now Today Yesterday ' +
    'Tomorrow Okay Ok Sure Thanks Thank'
  ).split(' '),
);

/**
 * The names a text states.
 *
 * Exported since `§13.184.5`: `nameScreen` compares an answer's names against its gold's names, and it
 * has to use *this* definition. The pool `entity-swap` draws replacements from and the set the screen
 * tests for disjointness are then one set, so the 44.90% the audit measured and the candidates the
 * screen lists are statements about the same thing. Not exported from the package index: the only
 * consumer is a sibling module, and `tools/export-census.mjs` refuses an advertisement with no caller.
 */
export function entitiesIn(text: string): string[] {
  const found = text.match(/\b[A-Z][a-z]{2,}\b/g) ?? [];
  return [...new Set(found.filter((word) => !NOT_A_NAME.has(word)))];
}

/** Does `text` mention `token` as a whole word, case-sensitively? */
function mentions(text: string, token: string): boolean {
  return new RegExp(
    `(^|[^A-Za-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`,
  ).test(text);
}

/** A stable choice that does not depend on iteration order or on `Math.random`. */
function pick<T>(items: readonly T[], key: string): T {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return items[hash % items.length]!;
}

/**
 * The replacement pool for `entity-swap`: every name any gold in the corpus states.
 *
 * Drawn from the corpus rather than invented, because an invented string ("Zarnov") is easy in a way
 * a real but wrong name is not — a judge that only rejects non-words has not been measured on the
 * failure that matters.
 */
function entityPool(sources: readonly AuditSource[]): string[] {
  const pool = new Set<string>();
  for (const source of sources) for (const entity of entitiesIn(source.gold)) pool.add(entity);
  return [...pool].sort();
}

/**
 * Put `replacement` where `token` stood, so that the gold answer is genuinely destroyed.
 *
 * The case this exists for was found on a real artifact rather than imagined: when the model answered
 * with the gold verbatim and the token was not the first word of it, replacing in the *answer* was
 * enough, but when the answer merely *contained* the gold the substitution could miss it and the case
 * would still be correct. Replacing inside the gold first, and splicing the perturbed gold back into
 * the answer, makes the invariant hold by construction instead of by luck — and when the token is not
 * in the answer at all, appending a sentence is the only honest way to introduce it.
 */
function substitute(source: AuditSource, token: string, replacement: string): string {
  const perturbedGold = source.gold.replace(token, replacement);
  let answer = source.answer;
  // EVERY occurrence, not the first. The case that taught this was real: question `75499fd8` answers
  // "…it would suit a Golden Retriever like Max…" and then closes with "Golden Retriever" as its final
  // line, so replacing only the first occurrence left the gold intact at the end, and the case would
  // have been scored as a false accept when the judge was right.
  //
  // The two branches are exclusive, and that is also a measured correction: on gold `"3"` the gold pass
  // already rewrote the answer to `"34"`, and a second token pass then made it `"344"` — a number that
  // appears in no conversation, which would have been a second uncontrolled variable.
  if (perturbedGold !== source.gold && answer.includes(source.gold)) {
    answer = answer.split(source.gold).join(perturbedGold);
  } else if (answer.includes(token)) {
    answer = answer.split(token).join(replacement);
  }
  return answer === source.answer ? `${answer} That is ${replacement}.` : answer;
}

/**
 * Build one `number-swap` case, or `null` when the gold states no number or every candidate value
 * already appears in the conversation.
 *
 * The replacement is `7n + 13`, then `3n + 101`, then `n + 4289`: three attempts, each checked
 * against the conversation. A value the user had mentioned could be another true fact and a "yes"
 * would then be right for a reason the instrument cannot see, so a candidate that appears anywhere
 * in the conversation is rejected rather than used.
 */
function planNumberSwap(source: AuditSource): AuditCase | null {
  const numbers = numbersIn(source.gold);
  if (numbers.length === 0) return null;
  const original = numbers[0]!;
  const value = Number(original.replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  const candidates = [value * 7 + 13, value * 3 + 101, value + 4289].map((n) =>
    String(Math.round(n)),
  );
  const replacement = candidates.find(
    (candidate) => !mentions(source.conversation, candidate) && !source.gold.includes(candidate),
  );
  if (replacement === undefined) return null;
  const answer = substitute(source, original, replacement);
  return {
    questionId: source.questionId,
    kind: 'number-swap',
    question: source.question,
    gold: source.gold,
    answer,
    introduced: replacement,
    original: source.answer,
  };
}

/**
 * Build one `entity-swap` case, or `null` when the gold names nothing swappable or every name in the
 * pool already appears in the conversation.
 */
function planEntitySwap(source: AuditSource, pool: readonly string[]): AuditCase | null {
  const named = entitiesIn(source.gold);
  if (named.length === 0) return null;
  const original = named[0]!;
  const candidates = pool.filter(
    (entity) =>
      entity !== original &&
      !mentions(source.conversation, entity) &&
      !source.gold.includes(entity),
  );
  if (candidates.length === 0) return null;
  const replacement = pick(candidates, `${source.questionId}:entity`);
  const answer = substitute(source, original, replacement);
  return {
    questionId: source.questionId,
    kind: 'entity-swap',
    question: source.question,
    gold: source.gold,
    answer,
    introduced: replacement,
    original: source.answer,
  };
}

/**
 * Build one `cross-gold` case, or `null` when the corpus holds no other gold to borrow.
 *
 * The borrowed gold is chosen by position in the sorted id order rather than by relevance, so the
 * selection cannot quietly become "the most similar wrong answer" — that would make the audit look
 * easier or harder depending on an unstated ranking. Its introduced token is whichever name or
 * number this question's gold does not contain, so the absence invariant still holds.
 */
function planCrossGold(source: AuditSource, sources: readonly AuditSource[]): AuditCase | null {
  const borrowable = sources.filter(
    (other) =>
      other.questionId !== source.questionId &&
      other.gold !== source.gold &&
      // A borrowed gold that CONTAINS this question's gold would leave the borrowed answer correct,
      // and a "yes" on it would be a true accept counted as a false one. Containment is the property
      // that matters, not inequality.
      !other.gold.includes(source.gold) &&
      !source.gold.includes(other.gold),
  );
  const sameCapability = borrowable.filter((other) => other.capability === source.capability);
  const others = (sameCapability.length > 0 ? sameCapability : borrowable).sort((a, b) =>
    a.questionId.localeCompare(b.questionId),
  );
  if (others.length === 0) return null;
  const index = others.findIndex((other) => other.questionId > source.questionId);
  const borrowed = others[index === -1 ? 0 : index]!;
  const token =
    entitiesIn(borrowed.gold).find(
      (entity) => !mentions(source.conversation, entity) && !source.gold.includes(entity),
    ) ??
    numbersIn(borrowed.gold).find(
      (n) => !mentions(source.conversation, n) && !source.gold.includes(n),
    );
  if (token === undefined) return null;
  return {
    questionId: source.questionId,
    kind: 'cross-gold',
    question: source.question,
    gold: source.gold,
    answer: borrowed.gold,
    introduced: token,
    original: source.answer,
  };
}

/**
 * Plan the audit for a set of questions.
 *
 * Deterministic: the same sources in the same order produce the same cases, with no randomness and no
 * clock. That is what lets a second reader reproduce a published false-accept rate from the artifact
 * alone, and it is why `pick` hashes the question id rather than drawing from a generator.
 */
export function planAudit(sources: readonly AuditSource[]): AuditCase[] {
  const pool = entityPool(sources);
  const cases: AuditCase[] = [];
  for (const source of sources) {
    for (const planned of [
      planNumberSwap(source),
      planEntitySwap(source, pool),
      planCrossGold(source, sources),
    ]) {
      if (planned === null) continue;
      assertWrongByConstruction(planned);
      cases.push(planned);
    }
  }
  return cases;
}

/**
 * Refuse to emit a case that is not provably wrong, or whose introduced token the judge may have read.
 *
 * This runs on every planned case rather than in a test, because the failure it prevents is silent:
 * a case whose answer still contains the gold would be a *correct* answer, and a "yes" on it would be
 * counted as a false accept and inflate the rate the instrument exists to report. A test can only
 * sample; this cannot.
 */
function assertWrongByConstruction(auditCase: AuditCase): void {
  if (auditCase.answer === auditCase.original) {
    throw new Error(`audit: ${auditCase.questionId} ${auditCase.kind} did not change the answer`);
  }
  // Word-boundary semantics, not `String.includes`. Gold can be one character — `"3"` is a real gold
  // in this dataset — and `"34".includes("3")` is true, which would reject every numeric swap and
  // quietly empty the audit of the kind that matters most for the count questions.
  if (mentions(auditCase.original, auditCase.gold) && mentions(auditCase.answer, auditCase.gold)) {
    throw new Error(
      `audit: ${auditCase.questionId} ${auditCase.kind} still contains the gold answer, so a "yes" ` +
        'on it would be correct and the case cannot measure anything',
    );
  }
  if (mentions(auditCase.question, auditCase.introduced)) {
    throw new Error(
      `audit: ${auditCase.questionId} ${auditCase.kind} introduced "${auditCase.introduced}", which ` +
        'the question itself states — the answer would not be wrong',
    );
  }
}

/** Collapse the judge's verdicts on the planned cases plus the unperturbed control into one reading. */
export function summariseAudit(
  cases: readonly AuditCase[],
  verdicts: readonly AuditVerdict[],
  control: readonly AuditVerdict[],
): AuditReading {
  if (verdicts.length !== cases.length) {
    throw new Error(
      `audit: ${verdicts.length} verdict(s) for ${cases.length} case(s) — a partial reading is not a rate`,
    );
  }
  const accepted = verdicts.filter((verdict) => verdict.accepted).length;
  const kinds: AuditKind[] = ['number-swap', 'entity-swap', 'cross-gold'];
  const byKind = Object.fromEntries(
    kinds.map((kind) => {
      const indices = cases.flatMap((auditCase, index) => (auditCase.kind === kind ? [index] : []));
      const hits = indices.filter((index) => verdicts[index]!.accepted).length;
      return [kind, rate(hits, indices.length)];
    }),
  ) as Record<AuditKind, AuditRate>;
  return {
    cases: rate(accepted, cases.length),
    byKind,
    control: rate(control.filter((verdict) => verdict.accepted).length, control.length),
  };
}
