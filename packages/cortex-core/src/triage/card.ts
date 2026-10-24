/**
 * The card queue: where a deferred fact becomes a question instead of a decision.
 *
 * ## Why this exists at all
 *
 * Measured twice, on two corpora: the rule layer decides about a quarter of what it sees, and the
 * shared store is nearly empty without the queue. `[POC-7]` put a number on the second half --
 * 0.52% of the turns a real run showed the reader are shareable, so "shared knowledge is the
 * shareable part of the private stream" is false at this workload, and a shared fact has to be
 * produced by someone saying yes. This is the someone.
 *
 * ## The six rules from the design, and how each one is enforced rather than promised
 *
 * 1. **A credential never becomes a card.** It is not admitted either: `retention: 'never'` means
 *    `TriageWriter.admit` writes nothing, so there is no row to open a card from. Checked, not
 *    assumed -- the test asserts the string appears in neither store afterwards.
 * 2. **`dismissed` is terminal.** Accepting or editing one throws. A queue whose refusals can be
 *    reversed teaches people to ignore it.
 * 3. **Cards are exportable.** `toMarkdown` and `toJSON`, including dismissed ones: the export is
 *    the audit surface, and an export that hides the decisions is a brochure.
 * 4. **A stale fact does not answer.** `expire` marks the fact withdrawn and the read side filters
 *    it, so the rule is enforced where answers are assembled rather than in a checkbox.
 * 5. **An edit is a new sentence, so it gets a new verdict.** If the edit introduces something a
 *    rule protects, nothing is published -- and the edit is not stored either, because the card is
 *    exported and a secret typed into a rejected edit is still a secret.
 * 6. **A card is a question about a claim, not about anything that happened to be typed.** The queue
 *    asks about the assertions inside a turn and nothing else, so a yes can never publish a request.
 *    The count that made this a rule rather than a preference is in `claims.ts`: 87.2% of real user
 *    sentences are deferrals, and 73.6% of those contain a question mark.
 */

import type { FederatedStorage } from '../federation/federated-storage.js';
import { claimsIn } from './claims.js';
import { groundedIn, type TriageProposal } from './proposer.js';
import { TriageError, type Admission, type TriageWriter } from './writer.js';

/** Where a card is in its life. `dismissed` and `stale` are the two that need care. */
export type CardState = 'proposed' | 'accepted' | 'edited' | 'dismissed' | 'stale';

/** A question about one fact: may this be shared? */
export type KnowledgeCard = {
  /**
   * The fact's id, not a second identifier.
   *
   * One identity means the card, the private row and the published row cannot drift apart, and it
   * means a support request can be answered from one string.
   */
  readonly id: string;
  /** What the user said, or what they edited it to. */
  readonly text: string;
  readonly state: CardState;
  /** One sentence a person can read. Never generated per view: it is stored with the card. */
  readonly reason: string;
  /** The rule that decided the scope, when one did. A card for a deferral has none. */
  readonly rule: string | null;
  /** Where the sentence came from, when the caller knew. */
  readonly origin?: { readonly sessionId: string; readonly turns: readonly string[] };
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly decidedAt?: number;
  /** When this fact stops counting as current. Set on accept/edit, cleared on refusal. */
  readonly decayAt?: number;
  /**
   * Set when an edit was refused, and why.
   *
   * The text that was refused is deliberately **not** kept: the export includes cards, and a
   * password typed into a rejected edit is still a password.
   */
  readonly refused?: { readonly rule: string; readonly policy: string; readonly at: number };
  /**
   * The sentence the person said, kept even after `text` becomes something else.
   *
   * ## Why this exists, and what found it
   *
   * The session demo published an atom and the paragraph it came from disappeared: `edit()` replaces
   * `text`, `promote()` deletes the private row, and nothing was left that said *what the person
   * originally said*. The export is the audit surface, and an audit surface that shows only the
   * agreed wording cannot answer the first question anyone asks about a disclosure -- "did they
   * really say that?".
   *
   * Set when the card is opened and never rewritten. Absent on a card stored before it existed, and
   * a reader treats absent as "same as `text`".
   */
  readonly sourceText?: string;
  /**
   * What a model offered to split this card into, and what the gates kept.
   *
   * Content, never verdict: attaching one publishes nothing, moves no row and rewrites no scope
   * field. The person's own sentence stays in `text` until they choose otherwise, because the card
   * is the record of what they said and a proposal is a suggestion about it.
   */
  readonly proposal?: TriageProposal;
};

