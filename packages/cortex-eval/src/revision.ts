/**
 * The code revision an artifact was produced by, taken from the job's own environment.
 *
 * ## Why an artifact needs it, and what it cost not to have it
 *
 * Every paired criterion in this campaign is a statement about **one** difference: two arms of a
 * configuration, everything else held equal. Nothing wrote down "everything else" until now. The
 * pair `S17` set against `S16` was read as a measurement of `queryExpansion`, and its control had
 * been produced 2026-11-17 while its treatment was 2026-11-20, four merged features apart --
 * `lexicalWeighting`, `sessionClock`, `factTimeline`, `resolution` -- which nobody could see from
 * the artifacts because an artifact had never carried the revision that made it.
 *
 * The symptom that found it was `E3`: fifty of 379 non-target prompts moved while their delivered
 * evidence bytes stayed identical. That is a renderer change, and a renderer change is a code
 * change. `§13.377.7` is the reading; `§13.377.8` is the clause the registration was missing -- a
 * paired criterion needs a tree, not only a flag table.
 *
 * ## Absent, never invented
 *
 * A local run has no `GITHUB_SHA`, and the field is absent rather than `0000...` or a build
 * timestamp: every other optional field in `AblationReport` follows the same rule, because a
 * default makes "predates the field" and "had no revision" two different bytes for one fact. A
 * malformed value is treated as absent for the same reason -- stamping a revision the run cannot
 * be resolved to would be worse than stamping none, since a reader would then trust it.
 */
export interface RunRevision {
  /** The commit the job checked out, `GITHUB_SHA`. Forty lowercase hex characters or absent. */
  readonly sha: string;
  /** The dispatch that produced this artifact, `GITHUB_RUN_ID`. */
  readonly runId?: string;
  /** A re-run of one dispatch is a different job, `GITHUB_RUN_ATTEMPT`. */
  readonly runAttempt?: string;
  /** The workflow that ran it, `GITHUB_WORKFLOW`, so two artifacts from two workflows can be told apart. */
  readonly workflow?: string;
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * The revision this process is running at, or `undefined` when it is not running in a CI job.
 *
 * Takes the environment rather than reading `process.env` so that the two cases a dispatch cannot
 * produce -- absent, and malformed -- are testable without a runner.
 */
export function readRevision(env: Record<string, string | undefined>): RunRevision | undefined {
  const sha = (env['GITHUB_SHA'] ?? '').trim();
  if (!SHA.test(sha)) {
    return undefined;
  }
  const runId = (env['GITHUB_RUN_ID'] ?? '').trim();
  const runAttempt = (env['GITHUB_RUN_ATTEMPT'] ?? '').trim();
  const workflow = (env['GITHUB_WORKFLOW'] ?? '').trim();
  return {
    sha,
    ...(runId === '' ? {} : { runId }),
    ...(runAttempt === '' ? {} : { runAttempt }),
    ...(workflow === '' ? {} : { workflow }),
  };
}

/*
 * The comparison itself is not here, and that is deliberate.
 *
 * `E0` is a criterion, and every criterion in this campaign is read by the Python gate that owns the
 * registration -- `expansion-reading.py` compares the two artifacts' `revision.sha` and reports
 * `same` / `different` / `unread`. A second implementation in this package would be a second place
 * for the three states to drift apart, and it would have no caller that the first one does not
 * already have: the TypeScript side's job is to **record** the revision on the artifact, which is the
 * half that cannot be done anywhere else.
 */
