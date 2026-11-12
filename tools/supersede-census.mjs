#!/usr/bin/env node
/**
 * How far a text-level supersession rule reaches, and what it costs to reach that far.
 *
 *     node tools/supersede-census.mjs <artifact.json> [--json]
 *
 * ## The question this answers, and why it needs an instrument
 *
 * `docs/MEASURE-KU-STALE.md` reads nine `KU` failures and finds that all nine answered with a value the
 * corpus later replaced; four of them had **both** versions in the delivered window. `docs/MEASURE-KU-STALE.md`
 * §7 then records two dispatches of `conflicts: true` — which *annotates* the pair — and both were refused.
 * The one shape left on that axis is `'drop'`: remove the superseded turn instead of pointing at it, so the
 * reader is never handed two versions of the same detail.
 *
 * `'drop'` needs a decision function that says "this turn states the same detail as that later turn, with a
 * different value". That function does not exist yet, and the whole cost of the arm is decided by how well it
 * separates a **substitution** (the corpus changed its mind) from two statements that merely both mention a
 * number. A rule that cannot separate them would delete evidence from hundreds of windows on the strength of
 * a coincidence.
 *
 * So the arm is not dispatched until the rule's reach *and* its precision are measured on the control
 * artifact, at zero model calls. This tool is that measurement. It reads only `questions[].turns`,
 * `question`, `capability` and `correct`.
 *
 * ## Why three rules instead of one, and why no threshold sweep
 *
 * The property that separates the two populations is **"the same attribute, a different value"**. That is a
 * *slot*, and a slot is not a function of the surface tokens: `a1eacc2a` says "I've written four so far"
 * in one turn and "Completing seven short stories" in another, and those two sentences share **no** content
 * term at all. A single rule therefore has to be either loose enough to pair them (and then it also pairs
 * every question that mentions two numbers) or tight enough to spare the correct windows (and then it pairs
 * none of them).
 *
 * Three rules are measured because the interesting quantity is the **curve**, not one point: each adds one
 * constraint, and the reading is what the constraint buys and what it costs. Sweeping a numeric threshold
 * instead would produce a value fitted to four known questions, which is the failure
 * `docs/MEASURE-CONFLICT-SURFACING.md` §2 already records once.
 *
 * | rule | what it adds |
 * | --- | --- |
 * | `anchor` | both sentences carry a value of a **shared kind**, the values differ, and both sentences share at least one term with the **question** |
 * | `anchor+subject` | the two sentences also share at least one content term with **each other**, so the pair has a subject in common |
 * | `anchor+subject+containment` | and one residue is at least half contained in the other (`|A∩B| / min(|A|,|B|) ≥ 0.5`), i.e. the two statements are *about the same thing* rather than merely near each other |
 *
 * ## What the numbers mean
 *
 * `wrong` is the number of questions the rule would touch that the arm currently gets **wrong** — the only
 * population a supersession repair can help. `right` is the number it would touch that are already correct,
 * where the rule can only cost. A rule whose `right` is an order of magnitude above its `wrong` is not a
 * mechanism, whatever its `hardest` column says: dropping turns from 280 correct windows to reach four
 * failures is a coin flip with extra steps, and `docs/ACCEPTANCE-MATRIX.md` §3.2 has already measured what
 * removing turns costs (`MR` −6.61, `TR` −4.72 at half the room).
 */

import { readFileSync } from 'node:fs';

/**
 * Words that carry no subject, and are therefore not evidence of one.
 *
 * Same list as `tools/ku-stale-census.mjs` and `packages/cortex-memory/src/conflict.ts`'s stopword set,
 * kept local rather than imported: this tool has to run on a checkout where the packages have not been
 * built, which is the state a census of an archived artifact is usually in.
 */
