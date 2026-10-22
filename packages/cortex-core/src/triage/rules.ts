/**
 * The deterministic disclosure layer: one sentence in, one scope out.
 *
 * ## Why rules at all
 *
 * Extraction is a model's job; disclosure is not. The evidence for that split is in `docs/01`
 * section 5.3: on CIMemories, frontier models violate context-appropriate information flow on up
 * to 69% of attribute-level checks, violations accumulate with use, and adding a privacy prompt
 * makes them worse rather than better. A layer with that error profile cannot have the last word
 * on "may this leave the device".
 *
 * So the last word is a rule table a reviewer can read in one screen, plus the user. The rules are
 * ordered -- every private rule precedes every shared rule -- so a sentence that reads
 * organisational *and* mentions money stays private. That ordering is the entire fail-closed
 * argument, and it is now machine-checked rather than implied by array position: see
 * {@link assertRuleTable}, which runs at module load.
 *
 * ## What "defer" means, and what the writer does with it
 *
 * A sentence no rule recognises is **not** shared. It is deferred: stored privately, and offered
 * to the user as a card. Two of three candidates land here in the measured sample, which is the
 * honest shape of a rule layer this size -- and the reason the card queue is the product, not a
 * fallback.
 *
 * ## Where the numbers live
 *
 * `__tests__/triage-rules.test.ts` runs this table over 60 hand-labelled utterances and over the
 * rows a CI run once published by mistake. The counts are asserted, so changing a rule means
 * changing a test on purpose. The measurements behind them are `[POC-4]` and `[POC-6]` in
 * `cortex-docs`.
 */

/** What a rule may conclude. `defer` is what remains when nothing fires. */
export type TriageScope = 'private' | 'shared' | 'defer';

/** One rule: an id quoted in the audit trail, a target scope, and the pattern that fires it. */
export type TriageRule = {
  /** Stable id. Appears on every card and every stored row, so two rules must not share one. */
  readonly id: string;
  readonly scope: 'private' | 'shared';
  /** One sentence a reviewer can hold against a disputed decision. */
  readonly policy: string;
  readonly pattern: RegExp;
  /**
   * What may be done with a match.
   *
   * `'never'` means the sentence is not stored anywhere, not even privately. Only `credential`
   * declares it, and it does so because the policy sentence above says exactly that: a password
   * kept "so the assistant can help" is a password store nobody asked for, and it is the first
   * thing an export would take with it. Absent means the ordinary path: store privately, offer a
   * card.
   */
  readonly retention?: 'never';
};

/** Raised when the table itself is unusable. A programming error, not a data condition. */
export class RuleTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleTableError';
  }
}

/**
 * The table. Read it top to bottom; the first match wins.
 *
 * Every pattern is a plain `/…/i`: no `g`, no `y`. That is not a style preference -- `test()` on a
 * global regex advances `lastIndex`, so the same sentence would classify differently on its second
 * pass, and {@link assertRuleTable} refuses such a table for exactly that reason.
 */
