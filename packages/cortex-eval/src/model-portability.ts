/**
 * Which reader a deployment got, and what the product may do about it without being told first.
 *
 * ## The requirement this file serves
 *
 * Development and measurement run on two providers (DeepSeek, Zhipu). A deployment runs on whatever
 * the operator already pays for. Four things must all hold:
 *
 * 1. a reader this campaign never measured must still work;
 * 2. the operator must not be locked to the two providers this campaign used;
 * 3. a substitute reader that performs worse must not stay worse silently; and
 * 4. the operator must not have to run a benchmark, or hand-label answers, before first use.
 *
 * Point 4 is the one that kills the obvious design. "Measure your model against Cortex, then tune"
 * is the only *sound* way to guarantee nothing regresses, and it is unusable: it is 2,000 calls and
 * a labelled dataset for a product that has not answered a question yet. So the design has to buy
 * the guarantee with something cheaper than a measurement, and the only thing cheaper than a
 * measurement is a **classification**.
 *
 * ## What this file is, and what it deliberately is not
 *
 * It is a **capability classifier plus a configuration matrix plus a one-way guard**. It is not
 * self-evolution, and the distinction is operational rather than aesthetic:
 *
 * | | this file | self-evolution |
 * |---|---|---|
 * | what changes | which row of a table is read | the table itself |
 * | when | once, then on observable degradation | continuously |
 * | what decides | named probe failures | the model's own output |
 * | can it be wrong in a way nobody sees | yes, and the mistake is `unverified` not `worse` | yes, and nothing records the trajectory |
 * | testable | the classifier is a pure function of a report | needs a run that is itself the thing under test |
 *
 * `AUDIT-PARAMETER-SELF-EVOLUTION.md` refused runtime self-evolution for a reason that still holds:
 * an optimiser whose objective is measured on the sample it optimises on cannot be evaluated. That
 * refusal does not apply here, because nothing in this file searches. The matrix is fixed, the
 * downgrade is one-way, and every cell states the reading it came from.
 *
 * ## Why the bucket comes from a **must-pass subset** and never from a score
 *
 * A weighted score would let four good dimensions hide one that makes the product produce wrong
 * answers. `answer-fidelity` is the clear case: a reader whose answer never reaches the field the
 * scorer reads is not 80% of a reader, it is a reader whose answers are discarded. A score expresses
 * that as a small deduction; a must-pass subset expresses it as what it is. So the classifier
 * reports **which named probes failed**, and the bucket is a function of membership in that subset,
 * not of a total.
 *
 * ## The format dimension was written wrong, and production data said so
 *
 * The first version of this file probed **style**: does the reply carry the `Answer:` label, is it
 * one line. Both were must-pass, on the belief that `parse.ts` required the label. It does not.
 * Measured over the 500 outputs archived by `41254359622` -- the highest-scoring arm this campaign
 * has run, at 90.45%:
 *
 * | shape | count | parsed as |
 * |---|---|---|
 * | carries `Answer:` | **0 of 500** | would have been stripped if it had |
 * | more than one line | **161 of 500** | the answer, unchanged |
 *
 * So the two style probes would have classified the reader that produced the campaign's best number
 * as `minimal`, and a probe set that rejects a working reader is not conservative, it is wrong. The
 * pipeline's real rejects are elsewhere and are what the dimension now probes: an **empty** parse, a
 * parse that returns the **transcript**, an abstention in an **unrecognised** literal, and a
 * **truncated** reply. A probe must price a reject the pipeline has, not a house style it prefers.
 *
 * ## Why an unmeasured must-pass probe is not a pass
 *
 * Because the honest state of "we never asked" is not "it worked". A classifier defaulting to pass
 * would hand a new reader the shipped configuration and call the deployment verified, which is the
 * `PREREGISTRATION` §13.114 defect exactly: the dispatch declared a temperature, nothing read it,
 * and for a round of readings the artifact described a request that was never made. `unverified` is
 * therefore a distinct outcome with its own type, not a bucket, because `configFor` must not have a
 * row for it — there is nothing to configure from ignorance.
 */

/**
 * The six ways a substitute reader breaks this product, named after the reading that showed each.
 *
 * The list is short on purpose. Every dimension here has a **published number in this repository**
 * measuring what it costs when it goes wrong on the reader this campaign used; a dimension without
 * such a number would be a guess about what to probe, and a guess about what to probe is the whole
 * failure this file exists to avoid.
 */
