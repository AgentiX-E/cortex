import { resolve } from 'node:path';

/**
 * A3 as a page a person can actually click through.
 *
 * ## Why this exists
 *
 * The review has been runnable since step 13, and nobody has run it: `tools/a3-review.mjs review` is
 * an interactive terminal loop, which means a person has to sit at the repository, keep a shell
 * alive, and trust that a mistyped key does not lose twenty judgements. That is not a threshold
 * problem, it is a friction problem, and friction is indistinguishable from "we chose not to".
 *
 * The dosage gate now passes on the remote backend (75%, step 15), so the only thing left between
 * this repository and its first A3 reading is a surface that does not lose a person's work. So: one
 * self-contained HTML file, no server, no network, no build step. Open it, press a/d/e/s twenty
 * times, download a JSONL, run `score`. The file is generated from the same cards the CLI reads, and
 * the JSONL it exports is the shape `scoreA3` accepts -- asserted in the tests, because a page whose
 * output the scorer rejects wastes the only thing it was built to collect.
 *
 * ## What it deliberately does not do
 *
 * It does not score. `scoreA3` is the single implementation of the arithmetic, and a second copy in
 * browser JavaScript would disagree with the first exactly when the sample is small enough to matter.
 * The page's last screen prints the command to run instead.
 *
 * It also does not hide which arm is which. A reviewer who edits a card knows whether they are
 * editing a sentence or an atom, and hiding that would need a different interface rather than a
 * different flag. Recorded in `docs/04` as a limitation of the measurement, not of this file.
 */

/** One card as the review needs it: the sentence, and the atoms the model proposed for it. */
export type ReviewCard = {
  readonly cardId: string;
  readonly source: string;
  readonly atoms: readonly string[];
  /** Optional label from the fixture, shown to the reviewer only when `revealGold` is set. */
  readonly gold?: string;
};

export type ReviewPageInput = {
  readonly cards: readonly ReviewCard[];
  /** Which prompt produced the atoms. Part of the resume key: two prompts are two reviews. */
  readonly promptVersion: string;
  /** The profile line, so a printed page says which model it came from. */
  readonly profile: string;
  /**
   * Show the fixture's gold label under each card.
   *
   * Off by default and only useful for checking the instrument: a reviewer who can see the expected
   * answer is not reviewing.
   */
  readonly revealGold?: boolean;
};

export type ReviewPair = {
  readonly index: number;
  readonly card: ReviewCard;
  /** The arm shown first. Alternates by index so a fatigue effect lands on both arms. */
  readonly first: 'source' | 'atoms';
};

export type ReviewPlan = {
  readonly pairs: readonly ReviewPair[];
  /** Cards with no atom cannot form a pair: there is no second presentation to show. */
  readonly skipped: readonly ReviewCard[];
};

/**
 * The command line, as a function.
 *
 * ## Why this is here and not in `tools/a3-review-page.mjs`
 *
 * It was in the tool, and the tool's test ran under `pnpm test:tools`, which the check script runs
 * **before** `pnpm build`. The tool imports `dist`, a fresh checkout has no `dist`, and CI went red on
 * a suite that passed locally with a stale build lying around. The rule that comes out of it is the
 * one this repository already follows everywhere else: logic lives in a package and is covered by the
 * package's tests; the tool is a shim that reads a file, calls one function, and writes a file.
 *
 * `resolveOutPath` exists for the specific defect that started this: `path.join(base, '/abs/file')`
 * returns `base/abs/file`, so an absolute `--out` was written *inside* the package. `path.resolve`
 * replaces on the first absolute segment, which is what `--out` means.
 */
export type ReviewPageArgs = {
  readonly cardsPath: string;
  readonly outPath: string;
  readonly revealGold: boolean;
};

const USAGE = 'usage: a3-review-page.mjs --cards <cards.json> --out <file.html> [--reveal-gold]';

