/**
 * `thinking` has to grow a value, because it cannot grow an input.
 *
 * ## Why the value carries the routes
 *
 * `PREREGISTRATION` §13.197 measured both states of `thinking` on the same 220 questions:
 * `enabled` bought `TR` four questions with **zero losses** and sold `IE` sixteen. §13.197.3
 * registers the product answer -- thinking on the two routes whose block closes with the answer
 * instruction, off on the four that do not -- and §13.197.4 records why it cannot be a new
 * dispatch input: the workflow declares **24** inputs and GitHub's ceiling is 25, the same wall
 * that moved `budgetMinutes` into a constant. The state therefore goes inside the value that
 * already exists, which is the repair §13.188 established for the turn-cap width.
 *
 * ## What this suite is for
 *
 * A grammar is only worth having if the invalid values are unrepresentable. Three of the cases
 * below are mistakes an operator will actually make, and each one would otherwise produce a run
 * whose artifact is consistent with a treatment it never administered:
 *
 * 1. **A misspelled route.** `multi-session+multi-sesion` applied to five of six routes reads
 *    exactly like six.
 * 2. **A comma.** The neighbouring reach inputs (`cortex_memory_max_turn_chars_routes`,
 *    `cortex_memory_evidence_roles_routes`) are comma-separated, so a comma is the likeliest
 *    transcription.
 * 3. **`all`.** That word means "every route" for those same two inputs, so it is the first thing
 *    an operator will reach for -- and here it names a reach without naming a mode, which is the
 *    one thing this value cannot be ambiguous about.
 *
 * Every rejection below names the value it got, because a dispatch is not repeatable for free and
 * an error message that does not state the offending input sends the operator back to the job log
 * to reconstruct it.
 */
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';

import {
  createLlmFromEnv,
  createReadersFromEnv,
  readThinkingReach,
  resolveReaderIdentity,
} from '../llm-factory.js';
import { ALL_TURN_CAP_ROUTES } from '../turn-cap-routes.js';

