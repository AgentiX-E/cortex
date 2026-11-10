/**
 * The plan prompt: a question, a schema, and a table of what each keyword in the question selects.
 *
 * ## Why this prompt carries no evidence
 *
 * The tally pass re-read the window and cost +98.4% of the feature arm's completion tokens. This pass
 * carries a *compiled summary* instead -- the ledger's schema and a table of per-keyword counts -- and
 * the table is built by program from the same history. The difference in cost is the whole difference
 * between the two passes, and it is a design decision rather than a tuning one: the reader is not
 * being asked to read again, it is being asked to *choose* from a table.
 *
 * ## Why the table exists at all
 *
 * Because the autopsy of the last pass located the failure in operand selection, and asking a model to
 * name the operand from memory is the same failure with fewer words. The table converts "decide which
 * quantity counts" into "read the row whose count is the answer", which is a smaller judgement over a
 * smaller object. It is also the part of this design that a retrieval-only baseline cannot copy: the
 * table is a property of a ledger that exists before the question, so its cost is amortised and its
 * contents are checkable.
 *
 * ## Why the contract is one JSON object and a stated refusal
 *
 * Because the parser refuses rather than defaults (`parseEventSpec`), and a prompt that does not say
 * so produces prose that the parser then refuses -- which reads in the census as a model failure when
 * it was a missing sentence. `{"refuse": "no-plan"}` is named explicitly for the same reason: the
 * honest response to "no plan expresses this answer" has to be available, or the model will write
 * *some* plan and the arm will compute a number nobody asked for.
 *
 * ## What it does not carry, and why
 *
 * No dates per row, no turn text, no sample turns. A sample row would anchor the model on a row
 * rather than on the question, and it would also make the prompt's cost a function of the corpus
 * rather than of the question. The unit list is the exception: units are how a sum says *which*
 * numbers, and a model that does not know `pages` exists cannot write a plan that sums pages.
 */

import { ledgerVocabulary, type Ledger } from './ledger.js';
import { mentions } from './execute.js';
import { questionKeywords } from './keywords.js';

/** What one keyword selects, computed once and rendered into the prompt. */
type KeywordRow = {
  readonly keyword: string;
  /** Turns containing the keyword, case-insensitively. */
  readonly turns: number;
  /** Of those, turns that state at least one number. */
  readonly withNumber: number;
  /** Sums by unit over those turns, `null` for numbers with no unit, sorted by unit. */
  readonly sums: readonly { readonly unit: string; readonly total: number }[];
};

/** The table the prompt carries, and the ledger it was computed from. */
type PlanTable = {
  readonly steps: number;
  readonly sessions: number;
  readonly roles: readonly string[];
  readonly firstDate: string | null;
  readonly lastDate: string | null;
  readonly rows: readonly KeywordRow[];
};

/**
 * Build the keyword table.
 *
 * A turn containing the keyword contributes **every** number it states to the corresponding unit's
 * sum, which is what a `sum` plan over that keyword will also do. The table is therefore not an
 * estimate: it reports exactly what the executor would return, so a model reading the table and
 * choosing `sum` over keyword `sold` in unit `$` is choosing a number it has already seen. That
 * equivalence is the point of compiling the table from the same rows the executor runs on, and it is
 * the property the prompt's tests pin.
 */
export function buildPlanTable(ledger: Ledger, keywords: readonly string[]): PlanTable {
  const vocabulary = ledgerVocabulary(ledger);
  const rows: KeywordRow[] = [];
  for (const keyword of keywords) {
    const lowered = keyword.toLowerCase();
    let turns = 0;
    let withNumber = 0;
    const totals = new Map<string, number>();
    for (const row of ledger.rows) {
      // The executor's own predicate, not a second copy of it: a table that counted with `includes`
      // while the executor counted with word-starts would report one number and compute another.
      if (!mentions(row.text, lowered)) continue;
      turns += 1;
      if (row.numbers.length > 0) withNumber += 1;
      for (const number of row.numbers) {
        const unit = number.unit ?? '(none)';
        totals.set(unit, (totals.get(unit) ?? 0) + number.value);
      }
    }
    rows.push({
      keyword,
      turns,
      withNumber,
      sums: [...totals.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([unit, total]) => ({ unit, total: Math.round(total * 1e6) / 1e6 })),
    });
  }
  return {
    steps: vocabulary.steps,
    sessions: vocabulary.sessions,
    roles: vocabulary.roles,
    firstDate: vocabulary.firstDate,
    lastDate: vocabulary.lastDate,
    rows,
  };
}

/** One table row as the prompt writes it. */
function renderRow(row: KeywordRow): string {
  const sums =
    row.sums.length === 0 ? '-' : row.sums.map((sum) => `${sum.unit}=${sum.total}`).join(', ');
  return `| ${row.keyword} | ${row.turns} | ${row.withNumber} | ${sums} |`;
}

/** A plan prompt, with the keywords it offered so the caller can record them. */
type PlanPrompt = {
  readonly prompt: string;
  readonly keywords: readonly string[];
};

/**
 * Build the plan prompt for a question over a compiled ledger.
 *
 * `ledger.steps` bounds the scope the prompt advertises, and the parser enforces the same bound, so a
 * model that copies `[0, steps - 1]` from the prompt is writing a plan this executor can run.
 */
export function buildSpecPrompt(question: string, ledger: Ledger): PlanPrompt {
  const keywords = questionKeywords(question);
  const table = buildPlanTable(ledger, keywords);
  const span =
    table.firstDate === null || table.lastDate === null
      ? 'no timestamps'
      : `${table.firstDate} to ${table.lastDate}`;

  const lines = [
    'ANSWER BY PLAN',
    '',
    `A program has compiled this history into a ledger: ${table.steps} turns in ${table.sessions} sessions, ` +
      `${span}, spoken by ${table.roles.join(' and ')}. Every turn is one row with \`step\` (0 to ` +
      `${table.steps - 1}), \`session\`, \`date\`, \`role\`, \`text\`, and the \`numbers\` the turn states with ` +
      'the unit the source attached to each.',
    '',
    'This table was computed from that ledger. Each row is one keyword from the question: how many turns ' +
      'contain it, how many of those state a number, and the sum of those numbers by unit.',
    '',
    '| keyword | turns | with a number | sums |',
    '| --- | --- | --- | --- |',
    ...table.rows.map(renderRow),
    '',
    'Write ONE JSON object and nothing else. You are choosing a plan; a program will run it and the ' +
      'result becomes the answer. Do not count or add anything yourself.',
    '',
    `{"scope": [0, ${table.steps - 1}], "predicates": [{"field": "text", "op": "contains", "value": "<keyword>"}], "operation": "count"}`,
    '',
    '- `"count"` returns how many turns the predicates select.',
    '- `"sum"` adds the numbers stated by the selected turns. Add ' +
      '`{"field": "number", "op": "unit-is", "value": "$"}` to a `sum` plan to add one unit only; ' +
      'without it, numbers of different units are added together and the result is discarded.',
    `- \`scope\` is inclusive and must lie inside \`0\` to \`${table.steps - 1}\`. A \`date\` predicate ` +
      'takes `{"field": "date", "op": "on-or-after", "value": "YYYY/MM/DD"}` (or `on-or-before`), and ' +
      '`{"field": "role", "op": "is", "value": "user"}` restricts the speaker.',
    '',
    'If no plan here can produce the answer the question wants, write {"refuse": "no-plan"} and the ' +
      'first answer stands. A plan that selects no turn produces nothing, which is also reported.',
    '',
    `QUESTION: ${question}`,
  ];

  return { prompt: lines.join('\n'), keywords };
}
