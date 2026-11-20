/**
 * The revision record, and the pair that made it necessary.
 *
 * `S17` was read as a measurement of one flag against `S16`. The control artifact was produced
 * 2026-11-17 and the treatment 2026-11-20, four merged features apart, and neither artifact could
 * say so: a report carried the dataset's fingerprint and the arm's configuration and nothing about
 * the code. `E3` found it sideways -- fifty of 379 non-target prompts moved while their delivered
 * evidence bytes stayed identical, which is a renderer change and therefore a code change.
 *
 * These cases are the three states the field can be in, and the third is the one that decides
 * whether archived artifacts get rewritten: absent is **unread**, not "different".
 */
import { describe, expect, it } from 'vitest';

import { readRevision } from '../revision.js';

const SHA = 'a'.repeat(40);

describe('readRevision', () => {
  it('reads the sha and the dispatch that produced it', () => {
    expect(
      readRevision({
        GITHUB_SHA: SHA,
        GITHUB_RUN_ID: '44711009470',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_WORKFLOW: 'Benchmark (cortex-memory A/B)',
      }),
    ).toEqual({
      sha: SHA,
      runId: '44711009470',
      runAttempt: '1',
      workflow: 'Benchmark (cortex-memory A/B)',
    });
  });

  it('is absent outside a job rather than inventing a revision', () => {
    // A local run has no sha, and a placeholder would make "predates the field" and "had no
    // revision" two different bytes for one fact -- the rule every optional field in the report
    // follows. The absence is also what keeps `compareRevisions` from calling the archived
    // artifacts "different" when what they are is unreadable.
    expect(readRevision({})).toBeUndefined();
    expect(readRevision({ GITHUB_SHA: '' })).toBeUndefined();
  });

  it('refuses a value that is not a commit id', () => {
    // `GITHUB_SHA` is a commit on a push and can be a branch-ish value in other event shapes. A
    // revision nobody can resolve is worse than none: a reader would trust it.
    expect(readRevision({ GITHUB_SHA: 'main' })).toBeUndefined();
    expect(readRevision({ GITHUB_SHA: 'A'.repeat(40) })).toBeUndefined();
  });

  it('keeps the sha when the run identifiers are missing', () => {
    // The sha is the field `E0` compares; the run ids are for a human. A stripped environment
    // must not lose the one that decides the criterion.
    expect(readRevision({ GITHUB_SHA: SHA })).toEqual({ sha: SHA });
  });
});