export type CardQueueOptions = {
  /** Injected clock, so a decay test does not have to wait six months. */
  now?: () => number;
  /**
   * How long a confirmed fact stays current.
   *
   * A product default, not a measured one: nothing in this repository calibrates it, and the field
   * exists so that the value can be changed in one place when the FSRS work reaches it. Six months
   * is the shortest interval at which "is this still true?" is a question a person can answer
   * without feeling nagged.
   */
  decayMs?: number;
  /** Logical table for facts, matching `TriageWriter`. */
  table?: string;
};

const DEFAULT_DECAY_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * The order the summary line counts states in: the life of a card, not the order they appeared.
 *
 * Emitting them in first-appearance order made the header of two identical exports differ
 * depending on which card happened to sort first, which is the kind of diff that makes people stop
 * comparing exports.
 */
const STATE_ORDER: readonly CardState[] = ['proposed', 'accepted', 'edited', 'stale', 'dismissed'];

/** The sentence a deferral gets. Stored, not composed at render time. */
const DEFER_REASON =
  'No rule recognised this sentence, so it is stored privately. Publishing it is your decision.';

export class CardQueue {
  private readonly federation: FederatedStorage;
  private readonly writer: TriageWriter;
  private readonly now: () => number;
  private readonly decayMs: number;
  private readonly table: string;

  constructor(federation: FederatedStorage, writer: TriageWriter, options: CardQueueOptions = {}) {
    this.federation = federation;
    this.writer = writer;
    this.now = options.now ?? (() => Date.now());
    this.decayMs = options.decayMs ?? DEFAULT_DECAY_MS;
    this.table = options.table ?? 'facts';
  }

  /**
   * Turn an admission into a card, or explain with `null` why it is not a question.
   *
   * `null` covers four different situations on purpose, and the caller has the admission in hand to
   * tell them apart: nothing was stored; a rule already answered the question; the answer was "yes"
   * and there is nothing to ask; or the turn contains **no claim** -- every sentence in it is a
   * question, a request or a fragment (see `claims.ts`).
   *
   * The fourth case is the one this method learned last, and it changed the card's text rather than
   * only its existence: a card now carries the claims inside the turn, not the turn. The reason is in
   * `claims.ts` and it is a publishing defect, not a tidiness one -- `accept` publishes this text, so
   * before the change a yes published "please continue, provide 10 additional examples" into the
   * organisation's knowledge. `sourceText` still holds the turn, so the export can answer "did they
   * say that?" and a claim that reads oddly can be traced to the paragraph it came out of.
   *
   * Idempotent by id: opening twice returns the first card rather than resetting a decided one.
   */
  async open(
    admission: Admission,
    options: { origin?: { sessionId: string; turns: readonly string[] } } = {},
  ): Promise<KnowledgeCard | null> {
    if (!admission.stored || admission.triage.scope !== 'defer') return null;

    const claims = claimsIn(admission.text);
    if (claims.length === 0) return null;

    const existing = await this.get(admission.id);
    if (existing !== undefined) return existing;

    const raised = this.now();
    const card: KnowledgeCard = {
      id: admission.id,
      text: claims.join(' '),
      sourceText: admission.text,
      state: 'proposed',
      reason:
        admission.triage.failure === undefined
          ? DEFER_REASON
          : // A classifier that could not run is a defect, and the card says so rather than
            // pretending the sentence was merely unremarkable. The user still gets to share it.
            `The rule layer could not classify this sentence (${admission.triage.failure}), so it ` +
            `is stored privately.`,
      rule: admission.triage.rule,
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      createdAt: raised,
      updatedAt: raised,
    };
    await this.put(card);
    return card;
  }