/** Arguments, or a message that says what was wrong. `--reveal-gold` is the only flag. */
export function parseReviewPageArgs(argv: readonly string[]): ReviewPageArgs {
  let cardsPath: string | undefined;
  let outPath: string | undefined;
  let revealGold = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === '--reveal-gold') {
      revealGold = true;
      continue;
    }
    if (!token.startsWith('--'))
      throw new Error(`${USAGE}\nunexpected argument ${JSON.stringify(token)}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${USAGE}\n${token} needs a value`);
    if (token === '--cards') cardsPath = value;
    else if (token === '--out') outPath = value;
    else throw new Error(`${USAGE}\nunknown option ${token}`);
    index += 1;
  }

  if (cardsPath === undefined || outPath === undefined) throw new Error(USAGE);
  return { cardsPath, outPath, revealGold };
}

/** An absolute `--out` replaces the base; a relative one is joined to it. */
export function resolveOutPath(outPath: string, base: string): string {
  return resolve(base, outPath);
}

export type ReviewCardsFile = {
  readonly cards: readonly ReviewCard[];
  readonly promptVersion: string;
  readonly profile: string;
};

/**
 * The cards file, validated to the point where a review can be attributed.
 *
 * Every message names the field and the file. A review whose cards do not say which prompt and which
 * backend produced them cannot be compared with any other review, and the page it renders would look
 * exactly like one that can.
 */
export function readReviewCards(payload: unknown, source: string): ReviewCardsFile {
  const cards = (payload as { cards?: unknown } | null)?.cards;
  if (!Array.isArray(cards) || cards.length === 0) {
    throw new Error(`${source}: no cards`);
  }
  const first = cards[0] as Partial<ReviewCard> & { promptVersion?: unknown; profile?: unknown };
  const absent = [
    ...(typeof first.promptVersion === 'string' && first.promptVersion !== ''
      ? []
      : ['promptVersion']),
    ...(typeof first.profile === 'string' && first.profile !== '' ? [] : ['profile']),
  ];
  if (absent.length > 0) {
    throw new Error(
      `${source}: cards carry no ${absent.join(' and no ')} -- rebuild them with a current ` +
        'a3-review.mjs prepare, because a review that cannot name its configuration is not a reading',
    );
  }
  const mixed = cards.some(
    (card: { promptVersion?: unknown; profile?: unknown }) =>
      card.promptVersion !== first.promptVersion || card.profile !== first.profile,
  );
  if (mixed) throw new Error(`${source}: the cards come from more than one configuration`);

  return {
    cards: cards as ReviewCard[],
    promptVersion: first.promptVersion as string,
    profile: first.profile as string,
  };
}

/**
 * The order, as data.
 *
 * Exported because it is the part of the design that has to be *checked*, not just implemented:
 * alternating the first arm by index is what keeps a fatigue effect from being attributed to the
 * second presentation, and a reviewer who sees the sentence first every time is a different
 * experiment.
 */
export function planReview(cards: readonly ReviewCard[]): ReviewPlan {
  const pairs: ReviewPair[] = [];
  const skipped: ReviewCard[] = [];
  for (const card of cards) {
    if (card.atoms.length === 0) {
      skipped.push(card);
      continue;
    }
    pairs.push({
      index: pairs.length,
      card,
      first: pairs.length % 2 === 0 ? 'source' : 'atoms',
    });
  }
  return { pairs, skipped };
}

/**
 * A resume key that changes when the experiment changes.
 *
 * `localStorage` is per origin, and `file://` origins are shared across every page a person has
 * opened. A key of "a3" would let yesterday's prompt resume today's run -- and the page would look
 * half-finished with cards the reviewer never saw.
 */
export function resumeKey(input: ReviewPageInput): string {
  const ids = planReview(input.cards)
    .pairs.map((pair) => pair.card.cardId)
    .join(',');
  return `cortex-a3:${input.promptVersion}:${hash32(ids)}`;
}

