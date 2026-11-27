/**
 * Reading a model's reply.
 *
 * ## The population these cover
 *
 * Every case below happened: the fence, the preamble, the trailing comma, the typographic quotes,
 * the truncated object from a thinking model that ran out of `max_tokens`, and the reply that
 * answers the question instead of deciding anything. The loop's policy is that none of them throws
 * -- a lost question is a reading, a lost dispatch is a morning -- and that each is recorded as the
 * distinct fact it is, because "the reader refused" and "the reader wrote prose" call for different
 * repairs.
 */
import { describe, expect, it } from 'vitest';

import { parseDecision } from '../../agent/parse.js';

describe('parseDecision', () => {
  it('reads the three actions', () => {
    expect(parseDecision('{"action":"answer"}')).toEqual({ action: 'answer' });
    expect(parseDecision('{"action":"search","query":"  charity run  "}')).toEqual({
      action: 'search',
      query: 'charity run',
    });
    expect(parseDecision('{"action":"session","turn":12}')).toEqual({
      action: 'session',
      turn: 12,
    });
  });

  it('accepts the wrapping a model adds around a correct answer', () => {
    expect(parseDecision('```json\n{"action":"answer"}\n```')).toEqual({ action: 'answer' });
    expect(parseDecision('Sure. Here is my decision:\n{"action":"answer"}')).toEqual({
      action: 'answer',
    });
    // A trailing comma before the brace is the most common single-character defect in the wild.
    expect(parseDecision('{"action":"answer",}')).toEqual({ action: 'answer' });
    expect(parseDecision('{"action":"search","query":"beach trip",}')).toEqual({
      action: 'search',
      query: 'beach trip',
    });
    // Typographic quotes: JSON.parse rejects them, and the content is unambiguous.
    expect(parseDecision('{“action”:“answer”}')).toEqual({ action: 'answer' });
  });

  it('reports prose as unreadable and never as a decision', () => {
    expect(parseDecision('I think the evidence is enough.')).toEqual({
      action: 'unparsed',
      reason: 'not-json',
    });
    // An opening brace with no close is the truncated-reply case.
    expect(parseDecision('{"action":"sea')).toEqual({ action: 'unparsed', reason: 'not-json' });
    expect(parseDecision('{"action":}')).toEqual({ action: 'unparsed', reason: 'not-json' });
  });

  it('reports a reply with no JSON object in it at all', () => {
    // A bare array, a bare string and a bare number are all "no decision" -- a reader that answers
    // with a list has not told the loop what to do with it.
    expect(parseDecision('["answer"]')).toEqual({ action: 'unparsed', reason: 'not-json' });
    expect(parseDecision('"answer"')).toEqual({ action: 'unparsed', reason: 'not-json' });
    expect(parseDecision('42')).toEqual({ action: 'unparsed', reason: 'not-json' });
  });

  it('reports an object that carries no action it knows', () => {
    expect(parseDecision('{"nested":{"a":1}} trailing')).toEqual({
      action: 'unparsed',
      reason: 'unknown-action:undefined',
    });
  });

  it('turns a malformed search field into the empty query the stop rule understands', () => {
    // Not `unparsed`: the reader asked to search, and a search with no words is a stop either way.
    expect(parseDecision('{"action":"search","query":7}')).toEqual({ action: 'search', query: '' });
    expect(parseDecision('{"action":"search"}')).toEqual({ action: 'search', query: '' });
  });

  it('reads a session id whether it is quoted or not, and refuses one that is not an id', () => {
    expect(parseDecision('{"action":"session","turn":"12"}')).toEqual({
      action: 'session',
      turn: 12,
    });
    expect(parseDecision('{"action":"session","turn":"twelve"}')).toEqual({
      action: 'unparsed',
      reason: 'session-without-turn',
    });
    expect(parseDecision('{"action":"session"}')).toEqual({
      action: 'unparsed',
      reason: 'session-without-turn',
    });
    expect(parseDecision('{"action":"session","turn":1.5}')).toEqual({
      action: 'unparsed',
      reason: 'session-without-turn',
    });
  });

  it('names an action it does not know', () => {
    expect(parseDecision('{"action":"browse"}')).toEqual({
      action: 'unparsed',
      reason: 'unknown-action:browse',
    });
  });

  // A reasoning model restates the three example shapes while it thinks, then emits its decision.
  // The object that governs the loop is the LAST well-formed decision object: earlier ones are the
  // model quoting the contract back at itself, and the conclusion is what it settled on. The old
  // first-to-last slice swallowed every object plus the prose between them and returned `not-json`,
  // losing a question the reader had actually answered.
  it('reads the final decision object out of a reply that echoes the example shapes first', () => {
    expect(
      parseDecision(
        'Thinking: the format is {"action":"search","query":"x"} but that is only an example. ' +
          'I conclude {"action":"answer"}',
      ),
    ).toEqual({ action: 'answer' });
    expect(
      parseDecision(
        'Let me consider {"action":"session","turn":3} then decide. Final: {"action":"answer"}',
      ),
    ).toEqual({ action: 'answer' });
  });

  it('does not let a brace inside a string or a trailing non-decision object hide the decision', () => {
    // A `}` inside a quoted value is not a boundary; a brace-blind lastIndexOf would cut there.
    expect(parseDecision('{"action":"search","query":"a } b"}')).toEqual({
      action: 'search',
      query: 'a } b',
    });
    // An escaped quote keeps the string open, so the `}` after it is still inside the value.
    expect(parseDecision('{"action":"search","query":"a \\"b\\" } c"}')).toEqual({
      action: 'search',
      query: 'a "b" } c',
    });
    // A trailing remark that is not a decision must not override the one decision present.
    expect(
      parseDecision('{"action":"answer"}\n(For reference: {"note":"search was considered"})'),
    ).toEqual({ action: 'answer' });
    // A stray `}` before any object is not a close; the real object is still read.
    expect(parseDecision('stray } then {"action":"answer"}')).toEqual({ action: 'answer' });
  });
});