describe('readThinkingReach', () => {
  it('reads an unfilled input as the shipped state', () => {
    // GitHub writes the empty string into the environment rather than omitting the variable, so
    // "the operator left it alone" arrives as `''`. Both spellings have to mean one thing, or the
    // default would depend on how the value travelled.
    expect(readThinkingReach(undefined)).toEqual({ mode: 'disabled', routes: undefined });
    expect(readThinkingReach('')).toEqual({ mode: 'disabled', routes: undefined });
    expect(readThinkingReach('   ')).toEqual({ mode: 'disabled', routes: undefined });
  });

  it('accepts the spellings the two ends have been dispatched under', () => {
    for (const raw of ['disabled', 'off', 'false', 'DISABLED', ' Off ']) {
      expect(readThinkingReach(raw), raw).toEqual({ mode: 'disabled', routes: undefined });
    }
    for (const raw of ['enabled', 'on', 'true', 'ENABLED']) {
      expect(readThinkingReach(raw), raw).toEqual({ mode: 'enabled', routes: undefined });
    }
  });

  it('reads a route list as enabled on exactly those routes and nothing else', () => {
    // `mode` describes the routes that ARE named; the routes that are not keep the shipped
    // `disabled`, which is why the reach and the mode are two fields rather than one string.
    expect(readThinkingReach('multi-session+temporal')).toEqual({
      mode: 'enabled',
      routes: ['multi-session', 'temporal'],
    });
  });

  it('keeps the order the operator wrote, so the artifact reads back the dispatch', () => {
    // The rendering is `thinking=enabled on temporal+multi-session` and is compared against the
    // dispatch by a human. Sorting would make the line a canonicalisation of the request rather
    // than a record of it, and the two differ on the day someone dispatches the reverse order to
    // check whether order matters.
    expect(readThinkingReach('temporal+multi-session').routes).toEqual([
      'temporal',
      'multi-session',
    ]);
  });

  it('tolerates the whitespace a hand-edited dispatch table carries', () => {
    expect(readThinkingReach(' multi-session + temporal ').routes).toEqual([
      'multi-session',
      'temporal',
    ]);
  });

  it('accepts every route on its own', () => {
    // The six names are the product's, and this loop is what keeps this copy honest: a route added
    // to the union but not here would be a route the arm cannot scope thinking to, silently.
    for (const route of ALL_TURN_CAP_ROUTES) {
      expect(readThinkingReach(route), route).toEqual({ mode: 'enabled', routes: [route] });
    }
    expect(ALL_TURN_CAP_ROUTES).toEqual([
      'multi-session',
      'temporal',
      'flat',
      'knowledge-update',
      'abstention',
      'assistant',
    ]);
  });

  it('rejects a name that is not a route, and names all six in the message', () => {
    expect(() => readThinkingReach('multi-session+multi-sesion')).toThrow(
      /DEEPSEEK_THINKING must be "disabled", "enabled", or a "\+"-separated list of routes/,
    );
    // The offending token, not only the whole value: the whole value is in the job log anyway and
    // the token is what has to be corrected.
    expect(() => readThinkingReach('multi-session+multi-sesion')).toThrow(/"multi-sesion"/);
    expect(() => readThinkingReach('multi-session+multi-sesion')).toThrow(/"knowledge-update"/);
  });

  it('rejects a comma and points at the separator, because the sibling inputs use commas', () => {
    expect(() => readThinkingReach('multi-session,temporal')).toThrow(
      /separates routes with "\+", not ","/,
    );
    expect(() => readThinkingReach('multi-session,temporal')).toThrow(
      /got "multi-session,temporal"/,
    );
  });

  it('rejects an inherited object member rather than mapping it', () => {
    // `TURN_CAP_ROUTES` is an object literal, so `'toString' in table` is true. With `in`, this
    // value would have produced a map whose only entry is a key the product can never ask for,
    // and the artifact would have printed `thinking=enabled on toString` as the treatment.
    for (const inherited of ['toString', 'constructor', '__proto__']) {
      expect(() => readThinkingReach(inherited), inherited).toThrow(
        /must be "disabled", "enabled", or a "\+"-separated list of routes/,
      );
    }
  });

  it('rejects "all", which names a reach without naming a mode', () => {
    // `all` means "every route" for `cortex_memory_max_turn_chars_routes`. Here the same word would
    // have to mean "thinking on every route" or "thinking off on every route", and a grammar that
    // accepted it would have to pick one silently.
    expect(() => readThinkingReach('all')).toThrow(/"all"/);
    expect(() => readThinkingReach('all')).toThrow(/every route is spelled "enabled"/);
  });

  it('rejects an empty segment rather than dropping it', () => {
    // Dropping it would turn `multi-session+` into a one-route run that reports as the value typed.
    expect(() => readThinkingReach('multi-session+')).toThrow(/empty route/i);
    expect(() => readThinkingReach('+multi-session')).toThrow(/empty route/i);
    expect(() => readThinkingReach('multi-session++temporal')).toThrow(/empty route/i);
  });

  it('rejects a route named twice, because the artifact would then claim it twice', () => {
    expect(() => readThinkingReach('temporal+temporal')).toThrow(/names "temporal" twice/);
  });

  it('rejects a mode word used as a route', () => {
    // `enabled+temporal` is a plausible slip: it reads as "enabled, plus temporal". The grammar has
    // no such form, and accepting it would leave the value's meaning dependent on token order.
    expect(() => readThinkingReach('enabled+temporal')).toThrow(/must be "disabled", "enabled"/);
  });
});