/** FNV-1a, 32-bit, hex. Small, stable, and not a security boundary. */
function hash32(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** HTML-escape for text and attribute values. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * JSON that is safe inside a `<script>` element.
 *
 * `JSON.stringify` alone will happily emit `</script>`, which ends the element early and turns the
 * user's sentence into markup. The replacements below are the standard three: the closing tag, the
 * HTML comment opener, and the two line separators that are legal in JSON but not in JavaScript
 * string literals.
 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const STYLE = `
:root{--bg:#101418;--panel:#171d24;--ink:#e8edf2;--dim:#93a1ad;--line:#26303a;--accent:#4aa3ff;--good:#38b27a;--warn:#d8a13a;--bad:#d8574a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:52rem;margin:0 auto;padding:2rem 1.25rem 4rem}
h1{font-size:1.35rem;margin:0 0 .35rem}
.meta{color:var(--dim);font-size:.82rem;overflow-wrap:anywhere}
.bar{position:sticky;top:0;background:linear-gradient(var(--bg),var(--bg) 70%,transparent);padding:.6rem 0;z-index:2}
.track{height:.4rem;background:#0b0f13;border:1px solid var(--line);border-radius:99px;overflow:hidden}
.fill{height:100%;width:0;background:var(--accent);transition:width .18s ease}
.card{background:var(--panel);border:1px solid var(--line);border-radius:.7rem;padding:1.1rem 1.15rem;margin:1rem 0 1.6rem}
.tag{display:inline-block;font-size:.7rem;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);border:1px solid var(--line);border-radius:99px;padding:.12rem .5rem;margin-bottom:.7rem}
.arm{font-size:1.12rem;margin:0}
.atoms{margin:0;padding-left:1.1rem}
.atoms li{margin:.2rem 0}
.keys{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1.1rem}
button{font:inherit;color:var(--ink);background:#1d2731;border:1px solid var(--line);border-radius:.5rem;padding:.5rem .85rem;cursor:pointer}
button:hover{border-color:var(--accent)}
button.primary{background:var(--accent);border-color:var(--accent);color:#08121c;font-weight:600}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
input[type=text]{width:100%;font:inherit;color:var(--ink);background:#0d1116;border:1px solid var(--line);border-radius:.5rem;padding:.55rem .7rem;margin-top:.7rem}
.hint{color:var(--dim);font-size:.8rem;margin-top:.9rem}
.done{display:none}
table{border-collapse:collapse;width:100%;font-size:.9rem;margin:.8rem 0 1rem}
td,th{border-bottom:1px solid var(--line);padding:.35rem .4rem;text-align:left}
code{background:#0d1116;border:1px solid var(--line);border-radius:.35rem;padding:.1rem .35rem;font-size:.82rem;overflow-wrap:anywhere}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
`;

/** The client script. Plain ES2019 in a string: no build step, no module loader, no network. */
const SCRIPT = String.raw`
(function () {
  var data = JSON.parse(document.getElementById('a3-data').textContent);
  var storageKey = data.resumeKey;
  var trials = [];
  var cursor = 0;
  var currentStarted = 0;
  var editing = false;

  try {
    var saved = window.localStorage.getItem(storageKey);
    if (saved) trials = JSON.parse(saved);
  } catch (error) {
    trials = [];
  }

  var seen = {};
  trials.forEach(function (trial) { seen[trial.cardId + ':' + trial.arm] = true; });

  var el = {
    body: document.getElementById('a3-body'),
    progress: document.getElementById('a3-progress'),
    fill: document.getElementById('a3-fill'),
    done: document.getElementById('a3-done'),
    live: document.getElementById('a3-live'),
    summary: document.getElementById('a3-summary'),
    json: document.getElementById('a3-json')
  };

  function total() { return data.steps.length; }
  function finished() { return Object.keys(seen).length; }

  function paint() {
    var pct = total() === 0 ? 0 : Math.round((finished() / total()) * 100);
    el.fill.style.width = pct + '%';
    el.progress.textContent = finished() + ' / ' + total() + ' judgements';
  }

  function save() {
    try { window.localStorage.setItem(storageKey, JSON.stringify(trials)); } catch (error) { /* private mode */ }
    // Written after every judgement, not only at the end: the export is the deliverable, and a person
    // who stops at card fourteen has fourteen judgements that are worth exactly as much as they would
    // be inside a finished run. The first version only filled this at the end, so the only copy of a
    // partial review was in localStorage -- which is invisible until something goes wrong.
    var box = document.getElementById('a3-json');
    if (box) box.value = trials.map(function (trial) { return JSON.stringify(trial); }).join('\n');
  }

  function next() {
    while (cursor < data.steps.length && seen[data.steps[cursor].cardId + ':' + data.steps[cursor].arm]) cursor += 1;
    if (cursor >= data.steps.length) return render();
    renderStep(data.steps[cursor]);
  }

  function render() {
    var byArm = { source: { accept: 0, total: 0 }, atoms: { accept: 0, total: 0 } };
    trials.forEach(function (trial) {
      byArm[trial.arm].total += 1;
      if (trial.decision !== 'dismiss') byArm[trial.arm].accept += 1;
    });
    function rate(arm) {
      return byArm[arm].total === 0 ? '—' : Math.round((byArm[arm].accept / byArm[arm].total) * 100) + '%';
    }
    el.summary.innerHTML =
      '<tr><th>presentation</th><th>accepted</th><th>of</th><th>rate</th></tr>' +
      '<tr><td>the sentence</td><td>' + byArm.source.accept + '</td><td>' + byArm.source.total + '</td><td>' + rate('source') + '</td></tr>' +
      '<tr><td>the atoms</td><td>' + byArm.atoms.accept + '</td><td>' + byArm.atoms.total + '</td><td>' + rate('atoms') + '</td></tr>';
    el.json.value = trials.map(function (trial) { return JSON.stringify(trial); }).join('\n');
    // Cleared, not just hidden: a hidden card still owns its buttons, and a stray click on one would
    // call record() with steps[cursor] undefined and throw inside the listener -- silently, because
    // nothing in a page reports an exception to the person clicking. Found by driving the page in a
    // browser and clicking two hundred times: the last hundred and sixty threw and nothing said so.
    el.body.innerHTML = '';
    el.body.hidden = true;
    el.done.hidden = false;
    el.live.textContent = 'All judgements recorded.';
    paint();
  }

  function renderStep(step) {
    el.done.hidden = true;
    el.body.hidden = false;
    currentStarted = Date.now();
    editing = false;

    var heading = step.arm === 'atoms' ? 'The atoms the model proposed' : 'What you said';
    var shown = step.arm === 'atoms'
      ? '<ul class="atoms">' + step.atoms.map(function (atom) { return '<li>' + escapeHtml(atom) + '</li>'; }).join('') + '</ul>'
      : '<p class="arm">' + escapeHtml(step.source) + '</p>';

    el.body.innerHTML =
      '<div class="card">' +
        '<span class="tag">card ' + (step.index + 1) + ' of ' + data.pairCount + ' · shown ' + (step.arm === 'atoms' ? 'second' : 'first') + '</span>' +
        '<div class="meta" style="margin-bottom:.6rem">' + heading + '</div>' +
        shown +
        (data.revealGold && step.gold ? '<p class="hint">fixture label: ' + escapeHtml(step.gold) + '</p>' : '') +
        '<div class="keys">' +
          '<button class="primary" data-act="accept" accesskey="a">Accept</button>' +
          '<button data-act="dismiss" accesskey="d">Dismiss</button>' +
          '<button data-act="edit" accesskey="e">Accept with edits</button>' +
          '<button data-act="skip" accesskey="s">Skip</button>' +
        '</div>' +
        '<p class="hint">Would a colleague be able to act on this? Keys: a / d / e / s</p>' +
      '</div>';

    el.live.textContent = heading + '. ' + (step.arm === 'atoms' ? step.atoms.length + ' atoms.' : 'One sentence.');
    paint();
    var first = el.body.querySelector('button');
    if (first) first.focus();
  }

  function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function record(step, decision, editedTo) {
    var trial = { cardId: step.cardId, arm: step.arm, decision: decision, elapsedMs: Date.now() - currentStarted };
    if (typeof editedTo === 'string' && editedTo !== '') trial.editedTo = editedTo;
    trials.push(trial);
    seen[step.cardId + ':' + step.arm] = true;
    save();
    cursor += 1;
    next();
  }

  el.body.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-act]');
    if (!button) return;
    var step = data.steps[cursor];
    if (!step) return;
    var act = button.dataset.act;
    if (act === 'skip') { cursor += 1; next(); return; }
    if (act === 'edit') {
      editing = true;
      var card = el.body.querySelector('.card');
      var existing = card.querySelector('input[type=text]');
      if (existing) { existing.focus(); return; }
      var input = document.createElement('input');
      input.type = 'text';
      input.placeholder = step.arm === 'atoms' ? 'your wording' : 'your wording';
      input.setAttribute('aria-label', 'edited wording');
      input.value = step.source;
      card.appendChild(input);
      input.focus();
      return;
    }
    record(step, act);
  });

  el.body.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && editing) {
      var input = el.body.querySelector('input[type=text]');
      if (!input) return;
      record(data.steps[cursor], 'edit', input.value);
    }
  });

  function download() {
    var blob = new Blob([el.json.value], { type: 'application/x-ndjson' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'a3-decisions.jsonl';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  document.getElementById('a3-download').addEventListener('click', download);
  document.getElementById('a3-copy').addEventListener('click', function () {
    el.json.select();
    document.execCommand('copy');
    el.live.textContent = 'Decisions copied to the clipboard.';
  });
  document.getElementById('a3-reset').addEventListener('click', function () {
    if (!window.confirm('Discard every recorded judgement?')) return;
    trials = []; seen = {}; cursor = 0; save(); next();
  });

  next();
})();
`;

/**
 * Render the whole page.
 *
 * One string, no files beside it: a page that needs a stylesheet and a script is a directory to
 * copy, and a directory is what makes a reviewer give up.
 */
export function renderA3ReviewPage(input: ReviewPageInput): string {
  const { pairs, skipped } = planReview(input.cards);
  if (pairs.length === 0) {
    throw new Error(
      'no reviewable pair: every card is missing atoms, so there is no second presentation to show',
    );
  }

  const steps = pairs.flatMap((pair) => {
    const order: ('source' | 'atoms')[] =
      pair.first === 'source' ? ['source', 'atoms'] : ['atoms', 'source'];
    return order.map((arm) => ({
      cardId: pair.card.cardId,
      arm,
      source: pair.card.source,
      atoms: [...pair.card.atoms],
      index: pair.index,
      // The fixture's label is only put in the payload when the caller asked to reveal it. Carrying
      // it and hiding it in the client would leave the expected answer in the file, one "view source"
      // away from the person whose judgement is the measurement.
      ...(input.revealGold === true && pair.card.gold !== undefined
        ? { gold: pair.card.gold }
        : {}),
    }));
  });

  const payload = {
    resumeKey: resumeKey(input),
    pairCount: pairs.length,
    promptVersion: input.promptVersion,
    profile: input.profile,
    revealGold: input.revealGold === true,
    steps,
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>A3 review — ${escapeHtml(input.promptVersion)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>A3 — does the model's split change what you decide?</h1>
  <p class="meta">${pairs.length} card(s), each shown twice · ${escapeHtml(input.promptVersion)} · ${escapeHtml(input.profile)}</p>
  ${
    skipped.length === 0
      ? ''
      : `<p class="meta">${skipped.length} card(s) had no atoms and are not in this review: there is no second presentation to compare.</p>`
  }
  <p class="meta">Accept means: a colleague reading this would know what to do. Edits count as an accept, with the wording changed.</p>

  <div class="bar"><div class="track"><div class="fill" id="a3-fill"></div></div><div class="meta" id="a3-progress">0 / ${steps.length} judgements</div></div>

  <div id="a3-body"></div>

  <section class="done" id="a3-done" hidden>
    <h2 style="font-size:1.05rem">Recorded</h2>
    <table id="a3-summary"></table>
    <p class="meta">Scoring is not done in this page: <code>scoreA3</code> is one implementation and it lives in the repository. Save the file, then run
      <code>node tools/a3-review.mjs score --decisions a3-decisions.jsonl</code>.</p>
    <div class="keys">
      <button class="primary" id="a3-download">Download decisions (JSONL)</button>
      <button id="a3-copy">Copy to clipboard</button>
      <button id="a3-reset">Start over</button>
    </div>
    <textarea id="a3-json" class="sr" readonly></textarea>
  </section>

  <p class="sr" id="a3-live" aria-live="polite"></p>
</main>
<script type="application/json" id="a3-data">${scriptJson(payload)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