  /**
   * Record what a model offered for this card. Writes a card, not a fact.
   *
   * Three things this refuses, each of which is a way for generated text to get somewhere it should
   * not be:
   *
   * 1. **A decided card.** The content of a published fact is history; replacing it would rewrite
   *    what the person agreed to after they agreed to it.
   * 2. **An empty proposal.** A card that offers no statement is a question with no answer to give,
   *    and it renders as a broken row rather than as "the model had nothing".
   * 3. **A statement the person did not say.** The proposer already refuses these, so this is the
   *    second gate of two -- and it is the one that also covers a proposal assembled by hand, which
   *    is what a future caller will do the first time it wants to skip the model.
   *
   * Re-attaching replaces the previous proposal rather than merging it: two models' atoms in one
   * card is a card nobody reviewed.
   */
  async attach(id: string, proposal: TriageProposal): Promise<KnowledgeCard> {
    const card = await this.require(id);
    if (card.state !== 'proposed') {
      throw new TriageError(
        `card ${JSON.stringify(id)} is ${card.state}: a proposal is content for an open question, ` +
          `and a decided card's content is history`,
      );
    }
    if (proposal.facts.length === 0) {
      throw new TriageError(
        'an empty proposal is not a proposal: it would render as a card offering nothing, which ' +
          'reads as "the model found nothing to share" rather than as a failure',
      );
    }
    for (const fact of proposal.facts) {
      if (!groundedIn(fact.text, card.text)) {
        throw new TriageError(
          `the proposed fact ${JSON.stringify(fact.text.slice(0, 80))} is not grounded in the ` +
            `sentence it claims to come from: a card may only offer words the person actually said`,
        );
      }
    }

    const raised = this.now();
    const attached: KnowledgeCard = { ...card, proposal, updatedAt: raised };
    await this.put(attached);
    return attached;
  }

  /** Publish a fact and close its card. Idempotent once accepted. */
  async accept(id: string): Promise<KnowledgeCard> {
    const card = await this.require(id);
    if (card.state === 'accepted' || card.state === 'edited') return card;
    if (card.state === 'dismissed') {
      throw new TriageError(
        `card ${JSON.stringify(id)} was dismissed, and a dismissal is terminal: a queue whose ` +
          `refusals can be reversed teaches people to ignore it`,
      );
    }
    if (card.state === 'stale') {
      throw new TriageError(
        `card ${JSON.stringify(id)} is stale: refresh it first, so the decision is made about the ` +
          `current text rather than one that has already expired`,
      );
    }

    const raised = this.now();

    // A card whose text is shorter than the turn it came from carries a sentence that has never
    // been classified **on its own**, and a substring can trip a rule the whole turn did not. The
    // case is not hypothetical: an anchored rule (`^I have been diagnosed`) does not fire on
    // "I run a team of four. I have been diagnosed with ...", which is a deferral, and then fires on
    // the claim the gate extracted. Publishing on the strength of the turn's verdict would be
    // publishing a sentence the rule layer had not seen, so the text is re-classified first and a
    // refusal is reported on the card rather than softened into a publication.
    //
    // When nothing was cut, the row's text already carries the verdict that made it a deferral, and
    // re-classifying would be a second write with nothing to learn from it.
    if (card.text !== card.sourceText) {
      const verdict = await this.writer.revise(id, card.text, { table: this.table, now: raised });
      if (!verdict.stored) {
        const refused: KnowledgeCard = {
          ...card,
          updatedAt: raised,
          refused: { rule: verdict.withheld.rule, policy: verdict.withheld.policy, at: raised },
        };
        await this.put(refused);
        return refused;
      }
    }

    await this.writer.promote(id, { table: this.table, now: raised });
    const accepted: KnowledgeCard = {
      ...card,
      state: 'accepted',
      updatedAt: raised,
      decidedAt: raised,
      decayAt: raised + this.decayMs,
    };
    await this.put(accepted);
    return accepted;
  }

