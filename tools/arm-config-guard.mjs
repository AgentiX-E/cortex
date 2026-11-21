#!/usr/bin/env node
/**
 * Does every dispatch send the arm the registration records?
 *
 * ## The defect this file exists for, which is the fourth instance of one class
 *
 * `tools/arm-config-record.py` compares `tools/arm-config-baseline.json` against the dispatch table
 * (`dispatch-cortex-memory-ab.py`'s `INPUTS`) and against `docs/PREREGISTRATION-...` §10.3. Three
 * copies, one gate, and the gate was green — because **the workflows were not one of the copies.**
 * They are the copies that actually run.
 *
 * `semantic-carry.yml` sent `temporal: 48000` where the registration says `24000`,
 * `relevance: retrieval-anchored` where it says `self-index`, and `thinking: disabled` where it says
 * `multi-session+temporal`. Its published reading (87.00%) was therefore taken on an arm with three
 * undeclared departures, and every gate in the repository passed, because no gate read a workflow.
 *
 * That is the same shape as the paragraph `arm-config-record.py` opens with, one layer out: a value
 * that the documents agree on and the run does not. The lesson it records is that a fourth copy of
 * the numbers does not fix it. What fixes it is reading the copy that executes.
 *
 * ## What it checks
 *
 * For every workflow under `.github/workflows`, every line that sets a variable the registry owns:
 *
 *   - the **spelled value** must equal the registered value, or
 *   - the expression must resolve to it through an input whose declared `default:` is right, or
 *   - the line must carry an `# arm-config: <VAR> departs — <reason>` comment on itself or the line
 *     above it.
 *
 * The third case is the escape hatch and it is deliberately loud: an exemption is printed in the run
 * output with its reason, so a departure is a decision somebody wrote down rather than a value that
 * quietly stopped matching. A gate that cannot be stepped away from gets deleted; a gate whose
 * exemptions are listed in every green run does not.
 *
 * ## What it does not check
 *
 * It does not check whether the registered values are *good*. That is `adoptedBy`'s job and the
 * dispatch that priced them. It does not read `$GITHUB_ENV` produced by `arm-config-env.mjs` either,
 * because a value written at run time is not in the file — that emitter exists so that a workflow
 * can stop spelling values at all, and this guard's job is the files that still do.
 *
 * Usage:
 *
 *     node tools/arm-config-guard.mjs
 *     node tools/arm-config-guard.mjs --workflows /tmp/fixture --baseline /tmp/baseline.json
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

const WORKFLOWS = path.resolve(flag('--workflows') ?? path.join(REPO, '.github/workflows'));
const BASELINE = path.resolve(flag('--baseline') ?? path.join(REPO, 'tools/arm-config-baseline.json'));

/**
 * The four registry keys whose environment variable is not just the upper-cased key.
 *
 * `cortex_memory_ask` -> `CORTEX_MEMORY_ASK` is a spelling rule, so it is computed rather than listed:
 * a new arm option should reach this guard by existing in the artifact, not by somebody remembering to
 * add a row here. The reader's three are listed because they live under a different prefix — the
 * artifact names them `model`, `temperature` and `thinking` because that is what they are, and the
 * workflow names them `DEEPSEEK_*` because that is the provider that served every archived run.
 */
const RENAMED = new Map([
  ['model', 'DEEPSEEK_MODEL'],
  ['temperature', 'DEEPSEEK_TEMPERATURE'],
  ['thinking', 'DEEPSEEK_THINKING'],
]);

/** How a value is spelled in the artifact, as the string a workflow would write. */
function spelling(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.join(',');
  if (typeof value === 'object' && typeof value.provider === 'string') return value.provider;
  // A map (the room table, for instance) is spelled the way the dispatch spells it.
  return Object.entries(value)
    .map(([route, width]) => `${route}:${width}`)
    .join(',');
}

/** Every variable the registry owns, with the value it must carry. */
function registry(baseline) {
  const out = new Map();
  for (const [key, value] of Object.entries(baseline.dispatch ?? {})) {
    const name = RENAMED.get(key) ?? key.toUpperCase();
    out.set(name, { key, value: String(value) });
  }
  return out;
}

/** The declared defaults of one workflow's `workflow_dispatch.inputs` and of its `workflow_call` form. */
function declaredDefaults(source) {
  const defaults = new Map();
  const lines = source.split('\n');
  let inputsIndent = null;
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const indent = line.length - line.trimStart().length;
    if (/^workflow_dispatch:\s*$/.test(trimmed) || /^workflow_call:\s*$/.test(trimmed)) {
      inputsIndent = null;
      current = null;
      continue;
    }
    if (/^inputs:\s*$/.test(trimmed)) {
      inputsIndent = indent + 2;
      current = null;
      continue;
    }
    if (inputsIndent !== null && indent < inputsIndent) {
      inputsIndent = null;
      current = null;
    }
    if (inputsIndent === null) continue;
    if (indent === inputsIndent) {
      current = trimmed.endsWith(':') ? trimmed.slice(0, -1).trim() : null;
      continue;
    }
    if (current !== null && /^default:/.test(trimmed)) {
      const raw = trimmed.slice('default:'.length).trim();
      defaults.set(current, unquote(raw));
      current = null;
    }
  }
  return defaults;
}