describe('the reach reaches the identity', () => {
  it('states the routes beside the mode, and only when there are any', () => {
    expect(resolveReaderIdentity({}).thinkingRoutes).toBeUndefined();
    expect(resolveReaderIdentity({ DEEPSEEK_THINKING: 'enabled' }).thinkingRoutes).toBeUndefined();
    // The mode stays `enabled` because that is what the named routes run under. A record that said
    // `disabled` here would describe the base client rather than the treatment.
    expect(resolveReaderIdentity({ DEEPSEEK_THINKING: 'multi-session+temporal' })).toMatchObject({
      thinking: 'enabled',
      thinkingRoutes: ['multi-session', 'temporal'],
    });
  });

  it('refuses a route list where only one reader can be built', () => {
    // The primary benchmark has one reader and no routes, so a route list is not expressible
    // there. Refusing is the honest answer: building the base client and letting the artifact name
    // `enabled on multi-session+temporal` is precisely the `40698883428` failure -- an artifact
    // describing a configuration the run did not administer -- on a new axis.
    const env = (thinking: string): Record<string, string> => ({
      DEEPSEEK_API_KEY: 'k',
      DEEPSEEK_THINKING: thinking,
    });
    expect(() => createLlmFromEnv(env('multi-session+temporal'))).toThrow(
      /cannot be administered by a single reader/,
    );
    expect(() => createLlmFromEnv(env('enabled'))).not.toThrow();
    expect(() => createLlmFromEnv(env('disabled'))).not.toThrow();
  });
});

describe('createReadersFromEnv', () => {
  it('builds one reader when the value names no routes', () => {
    // Every archived artifact was produced this way, so this is the branch that must stay a single
    // object: a map with a default entry would be a second reader built for a run that has one.
    for (const thinking of ['', 'disabled', 'enabled']) {
      const readers = createReadersFromEnv({ DEEPSEEK_API_KEY: 'k', DEEPSEEK_THINKING: thinking });
      expect(readers.readerByRoute, thinking).toBeUndefined();
    }
  });

  it('maps exactly the routes the value names, and one client serves them all', () => {
    const readers = createReadersFromEnv({
      DEEPSEEK_API_KEY: 'k',
      DEEPSEEK_THINKING: 'multi-session+temporal',
    });
    const byRoute = readers.readerByRoute;
    expect(byRoute).toBeDefined();
    expect(Object.keys(byRoute ?? {}).sort()).toEqual(['multi-session', 'temporal']);
    // One client, not one per route: two clients would be two connection pools and two token
    // counters for one treatment, and the artifact's usage block would then be a sum of parts.
    expect(byRoute?.['multi-session']).toBe(byRoute?.['temporal']);
    // The base reader is a different object, which is the whole point: the four routes the value
    // does not name keep the reader that produced every archived number.
    expect(readers.llm).not.toBe(byRoute?.['temporal']);
  });

  it('sends thinking only on the mapped client, proved at the wire', async () => {
    // The structural assertions above say the map has two entries and the base is another object.
    // They do not say the base is the DISABLED client, and that is the property the treatment
    // depends on: a pair that swapped them would pass every assertion above and buy `IE`'s sixteen
    // questions back for nothing. So the bodies are read off a real socket.
    const bodies: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    try {
      const readers = createReadersFromEnv({
        DEEPSEEK_API_KEY: 'k',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${addr.port}/v1`,
        DEEPSEEK_THINKING: 'multi-session+temporal',
      });
      await readers.llm.complete('flat route');
      await readers.readerByRoute?.['temporal']?.complete('temporal route');
      expect(bodies.map((body) => body['thinking'])).toEqual([
        { type: 'disabled' },
        { type: 'enabled' },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it('keeps the temperature wrapper on both clients', async () => {
    // §13.119 pinned the temperature, and a second client is the obvious way to lose it: the pair
    // is built from the identity, so a caller that pinned `0` must see `0` on both bodies. Half a
    // pair sending it would make the two sides' requests differ by two fields instead of one.
    const bodies: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    try {
      const readers = createReadersFromEnv({
        DEEPSEEK_API_KEY: 'k',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${addr.port}/v1`,
        DEEPSEEK_THINKING: 'multi-session+temporal',
        TEMPERATURE: '0',
      });
      await readers.llm.complete('flat route');
      await readers.readerByRoute?.['multi-session']?.complete('multi-session route');
      expect(bodies.map((body) => body['temperature'])).toEqual([0, 0]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
