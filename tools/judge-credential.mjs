#!/usr/bin/env node
/**
 * Refuse to start work that would spend credits on a credential the job does not have.
 *
 *     node tools/judge-credential.mjs --artifact <report.json>
 *
 * ## Why this is a tool and not four lines of shell
 *
 * `judge-audit.yml` used to carry:
 *
 *     if [ -z "${DEEPSEEK_API_KEY}" ]; then echo "... is empty" >&2; exit 1; fi
 *
 * That line was correct for as long as the judge could only be a DeepSeek model, and it became wrong
 * the moment a dispatch could pin `zhipu:glm-4.6` -- because it would then pass while the judge it
 * passed *for* had no key at all. The obvious repair is a `case` over provider names in the same
 * step, and the reason that repair is not here is that it would be a third copy of a table with two
 * homes already: `reader-provider.ts` declares the variables, and `createJudgeFromEnv` reads one of
 * them. A shell copy cannot be compared to either, so the day the table changes, this step keeps
 * passing for a provider that has moved.
 *
 * So the question goes to the module that answers it. `credentialForJudge` resolves the judge the
 * same way the factory will -- through `judgeEnvFor`, so an artifact that records its judge decides
 * the vendor even when the dispatch says nothing -- and reports the variable name, not the value.
 *
 * ## What it prints, and why the value never appears
 *
 * A length. "A 35-character key arrived" answers the two questions an operator has (did the secret
 * reach the job, and did the *right* one reach it) without putting a credential in a transcript that
 * outlives the job. The only place the value is used is the request.
 *
 * ## Exit codes
 *
 * `0` -- the credential the judge will use is present. `1` -- it is not, and the message names the
 * variable. `2` -- the invocation itself is wrong, which is a different failure from a missing
 * secret and must not be read as one.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

import { credentialForJudge } from './judge-identity.mjs';

function flag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : (process.argv[index + 1] ?? '');
}

function main() {
  const artifactPath = flag('--artifact');
  if (!artifactPath) {
    console.error('usage: judge-credential.mjs --artifact <report.json>');
    return 2;
  }
  const report = JSON.parse(readFileSync(artifactPath, 'utf8'));
  if (!Array.isArray(report.questions)) {
    // Not a politeness check: a file that is not a report has no `memoryArmConfig` either, so the
    // judge would be resolved from the environment alone -- which is the answer this tool exists to
    // stop trusting.
    console.error(`${artifactPath} has no questions array: not a benchmark report`);
    return 2;
  }

  const credential = credentialForJudge(report, process.env);
  console.log(`judge selection  ${credential.selection ?? '(the reader default)'}`);
  console.log(`judge from       ${credential.origin}`);
  console.log(`judge provider   ${credential.providerId}`);
  if (credential.present) {
    console.log(
      `credential       ${credential.variable} present (length ${credential.length}); ` +
        'value never printed',
    );
    return 0;
  }
  console.error(
    `credential       ${credential.variable} MISSING (judge provider ${JSON.stringify(credential.providerId)})`,
  );
  console.error(
    '::error::the judge this job would build needs a credential the job does not have: ' +
      `${credential.variable} is empty. ` +
      (credential.origin === 'the dispatch'
        ? 'The dispatch pinned this judge, so this is the variable to export.'
        : `The judge was taken from ${credential.origin}, so this is the variable to export -- ` +
          'or pin the judge with the `model` input and check that provider instead.'),
  );
  return 1;
}

process.exitCode = main();