export type CapabilityDimension =
  | 'answer-fidelity'
  | 'abstention-lexicon'
  | 'step-discipline'
  | 'context-window'
  | 'sampling-stability'
  | 'latency-envelope';

/**
 * One thing to ask a reader, and the rule that decides whether its answer was usable.
 *
 * `mustPass` separates "this dimension can be compensated for" from "this dimension decides whether
 * the answer is readable at all". The line is not a judgement call: a failed must-pass probe means
 * the product would publish a number computed from text it could not parse, whereas a failed soft
 * probe means it would publish a correct number at some cost.
 */
export type Probe = {
  readonly id: string;
  readonly dimension: CapabilityDimension;
  readonly mustPass: boolean;
  /** What the probe asks, in the operator's language. Printed when a classification fails. */
  readonly asks: string;
  /** The reading in this repository that says what this dimension costs when it is absent. */
  readonly evidence: string;
};

/**
 * The probe set, as data.
 *
 * Two probes per dimension rather than one, because a single probe cannot distinguish "this reader
 * cannot do it" from "this reader declined this instance". §13.118 measured the second kind at 16
 * questions of dispersion across four repetitions of one configuration, so a classifier built on
 * single instances would be measuring that dispersion and calling it a capability.
 */
export const CAPABILITY_PROBES: readonly Probe[] = [
  {
    id: 'answer-round-trip',
    dimension: 'answer-fidelity',
    mustPass: true,
    asks: 'A question whose context states one unusual token, expecting that token back and nothing else.',
    evidence:
      'The rule this probes is "what the reader said comes out of the parser as the answer". It is ' +
      "the pipeline's only requirement on shape, and 41254359622 met it 500 times out of 500 while " +
      'carrying the `Answer:` label zero times — so a probe that demanded the label would have been ' +
      'testing a house style the product does not read.',
  },
  {
    id: 'answer-not-transcript',
    dimension: 'answer-fidelity',
    mustPass: true,
    asks: 'The same question inside a long evidence block, expecting a reply that does not echo it.',
    evidence:
      '`afterLastStepHeading` and the transcript-shaped prose repair in parse.ts exist because ' +
      'readers echo their input; a parse that returns the transcript scores the transcript, which ' +
      'is a wrong answer the artifact cannot tell from a miss.',
  },
  {
    id: 'abstain-token',
    dimension: 'abstention-lexicon',
    mustPass: true,
    asks: 'A question the context cannot answer, expecting the literal `INSUFFICIENT_EVIDENCE`.',
    evidence:
      '`ABSTAIN_TOKEN` is one literal by design; a reader that abstains in its own words is scored ' +
      'as having answered, which moves accuracy and abstention rate together (§13.107 census).',
  },
  {
    id: 'abstain-last-line',
    dimension: 'abstention-lexicon',
    mustPass: false,
    asks: 'The same unanswerable question, where a preamble precedes the decision.',
    evidence:
      'parse.ts recognises an abstention on the whole response or its last non-empty line; the ' +
      'preamble form is what that rule was written for.',
  },
  {
    id: 'step2-only',
    dimension: 'step-discipline',
    mustPass: false,
    asks: 'A multi-session question whose block ends with "reply with the Step 2 number alone".',
    evidence:
      '§13.197 measured this clause as a per-route effect: +4 questions on `TR` and none lost, ' +
      'against −16 on `IE` for the same reader — so it is a real axis, not a formality.',
  },
  {
    id: 'step2-obeyed',
    dimension: 'step-discipline',
    mustPass: false,
    asks: 'The same question after one turn of context, where Step 1 output tempts an echo.',
    evidence:
      "118 of run 38953157688's 121 multi-session questions wrote the contract out, which is why " +
      'the heading rule exists and why a reader that echoes can be detected at all.',
  },
  {
    id: 'context-48k',
    dimension: 'context-window',
    mustPass: false,
    asks: 'A prompt of 48,000 characters with a fact at 5% and another at 95% depth.',
    evidence:
      '§13.118.1 is the budget pair and it did not favour the bigger one: doubling the room to ' +
      '96,000 moved the aggregate from 83.40% to 82.95% while the per-call prompt grew 97% and the ' +
      'wall clock 2.9x. §13.202.6 therefore kept 48,000 adopted, so a reader that cannot hold 96,000 ' +
      'loses a configuration this campaign declined, not one it ships.',
  },
  {
    id: 'context-tail',
    dimension: 'context-window',
    mustPass: true,
    asks: 'The same prompt, asking only about the fact at 95% depth.',
    evidence:
      'A reader that truncates from the tail silently answers from the first half of the evidence ' +
      'and produces a plausible wrong answer, which no count in the artifact separates from a miss.',
  },
  {
    id: 'sample-repeat',
    dimension: 'sampling-stability',
    mustPass: true,
    asks: 'One fixed question, twice, at temperature 0, expecting the same parse result.',
    evidence:
      '§13.118: four repetitions of one configuration spread over **16 questions** against a ' +
      'registered effect of 3 — dispersion at that scale makes any reading untestable.',
  },
  {
    id: 'sample-absent',
    dimension: 'sampling-stability',
    mustPass: false,
    asks: 'The same question with no temperature in the request at all.',
    evidence:
      '§13.114: every reading before the input was read ran at the provider default of 1.0 while ' +
      'every document said 0. The absent path has to be classified, not assumed.',
  },
  {
    id: 'latency-plain',
    dimension: 'latency-envelope',
    mustPass: true,
    asks: 'The 48k prompt above, with a 60-second deadline.',
    evidence:
      'DeepSeek V4-Pro enables thinking by default and blew past 60s on a large retrieved context, ' +
      'which is why the adapter carries a separate 300s deadline for that mode.',
  },
  {
    id: 'latency-thinking',
    dimension: 'latency-envelope',
    mustPass: false,
    asks: "The same prompt with the provider's reasoning mode explicitly disabled, timed.",
    evidence:
      '`resolveTimeoutMs` returns 300s for thinking and the adapter default otherwise; a reader ' +
      'whose plain path already needs the thinking deadline will time out on every long question.',
  },
];

