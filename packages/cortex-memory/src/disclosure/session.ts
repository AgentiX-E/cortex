/**
 * One object that carries a sentence from "they said it" to "a colleague can read it".
 *
 * ## Why a session and not a caller for each piece
 *
 * `TriageWriter`, `CardQueue`, `TriageProposer` and `ReadSideAssembler` compose in exactly one order,
 * and getting it wrong is silent: call `accept` before `attach` and the user publishes a paragraph;
 * call `propose` after `dismiss` and a dismissed question gets content nobody will ever see. Written
 * once, in one place, the order is a property. Written at each call site, it is a convention -- and
 * this repository has already paid for one of those (see `writer.ts`'s module comment on the
 * boundary being a convention held by the next caller).
 *
 * ## The five rules this object enforces, and where each one comes from
 *
 * 1. **A sentence is stored before it is asked about.** `say()` admits first; a card only exists for
 *    a row that exists, because a question about something not stored cannot be answered by
 *    promoting it.
 * 2. **A proposal is content, not consent.** `propose()` attaches and returns; it publishes nothing.
 * 3. **Publishing an atom goes through `edit`,** so the rule table classifies it again at the moment
 *    of the click. The model's verdict is from when the proposal was made.
 * 4. **A failure is returned, not swallowed.** `propose()` hands back the failure union so the caller
 *    can render "the model could not be reached, here is your sentence" -- which is the only honest
 *    thing to show.
 * 5. **A shared task reads the shared store only.** `evidence()` delegates to the assembler, which
 *    throws rather than filtering when a row mis-declares itself.
 *
 * ## What this object deliberately does not do
 *
 * It does not choose an engine, own a clock, or know what a card looks like on screen. The storage
 * comes in as an interface so this file stays importable in a browser; the clock comes in so a decay
 * test does not wait six months; the rendering lives in the CLI and in `toMarkdown`.
 */
import type { Storage } from '@agentix-e/cortex-core';
import {
  CardQueue,
  FederatedStorage,
  OutputGuard,
  ReadSideAssembler,
  TriageError,
  TriageWriter,
  type Admission,
  type KnowledgeCard,
  type OutputScan,
  type AdmittedFact,
  type ProposalResult,
  type ReleaseRecord,
  type ScopedRow,
  type TaskScope,
  type TriageProposer,
} from '@agentix-e/cortex-core';

export type DisclosureSessionOptions = {
  /**
   * The owner's store.
   *
   * Two stores, not one, and that is a measurement rather than a preference: the first version of
   * this file took a single `Storage` on the theory that the table prefix would separate them. It
   * does not. `FederatedStorage` treats the prefix as a *routing marker* and strips it, so both
   * halves write to a table called `facts` in the same engine, and the first shared query returns
   * the private rows too -- where `ReadSideAssembler` refuses, correctly, with a `ScopeViolation`
   * naming the offending key. Wiring is what showed this; no unit test of either half could, because
   * each half was right.
   */
  readonly private: Storage;
  /**
   * The store a colleague's task may read.
   *
   * A second file, a second database, or a second connection to a different schema. The isolation
   * this product sells is "the data did not go there", and a shared table in the same file is a
   * filter away from the thing it claims not to be.
   */
  readonly shared: Storage;
  /** Required only by `propose()`; a session without one still admits, asks and publishes. */
  readonly proposer?: TriageProposer;
  /** Logical table for facts and cards; defaults to `facts` and `cards`. */
  readonly table?: string;
  readonly now?: () => number;
  /** How long a confirmed fact stays current; forwarded to the queue. */
  readonly decayMs?: number;
};

export type SayResult = {
  readonly admission: Admission;
  /** `null` when nothing was stored, when a rule already answered, or when the answer was "yes". */
  readonly card: KnowledgeCard | null;
};

export type CheckOptions = {
  readonly task: TaskScope;
  /** Whether a shared draft must cite anything. Defaults to the guard's rule: yes for shared. */
  readonly requireCitation?: boolean;
  /** Shortest verbatim overlap that counts as an echo. Defaults to the guard's thirty-two. */
  readonly minEchoChars?: number;
};

export class DisclosureSession {
  private readonly federation: FederatedStorage;
  private readonly writer: TriageWriter;
  private readonly queue: CardQueue;
  private readonly assembler: ReadSideAssembler;
  private readonly guard = new OutputGuard();
  private readonly proposer: TriageProposer | undefined;
  private readonly table: string;
  private readonly now: () => number;