function unquote(raw) {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * The literal an expression falls back to, when it has one.
 *
 * `${{ inputs.ask || 'verbatim-acts' }}` resolves to the literal when the input is empty, and to the
 * input's declared default otherwise — which is the same string whenever the default is right. Both
 * are checked below, so a workflow that spells a stale fallback *and* a right default is reported:
 * that pair is exactly how `benchmark.yml` would look after one of its two values was updated.
 */
function fallbackLiteral(raw) {
  const match = /\|\|\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z0-9._-]+))\s*\}\}/.exec(raw);
  if (match !== null) return match[1] ?? match[2] ?? match[3];
  const bare = /^\$\{\{\s*(?:github\.event\.)?(?:inputs|vars)\.([A-Za-z0-9_-]+)\s*\}\}/.exec(raw);
  if (bare !== null) return { input: bare[1] };
  const plain = /^\$\{\{\s*'([^']*)'\s*\}\}$/.exec(raw);
  if (plain !== null) return plain[1];
  return undefined;
}

/** The input an expression names, when it names one. */
function namedInput(raw) {
  const match = /(?:inputs|github\.event\.inputs)\.([A-Za-z0-9_-]+)/.exec(raw);
  return match === null ? undefined : match[1];
}

/**
 * The variables whose value is deliberately **not** written here, and why.
 *
 * One entry, and it exists because the alternative is worse. `cortex_memory_max_prompt_chars` defers to
 * `REGISTERED_ROOMS` in the product: the table ships, is pinned to this baseline by
 * `assemble-rooms.test.ts` and `registered-arm.test.ts`, and `tools/__tests__/test_prompt_budget_parity.py`
 * refuses a literal here on the argument that a default in the workflow would be a third copy that no test
 * reads. That argument is right for this key and wrong for the other fifteen, which have no single product
 * constant to defer to — so they spell the registration, and this one says in the gate that it does not.
 */
const DEFERRED = new Map([
  [
    'CORTEX_MEMORY_MAX_PROMPT_CHARS',
    'the arm reads `REGISTERED_ROOMS`, which is pinned to this baseline by two tests; a literal here ' +
      'would be the third copy `test_prompt_budget_parity.py` refuses',
  ],
]);

const EXEMPT = /#\s*arm-config:\s*([A-Z0-9_]+)\s+departs\b\s*[—–:-]\s*(.+)$/;

/**
 * A whole-file departure, for the workflows that exist to replay an arm the registration has left.
 *
 * `restore-counterfactual.yml` re-runs an archived configuration; every value it spells is a historical
 * one by design, and five line-level exemptions would restate the file's purpose five times. The marker
 * still has to give a reason, and it is still printed in every run.
 */
const FILE_EXEMPT = /#\s*arm-config:\s*file\s+departs\b\s*[—–:-]\s*(.+)$/m;