const STOPWORDS = new Set(
  `a an and are as at be been but by can could did do does for from had has have how i if in into is it
   its just like me my not of on or our so than that the their them then there these they this to was we
   were what when where which who why will with would you your about after also any because before both
   each few get got more most much no now only other over same should some such up very`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * The value kinds a substitution can preserve.
 *
 * Ordered most to least specific, and the order matters for one question only: `$350,000` is matched by the
 * `money` pattern and again by `number`, so a sentence that states a price carries **two** entries for one
 * value. That is deliberate — the kinds are compared by intersection, so an extra match can only make two
 * sentences *more* likely to pair, and the containment rule is what decides. Filtering the overlap out would
 * be a second tokenizer to maintain for no decision.
 *
 * `count` exists because `a1eacc2a` writes `four` and `seven` as words. Without it the one question this
 * arm was registered for would be invisible to every rule below.
 */
const VALUE_KINDS = [
  ['time', /\b\d{1,2}:\d{2}\s*(?:am|pm)?/gi],
  ['record', /\b\d+\s*[-–]\s*\d+\b/g],
  ['money', /\$\s?\d[\d,]*(?:\.\d+)?/g],
  ['number', /\b\d[\d,]*(?:\.\d+)?\b/g],
  [
    'count',
    /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/gi,
  ],
];

/** The evidence line is `[2023/05/20 (Sat) 03:51] user: …`; neither the stamp nor the role is content. */
const TURN_PREFIX = /^\[[^\]]*\]\s*/;
const ROLE_PREFIX = /^(?:user|assistant|system):\s*/i;

const turnBody = (text) => String(text ?? '').replace(TURN_PREFIX, '').replace(ROLE_PREFIX, '');

const normaliseValue = (text) => text.toLowerCase().replace(/[\s,]/g, '');

/**
 * Plural folding, and the one question that needs it.
 *
 * `a2f3aa27` asks "how many followers do I have on Instagram now", and the statement that replaces the
 * stale value says "I've been meaning to check my current **follower** count". Without folding the two
 * spellings, the newer statement does not anchor on the question and the rule cannot see the pair — which
 * is `conflict.ts`'s recorded reach limit, restated here as a tokenisation fact rather than a mystery.
 *
 * Crude on purpose: `stories` folds to `storie`, which then fails to match `story`, and that is the right
 * direction to fail in. A stemmer would fold it and would also fold unrelated pairs together, and the
 * containment rule downstream is what has to hold those apart.
 */
const fold = (token) =>
  token.length > 4 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token;

function contentTerms(text) {
  const matched = String(text ?? '')
    .toLowerCase()
    .match(/[a-z]+/g);
  return new Set((matched ?? []).map(fold).filter((t) => t.length > 1 && !STOPWORDS.has(fold(t))));
}

/** Every value a sentence states, tagged with its kind. */
function valuesIn(sentence) {
  const found = [];
  for (const [kind, pattern] of VALUE_KINDS) {
    for (const match of sentence.matchAll(pattern)) found.push({ kind, value: normaliseValue(match[0]) });
  }
  return found;
}

/** The sentence's words with every value removed — what is left is what the sentence is *about*. */
function residueOf(sentence) {
  let rest = sentence;
  for (const [, pattern] of VALUE_KINDS) rest = rest.replace(pattern, ' ');
  return contentTerms(rest);
}

function sentencesOf(turnText) {
  return turnBody(turnText)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Every ordered (older, newer) sentence pair in one question's window that a rule could read as a
 * substitution, under every constraint, so the three rules can be compared without re-tokenising.
 *
 * The window is ordered by the timestamp in the turn's stamp, not by position in the array: the delivered
 * set is a subsequence of the corpus and a rendering that reorders it (`ordering` in `prompt.ts`) would
 * otherwise make "later" mean "printed later".
 */
function candidatePairs(turns, question) {
  const questionTerms = contentTerms(question);
  const rows = turns.map((turn, index) => {
    const stamp = /^\[([^\]]*)\]/.exec(String(turn.text ?? ''))?.[1] ?? '';
    const stamped = sentencesOf(turn.text).map((sentence) => {
      const residue = residueOf(sentence);
      return {
        sentence,
        values: valuesIn(sentence),
        residue,
        anchor: [...residue].filter((t) => questionTerms.has(t)),
      };
    });
    return { index, stamp, sentences: stamped };
  });

  const pairs = [];
  for (let older = 0; older < rows.length; older += 1) {
    for (let newer = 0; newer < rows.length; newer += 1) {
      if (older === newer) continue;
      if (!(rows[older].stamp < rows[newer].stamp)) continue;
      for (const a of rows[older].sentences) {
        if (a.values.length === 0 || a.anchor.length === 0) continue;
        for (const b of rows[newer].sentences) {
          if (b.values.length === 0 || b.anchor.length === 0) continue;
          // Same kind of value, and at least one of them differs: a restatement is not a substitution.
          const sharedKinds = a.values.filter((x) => b.values.some((y) => y.kind === x.kind));
          if (sharedKinds.length === 0) continue;
          const differs = a.values.some((x) => b.values.some((y) => y.kind === x.kind && y.value !== x.value));
          if (!differs) continue;

          const anchorShared = a.anchor.filter((t) => b.anchor.includes(t));
          if (anchorShared.length === 0) continue;

          const subjectShared = [...a.residue].filter((t) => b.residue.has(t));
          const containment =
            Math.min(a.residue.size, b.residue.size) === 0
              ? 0
              : subjectShared.length / Math.min(a.residue.size, b.residue.size);

          pairs.push({
            older: rows[older].index,
            newer: rows[newer].index,
            kind: sharedKinds[0].kind,
            anchor: anchorShared,
            subject: subjectShared,
            containment,
          });
        }
      }
    }
  }
  return pairs;
}