  /**
   * Replace the text and publish it, unless the new sentence trips a rule.
   *
   * The refusal path is the interesting one. An edit is a **new sentence**, so it is classified
   * again: a user who pastes an account number into a card about their week has produced something
   * the policy protects, and publishing it because "they confirmed the card" would be treating
   * consent to a summary as consent to a secret.
   *
   * On refusal nothing is published, the card keeps the text it had, and the refused string is not
   * stored anywhere -- see the module comment.
   */
  async edit(id: string, text: string): Promise<KnowledgeCard> {
    const card = await this.require(id);
    if (typeof text !== 'string' || text.trim() === '') {
      throw new TypeError('edit() needs a non-blank sentence');
    }
    if (card.state === 'dismissed') {
      throw new TriageError(`card ${JSON.stringify(id)} was dismissed, so it cannot be edited`);
    }
    if (card.state !== 'proposed') {
      throw new TriageError(
        `card ${JSON.stringify(id)} is ${card.state}: only a proposed card can be edited, because ` +
          `an edit is a new sentence and a published fact has already been classified`,
      );
    }

    const raised = this.now();
    // `revise()` writes only a sentence that may be published, so the refusal path is a no-op on
    // the stores rather than a write followed by a rollback. That distinction is the whole reason
    // it exists: a paste of an account number must not land in the private store on its way to
    // being rejected, because the private store is what the export reads.
    const verdict = await this.writer.revise(card.id, text, { table: this.table, now: raised });

    if (!verdict.stored) {
      const refused: KnowledgeCard = {
        ...card,
        updatedAt: raised,
        // Narrowed by the `!verdict.stored` branch: an admission that stored nothing always says
        // which rule refused, because the type says so.
        refused: { rule: verdict.withheld.rule, policy: verdict.withheld.policy, at: raised },
      };
      await this.put(refused);
      return refused;
    }

    // `shared` (a rule now agrees) and `defer` (the user's edit is consent) both publish. The
    // second is the one worth stating: a deferral has no rule to appeal to, so the confirmation
    // *is* the decision -- and it is recorded as `confirmedAt`, not as a rule firing.
    await this.writer.promote(id, { table: this.table, now: raised });
    const edited: KnowledgeCard = {
      ...card,
      text,
      state: 'edited',
      updatedAt: raised,
      decidedAt: raised,
      decayAt: raised + this.decayMs,
    };
    await this.put(edited);
    return edited;
  }

  /** Refuse a card. Terminal; idempotent once dismissed. */
  async dismiss(id: string): Promise<KnowledgeCard> {
    const card = await this.require(id);
    if (card.state === 'dismissed') return card;
    if (card.state !== 'proposed') {
      throw new TriageError(
        `card ${JSON.stringify(id)} is ${card.state}: withdrawing a published fact is a different ` +
          `operation, and this one would leave the shared copy in place`,
      );
    }

    const raised = this.now();
    const dismissed: KnowledgeCard = {
      ...card,
      state: 'dismissed',
      updatedAt: raised,
      decidedAt: raised,
    };
    await this.put(dismissed);
    return dismissed;
  }

  /**
   * Withdraw the facts whose confirmation has expired.
   *
   * Returns the cards that changed, so a caller can show "these five need a second look" without
   * recomputing the predicate. A fact is withdrawn at the read side as well, which is what makes
   * this a control rather than a reminder.
   */
  async expire(): Promise<KnowledgeCard[]> {
    const raised = this.now();
    const stale: KnowledgeCard[] = [];

    for (const card of await this.list()) {
      if (card.state !== 'accepted' && card.state !== 'edited') continue;
      // `card.decayAt === undefined` is not defensive noise: it is the row a previous release
      // wrote, before deadlines existed. Such a card is left alone rather than swept on sight --
      // the same call the read side makes about a missing `stale` flag, and for the same reason.
      if (card.decayAt === undefined || card.decayAt > raised) continue;

      await this.writer.setStale(card.id, true, { table: this.table, now: raised });
      const expired: KnowledgeCard = { ...card, state: 'stale', updatedAt: raised };
      await this.put(expired);
      stale.push(expired);
    }

    return stale;
  }

  /** Re-confirm a stale fact: it answers again, with a fresh interval. */
  async refresh(id: string): Promise<KnowledgeCard> {
    const card = await this.require(id);
    if (card.state !== 'stale') {
      throw new TriageError(
        `card ${JSON.stringify(id)} is ${card.state}: only a stale card needs refreshing`,
      );
    }

    const raised = this.now();
    await this.writer.setStale(card.id, false, { table: this.table, now: raised });
    const refreshed: KnowledgeCard = {
      ...card,
      state: 'accepted',
      updatedAt: raised,
      decidedAt: raised,
      decayAt: raised + this.decayMs,
    };
    await this.put(refreshed);
    return refreshed;
  }

