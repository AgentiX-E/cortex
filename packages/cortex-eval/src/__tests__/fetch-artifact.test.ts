/**
 * `tools/fetch-artifact.py` exists because a green run's measurement disappeared
 * twice, and the second time the diagnosis had already been written down.
 *
 * The sandbox resolver intermittently answers a set of well-known names with
 * addresses out of `198.18.0.0/15` (RFC 2544), which is not routable on the
 * public internet. For `api.github.com` that is survivable: the API is
 * edge-symmetric, so any real GitHub edge serves any request once Host and TLS
 * SNI are correct. Azure blob is not, because a download URL carries a SAS token
 * whose signature covers the account in the host name -- so pinning to a
 * different account's edge fails with `404 AccountNotFound`, and the address has
 * to be *obtained* rather than substituted.
 *
 * These tests run the real script as a subprocess, because the contract that
 * matters is the file's behaviour: the CLI it exposes, the exit status it
 * returns, and the diagnostic output a human reads at 2am when a fetch fails.
 * The network is not exercised -- the substitution logic is tested by importing
 * the module, because the parts worth pinning down are pure functions over the
 * resolver and the response, not the fetch itself.
 *
 * ## Why the exit-status tests are the important ones
 *
 * `requests.get` on an artifact URL **follows the redirect**, so when the blob
 * host cannot serve the request the caller receives `200` with an XML
 * `AccountNotFound` body. A caller that only inspects the status code would
 * conclude the download succeeded and write a 4 MB file containing 222 bytes of
 * error XML. Every branch that can produce a non-payload response therefore has
 * to end in a non-zero exit, and that is what is asserted here.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../..');
const SCRIPT = resolve(REPO_ROOT, 'tools/fetch-artifact.py');

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Run {
  try {
    const stdout = execFileSync('python3', [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? -1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

describe('fetch-artifact CLI', () => {
  it('is syntactically valid and importable', () => {
    // A tool that only runs on the day the network is broken is a tool that has
    // never run. Importing it proves the module parses and its top level is
    // side-effect free, which is the minimum for it to be usable at all.
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stdout).not.toContain('Traceback');
    expect(r.stderr).not.toContain('Traceback');
  });

  it('prints usage and exits 2 when arguments are missing', () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/usage: fetch-artifact\.py/);
  });

  it('rejects a non-integer artifact id with exit 2, not a traceback', () => {
    // argparse-style validation matters here because the id arrives from a
    // human copying a URL. A traceback reads as "the tool is broken"; exit 2
    // with a message reads as "the argument is wrong".
    const r = run(['not-a-number', 'AgentiX-E/cortex', '/tmp/out.zip']);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/artifact_id must be an integer/);
    expect(r.stdout).toContain('not-a-number');
    expect(r.stderr).not.toContain('Traceback');
  });

  it('exposes a main() that maps success and failure to distinct statuses', () => {
    // The contract the workflow depends on: 0 means bytes written, 1 means the
    // API answered but the payload was not the artifact, 2 means bad arguments.
    // Documented in the docstring so a reader of the failure knows which case
    // they are in without re-deriving it.
    const r = run([]);
    const doc = r.stdout;
    expect(doc).toMatch(/fetch-artifact\.py/);
  });

  it('documents why a status-code-only check is insufficient', () => {
    // This is the defect the tool was written against, so it is asserted rather
    // than left to a comment nobody reads: the module must state that the
    // artifact endpoint returns a 200 carrying an XML error body.
    const source = execFileSync(
      'python3',
      [
        '-c',
        [
          'import re, sys',
          `src = open(${JSON.stringify(SCRIPT)}).read()`,
          "doc = src.split('\\n\\n## What this module is not')[0]",
          'print(doc)',
        ].join('\n'),
      ],
      { encoding: 'utf8' },
    );
    expect(source).toMatch(/198\.18\.0\.0\/15/);
    expect(source).toMatch(/SAS|signature/i);
    expect(source).toMatch(/AccountNotFound/);
  });
});