/** The three rules, loosest first, each stated as a predicate over one candidate pair. */
export const RULES = [
  { name: 'anchor', accepts: () => true },
  { name: 'anchor+subject', accepts: (p) => p.subject.length > 0 },
  { name: 'anchor+subject+containment', accepts: (p) => p.subject.length > 0 && p.containment >= 0.5 },
];

/**
 * Whole-token run matching, and why a substring test will not do.
 *
 * The census has to answer "is the value the reply gave still in the window after the drop". `52` appears
 * inside 22 turns of `c7dc5443`'s transcript while the volleyball record `5-2` does not, and a substring test
 * would read the drop as ineffective for the wrong reason. `tools/ku-stale-census.mjs` records the same defect
 * from the other direction. Tokens are `[a-z0-9]+`, so `$350,000` and `350000` are the same run and `37` is
 * not found inside `1370`.
 */
function tokenise(text) {
  return String(text ?? '')
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
}

function carries(haystackText, needleText) {
  const needle = tokenise(needleText);
  if (needle.length === 0) return false;
  const hay = tokenise(haystackText);
  for (let at = 0; at + needle.length <= hay.length; at += 1) {
    let ok = true;
    for (let k = 0; k < needle.length; k += 1) {
      if (hay[at + k] !== needle[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * One question under one rule: which turns the rule would drop.
 *
 * `staleRemoved` and `goldKept` are the columns that decide the arm, and neither is implied by "reached".
 * `a1eacc2a` is reached and its wrong value survives, because the turn that pairs with the newer statement is
 * an assistant turn that restates the count — the turn carrying the answer the reader copied shares no term
 * with the newer statement at all. A window count cannot see that; these two can.
 */
function judge(question, rule) {
  const pairs = candidatePairs(question.turns ?? [], question.question).filter(rule.accepts);
  const dropped = new Set(pairs.map((p) => p.older));
  const survivors = (question.turns ?? [])
    .filter((_, index) => !dropped.has(index))
    .map((turn) => turnBody(turn.text))
    .join('\n');
  return {
    pairs,
    dropped,
    staleRemoved: dropped.size > 0 && !carries(survivors, question.answer),
    goldKept: carries(survivors, question.groundTruth),
  };
}

function census(questions) {
  const out = new Map();
  for (const rule of RULES) {
    const row = {
      rule: rule.name,
      touched: 0,
      wrong: 0,
      right: 0,
      dropped: 0,
      removed: 0,
      goldLost: 0,
      byCapability: new Map(),
      reached: [],
    };
    for (const question of questions) {
      const { pairs, dropped, staleRemoved, goldKept } = judge(question, rule);
      if (dropped.size === 0) continue;
      row.touched += 1;
      row.dropped += dropped.size;
      if (question.correct === false) {
        row.wrong += 1;
        if (staleRemoved) row.removed += 1;
      } else {
        row.right += 1;
      }
      if (!goldKept) row.goldLost += 1;
      const cap = row.byCapability.get(question.capability) ?? {
        touched: 0,
        wrong: 0,
        right: 0,
        dropped: 0,
        removed: 0,
        goldLost: 0,
      };
      cap.touched += 1;
      cap.dropped += dropped.size;
      if (!goldKept) cap.goldLost += 1;
      if (question.correct === false) {
        cap.wrong += 1;
        if (staleRemoved) cap.removed += 1;
      } else {
        cap.right += 1;
      }
      row.byCapability.set(question.capability, cap);
      if (question.correct === false)
        row.reached.push({
          id: question.questionId,
          capability: question.capability,
          dropped: dropped.size,
          pairs: pairs.length,
          staleRemoved,
          goldKept,
        });
    }
    out.set(rule.name, row);
  }
  return out;
}

const path = process.argv[2];
if (path === undefined) {
  process.stderr.write('usage: node tools/supersede-census.mjs <artifact.json> [--json] [--detail <questionId>]\n');
  process.exit(2);
}

const artifact = JSON.parse(readFileSync(path, 'utf8'));
const questions = artifact.questions ?? [];

/**
 * One question, pair by pair, under the tightest rule.
 *
 * The summary table says a rule reaches a window; this says **which pair** it read, which is the difference
 * between a reach number and an argument. `a1eacc2a` is the case that made it necessary: the turn carrying the
 * wrong value is not the turn that pairs with the newer statement, and no count column can show that.
 */
const detailAt = process.argv.indexOf('--detail');
if (detailAt !== -1) {
  const id = process.argv[detailAt + 1];
  const question = questions.find((q) => q.questionId === id);
  if (question === undefined) {
    process.stderr.write(`no question ${id} in ${path}\n`);
    process.exit(2);
  }
  const pairs = candidatePairs(question.turns ?? [], question.question);
  const tight = RULES[RULES.length - 1];
  console.log(`${id}  capability=${question.capability}  correct=${question.correct}`);
  console.log(`  answer=${JSON.stringify(question.answer)}  gold=${JSON.stringify(question.groundTruth)}`);
  for (const pair of pairs) {
    const accepted = tight.accepts(pair) ? 'ACCEPT' : 'reject';
    console.log(
      `  ${accepted}  older=${pair.older} newer=${pair.newer} kind=${pair.kind} ` +
        `containment=${pair.containment.toFixed(2)} subject=${pair.subject.join(',')} anchor=${pair.anchor.join(',')}`,
    );
  }
  process.exit(0);
}

const table = census(questions);

if (process.argv.includes('--json')) {
  const payload = {};
  for (const [name, row] of table)
    payload[name] = {
      touched: row.touched,
      wrong: row.wrong,
      right: row.right,
      dropped: row.dropped,
      removed: row.removed,
      goldLost: row.goldLost,
      byCapability: Object.fromEntries(row.byCapability),
      reached: row.reached,
    };
  process.stdout.write(`${JSON.stringify({ questions: questions.length, rules: payload }, null, 2)}\n`);
  process.exit(0);
}

console.log(`${questions.length} questions`);
console.log('');
console.log('rule                            touched   wrong   right  dropped  removed  goldLost   wrong/right');
for (const [, row] of table) {
  const ratio = row.right === 0 ? 'all' : (row.wrong / row.right).toFixed(3);
  console.log(
    `${row.rule.padEnd(30)}  ${String(row.touched).padStart(6)}  ${String(row.wrong).padStart(6)}  ` +
      `${String(row.right).padStart(6)}  ${String(row.dropped).padStart(7)}  ${String(row.removed).padStart(7)}  ` +
      `${String(row.goldLost).padStart(8)}   ${ratio.padStart(11)}`,
  );
}
for (const [name, row] of table) {
  console.log('');
  console.log(`${name}:`);
  for (const [cap, capRow] of [...row.byCapability].sort())
    console.log(
      `  ${cap.padEnd(4)} touched ${String(capRow.touched).padStart(3)}  wrong ${String(capRow.wrong).padStart(3)}  ` +
        `right ${String(capRow.right).padStart(3)}  dropped ${String(capRow.dropped).padStart(4)}  ` +
        `removed ${String(capRow.removed).padStart(3)}  goldLost ${String(capRow.goldLost).padStart(3)}`,
    );
  if (row.reached.length > 0) {
    console.log(
      `  wrong questions reached: ${row.reached
        .map((r) => `${r.id}(${r.dropped}${r.staleRemoved ? ',value-gone' : ',value-kept'}${r.goldKept ? '' : ',gold-lost'})`)
        .join(', ')}`,
    );
  }
}