  /** One card, or `undefined`. */
  async get(id: string): Promise<KnowledgeCard | undefined> {
    return this.federation.get<KnowledgeCard>('private/cards', id);
  }

  /** Every card, oldest first. Dismissed ones included: the export is the audit surface. */
  async list(): Promise<KnowledgeCard[]> {
    const cards = await this.federation.query<KnowledgeCard>('private/cards', {});
    return [...cards].sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
      // A stable tie-break, because two cards admitted in the same millisecond would otherwise
      // swap places between two calls to `list()` and make every export a diff. No `0` arm: the
      // store cannot hold two rows under one key, so it would be unreachable code pretending to be
      // defensive.
      return left.id < right.id ? -1 : 1;
    });
  }

  /** The export a person reads. Markdown, because the alternative is a PDF nobody opens. */
  async toMarkdown(): Promise<string> {
    const cards = await this.list();
    const counts: Record<CardState, number> = {
      proposed: 0,
      accepted: 0,
      edited: 0,
      stale: 0,
      dismissed: 0,
    };
    for (const card of cards) counts[card.state] += 1;

    const summary = STATE_ORDER.filter((state) => counts[state] > 0).map(
      (state) => `${counts[state]} ${state}`,
    );

    // Two optional columns, each shown only when it carries something. A column that is empty for
    // every row teaches the reader to skip the right-hand side of the table, which is where the
    // audit lives.
    const showProposal = cards.some((card) => card.proposal !== undefined);
    // The source column appears only for a card whose wording changed -- an edit, or an accepted
    // atom. On a card nobody touched it would repeat the `text` column for every row.
    const showSource = cards.some(
      (card) => card.sourceText !== undefined && card.sourceText !== card.text,
    );
    const columns = [
      'id',
      'state',
      'reason',
      'text',
      ...(showSource ? ['source'] : []),
      ...(showProposal ? ['proposed'] : []),
    ];
    const header = `| ${columns.join(' | ')} |`;
    const divider = `|${columns.map(() => '---').join('|')}|`;

    const lines = [
      '# Knowledge cards',
      '',
      `${cards.length} card(s): ${summary.join(', ')}.`,
      '',
      header,
      divider,
      ...cards.map((card) => {
        const cells = [
          `\`${card.id}\``,
          card.state,
          escapeCell(card.reason),
          escapeCell(card.text),
          ...(showSource ? [escapeCell(sourceCell(card))] : []),
          ...(showProposal ? [escapeCell(proposedCell(card))] : []),
        ];
        return `| ${cells.join(' | ')} |`;
      }),
    ];
    return `${lines.join('\n')}\n`;
  }

  /** The same content as data, for anything that is not a person reading a table. */
  async toJSON(): Promise<KnowledgeCard[]> {
    return this.list();
  }

  private async put(card: KnowledgeCard): Promise<void> {
    await this.federation.put('private/cards', card.id, card);
  }

  private async require(id: string): Promise<KnowledgeCard> {
    const card = await this.get(id);
    if (card === undefined) {
      throw new TriageError(`no card with id ${JSON.stringify(id)}`);
    }
    return card;
  }
}

/** A table cell cannot carry a pipe or a newline; the text is the user's, so both are possible. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** The wording the person used, or nothing when it is what the card already shows. */
function sourceCell(card: KnowledgeCard): string {
  if (card.sourceText === undefined || card.sourceText === card.text) return '';
  return card.sourceText;
}

/**
 * The atoms a card offers, with the withheld count beside them.
 *
 * The count is printed even when it is zero, because "0 withheld" is a reading and an empty cell is
 * not: a reviewer comparing two exports needs to see that the second one rejected six statements.
 */
function proposedCell(card: KnowledgeCard): string {
  if (card.proposal === undefined) return '';
  const atoms = card.proposal.facts.map((fact) => fact.text).join('; ');
  return `${atoms} (${card.proposal.withheld.length} withheld)`;
}
