#!/usr/bin/env node
/**
 * What moved between two artifacts, question by question, and which predicate explains it.
 *
 * ## Why a paired census and not two accuracies
 *
 * The reader-axis reading on record (`40698867439` against `40698883428`) was reported as **417 to 381**, and
 * the sentence attached to it in the tracking report attributed the whole loss to one population: bare abstention
 * replies on questions whose gold is an answer. A difference of two aggregates cannot support that sentence, and
 * the per-question records can. This tool reads both artifacts, pairs them by `questionId`, and prints the only
 * table that can support or refuse an attribution:
 *
 *   - the 2x2 per capability -- lost, gained, both, neither -- so a net of -36 cannot hide a +22 that came from
 *     somewhere else;
 *   - the reply shape of every lost and every gained question, through the product's own classifier, so a
 *     "declines" claim is counted rather than asserted;
 *   - and, on request, the separation of one named predicate over both sides, so a hypothesis about *why* is a
 *     number with a false-positive count instead of a paragraph that survives because nobody tested it.
 *
 * ## What it refuses
 *
 * A pair whose populations differ is not a pair. Two artifacts that disagree about `questionCount`, about
 * `dataset`, or about the set of question ids are refused rather than intersected: an intersection is the
 * quantity that makes "500 questions" and "492 questions" print the same table, and this repository has retracted
 * that shape more than once.
 *
 * A pair whose **arms** differ is not a pair either, and that rule is newer than the table it guards.
 * `S8`'s first dispatch is the precedent: `44835820692` compared a control (`44829684980`) at
 * `multi-session:62000` against a treatment at `48,460` and had to be re-derived through a third arm that read
 * neither, because the delta mixed the ask with the room. The same shape reappeared on `45636994046`, where a
 * clock-axis prompt was dispatched through `benchmark-cortex-memory.yml` while `CORTEX_MEMORY_RESOLUTION` fell
 * back to its `vars.` default of `raw`, and the comparison against the *shipped* arm (`layered`) read **-6
 * questions** that belonged to the resolution. The population rule could not see it: both sides carried 121
 * `MR` questions and the same ids.
 *
 * So every field of `memoryArmConfig` is compared, and a difference is refused **unless the command line
 * declares it** (`--allow-arm-drift ask`). The declaration is not a formality: it is the sentence "these two
 * artifacts differ in this field and nothing else", printed with the table so the reading cannot be quoted
 * without it. Two classes are exempt from the comparison and named below, because they differ between two runs
 * of one configuration by construction.
 *
 * ## Why the classifier is imported rather than re-implemented
 *
 * `classifyReply` is the product's own reading of a reply. A copy here would be a second scorer, and the first
 * time the two disagree the tool would be describing its own vocabulary instead of the product's -- the defect
 * `tools/reply-shape-census.mjs` states for itself and `tools/efficiency-frontier.mjs` for every instrument in
 * this directory.
 *
 * Usage:
 *   node tools/paired-delta-census.mjs <control.json> <treatment.json> [--discriminant heading-instantiation] [--json]
 *   node tools/paired-delta-census.mjs --self-test
 */

import { readFileSync } from 'node:fs';
import { classifyReply } from '../packages/cortex-memory/dist/reply-repair.js';

/** The capability order every table in this repository prints in. */
const CAPABILITIES = ['IE', 'MR', 'KU', 'TR', 'ABS'];

/**
 * The arm fields a pair may differ in without the difference meaning anything.
 *
 * Two kinds, and both were learned from artifacts rather than guessed:
 *
 * - `census` fields are counted **after** the questions were answered, so two runs of one configuration
 *   disagree there by design. `admission.mean` is `0.5` in both arms of `45543010618` and its `candidates`
 *   count is not -- one is a floor, the other is how much the floor let through. Refusing on it would make the
 *   gate fire on every honest pair, and a gate that always fires is a gate somebody turns off.
 * - `derived` fields are a function of a declared one, so comparing them would report a **second** violation for
 *   one cause. `askRoutes` is `ASK_ROUTES[ask]`, and a pair that declared `ask` has already said what moved.
 *
 * Anything else -- a model, a width, a room, a rendering, a gate -- is a different experiment when it differs.
 */
const ARM_CENSUS = new Set([
  'admission',
  'censusKeys',
  'effectivePromptChars',
  'goldAccount',
  'selfIndex',
]);
const ARM_DERIVED = new Set(['askRoutes']);

