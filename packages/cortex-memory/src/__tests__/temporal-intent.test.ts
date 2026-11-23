/**
 * Which end of a supersession the question is asking for.
 *
 * ## What this test is written against
 *
 * `MEASURE-FAILURE-STABILITY.md` §3 names six `KU` questions that are wrong in all four repetitions, and
 * the mechanism built for them (`supersede.ts`) refuses in seven named ways -- none of which reads the
 * question. That is a gap with a measurement behind it: on the `semantic-carry` artifact, `50635ada`
 * ("**previous** frequent flyer status ... **before** I got the current status") was answered correctly
 * with the pass off and incorrectly with it on, because the pass found a later statement (`Premier Gold`)
 * and replaced the answer with it. Seven substitutions, one question, the wrong direction.
 *
 * The product's own `knowledge-update` instruction already states the rule the mechanism did not
 * implement:
 *
 * > Use the evidence with the latest date in the evidence that is consistent with the time qualifier in
 * > the question. If the question asks for a previous value, reply with the earlier one.
 *
 * This classifier is that sentence, as a function. The tests below are the population it has to get
 * right, taken from the 72 `KU` questions verbatim rather than invented, plus the boundary cases where a
 * direction word does **not** set the direction.
 *
 * ## Why the fallback is `latest` rather than `unknown`
 *
 * A third value would force every caller to decide what `unknown` means, and the two callers want
 * different things from it: the adjudicator would treat it as "do not refuse", the carry gate as "carry
 * anyway". Those are the same decision as `latest`, stated twice. The default is also the measured one:
 * 63 of the 72 `KU` questions ask for the value in force now, and a classifier that returned a third
 * state for the ordinary case would be reporting its own uncertainty as a property of the question.
 */

import { describe, expect, it } from 'vitest';

import { classifyTemporalIntent } from '../temporal-intent.js';