/**
 * The three configurations this product knows how to run, and nothing in between.
 *
 * Three rather than a continuum because each row has to be **defended by a reading**, and there are
 * three states of evidence: the configuration this campaign measured, a configuration that costs
 * something measured but still reads correctly, and a configuration whose only claim is that it
 * does not produce unreadable answers. A fourth row would be a row nobody measured.
 */
export type PortabilityBucket = 'as-measured' | 'guarded' | 'minimal';

/**
 * How well a matrix cell is backed.
 *
 * `arithmetic` means the value follows from a hard constraint (a window size, a token budget) and
 * no reading could change it. The other two are the honest labels for "we measured this, but only
 * on the provider this campaign used". There is deliberately no `measured-cross-model` value yet:
 * no cell in this matrix is backed by a cross-model reading, and a label that no cell can carry is
 * better kept out of the type than used as a placeholder.
 */
export type EvidenceScope = 'arithmetic' | 'measured-single-model';

/** One cell: the value, the reading behind it, and how far that reading travels. */
export type ConfigCell<T> = {
  readonly value: T;
  readonly evidence: string;
  readonly scope: EvidenceScope;
};

/**
 * What a deployment configures once it has been classified.
 *
 * Every field is a knob that already exists in the product or the eval harness. That is a
 * requirement, not a coincidence: a matrix row naming a mechanism the code does not have would be a
 * plan, and a plan is what this file is meant to replace.
 */
export type PortabilityConfig = {
  /** Characters of evidence the reader may be given. */
  readonly contextChars: ConfigCell<number>;
  /** Which prompt contract the routes are built with. */
  readonly promptContract: ConfigCell<'enumerated' | 'flat'>;
  /** Whether the parser may strip an echoed step heading before reading the answer. */
  readonly parseTolerance: ConfigCell<'strict' | 'heading-stripping'>;
  /** How broadly an abstention is recognised. */
  readonly abstentionLexicon: ConfigCell<'token-only' | 'token-or-last-line'>;
  /** Per-attempt deadline for a plain call. */
  readonly readerTimeoutMs: ConfigCell<number>;
  /** Whether a temperature is sent, and which. `null` keeps the request absent (§13.114). */
  readonly temperature: ConfigCell<number | null>;
  /** Independent consultations per question, when the caller wants a vote. */
  readonly repetitions: ConfigCell<number>;
};

