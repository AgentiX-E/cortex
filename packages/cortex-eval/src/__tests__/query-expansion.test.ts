import { describe, expect, it, vi } from 'vitest';
import {
  expandMultiSessionQueries,
  type ExpansionTarget,
  type QuestionExpansion,
} from '../query-expansion.js';

/**
 * The prompt and the parser are observed through the one call that uses them.
 *
 * ## Why not import them
 *
 * Neither is exported. The census in `tools/export-census.mjs` reports an export used only
 * inside its own file as an orphan -- "the `export` keyword is unnecessary; the code is not"
 * -- and the only reason to export them would be this suite. Observing them through
 * `expandMultiSessionQueries` is also the stronger test: what reaches retrieval is
 * `byQuestion`, so a parser rule is asserted by the list the index would be built with, not
 * by a function's return value one layer above it. The prompt is read from the completion's
 * own argument, which is exactly the string the model receives.
 */

const QUESTION = 'How many projects did I lead at work?';

type Observation = {
  /** The prompt the model was asked with. */
  readonly prompt: string;
  /** The phrases the index would be built with. */
  readonly phrases: string[];
  readonly questions: number;
  readonly phrased: number;
  readonly empty: number;
};

/** Expand one question with a fixed response, and report everything the call produced. */
async function expand(raw: string, limit?: number): Promise<Observation> {
  const prompts: string[] = [];
  const llm = {
    complete: (prompt: string): Promise<string> => {
      prompts.push(prompt);
      return Promise.resolve(raw);
    },
  };
  const targets: readonly ExpansionTarget[] = [{ question: QUESTION, capability: 'MR' }];
  const expansion: QuestionExpansion =
    limit === undefined
      ? await expandMultiSessionQueries(llm, targets)
      : await expandMultiSessionQueries(llm, targets, limit);
  return {
    // `prompts[0]` is the only call this fixture makes, and `as string` states that rather
    // than carrying a fallback whose branch no test could reach.
    prompt: prompts[0] as string,
    phrases: [...(expansion.byQuestion.get(QUESTION) ?? [])],
    questions: expansion.questions,
    phrased: expansion.phrases,
    empty: expansion.empty,
  };
}

/** Just the phrases, which is what every parser rule is asserted against. */
async function phrasesOf(raw: string, limit?: number): Promise<string[]> {
  return (await expand(raw, limit)).phrases;
}

describe('the expansion prompt', () => {
  it('asks with the question verbatim and ends on the answer label', async () => {
    const { prompt } = await expand('led a project');
    expect(prompt).toContain(`Question: ${QUESTION}`);
    expect(prompt.endsWith('Activities:')).toBe(true);
  });

  it('names the bound it will enforce, so the prompt and the parser cannot drift', async () => {
    // The default is written out as a literal on purpose: it is a contract a reader compares
    // against §13.97's registration, and a test that read the constant would pass on any value.
    expect((await expand('led a project')).prompt).toContain('at most 4');
    expect((await expand('led a project', 2)).prompt).toContain('at most 2');
  });

  it('asks for an action with its object and forbids invented names', async () => {
    const { prompt } = await expand('led a project');
    // Both instructions are load-bearing: a bare category noun retrieves every session that
    // mentions the category, and an invented name retrieves nothing at all.
    expect(prompt).toContain('Do not list bare category nouns');
    expect(prompt).toContain('Do not invent names');
  });
});