describe('the direction a question asks for', () => {
  it.each([
    [
      'What was my previous frequent flyer status on United Airlines before I got the current status?',
      'earlier',
    ],
    [
      'How many largemouth bass did I catch with Alex on the earlier fishing trip to Lake Michigan before the 7/22 trip?',
      'earlier',
    ],
    ['What was my previous goal for my Apex Legends level before I updated my goal?', 'earlier'],
    ['What new kitchen gadget did I invest in before getting the Air Fryer?', 'earlier'],
    [
      'Before I purchased the gravel bike, do I have other bikes in addition to my mountain bike and my commuter bike?',
      'earlier',
    ],
    ['What was my previous personal best time for the charity 5K run?', 'earlier'],
    [
      'How many autographed baseballs have I added to my collection in the first three months of collection?',
      'earlier',
    ],
    ['Where did I initially keep my old sneakers?', 'earlier'],
    ['What brand of coffee did I originally buy before the switch?', 'earlier'],
    ['What did I use to drink in the morning?', 'earlier'],
  ])('%s -> %s', (question, expected) => {
    expect(classifyTemporalIntent(question)).toBe(expected);
  });

  it.each([
    ['How many dozen eggs do we currently have stocked up in our refrigerator?', 'latest'],
    ['How many followers do I have on Instagram now?', 'latest'],
    ['What type of camera lens did I purchase most recently?', 'latest'],
    ['Where did I go on my most recent family trip?', 'latest'],
    ['How many tops have I bought from H&M so far?', 'latest'],
    ['How many pages of a book have I read to date?', 'latest'],
    ['Do I still have my old laptop?', 'latest'],
    ['How many pre-1920 American coins do I have in my collection?', 'latest'],
    ['What time do I usually go to the gym?', 'latest'],
  ])('%s -> %s', (question, expected) => {
    expect(classifyTemporalIntent(question)).toBe(expected);
  });

  it('reads two sub-questions as two directions', () => {
    // `f685340e` and `031748ae` are the population's own both-ends questions: each asks for the value
    // before a change and the value after it, in one string. The gold spans both answers, so no single
    // replacement can be right for the whole question -- which is what `both` is for.
    expect(
      classifyTemporalIntent(
        'How often do I play tennis with my friends at the local park previously? How often do I play now?',
      ),
    ).toBe('both');
    expect(
      classifyTemporalIntent(
        'How many engineers do I lead when I just started my new role as Senior Software Engineer? How many engineers do I lead now?',
      ),
    ).toBe('both');
  });

  it('does not read a qualifier inside an earlier clause as a second question', () => {
    // The boundary `50635ada` draws. Its `current` sits inside the subordinate clause that says which
    // status the *previous* one came before, so the question has one direction and it is `earlier`. A
    // rule that took any latest word anywhere in the string would call this `both` and lose the case the
    // classifier exists for.
    expect(
      classifyTemporalIntent(
        'What was my previous frequent flyer status on United Airlines before I got the current status?',
      ),
    ).toBe('earlier');
  });

  it('does not read a qualifier inside an aside as a direction', () => {
    // `5a4f22c0` asks where Rachel works **now**; its `previous` sits in the appositive that says who she
    // is. Reading the aside as a direction would refuse a legitimate substitution for a reason unrelated
    // to the question, so the aside is stripped before the clause is read.
    expect(
      classifyTemporalIntent(
        'What company is Rachel, an old colleague from my previous company, currently working at?',
      ),
    ).toBe('latest');
  });

  it('falls back to the value in force, which is what most questions ask for', () => {
    // No direction word at all. The measured population is `KU`'s 72 questions, 63 of which are ordinary
    // present-tense asks; a classifier that made the ordinary case a third state would be reporting its
    // own uncertainty rather than the question's direction.
    expect(classifyTemporalIntent('How many bikes do I own?')).toBe('latest');
    expect(classifyTemporalIntent('Where did I get my guitar serviced?')).toBe('latest');
    expect(classifyTemporalIntent('')).toBe('latest');
  });

  it('is not fooled by a direction word inside a longer word', () => {
    // A substring test over the raw string would read the `before` inside `Before20` as a qualifier. The
    // tokenizer keeps digits attached to their letters, so the token is `before20` and matches nothing.
    expect(classifyTemporalIntent('What is my score in the Before20 tournament?')).toBe('latest');
    expect(classifyTemporalIntent('What is my follower count on the PreviouslySeen app?')).toBe(
      'latest',
    );
  });

  it('separates the pair of questions that differ only in their direction word', () => {
    // `07741c44` and `07741c45` are one pair in the population -- same question, one word apart -- and the
    // pair is the cleanest statement of what this classifier is for: the evidence and the later statement
    // are identical, and the two golds are the two ends of it.
    expect(classifyTemporalIntent('Where do I initially keep my old sneakers?')).toBe('earlier');
    expect(classifyTemporalIntent('Where do I currently keep my old sneakers?')).toBe('latest');
  });

  it('reads `first` as a direction only when it bounds a span of time', () => {
    // `0ddfec37` is the case: "in the **first three months** of collection" asks for the count as it
    // stood at the end of that window, not the count now. "the first aid kit" is a name, and a rule that
    // treated every `first` as a direction would refuse legitimate substitutions on questions about one.
    expect(classifyTemporalIntent('How many have I added in the first three months?')).toBe(
      'earlier',
    );
    expect(classifyTemporalIntent('How many have I added in the first year?')).toBe('earlier');
    expect(classifyTemporalIntent('How many are in the first aid kit?')).toBe('latest');
  });

  it('does not read `first` as a direction when there is no unit for it to bound', () => {
    // The three ways the span test fails, each reached without a time unit after it: nothing at all, a
    // count word with nothing after it, and a count word followed by something that is not a unit. They
    // are separate branches rather than one because each is a different way for ordinary English to walk
    // into the rule.
    expect(classifyTemporalIntent('Which one did I buy first?')).toBe('latest');
    expect(classifyTemporalIntent('Who were the first three?')).toBe('latest');
    expect(classifyTemporalIntent('Who were the first three finalists?')).toBe('latest');
    // The digit form of the same span, which a corpus writes when it abbreviates: "the first 3 months".
    expect(classifyTemporalIntent('How much did I save in the first 3 months?')).toBe('earlier');
  });
});