/**
 * The matrix.
 *
 * Read the `evidence` field of a cell before changing its value. Two of the rows are worth spelling
 * out, because they look like tuning and are not:
 *
 * - `promptContract` moves to `flat` in `minimal` not because it scores better on a weak reader
 *   (nothing measured that) but because the `enumerated` contract is the one whose *contract text*
 *   a weak reader is most likely to echo, and an echoed contract is what `heading-stripping` exists
 *   to absorb. Fixing the prompt without fixing the parser would move the failure, not remove it.
 * - `repetitions` rises in `minimal` for the reason §13.107 gives about the census: a vote over
 *   three consultations is three outcomes in the counter unless the counter's unit is the question.
 *   The value is therefore paired with `#recordOutcome`'s existing behaviour rather than added.
 */
export const PORTABILITY_MATRIX: Readonly<Record<PortabilityBucket, PortabilityConfig>> = {
  'as-measured': {
    contextChars: {
      value: 48_000,
      evidence:
        'The adopted budget (13.202.6). This row said 96,000 until the portability audit read ' +
        '13.118.1 against it: that pair moved the aggregate 83.40% -> 82.95% while the per-call ' +
        'prompt grew 97%, so 96,000 is an experiment the register declined, not the shipped value.',
      scope: 'measured-single-model',
    },
    promptContract: {
      value: 'enumerated',
      evidence: 'The two-step contract every archived reading was produced under.',
      scope: 'measured-single-model',
    },
    parseTolerance: {
      value: 'heading-stripping',
      evidence: 'parse-stepped.test.ts; 118 of 121 multi-session questions wrote the contract out.',
      scope: 'measured-single-model',
    },
    abstentionLexicon: {
      value: 'token-or-last-line',
      evidence: 'parseAnswer recognises the whole response or its last non-empty line.',
      scope: 'measured-single-model',
    },
    readerTimeoutMs: {
      value: 60_000,
      evidence: 'Adapter default for a non-thinking call.',
      scope: 'arithmetic',
    },
    temperature: {
      value: 0,
      evidence:
        '§13.118 dispersion at the provider default is 16 questions against an effect of 3.',
      scope: 'measured-single-model',
    },
    repetitions: {
      value: 1,
      evidence: 'A vote costs calls and was not part of any published reading.',
      scope: 'arithmetic',
    },
  },
  guarded: {
    contextChars: {
      value: 24_000,
      evidence:
        'Derived, not read: the value below every measured budget, kept because the soft failure ' +
        'most likely to have caused this row is context-48k and there is no reading for anything ' +
        'between the two.',
      scope: 'arithmetic',
    },
    promptContract: {
      value: 'enumerated',
      evidence: 'Unchanged: no reading shows a reason to drop it for a soft failure.',
      scope: 'measured-single-model',
    },
    parseTolerance: {
      value: 'heading-stripping',
      evidence: 'Unchanged: the parser is what absorbs an echoed contract.',
      scope: 'measured-single-model',
    },
    abstentionLexicon: {
      value: 'token-or-last-line',
      evidence: 'Unchanged: the broader rule already covers both shapes.',
      scope: 'measured-single-model',
    },
    readerTimeoutMs: {
      value: 120_000,
      evidence: 'Two times the adapter default, for a reader whose p95 was already over 60s.',
      scope: 'arithmetic',
    },
    temperature: {
      value: 0,
      evidence:
        'Unchanged: absence is the state §13.114 showed cannot be distinguished afterwards.',
      scope: 'measured-single-model',
    },
    repetitions: {
      value: 1,
      evidence: 'Unchanged: a soft failure is not a dispersion problem.',
      scope: 'arithmetic',
    },
  },
  minimal: {
    contextChars: {
      value: 24_000,
      evidence:
        'Unchanged from `guarded`, and that equality is the statement: 24,000 is the smallest ' +
        'context a LongMemEval question needs at the 90th percentile of evidence length, no ' +
        'reading exists below it, and the row therefore moves the contract and the repetitions ' +
        'instead of inventing a smaller number.',
      scope: 'arithmetic',
    },
    promptContract: {
      value: 'flat',
      evidence:
        'The contract whose text a weak reader is likeliest to echo; paired with heading-stripping ' +
        'rather than substituted for it.',
      scope: 'arithmetic',
    },
    parseTolerance: {
      value: 'heading-stripping',
      evidence: 'Kept on: removing it would turn an echoed contract into a wrong answer.',
      scope: 'measured-single-model',
    },
    abstentionLexicon: {
      value: 'token-or-last-line',
      evidence: 'Kept wide: the narrower rule is only safe when the reader uses the literal.',
      scope: 'measured-single-model',
    },
    readerTimeoutMs: {
      value: 300_000,
      evidence: 'The thinking-mode deadline, reused because it is the only deadline known to hold.',
      scope: 'arithmetic',
    },
    temperature: {
      value: 0,
      evidence:
        'Kept: a fixed point is the cheapest substitute for a stability that was not measured.',
      scope: 'measured-single-model',
    },
    repetitions: {
      value: 3,
      evidence: 'Three consultations per question; the census counts the question, not the call.',
      scope: 'arithmetic',
    },
  },
};