describe('parsing the response into queries', () => {
  it('splits on commas, semicolons and newlines', async () => {
    expect(await phrasesOf('led a project; attended a workshop\nran a review')).toEqual([
      'led a project',
      'attended a workshop',
      'ran a review',
    ]);
  });

  it('strips list decoration, numbering and wrapping quotes', async () => {
    expect(await phrasesOf('1. "led a project", - attended a workshop')).toEqual([
      'led a project',
      'attended a workshop',
    ]);
  });

  it('strips a label the model echoed before the first phrase', async () => {
    expect(await phrasesOf('Activities: led a project, attended a workshop')).toEqual([
      'led a project',
      'attended a workshop',
    ]);
  });

  it('drops a refusal whole rather than truncating it to its first clause', async () => {
    // The reference pipeline's recorded failure: three sentences of a refusal carried into
    // retrieval as phrases, so the reader searched for text unrelated to the question.
    expect(
      await phrasesOf(
        "I don't have access to your past conversations or evidence sessions, so I can't identify the specific activities, I can help if you share context",
      ),
    ).toEqual([]);
  });

  it('drops one apologetic item and keeps the list around it', async () => {
    // The mixed case: a real list with a refusal in the middle. The head does not decline,
    // so the response is not a refusal, and the item itself is still filtered out.
    expect(await phrasesOf('led a project, sorry I cannot help further, ran a review')).toEqual([
      'led a project',
      'ran a review',
    ]);
  });

  it('drops a phrase identical to the question, which would add no reach', async () => {
    expect(await phrasesOf(`${QUESTION}, led a project`)).toEqual(['led a project']);
  });

  it('compares the question without case, spacing or trailing punctuation', async () => {
    expect(await phrasesOf('how many projects did i lead at work, led a project')).toEqual([
      'led a project',
    ]);
  });

  it('folds case-insensitive duplicates instead of letting them spend the budget', async () => {
    expect(await phrasesOf('led a project, Led A Project, attended a workshop', 2)).toEqual([
      'led a project',
      'attended a workshop',
    ]);
  });

  it('drops items shorter than a real phrase and longer than a query', async () => {
    const long = 'a'.repeat(81);
    expect(await phrasesOf(`2, -, led a project, ${long}`)).toEqual(['led a project']);
  });

  it('keeps the shortest legal phrase and the longest legal one', async () => {
    const longest = 'a'.repeat(80);
    expect(await phrasesOf(`abc, ${longest}`)).toEqual(['abc', longest]);
  });

  it('applies the bound after folding, so duplicates cannot shrink the list', async () => {
    expect(
      await phrasesOf('led a project, led a project, attended a workshop, ran a review', 3),
    ).toEqual(['led a project', 'attended a workshop', 'ran a review']);
  });

  it('returns nothing for an empty or unusable response', async () => {
    expect(await phrasesOf('')).toEqual([]);
    expect(await phrasesOf('   ,  ; \n ')).toEqual([]);
  });

  it('returns nothing for a bound of zero rather than one phrase', async () => {
    expect(await phrasesOf('led a project', 0)).toEqual([]);
  });
});

describe('who is asked, and what the counts say', () => {
  const mr = (question: string): ExpansionTarget => ({ question, capability: 'MR' });

  it('asks only the multi-session questions, and counts what reached the index', async () => {
    const complete = vi.fn((prompt: string): Promise<string> =>
      Promise.resolve(
        prompt.includes('projects') ? 'led a project, ran a review' : 'attended a workshop',
      ),
    );
    const expansion = await expandMultiSessionQueries({ complete }, [
      mr('How many projects did I lead?'),
      { question: 'When did I move house?', capability: 'TR' },
      { question: 'What is my cat called?', capability: 'IE' },
      mr('How many workshops did I attend?'),
    ]);

    // Two MR questions, two non-MR ones never asked: the reach is the route, not the dataset.
    expect(complete).toHaveBeenCalledTimes(2);
    expect(expansion.questions).toBe(2);
    expect(expansion.phrases).toBe(3);
    expect(expansion.empty).toBe(0);
    expect([...expansion.byQuestion.keys()]).toEqual([
      'How many projects did I lead?',
      'How many workshops did I attend?',
    ]);
  });

  it('counts a refused response and leaves the question on its bare query', async () => {
    const complete = vi.fn((): Promise<string> => Promise.resolve("I'm unable to help with that."));
    const expansion = await expandMultiSessionQueries({ complete }, [
      mr('How many projects did I lead?'),
      mr('How many workshops did I attend?'),
    ]);
    expect(expansion.empty).toBe(2);
    expect(expansion.questions).toBe(2);
    expect(expansion.phrases).toBe(0);
    expect(expansion.byQuestion.size).toBe(0);
  });

  it('asks each distinct question once, and counts it once', async () => {
    const complete = vi.fn((): Promise<string> => Promise.resolve('led a project'));
    const expansion = await expandMultiSessionQueries({ complete }, [mr(QUESTION), mr(QUESTION)]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(expansion.questions).toBe(1);
    expect(expansion.phrases).toBe(1);
  });

  it('keeps questions, phrases and refusals consistent by construction', async () => {
    const complete = vi.fn((prompt: string): Promise<string> =>
      Promise.resolve(
        prompt.includes('projects') ? 'led a project, ran a review' : 'I cannot help with that',
      ),
    );
    const expansion = await expandMultiSessionQueries({ complete }, [
      mr('How many projects did I lead?'),
      mr('How many workshops did I attend?'),
    ]);
    expect(expansion.questions).toBe(expansion.byQuestion.size + expansion.empty);
  });

  it('propagates a transport failure rather than degrading to the control', async () => {
    // A run dispatched with `llm` that silently answered from the bare question would publish
    // an artifact claiming a treatment it never administered.
    const complete = vi.fn((): Promise<string> => Promise.reject(new Error('429')));
    await expect(expandMultiSessionQueries({ complete }, [mr(QUESTION)])).rejects.toThrow('429');
  });

  it('asks nothing when the dataset holds no multi-session question', async () => {
    const complete = vi.fn((): Promise<string> => Promise.resolve('led a project'));
    const expansion = await expandMultiSessionQueries({ complete }, [
      { question: 'When did I move?', capability: 'TR' },
    ]);
    expect(complete).not.toHaveBeenCalled();
    expect(expansion).toEqual({ byQuestion: new Map(), questions: 0, phrases: 0, empty: 0 });
  });
});