/** A value two artifacts can be compared on, with object keys ordered so a key order is not a drift. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

/**
 * Every field of `memoryArmConfig` the two artifacts disagree about, minus the exempt and the declared.
 *
 * An artifact that carries no `memoryArmConfig` is not compared and the table says so (`compared: false`): the
 * pre-`S9` artifacts genuinely have none, and inventing an equality for them is the defect this whole directory
 * is written against. What it must not do is print *"arms equal"*, which is why the value is a tri-state.
 */
function armDrift(control, treatment) {
  const left = control.report.memoryArmConfig;
  const right = treatment.report.memoryArmConfig;
  if (left === undefined || right === undefined || left === null || right === null) {
    return { compared: false, fields: [] };
  }
  const declared = control.allowArmDrift ?? new Set();
  const names = new Set([...Object.keys(left), ...Object.keys(right)]);
  const fields = [];
  for (const field of [...names].sort()) {
    if (ARM_CENSUS.has(field) || ARM_DERIVED.has(field) || declared.has(field)) continue;
    const a = canonical(left[field]);
    const b = canonical(right[field]);
    if (a !== b) fields.push({ field, control: a, treatment: b, declared: false });
  }
  return { compared: true, fields };
}

/** The arm fields the two artifacts differ in **because the command line said they would**. */
function declaredDrift(control, treatment) {
  const left = control.report.memoryArmConfig ?? {};
  const right = treatment.report.memoryArmConfig ?? {};
  const declared = control.allowArmDrift ?? new Set();
  return [...declared]
    .sort()
    .map((field) => ({
      field,
      control: canonical(left[field]),
      treatment: canonical(right[field]),
    }));
}

/**
 * The reply kinds a lost or gained question is split into.
 *
 * `declined` collapses the two refusal states because the claim being tested is about declines as a population;
 * the four others keep the product's own names so a reader can look one up in `reply-repair.ts`.
 */
const SHAPES = ['declined', 'committed', 'evidence-echo', 'shape-failed'];

function pad(value, width) {
  return String(value).padStart(width);
}

function shapeOf(raw) {
  const kind = classifyReply(raw ?? null);
  return kind === 'bare-decline' || kind === 'prose-decline' ? 'declined' : kind;
}

/**
 * The content terms of a string, by the same stoplist rule the discriminants use.
 *
 * Deliberately crude and deliberately local: a discriminant is a hypothesis about a *rendering*, and the one
 * property every hypothesis here shares is that it must be decidable from the record without a model call. A
 * richer tokenizer would make the predicate harder to state and no easier to falsify.
 */
const STOPWORDS = new Set(
  (
    'a an the of in on at to for and or is are was were be been being i me my we our you your it its this that ' +
    'these those with without from by as what which who whom whose when where why how did do does have has had ' +
    'not no yes if then than so such can could should would will may might must about into over under more most ' +
    'less least all any each every other some own same very just also there their them they he she his her him ' +
    'mention mentions mentioned evidence question answer'
  ).split(' '),
);

function askedTerms(text) {
  const words =
    String(text)
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9'-]*/g) ?? [];
  return new Set(words.filter((word) => word.length > 1 && !STOPWORDS.has(word)));
}

const STEP_HEADING = /^\s*(?:\*\*)?step\s*\d+\b/i;

/**
 * Whether a reply carries a step heading that says nothing about the question it was asked.
 *
 * The hypothesis, stated so it can fail: a two-step contract asks the reader to write `Step 1 -- ...`, and a
 * reader that copies the contract's own generic wording writes a heading whose content terms are disjoint from
 * the question's. A reader that instantiates the contract paraphrases the question into the heading, and the two
 * sets intersect. If the predicate separates lost from kept questions it is a mechanism; if it does not, the
 * numbers below say so and the hypothesis is refused rather than softened.
 */
function uninstantiatedHeading(question, raw) {
  if (typeof raw !== 'string') return false;
  const asked = askedTerms(question);
  if (asked.size === 0) return false;
  for (const line of raw.split('\n')) {
    if (!STEP_HEADING.test(line)) continue;
    const heading = askedTerms(line);
    let shared = false;
    for (const term of heading) {
      if (asked.has(term)) {
        shared = true;
        break;
      }
    }
    if (!shared) return true;
  }
  return false;
}

const DISCRIMINANTS = { 'heading-instantiation': uninstantiatedHeading };