/** One file's lines, with a variable assignment on each line the guard can read. */
function assignments(source) {
  const lines = source.split('\n');
  return lines.flatMap((line, index) => {
    const match = /^(\s*)([A-Z][A-Z0-9_]*):\s*(.+?)\s*$/.exec(line);
    if (match === null) return [];
    const [, indent, name, raw] = match;
    // A comment on the line itself, or anywhere in the comment block directly above it. The block
    // rather than the single line above, because the reasons worth writing are longer than one line
    // and a rule that forces them into one produces a reason nobody reads.
    const inline = EXEMPT.exec(raw);
    let exemption = inline;
    for (let above = index - 1; above >= 0 && exemption === null; above -= 1) {
      const line2 = lines[above] ?? '';
      if (!/^\s*#/.test(line2)) break;
      exemption = EXEMPT.exec(line2);
    }
    if (exemption === null) exemption = undefined;
    return [
      {
        name,
        indent: indent.length,
        raw: raw.replace(/\s+#.*$/, '').trim(),
        line: index + 1,
        exempt: exemption === undefined ? undefined : { name: exemption[1], reason: exemption[2].trim() },
      },
    ];
  });
}

export function inspect({ workflows, baseline }) {
  const owned = registry(baseline);
  const defects = [];
  const exemptions = [];
  /** The workflows that dispatch the memory arm, which is the set this guard claims to have read. */
  const inspected = [];
  const files = readdirSync(workflows)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();

  for (const file of files) {
    const source = readFileSync(path.join(workflows, file), 'utf8');
    // Scope: a workflow is dispatching the memory arm only if it spells a variable the arm owns. The
    // natural-language pipeline (`benchmark.yml`) sets `DEEPSEEK_*` and no `CORTEX_MEMORY_*`, and the
    // registry is not a claim about its reader.
    if (!/^\s*CORTEX_MEMORY_[A-Z0-9_]+:/m.test(source)) continue;
    inspected.push(file);
    const fileExempt = FILE_EXEMPT.exec(source);
    if (fileExempt !== null) {
      exemptions.push(`${file} departs as a file: ${fileExempt[1].trim()}`);
      continue;
    }
    const defaults = declaredDefaults(source);
    for (const assignment of assignments(source)) {
      const entry = owned.get(assignment.name);
      if (entry === undefined) continue;
      const where = `${file}:${assignment.line} ${assignment.name}`;

      if (assignment.exempt !== undefined) {
        if (assignment.exempt.name !== assignment.name) {
          defects.push(
            `${where} carries an exemption for ${assignment.exempt.name}, which is a different ` +
              'variable. An exemption that does not name the line it exempts licenses every value ' +
              'the file will ever hold.',
          );
          continue;
        }
        exemptions.push(`${where} departs: ${assignment.exempt.reason}`);
        continue;
      }

      // A line without an expression is its own literal; `'0'`, `0` and `"0"` all send `0`.
      const spelled = unquote(assignment.raw);
      const literal = spelled.includes('${{') ? fallbackLiteral(spelled) : spelled;
      if (typeof literal === 'object' && literal !== null) {
        // A bare `${{ inputs.x }}`: the value is whatever the input's default is.
        const declared = defaults.get(literal.input);
        if (declared === '' && DEFERRED.has(assignment.name)) {
          exemptions.push(`${where} defers: ${DEFERRED.get(assignment.name)}`);
          continue;
        }
        if (declared === undefined) {
          defects.push(
            `${where} reads input \`${literal.input}\`, which this workflow does not declare a ` +
              'default for, so the value is whatever the dispatcher types.',
          );
        } else if (declared !== entry.value) {
          defects.push(
            `${where} sends the declared default ${JSON.stringify(declared)} and the registration ` +
              `is ${JSON.stringify(entry.value)} (dispatch \`${entry.key}\`).`,
          );
        }
        continue;
      }
      if (literal === undefined) {
        // An expression this guard cannot reduce. Fail closed: an unreadable value on a registry key
        // is a value nobody can compare, which is the state every drift started from.
        defects.push(
          `${where} reads \`${assignment.raw}\`, which this guard cannot reduce to a value. Write a ` +
            'literal, a `||` fallback, or a bare `${{ inputs.x }}` with a declared default.',
        );
        continue;
      }
      if (String(literal) !== entry.value) {
        defects.push(
          `${where} sends ${JSON.stringify(String(literal))} and the registration is ` +
            `${JSON.stringify(entry.value)} (dispatch \`${entry.key}\`).`,
        );
      }

      // A `||` fallback is compared too, because it is the value a dispatch gets when the input is
      // cleared -- and the default and the fallback disagreeing is a drift that only fires on the
      // dispatch nobody re-reads.
      const input = namedInput(assignment.raw);
      if (input !== undefined) {
        const declared = defaults.get(input);
        if (declared !== undefined && declared !== entry.value) {
          defects.push(
            `${where} declares \`${input}\`'s default as ${JSON.stringify(declared)} and the ` +
              `registration is ${JSON.stringify(entry.value)} (dispatch \`${entry.key}\`).`,
          );
        }
      }
    }
  }

  return { defects, exemptions, files: inspected };
}

function main() {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  } catch (error) {
    process.stderr.write(`arm-config-guard: ${BASELINE} cannot be read: ${error.message}\n`);
    process.exit(1);
  }
  if (baseline.dispatch === undefined) {
    process.stderr.write(
      `arm-config-guard: ${BASELINE} carries no \`dispatch\` block, so no workflow can be checked ` +
        'against it.\n',
    );
    process.exit(1);
  }

  const { defects, exemptions, files } = inspect({ workflows: WORKFLOWS, baseline });
  for (const line of exemptions) process.stdout.write(`arm-config exempt: ${line}\n`);
  if (defects.length === 0) {
    process.stdout.write(
      `arm-config-guard: ${files.length} workflows agree with the registration ` +
        `(run ${baseline.run}, adopted by §${baseline.adoptedBy}); ${exemptions.length} declared ` +
        'departure(s).\n',
    );
    return;
  }
  process.stderr.write(
    `arm-config-guard: ${defects.length} workflow value(s) do not match the registration ` +
      `(run ${baseline.run}, adopted by §${baseline.adoptedBy}). A dispatch is not the arm the ` +
      'reading was taken on if its workflow spells a different value:\n',
  );
  for (const line of defects) process.stderr.write(`  - ${line}\n`);
  process.stderr.write(
    'Fix the value, or write `# arm-config: <VAR> departs — <reason>` beside it if the departure is ' +
      'the experiment.\n',
  );
  process.exit(1);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  main();
}