  constructor(options: DisclosureSessionOptions) {
    const federation = new FederatedStorage({ private: options.private, shared: options.shared });
    this.federation = federation;
    this.writer = new TriageWriter(federation);
    this.queue = new CardQueue(federation, this.writer, {
      now: options.now ?? (() => Date.now()),
      ...(options.decayMs === undefined ? {} : { decayMs: options.decayMs }),
      ...(options.table === undefined ? {} : { table: options.table }),
    });
    this.assembler = new ReadSideAssembler(federation);
    this.proposer = options.proposer;
    this.table = options.table ?? 'facts';
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Admit one sentence and, if the rules deferred it, open a question about it.
   *
   * Returns both halves because the caller needs both: a withheld credential has no card but must
   * still be reported as withheld, and a sentence a shared rule claimed has no card because nothing
   * is in question.
   */
  async say(text: string, options: { id?: string } = {}): Promise<SayResult> {
    const admission = await this.writer.admit(text, {
      ...(options.id === undefined ? {} : { id: options.id }),
      table: this.table,
      now: this.now(),
    });
    const card = admission.stored ? await this.queue.open(admission) : null;
    return { admission, card };
  }

  /**
   * Ask the model to split one card's sentence, and record what survived.
   *
   * Throws when no proposer was configured: that is a caller defect, not a model failure, and
   * returning a failure union would let it be rendered as "the model had nothing to say".
   */
  async propose(id: string): Promise<ProposalResult> {
    if (this.proposer === undefined) {
      throw new TriageError(
        'this session has no proposer, so it cannot split a card into atoms: pass one when opening ' +
          'the session, or leave the card showing the sentence the person said',
      );
    }
    const card = await this.require(id);
    const result = await this.proposer.propose(card.text);
    if (result.ok) await this.queue.attach(id, result.proposal);
    return result;
  }

  /**
   * Publish, either the card's own sentence or one of the atoms a model proposed.
   *
   * An atom index is checked before anything is written: an index that does not exist is a UI bug,
   * and publishing the original sentence because the index was wrong would be a silent edit to what
   * the person agreed to.
   */
  async accept(id: string, options: { atom?: number } = {}): Promise<KnowledgeCard> {
    if (options.atom === undefined) return this.queue.accept(id);
    const card = await this.require(id);
    const facts = card.proposal?.facts ?? [];
    if (facts.length === 0) {
      throw new TriageError(
        `card ${JSON.stringify(id)} has no proposal, so there is no atom to publish: accept the ` +
          `card itself, or propose first`,
      );
    }
    const chosen = facts[options.atom];
    if (chosen === undefined) {
      throw new TriageError(
        `atom ${options.atom} is out of range: this card offers ${facts.length} atom(s), ` +
          `indexes 0..${facts.length - 1}`,
      );
    }
    return this.queue.edit(id, chosen.text);
  }

  /** Type a different sentence for this card, and publish it if a rule allows. */
  async edit(id: string, text: string): Promise<KnowledgeCard> {
    return this.queue.edit(id, text);
  }

  /** Refuse a card. Terminal, and the session does not soften that. */
  async dismiss(id: string): Promise<KnowledgeCard> {
    return this.queue.dismiss(id);
  }

  /** Re-confirm a stale fact. */
  async refresh(id: string): Promise<KnowledgeCard> {
    return this.queue.refresh(id);
  }

  /** Withdraw every confirmed fact that has outlived its interval. */
  async expire(): Promise<KnowledgeCard[]> {
    return this.queue.expire();
  }

  /** The queue, oldest first, dismissed included. */
  async cards(): Promise<KnowledgeCard[]> {
    return this.queue.list();
  }

  /**
   * Check a draft against the three output layers, with the window it was supposed to be built from.
   *
   * This is the method that makes O1/O2/O3 reachable from a product path. Until it existed, the
   * output side had tests and a benchmark script and no caller -- which the export ledger said out
   * loud for two steps before anyone acted on it.
   *
   * The window comes from the read side, so a finding can be excused by a shared row that says the
   * same thing; the private corpus comes from the private store, so O3 can catch a sentence no rule
   * recognises. Both come from the same session that wrote them, which is the point: the check is
   * never asking a different question from the one the write side answered.
   */
  async check(draft: string, options: CheckOptions): Promise<OutputScan> {
    const window = await this.evidence(options.task);
    const privateValues = await this.federation.query(`private/${this.table}`, {});
    return this.guard.scan(draft, {
      task: options.task,
      window,
      privateValues,
      ...(options.requireCitation === undefined
        ? {}
        : { requireCitation: options.requireCitation }),
      ...(options.minEchoChars === undefined ? {} : { minEchoChars: options.minEchoChars }),
    });
  }

  /**
   * Override a rule for one row the rules kept private, and record that it happened.
   *
   * This is the ninth command and the last one that was missing: until it existed, a sentence the
   * rules judged private was stored privately forever with no card and no question, so the owner
   * could not change their mind about their own memory. `g42` was the example in step 6.
   *
   * The awkward part is on purpose and is documented in `cortex-core`'s `release.ts`: a token has to
   * be typed, the record is written before the row moves, and the record lives in its own table
   * inside the private store. `acknowledge` is passed through rather than defaulted -- a default
   * here would be a door that opens itself.
   */
  async release(
    id: string,
    options: { acknowledge: string },
  ): Promise<{ record: ReleaseRecord; fact: AdmittedFact }> {
    return this.writer.release(id, { acknowledge: options.acknowledge, table: this.table });
  }

  /** Every override, oldest first. The audit trail, and nothing else. */
  async releases(): Promise<ReleaseRecord[]> {
    return this.writer.releases();
  }

  /** What a task of this scope may read. The assembler enforces the boundary, not this method. */
  async evidence(task: TaskScope): Promise<ScopedRow[]> {
    return this.assembler.assemble({ task, table: this.table });
  }

  /** The export a person reads. */
  async export(): Promise<string> {
    return this.queue.toMarkdown();
  }

  private async require(id: string): Promise<KnowledgeCard> {
    const card = await this.queue.get(id);
    if (card === undefined) throw new TriageError(`no card with id ${JSON.stringify(id)}`);
    return card;
  }
}