/**
 * One artifact, indexed by question id, optionally narrowed to one capability.
 *
 * ## Why a capability is a population and not a filter applied late
 *
 * A scoped dispatch answers one route's questions and its artifact carries only those, so pairing it against a
 * 500-question control used to be refused on `questionCount` -- correctly, because an intersection of 121 against
 * 500 would print a table neither artifact produced. But the *control* for a scoped run is the same arm at the same
 * load on the same questions, and those questions are a well-defined subset of the control's roster. Narrowing
 * both sides before the population rule runs keeps the rule's meaning (equal populations, no intersection) while
 * letting a 121-question artifact be read against a 500-question one.
 *
 * The scope is carried on the index rather than passed to `pair`, so every refusal message can name the basis it
 * refused on: a reader of *"questionCount differs"* cannot tell whether the two artifacts disagree about a
 * dispatch or about a filter.
 */
function index(report, label, capability, allowArmDrift, side) {
  const all = Array.isArray(report.questions) ? report.questions : [];
  const scoped =
    capability === undefined ? all : all.filter((record) => record.capability === capability);
  const records = side === 'baseline' ? baselineRecords(report, all, scoped) : scoped;
  const byId = new Map();
  for (const record of records) byId.set(record.questionId, record);
  return { label, report, records, byId, scope: capability, allowArmDrift, side };
}

/**
 * One artifact's **baseline** side, as records a reading can pair.
 *
 * ## Why this exists rather than a script in a shell history
 *
 * A paired artifact spells its *feature* side's configuration and stores the baseline side's verdicts only
 * (`ablation.baselineCorrectByRun`), so the ordinary way to read a control that a pairing already ran was a
 * throwaway script. That is the defect this directory is written against: the reading that retired the clock axis
 * (`PREREG-CLOCK-AXIS.md` §6) was taken by one, and a number whose instrument lives in a shell history is a number
 * nobody can re-derive.
 *
 * The vector is **positional over the artifact's own `questions`**, so the index is taken from the unscoped array
 * and a length disagreement is a refusal rather than an off-by-one. Replies are not stored for this side, which
 * the caller can see: `rawOutput` is `null`, and the only table that reads replies is the treatment's.
 */
function baselineRecords(report, all, scoped) {
  const vector = report?.ablation?.baselineCorrectByRun?.[0];
  if (typeof vector !== 'string') {
    throw new Refusal(
      'the artifact stores no baseline verdict vector, so its control side cannot be read',
    );
  }
  if (vector.length !== all.length) {
    throw new Refusal(
      `baseline vector is ${vector.length} verdicts for ${all.length} questions; the vector is positional and ` +
        'an unequal length is a pairing that would be off by an unknown number of questions',
    );
  }
  const position = new Map(all.map((record, at) => [record.questionId, at]));
  return scoped.map((record) => ({
    ...record,
    correct: vector[position.get(record.questionId)] === '1',
    rawOutput: null,
  }));
}

/**
 * A refusal is an exception rather than an exit, so the self-test can assert the refusal.
 *
 * The first draft called `process.exit` here, and the test that followed could only assert that no exception was
 * thrown -- which is the shape of a check that passes because it cannot fail. The self-test now catches it and
 * compares the message, so the population rule is exercised on the same path a real pair takes.
 */
class Refusal extends Error {}

/** The basis every refusal names, so a scoped refusal cannot read as a dispatch disagreement. */
function basis(left, right) {
  if (left.scope === undefined && right.scope === undefined) return '';
  return ` (capability ${left.scope ?? right.scope})`;
}

function pair(control, treatment) {
  if (control.report.dataset !== treatment.report.dataset) {
    throw new Refusal(
      `dataset differs: ${control.report.dataset} against ${treatment.report.dataset}`,
    );
  }
  const drift = armDrift(control, treatment);
  if (drift.fields.length > 0) {
    const named = drift.fields
      .map((entry) => `${entry.field} ${entry.control} against ${entry.treatment}`)
      .join('; ');
    throw new Refusal(
      `arm differs in ${drift.fields.length} field(s): ${named}. A pair is one mechanism, so declare the ` +
        'difference the run was dispatched for (`--allow-arm-drift field[,field]`) or pair the like with the ' +
        'like; a table over two changes answers neither',
    );
  }
  for (const side of [control, treatment]) {
    if (side.records.length === 0) {
      throw new Refusal(`${side.label} artifact carries no question for capability ${side.scope}`);
    }
  }
  if (control.records.length !== treatment.records.length) {
    throw new Refusal(
      `questionCount differs${basis(control, treatment)}: ${control.records.length} against ` +
        `${treatment.records.length}; an intersection would print a table neither artifact produced`,
    );
  }
  const ids = [...control.byId.keys()].filter((id) => treatment.byId.has(id));
  if (ids.length !== control.records.length) {
    throw new Refusal(
      `${control.records.length - ids.length} control question(s) are absent from the treatment artifact`,
    );
  }
  return ids.sort();
}