export const RULE_TABLE: readonly TriageRule[] = [
  {
    id: 'credential',
    scope: 'private',
    policy: 'credentials are never stored, not even as a card',
    retention: 'never',
    // CVV and wallet addresses were added after a CI run of POC-6 over 3,000 identifier-bearing
    // rows published 16 of them, and every one was a payment secret no rule claimed: "the CVV is
    // 412", "provide your Bitcoin address 3D1mKZ…". An unrecognised credential is not a card the
    // user can dismiss; it is a string that left the device.
    pattern:
      /\b(password|passcode|api[ _-]?key|secret|token|private key|passphrase|ssn|social security|pin|ghp_|sk-|cvv|cvc|seed phrase)\b|\b(bitcoin|litecoin|ethereum|wallet)\s+address\b|\b0x[0-9a-f]{40}\b|\bbc1[a-z0-9]{25,}\b|\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/i,
  },
  {
    id: 'strong-pii',
    scope: 'private',
    policy: 'identifiers that are regulated by form: email, phone, card, postal address, account',
    // Account numbers and apartment designators were added after a second CI run: of the four rows
    // it still published, all four were bank accounts inside sentences that otherwise read as
    // organisational ("charge your travel to our company account, number 40387…"). An account
    // number is a regulated identifier in the same sense a card number is, so it belongs here
    // rather than in a new rule.
    pattern:
      /[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d ()-]{7,}\d|\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b|\b\d+\s+[A-Z][a-z]+\s+(street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd)\b|\b(account|acct|card)\s*(number|no\.?|#)\s*[\d*]{4,}|\bapt\.?\s*\d+/i,
  },
  {
    id: 'money',
    scope: 'private',
    policy: 'amounts, income, budget, debt',
    pattern:
      /(\$\s?\d|\b\d+\s?(dollars|usd|eur|gbp)\b|salary|income|mortgage|\brent\b|\bdebt\b|budget|\bspent\b|\bpaid\b|\bafford)/i,
  },
  {
    id: 'health',
    scope: 'private',
    policy: 'body, diagnosis, medication, diet, exercise, measurements',
    // The vitals clause exists because POC-6 ran this rule over 151 sentences from a different
    // corpus and found it silent on measurements: "blood pressure 138 over 86", "liver function
    // test showed ALT 28", "I average 7.5 hours of sleep". Those are health facts by any reading,
    // and being silent about them costs the user a card rather than safety -- which is why the gap
    // survived a false-share audit and had to be found by a coverage measurement instead.
    //
    // `walk`/`sugar`/`calorie`/`intake` came from the card queue's first measurement (step 6): of
    // the 12 gold-private utterances, 3 were never caught by any rule, and all 3 were ordinary
    // exercise and diet phrasing -- "more walking into my daily routine", "reducing my intake of
    // added sugars", "longer walks in the morning". A user who accepted every card then published
    // them. Measured before shipping, on three corpora at once: private recall 9/12 -> 12/12,
    // coverage 26.7% -> 31.7% on the 60 labelled rows, 0 changed rows in the 13 frozen leak
    // regressions, and 28.6% -> 29.2% on the 1,467 persona facts. Nothing else moved.
    pattern:
      /\b(diagnos\w*|doctor|dentist|therapy|therapist|medication|prescription|symptom|allerg\w*|surgery|clinic|mental health|anxiety|depress\w*)\b|\b(vegan|vegetarian|lacto|gluten[- ]free|diet)\b|\b(jog|walk(ing|s)?|workout|exercise|strength training|wake up at|weight|sugar|calorie|intake)\b|\b(blood pressure|heart rate|cholesterol|liver function|kidney function|alt|ast|bmi|mmhg|blood sugar|blood test|hours of sleep|sober|sobriety)\b/i,
  },
  {
    id: 'family',
    scope: 'private',
    policy: 'family and relationship details',
    pattern:
      /\b(my|our)\s+(wife|husband|partner|girlfriend|boyfriend|son|daughter|kid|kids|child|children|mother|father|mom|dad|parents|family|sister|brother)\b|\banniversary\b/i,
  },
  {
    id: 'career-status',
    scope: 'private',
    policy: 'employment status and its rewards are personal, even when they happen at work',
    // `raise` on its own was a defect this table found: it fired on "raise funds for a food bank",
    // a team event, and filed it as a career fact. The word sense is fixed here. The row it
    // mislabelled stayed private for a different reason, so the metric never moved -- only the
    // reason attached to it did, which is why the fix is tested by rule id and not by outcome.
    pattern:
      /\b(promotion|promoted|pay rise|pay raise|resigned|quit|fired|laid off|interview at|new job)\b/i,
  },
  {
    id: 'third-party',
    scope: 'private',
    policy: "other people's information is not the user's to publish",
    pattern:
      /\b(my|a|the)\s+(colleague|colleagues|boss|manager|teammate|co-?worker|friend|neighbou?r|landlord)\b/i,
  },
  {
    id: 'org-knowledge',
    scope: 'shared',
    // Deliberately narrower than "mentions work". POC-4 measured that "at work" fires on a personal
    // to-do ("meetings scheduled at work, finish a report"), which is not organisational
    // knowledge, so this rule requires an *organisational object* rather than a location.
    policy: 'an organisational object a colleague could act on',
    pattern:
      /\b(our team|our company|our org|the company i work|the project|project plan|the client|roadmap|sprint|onboarding|deliverable|team-building|we decided|the department|the board)\b/i,
  },
];

/**
 * What the rule layer concluded about one piece of text.
 *
 * `rule` and `policy` are `null` exactly when `scope` is `defer`, and that is asserted rather than
 * left to convention: a deferred decision with a rule id attached would put a rule in the audit
 * trail that did not fire.
 */
export type TriageDecision = {
  readonly scope: TriageScope;
  readonly rule: string | null;
  readonly policy: string | null;
  /**
   * Forwarded from the rule, so the write path does not have to look the id up again and cannot
   * disagree with the table. Absent on a deferral, which is also what an injected classifier
   * produces -- an unknown verdict is a failure and lands private, never `'never'`.
   */
  readonly retention?: 'never';
};

/**
 * Refuse a table whose shape would break the fail-closed argument.
 *
 * Three properties, each of which has an observable failure mode and none of which is visible by
 * reading the table:
 *
 * 1. **Partitioned by scope.** All private rules before all shared rules. One shared rule moved
 *    above a private one means a sentence that is both gets published -- silently, and only on the
 *    inputs where both fire.
 * 2. **Unique ids.** The id is the audit trail. Two rules sharing one makes a disputed decision
 *    unattributable.
 * 3. **Stateless patterns.** No `g` or `y` flag: `test()` advances `lastIndex` on those, so the
 *    same sentence answers differently on a second pass. That defect is invisible in a run that
 *    classifies each sentence once, which is every run until it is not.
 */
export function assertRuleTable(table: readonly TriageRule[]): void {
  const seen = new Set<string>();
  let sawShared = false;
  for (const rule of table) {
    if (rule.id === '') throw new RuleTableError('a rule has an empty id, so it cannot be cited');
    if (seen.has(rule.id)) {
      throw new RuleTableError(
        `duplicate rule id ${JSON.stringify(rule.id)}: the audit trail ` +
          `cannot distinguish two rules that share a name`,
      );
    }
    seen.add(rule.id);

    if (rule.scope !== 'private' && rule.scope !== 'shared') {
      throw new RuleTableError(`rule ${rule.id} has unknown scope ${JSON.stringify(rule.scope)}`);
    }
    if (rule.policy.trim() === '') {
      throw new RuleTableError(`rule ${rule.id} has no policy sentence to cite`);
    }
    const flags = rule.pattern.flags;
    if (flags.includes('g') || flags.includes('y')) {
      throw new RuleTableError(
        `rule ${rule.id} uses the ${flags.includes('g') ? 'g' : 'y'} flag: test() advances ` +
          `lastIndex on a stateful pattern, so the same text classifies differently on a second ` +
          `pass`,
      );
    }

    if (rule.scope === 'shared') sawShared = true;
    else if (sawShared) {
      throw new RuleTableError(
        `private rule ${rule.id} appears after a shared rule. The first match wins, so this rule ` +
          `can only fire when no shared rule does -- which is the inverse of fail-closed`,
      );
    }
  }
}

/**
 * Classify one sentence.
 *
 * The table is validated at module load, so a caller that injects its own table during a test gets
 * the same protection. Empty text is a deferral, not an error: nothing fired, which is what the
 * writer then handles in the safe direction.
 */
export function classify(text: string, table: readonly TriageRule[] = RULE_TABLE): TriageDecision {
  for (const rule of table) {
    if (rule.pattern.test(text)) {
      return {
        scope: rule.scope,
        rule: rule.id,
        policy: rule.policy,
        ...(rule.retention === undefined ? {} : { retention: rule.retention }),
      };
    }
  }
  return { scope: 'defer', rule: null, policy: null };
}

/**
 * Where a fact may be stored, given a decision.
 *
 * The write path's rule, stated once: **a deferred decision is not consent**, so `defer` and
 * `private` both land privately. Nothing but an explicit user confirmation moves a row across the
 * boundary -- see `TriageWriter.promote`.
 */
export function destinationOf(decision: TriageDecision): 'private' | 'shared' {
  return decision.scope === 'shared' ? 'shared' : 'private';
}

// Validated at import, so a table edited into an unsafe shape cannot reach a call site. This runs
// after the declarations above and before anything can call `classify`.
assertRuleTable(RULE_TABLE);