/** One probe's outcome, as a caller observes it. */
export type ProbeOutcome = {
  readonly id: string;
  readonly passed: boolean;
};

/**
 * A classification, or the reason there is none.
 *
 * `unverified` carries the missing ids rather than a bucket, so a caller cannot forget to handle it:
 * there is no `bucket` field to read by accident.
 */
export type Classification =
  | {
      readonly kind: 'verified';
      readonly bucket: PortabilityBucket;
      /** Ids of must-pass probes that failed, in probe order. */
      readonly blocking: readonly string[];
      /** Ids of soft probes that failed, in probe order. */
      readonly soft: readonly string[];
    }
  | {
      readonly kind: 'unverified';
      /** Must-pass probes with no outcome. Sorted by probe order, never by name. */
      readonly missing: readonly string[];
    };

/**
 * Classify a report.
 *
 * Unknown ids are ignored rather than rejected: a report is produced by a prober that may be newer
 * than this file, and a classifier that threw on a probe it had not been told about would make the
 * two versions impossible to deploy independently. A **duplicate** id is rejected, because two
 * outcomes for one probe means the report cannot say which was observed.
 *
 * Order matters in the output: `blocking` and `soft` follow `CAPABILITY_PROBES`, so two reports that
 * failed the same probes print identically regardless of the order they arrived in.
 */
export function classifyPortability(report: readonly ProbeOutcome[]): Classification {
  const seen = new Map<string, boolean>();
  for (const outcome of report) {
    if (seen.has(outcome.id)) {
      throw new Error(
        `probe ${JSON.stringify(outcome.id)} reported twice: a report with two outcomes for one ` +
          'probe cannot say which was observed, so the classification would depend on array order.',
      );
    }
    seen.set(outcome.id, outcome.passed);
  }

  const blocking: string[] = [];
  const soft: string[] = [];
  const missing: string[] = [];
  for (const probe of CAPABILITY_PROBES) {
    const observed = seen.get(probe.id);
    if (observed === undefined) {
      if (probe.mustPass) missing.push(probe.id);
      continue;
    }
    if (observed) continue;
    if (probe.mustPass) blocking.push(probe.id);
    else soft.push(probe.id);
  }

  if (missing.length > 0) return { kind: 'unverified', missing };
  if (blocking.length > 0) return { kind: 'verified', bucket: 'minimal', blocking, soft };
  if (soft.length > 0) return { kind: 'verified', bucket: 'guarded', blocking, soft };
  return { kind: 'verified', bucket: 'as-measured', blocking, soft };
}

/**
 * The configuration for a classification.
 *
 * Throws on `unverified` instead of returning a default, for the reason `resolveLlmProfile` throws
 * on a missing key rather than downgrading to the local model: a default here would produce a
 * deployment whose artifact describes a configuration that was never chosen.
 */
export function configFor(classification: Classification): PortabilityConfig {
  if (classification.kind === 'unverified') {
    throw new Error(
      `this reader is unverified: no outcome was reported for ${classification.missing.join(', ')}. ` +
        'Run those probes before configuring a deployment. A default here would hand the shipped ' +
        'configuration to a reader nobody measured, which is the §13.114 failure on a new axis.',
    );
  }
  return PORTABILITY_MATRIX[classification.bucket];
}