/** The 2x2, per capability and in total. */
function census(control, treatment, ids) {
  const rows = new Map(
    CAPABILITIES.map((capability) => [
      capability,
      { n: 0, lost: 0, gained: 0, both: 0, neither: 0 },
    ]),
  );
  const lost = [];
  const gained = [];
  for (const id of ids) {
    const left = control.byId.get(id);
    const right = treatment.byId.get(id);
    const row =
      rows.get(left.capability) ??
      rows
        .set(left.capability, { n: 0, lost: 0, gained: 0, both: 0, neither: 0 })
        .get(left.capability);
    row.n += 1;
    const a = left.correct === true;
    const b = right.correct === true;
    if (a && b) row.both += 1;
    else if (a) {
      row.lost += 1;
      lost.push(id);
    } else if (b) {
      row.gained += 1;
      gained.push(id);
    } else row.neither += 1;
  }
  return { rows, lost, gained };
}

function shapeSplit(treatment, ids) {
  const counts = new Map(SHAPES.map((shape) => [shape, 0]));
  for (const id of ids) {
    const shape = shapeOf(treatment.byId.get(id)?.rawOutput);
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  return counts;
}

function discriminantSplit(name, other, side, ids) {
  const predicate = DISCRIMINANTS[name];
  const groups = new Map([
    [true, { matched: 0, correct: 0, lost: 0 }],
    [false, { matched: 0, correct: 0, lost: 0 }],
  ]);
  for (const id of ids) {
    const record = side.byId.get(id);
    const hit = predicate(record.question, record.rawOutput);
    const group = groups.get(hit);
    group.matched += 1;
    if (record.correct === true) group.correct += 1;
    if (other.byId.get(id).correct === true && record.correct !== true) group.lost += 1;
  }
  return groups;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 'n/a' : `${((100 * numerator) / denominator).toFixed(1)}%`;
}

function render(control, treatment, ids, censusResult, options) {
  const lines = [];
  lines.push(
    control.side === 'baseline'
      ? `control   ${control.label}  (${control.records.length} questions, BASELINE side: verdicts from ` +
          '`ablation.baselineCorrectByRun[0]`, replies not stored)'
      : `control   ${control.label}  (${control.records.length} questions)`,
  );
  lines.push(`treatment ${treatment.label}  (${treatment.records.length} questions)`);
  lines.push(`paired    ${ids.length}`);
  const drift = armDrift(control, treatment);
  if (drift.compared) {
    const declared = declaredDrift(control, treatment);
    lines.push(
      declared.length === 0
        ? 'arm       equal on every field outside the census and the derived'
        : `arm       differs only where declared: ${declared
            .map((entry) => `${entry.field} ${entry.control} -> ${entry.treatment}`)
            .join(', ')}`,
    );
    if (control.side === 'baseline') {
      // The artifact spells its FEATURE side's configuration, so a declared field whose value came from the
      // pairing reads inverted here. Said out loud rather than left for a reader to notice, because the line
      // above is otherwise a claim about an arm this table is not reading.
      lines.push(
        '          ...but the control is the BASELINE side, so every field the pairing owns is its feature ' +
          "side's inverse: `resolution` above is the pairing's control, not the arm this table pairs",
      );
    }
  } else {
    lines.push('arm       not comparable (an artifact carries no memoryArmConfig)');
  }
  lines.push('');
  lines.push('| capability |    n | lost | gained | both | neither | net |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  let total = { n: 0, lost: 0, gained: 0, both: 0, neither: 0 };
  for (const [capability, row] of censusResult.rows) {
    if (row.n === 0) continue;
    lines.push(
      `| ${capability} | ${pad(row.n, 3)} | ${pad(row.lost, 4)} | ${pad(row.gained, 6)} | ${pad(row.both, 4)} | ` +
        `${pad(row.neither, 7)} | ${pad(row.gained - row.lost, 3)} |`,
    );
    total = {
      n: total.n + row.n,
      lost: total.lost + row.lost,
      gained: total.gained + row.gained,
      both: total.both + row.both,
      neither: total.neither + row.neither,
    };
  }
  lines.push(
    `| **all** | ${pad(total.n, 3)} | ${pad(total.lost, 4)} | ${pad(total.gained, 6)} | ${pad(total.both, 4)} | ` +
      `${pad(total.neither, 7)} | ${pad(total.gained - total.lost, 3)} |`,
  );
  lines.push('');
  lines.push('| reply shape (treatment) | lost | gained |');
  lines.push('| --- | ---: | ---: |');
  const lostShapes = shapeSplit(treatment, censusResult.lost);
  const gainedShapes = shapeSplit(treatment, censusResult.gained);
  for (const shape of SHAPES) {
    lines.push(
      `| ${shape} | ${pad(lostShapes.get(shape) ?? 0, 4)} | ${pad(gainedShapes.get(shape) ?? 0, 6)} |`,
    );
  }
  if (options.discriminant !== undefined) {
    const groups = discriminantSplit(options.discriminant, control, treatment, ids);
    lines.push('');
    lines.push(`discriminant: ${options.discriminant}`);
    lines.push('| group | matched | correct (treatment) | accuracy | lost |');
    lines.push('| --- | ---: | ---: | ---: | ---: |');
    for (const [name, key] of [
      ['predicate true', true],
      ['predicate false', false],
    ]) {
      const group = groups.get(key);
      lines.push(
        `| ${name} | ${group.matched} | ${group.correct} | ${ratio(group.correct, group.matched)} | ${group.lost} |`,
      );
    }
  }
  return lines.join('\n');
}

function load(path, label, capability, allowArmDrift, side) {
  return index(JSON.parse(readFileSync(path, 'utf8')), label, capability, allowArmDrift, side);
}

function main(argv) {
  if (argv.includes('--self-test')) {
    selfTest();
    return 0;
  }
  const positional = [];
  let discriminant;
  let capability;
  let allowArmDrift;
  let controlSide;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--discriminant') {
      discriminant = argv[(index += 1)];
      continue;
    }
    if (argument === '--capability') {
      capability = argv[(index += 1)];
      continue;
    }
    if (argument === '--control-side') {
      const value = argv[(index += 1)];
      if (value !== 'feature' && value !== 'baseline') {
        process.stderr.write(`refused: unknown control side ${JSON.stringify(value)}\n`);
        return 1;
      }
      controlSide = value;
      continue;
    }
    if (argument === '--allow-arm-drift') {
      const value = argv[(index += 1)] ?? '';
      allowArmDrift = new Set(
        value
          .split(',')
          .map((field) => field.trim())
          .filter((field) => field.length > 0),
      );
      continue;
    }
    if (argument.startsWith('--')) continue;
    positional.push(argument);
  }
  if (discriminant !== undefined && DISCRIMINANTS[discriminant] === undefined) {
    process.stderr.write(`refused: unknown discriminant ${JSON.stringify(discriminant)}\n`);
    return 1;
  }
  if (positional.length !== 2) {
    process.stderr.write(
      'usage: paired-delta-census.mjs <control.json> <treatment.json> [--capability <NAME>] ' +
        '[--control-side baseline|feature] [--allow-arm-drift <field[,field]>] ' +
        '[--discriminant <name>] [--json]\n',
    );
    return 1;
  }
  let ids;
  let control;
  let treatment;
  try {
    control = load(positional[0], 'control', capability, allowArmDrift, controlSide);
    treatment = load(positional[1], 'treatment', capability, allowArmDrift, undefined);
    ids = pair(control, treatment);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    process.stderr.write(`refused: ${error.message}\n`);
    return 1;
  }
  const counted = census(control, treatment, ids);
  if (argv.includes('--json')) {
    const payload = {
      paired: ids.length,
      armDrift: {
        compared: armDrift(control, treatment).compared,
        declared: declaredDrift(control, treatment),
      },
      lost: counted.lost,
      gained: counted.gained,
      byCapability: Object.fromEntries(counted.rows),
      lostShapes: Object.fromEntries(shapeSplit(treatment, counted.lost)),
      gainedShapes: Object.fromEntries(shapeSplit(treatment, counted.gained)),
      ...(discriminant === undefined
        ? {}
        : {
            discriminant: {
              name: discriminant,
              treatment: Object.fromEntries(
                [...discriminantSplit(discriminant, control, treatment, ids)].map(
                  ([key, value]) => [String(key), value],
                ),
              ),
              control: Object.fromEntries(
                [...discriminantSplit(discriminant, treatment, control, ids)].map(
                  ([key, value]) => [String(key), value],
                ),
              ),
            },
          }),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 1)}\n`);
    return 0;
  }
  process.stdout.write(`${render(control, treatment, ids, counted, { discriminant })}\n`);
  return 0;
}

/**
 * The self-test builds the pair rather than reading one.
 *
 * A tool whose only exercise is a real artifact cannot be run on a machine without that artifact, and the three
 * properties below are the ones a real artifact is worst at proving: a net of zero that hides a symmetric
 * movement, a refusal on a mismatched population, and a shape split that must not be inferred from the net.
 */
function selfTest() {
  const record = (id, capability, correct, rawOutput, question = 'how many items did I buy') => ({
    questionId: id,
    capability,
    correct,
    rawOutput,
    question,
  });
  /**
   * The arm both fixture sides carry.
   *
   * Small on purpose: the gate compares every key it is given, so a fixture that spelled all thirty-eight would
   * be a second copy of `arm-config-baseline.json` and the first time the two disagreed this test would be
   * testing the copy. The keys here are the two the drift cases below move, plus one of each exempt class.
   */
  const arm = (overrides = {}) => ({
    ask: 'verbatim-acts',
    askRoutes: ['multi-session'],
    admission: { candidates: 10, admitted: 10 },
    resolution: 'layered',
    maxTurnChars: 400,
    ...overrides,
  });
  const control = index(
    {
      dataset: 'fixture',
      questionCount: 7,
      memoryArmConfig: arm(),
      questions: [
        record('q1', 'MR', true, 'Step 1 - list every item matching what I bought\n- one\n\n4'),
        record('q2', 'MR', false, 'INSUFFICIENT_EVIDENCE'),
        record('q3', 'TR', true, '2023/05/20'),
        record('q4', 'ABS', true, 'INSUFFICIENT_EVIDENCE'),
        record('q5', 'KU', true, '4'),
        record('q6', 'IE', false, 'I am not sure'),
        record('q7', 'IE', false, 'unclear'),
      ],
    },
    'control',
  );
  const treatment = index(
    {
      dataset: 'fixture',
      questionCount: 7,
      memoryArmConfig: arm(),
      questions: [
        record('q1', 'MR', false, 'INSUFFICIENT_EVIDENCE'),
        record('q2', 'MR', true, '4'),
        record('q3', 'TR', true, '2023/05/20'),
        record('q4', 'ABS', true, 'INSUFFICIENT_EVIDENCE'),
        record(
          'q5',
          'KU',
          false,
          'Step 1 - list every item in the evidence that matches the question',
        ),
        record('q6', 'IE', false, 'I am not sure'),
        record('q7', 'IE', true, '4'),
      ],
    },
    'treatment',
  );
  const ids = pair(control, treatment);
  assertEqual(ids.length, 7, 'pairing keeps every shared id');
  const counted = census(control, treatment, ids);
  assertEqual(counted.rows.get('MR').lost, 1, 'MR loses one');
  assertEqual(counted.rows.get('MR').gained, 1, 'MR gains one');
  assertEqual(counted.rows.get('ABS').lost, 0, 'ABS loses none');
  assertEqual(
    counted.gained.length - counted.lost.length,
    0,
    'the net is zero and the movement is not',
  );
  assertEqual(counted.gained.length, 2, 'two questions moved up');
  const lostShapes = shapeSplit(treatment, counted.lost);
  assertEqual(lostShapes.get('declined'), 1, 'one loss is a decline');
  assertEqual(
    lostShapes.get('committed'),
    1,
    'the other loss is a well-formed reply that answers the wrong thing',
  );
  assertEqual(lostShapes.get('shape-failed'), 0, 'and neither loss is a contract violation');
  assertEqual(
    uninstantiatedHeading('how many items did I buy', treatment.byId.get('q5').rawOutput),
    true,
    'generic heading is uninstantiated',
  );
  assertEqual(
    uninstantiatedHeading('how many items did I buy', treatment.byId.get('q1').rawOutput),
    false,
    'instantiated heading is not',
  );
  const groups = discriminantSplit('heading-instantiation', control, treatment, ids);
  assertEqual(groups.get(true).matched, 1, 'the discriminant selects one treatment record');
  assertEqual(groups.get(true).correct, 0, 'and that record is wrong');
  assertEqual(groups.get(false).matched, 6, 'every other record is in the negative group');

  let refusal = null;
  try {
    pair(
      control,
      index(
        { dataset: 'fixture', questionCount: 3, questions: treatment.records.slice(0, 3) },
        'short',
      ),
    );
  } catch (error) {
    refusal = error;
  }
  assertEqual(refusal instanceof Refusal, true, 'a population mismatch is refused');
  assertEqual(
    /questionCount differs/.test(refusal.message),
    true,
    'and the refusal names the population',
  );

  let datasetRefusal = null;
  try {
    pair(
      control,
      index({ dataset: 'other', questionCount: 7, questions: treatment.records }, 'other'),
    );
  } catch (error) {
    datasetRefusal = error;
  }
  assertEqual(datasetRefusal instanceof Refusal, true, 'a dataset mismatch is refused');

  // A scoped pair: the control is the whole file, the treatment is one route's questions, and the two must be
  // equal *after* the scope is applied. This is the shape every capability-scoped dispatch produces.
  const scopedControl = index(
    { dataset: 'fixture', questionCount: 7, questions: control.records },
    'control',
    'MR',
  );
  const scopedTreatment = index(
    { dataset: 'fixture', questionCount: 7, questions: treatment.records },
    'treatment',
    'MR',
  );
  const scopedIds = pair(scopedControl, scopedTreatment);
  assertEqual(scopedIds.length, 2, 'the scope narrows both sides to the same two questions');
  const scopedCounted = census(scopedControl, scopedTreatment, scopedIds);
  assertEqual(scopedCounted.rows.get('MR').lost, 1, 'and the 2x2 is over those two');
  let scopedRefusal = null;
  try {
    pair(
      scopedControl,
      index(
        { dataset: 'fixture', questionCount: 7, questions: [treatment.records[0]] },
        'treatment',
        'MR',
      ),
    );
  } catch (error) {
    scopedRefusal = error;
  }
  assertEqual(scopedRefusal instanceof Refusal, true, 'a scoped population mismatch is refused');
  assertEqual(
    /questionCount differs \(capability MR\)/.test(scopedRefusal.message),
    true,
    'and the refusal names the capability, so it cannot read as a dispatch disagreement',
  );
  let emptyRefusal = null;
  try {
    pair(
      index({ dataset: 'fixture', questionCount: 7, questions: control.records }, 'control', 'ZZ'),
      scopedTreatment,
    );
  } catch (error) {
    emptyRefusal = error;
  }
  assertEqual(
    emptyRefusal instanceof Refusal,
    true,
    'a capability the artifact does not carry is refused',
  );
  assertEqual(
    /carries no question for capability ZZ/.test(emptyRefusal.message),
    true,
    'and says which side',
  );

  // -- the arm gate ----------------------------------------------------------------------------------------
  //
  // The reading that motivated it: a 121-question clock-axis artifact was paired against the shipped arm and the
  // table printed -6 questions, every one of which belonged to `resolution: layered -> raw`. The population rule
  // passed, because both sides held the same 121 ids and the same dataset. Nothing in the table could say the
  // configuration had moved, so the number was quoted as if the ask had moved it.
  const withArm = (overrides) =>
    index(
      {
        dataset: 'fixture',
        questionCount: 7,
        memoryArmConfig: arm(overrides),
        questions: control.records,
      },
      'treatment',
    );
  assertEqual(pair(control, withArm({})).length, 7, 'equal arms pair');
  assertEqual(
    armDrift(control, withArm({})).fields.length,
    0,
    'and the gate finds nothing to refuse',
  );
  let censusOnly = null;
  try {
    censusOnly = pair(
      control,
      withArm({ admission: { candidates: 999, admitted: 999 }, selfIndex: { indexes: 3 } }),
    );
  } catch (error) {
    censusOnly = error;
  }
  assertEqual(
    Array.isArray(censusOnly) && censusOnly.length === 7,
    true,
    'a census difference is not a drift: two runs of one configuration disagree there by design',
  );
  let derivedOnly = null;
  try {
    derivedOnly = pair(control, withArm({ askRoutes: ['multi-session', 'flat'] }));
  } catch (error) {
    derivedOnly = error;
  }
  assertEqual(
    Array.isArray(derivedOnly) && derivedOnly.length === 7,
    true,
    'a derived difference is not a drift, or one cause would be reported twice',
  );
  let armRefusal = null;
  try {
    pair(control, withArm({ resolution: 'raw' }));
  } catch (error) {
    armRefusal = error;
  }
  assertEqual(armRefusal instanceof Refusal, true, 'an undeclared arm difference is refused');
  assertEqual(
    /arm differs in 1 field\(s\): resolution "layered" against "raw"/.test(armRefusal.message),
    true,
    'and the refusal names the field and both values',
  );
  assertEqual(
    /--allow-arm-drift/.test(armRefusal.message),
    true,
    'and says how to declare it, because a refusal with no path forward is a wall',
  );
  const declaredPair = index(
    { dataset: 'fixture', questionCount: 7, memoryArmConfig: arm(), questions: control.records },
    'control',
    undefined,
    new Set(['ask']),
  );
  const declaredOther = index(
    {
      dataset: 'fixture',
      questionCount: 7,
      memoryArmConfig: arm({ ask: 'verbatim-clock' }),
      questions: control.records,
    },
    'treatment',
    undefined,
    new Set(['ask']),
  );
  assertEqual(pair(declaredPair, declaredOther).length, 7, 'a declared difference pairs');
  assertEqual(
    declaredDrift(declaredPair, declaredOther)[0].field,
    'ask',
    'and the declaration is what the table prints',
  );
  assertEqual(
    /"verbatim-acts" -> "verbatim-clock"/.test(
      declaredDrift(declaredPair, declaredOther)
        .map((entry) => `${entry.control} -> ${entry.treatment}`)
        .join(),
    ),
    true,
    'with both values, so the reading cannot be quoted without them',
  );
  const noArm = index({ dataset: 'fixture', questionCount: 7, questions: control.records }, 'old');
  assertEqual(
    armDrift(noArm, withArm({ resolution: 'raw' })).compared,
    false,
    'an artifact with no memoryArmConfig is not compared rather than assumed equal',
  );
  assertEqual(pair(noArm, withArm({ resolution: 'raw' })).length, 7, 'and it still pairs');

  // -- the baseline side -----------------------------------------------------------------------------------
  //
  // A paired artifact stores the control side's verdicts only. Reading it used to be a throwaway script, which is
  // how the reading in `PREREG-CLOCK-AXIS.md` §6 was taken and why it could not be re-derived. The vector is
  // positional, so both its content and its length are asserted here.
  const pairedReport = {
    dataset: 'fixture',
    questionCount: 7,
    memoryArmConfig: arm(),
    questions: control.records,
    // Deliberately the INVERSE of the fixture's own `correct` flags on q1 and q2, so a reader that kept them
    // instead of reading the vector would pass a `true` where the vector says `false`.
    ablation: { baselineCorrectByRun: ['0100000', '0100000'] },
  };
  const fromBaseline = index(pairedReport, 'control', undefined, undefined, 'baseline');
  assertEqual(fromBaseline.records[0].correct, false, 'the vector decides the baseline verdict');
  assertEqual(fromBaseline.records[1].correct, true, 'and it is read by position, not by luck');
  assertEqual(fromBaseline.records[0].rawOutput, null, 'the control side stores no replies');
  assertEqual(fromBaseline.records.length, 7, 'and every question is carried');
  let vectorRefusal = null;
  try {
    index(
      { ...pairedReport, ablation: { baselineCorrectByRun: ['100000'] } },
      'control',
      undefined,
      undefined,
      'baseline',
    );
  } catch (error) {
    vectorRefusal = error;
  }
  assertEqual(vectorRefusal instanceof Refusal, true, 'a short vector is refused');
  assertEqual(
    /positional/.test(vectorRefusal.message),
    true,
    'and the refusal says why a length matters',
  );
  let noVectorRefusal = null;
  try {
    index(
      { dataset: 'fixture', questionCount: 7, questions: control.records },
      'control',
      undefined,
      undefined,
      'baseline',
    );
  } catch (error) {
    noVectorRefusal = error;
  }
  assertEqual(noVectorRefusal instanceof Refusal, true, 'an artifact with no vector is refused');
  // The scoped read: the vector stays positional over the whole artifact while the records are narrowed.
  const scopedBaseline = index(pairedReport, 'control', 'MR', undefined, 'baseline');
  assertEqual(scopedBaseline.records.length, 2, 'the capability narrows the baseline side too');
  assertEqual(
    scopedBaseline.records[0].correct,
    false,
    'and the verdict still comes from the question own position',
  );
  assertEqual(
    scopedBaseline.records[1].correct,
    true,
    'including for the second scoped record, whose position is one further down the vector',
  );

  process.stdout.write('paired-delta-census: self-test ok\n');
}

function assertEqual(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('paired-delta-census.mjs')) {
  process.exit(main(process.argv.slice(2)));
}

export { census, discriminantSplit, pair, shapeSplit, uninstantiatedHeading };