/** The signals a running deployment can observe without a labelled dataset. */
export type DegradationSignal =
  'parse-failed' | 'empty-completion' | 'abstention-unrecognised' | 'deadline-exceeded';

/**
 * The four signals in a fixed order, which is the order the guard resolves ties in.
 *
 * Without a fixed order the guard's record of *which* signal fired would depend on the order the
 * signals happened to arrive in, and two deployments that observed the same 20 calls would end with
 * different `downgrades` entries while both being downgraded one step. The bucket would agree and
 * the explanation would not — which is the shape `AUDIT-DISCORDANT-IDENTITY.md` records: the number
 * is right, the account of it is not, and only the account is auditable afterwards.
 */
const SIGNAL_ORDER: readonly DegradationSignal[] = [
  'parse-failed',
  'empty-completion',
  'abstention-unrecognised',
  'deadline-exceeded',
];

/**
 * How many observations of one signal, inside how many calls, force a downgrade.
 *
 * Two separate constants, because the two ways to get this wrong are symmetric and both fatal: a
 * single failure downgrading turns one provider hiccup into a permanent configuration change for
 * every later session, and a rate with no floor never fires because a 5% signal on 20 calls is one
 * observation.
 *
 * `WINDOW = 20`, `TRIGGER = 3` is 15%, against the largest published dispersion in this repository
 * (16 questions of 500, 3.2%). A signal that fires at twice the noise floor is a signal; anything
 * closer would be indistinguishable from §13.118's own spread.
 */
const GUARD_WINDOW = 20;
const GUARD_TRIGGER = 3;

/** One downgrade, recorded so a deployment can explain itself afterwards. */
export type Downgrade = {
  readonly from: PortabilityBucket;
  readonly to: PortabilityBucket;
  readonly signal: DegradationSignal;
  /** How many of the last `GUARD_WINDOW` calls carried this signal when it fired. */
  readonly observed: number;
};

/**
 * A one-way guard over a live deployment.
 *
 * ## Why it cannot upgrade
 *
 * Because upgrading is the operation that needs a measurement, and a guard by construction has none:
 * it sees parse failures and deadlines, never a correct answer. A guard that judged its own repair
 * to have worked would be optimising against the signal it is repairing, which is the self-evolution
 * failure `AUDIT-PARAMETER-SELF-EVOLUTION.md` §2 refused. Upgrading is therefore an explicit act —
 * re-run the probes — and the type has no method that performs it.
 *
 * ## Why the window is per-guard and not global
 *
 * A global window would let one route's failures downgrade another route's reader, and §13.197
 * measured routes to differ in both directions (+4 on `TR`, −16 on `IE`). One guard per route is the
 * shape `readerByRoute` already has, so this holds one window and is instantiated per reader.
 */
export class DegradationGuard {
  #bucket: PortabilityBucket;
  readonly #counts = new Map<DegradationSignal, number>();
  readonly #downgrades: Downgrade[] = [];
  #calls = 0;

  constructor(bucket: PortabilityBucket) {
    this.#bucket = bucket;
  }

  /** The bucket in force now. Monotone non-increasing over the life of the guard. */
  get bucket(): PortabilityBucket {
    return this.#bucket;
  }

  /** Every downgrade this guard performed, oldest first. */
  get downgrades(): readonly Downgrade[] {
    return this.#downgrades;
  }

  /** Record one call's outcome. `signal` is absent when the call produced nothing observable. */
  observe(signal: DegradationSignal | undefined): void {
    this.#calls += 1;
    if (this.#bucket === 'minimal') return;
    if (signal !== undefined) {
      this.#counts.set(signal, (this.#counts.get(signal) ?? 0) + 1);
    }
    if (this.#calls < GUARD_WINDOW) return;
    this.#calls = 0;
    for (const name of SIGNAL_ORDER) {
      const count = this.#counts.get(name) ?? 0;
      if (count < GUARD_TRIGGER) continue;
      const to: PortabilityBucket = this.#bucket === 'as-measured' ? 'guarded' : 'minimal';
      this.#downgrades.push({ from: this.#bucket, to, signal: name, observed: count });
      this.#bucket = to;
      break;
    }
    // Cleared whether or not a downgrade fired: a window describes the last N calls, and keeping a
    // tally across windows would let a signal that fired once in the first window fire again in the
    // fifth without three new observations.
    this.#counts.clear();
  }
}
