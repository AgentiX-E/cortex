import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LOCAL_MODEL,
  DEFAULT_WEIGHT_HOST,
  PROFILE_ENV,
  ProfileError,
  describeProfile,
  readApiKey,
  resolveLlmProfile,
  type LlmProfile,
} from '../profile.js';

/**
 * The configuration is a measurement input, so it is tested like one.
 *
 * The cases below are not "does the flag work". Each one is a way a run can be attributed to the
 * wrong configuration after the fact: a key that leaked into a printed record, a base URL that
 * produced `//chat/completions`, an empty variable that a shell exported but never set, an unknown
 * backend that quietly became local. The last one is the whole reason this module exists.
 */

const REMOTE_ENV = {
  [PROFILE_ENV.model]: 'deepseek-chat',
  [PROFILE_ENV.baseUrl]: 'https://api.deepseek.com',
  [PROFILE_ENV.apiKey]: 'sk-test-not-a-real-key',
};

function remote(overrides: Record<string, string | undefined> = {}): LlmProfile {
  return resolveLlmProfile({ backend: 'remote' }, { ...REMOTE_ENV, ...overrides });
}

describe('the local backend', () => {
  it('needs no key, and says its inference makes no network request', () => {
    const profile = resolveLlmProfile({ backend: 'local' }, {});
    expect(profile).toEqual({
      backend: 'local',
      model: DEFAULT_LOCAL_MODEL,
      dtype: 'fp32',
      weightHost: DEFAULT_WEIGHT_HOST,
      inferenceNetwork: 'none',
    });
  });

  it('pins the dtype rather than inheriting a default', () => {
    // 4.x changed the default from quantised weights to fp32. For generation that changes which
    // weights answer, and nothing downstream compares the prose to a stored value -- so a profile
    // that leaves `dtype` to the library produces readings nobody can re-derive.
    expect(resolveLlmProfile({ backend: 'local' }, {}).backend).toBe('local');
    expect(resolveLlmProfile({ backend: 'local', dtype: 'q4' }, {})).toMatchObject({ dtype: 'q4' });
  });

  it('takes the quantisation from the argument, then the environment, then the pin', () => {
    // Three sources in a stated order, because a quantisation that changes silently changes which
    // weights answer and nothing downstream compares the prose to a stored value.
    expect(resolveLlmProfile({ backend: 'local', dtype: 'q4' }, {})).toMatchObject({ dtype: 'q4' });
    expect(resolveLlmProfile({ backend: 'local' }, { [PROFILE_ENV.dtype]: 'q8' })).toMatchObject({
      dtype: 'q8',
    });
    expect(
      resolveLlmProfile({ backend: 'local', dtype: 'q4' }, { [PROFILE_ENV.dtype]: 'q8' }),
    ).toMatchObject({ dtype: 'q4' });
    // Exported but empty is the shell's way of saying unset, and fp32 is what it must fall back to.
    expect(resolveLlmProfile({ backend: 'local' }, { [PROFILE_ENV.dtype]: '  ' })).toMatchObject({
      dtype: 'fp32',
    });
  });

  it('takes the checkpoint from the argument before the environment', () => {
    const env = { [PROFILE_ENV.localModel]: 'from-env/model' };
    expect(resolveLlmProfile({ backend: 'local' }, env)).toMatchObject({ model: 'from-env/model' });
    expect(resolveLlmProfile({ backend: 'local', model: 'from-arg/model' }, env)).toMatchObject({
      model: 'from-arg/model',
    });
  });

  it('reads the weight host, and normalises a trailing slash', () => {
    expect(
      resolveLlmProfile(
        { backend: 'local' },
        { [PROFILE_ENV.weightHost]: 'https://hf-mirror.com/' },
      ),
    ).toMatchObject({ weightHost: 'https://hf-mirror.com' });
  });

  it('refuses an exported-but-empty checkpoint instead of falling back to the default', () => {
    // `CORTEX_LOCAL_MODEL=` in a shell exports an empty string, and `??` would accept it: the run
    // would then ask the library for a model named "". Naming the variable is the whole fix.
    expect(() =>
      resolveLlmProfile({ backend: 'local' }, { [PROFILE_ENV.localModel]: '   ' }),
    ).toThrow(ProfileError);
  });
});

describe('the remote backend', () => {
  it('resolves when all three variables are set', () => {
    expect(remote()).toEqual({
      backend: 'remote',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      inferenceNetwork: 'required',
    });
  });

  it('names every missing variable at once', () => {
    // One at a time turns setup into a guessing game: fix, rerun, discover the next. The demo did
    // that in three separate `if` statements before this module existed.
    let error: ProfileError | undefined;
    try {
      resolveLlmProfile({ backend: 'remote' }, {});
    } catch (caught) {
      error = caught as ProfileError;
    }
    expect(error).toBeInstanceOf(ProfileError);
    expect(error?.missing).toEqual([PROFILE_ENV.model, PROFILE_ENV.baseUrl, PROFILE_ENV.apiKey]);
    for (const name of error?.missing ?? []) expect(error?.message).toContain(name);
  });

  it('names only the variable that is actually missing', () => {
    let error: ProfileError | undefined;
    try {
      remote({ [PROFILE_ENV.apiKey]: undefined });
    } catch (caught) {
      error = caught as ProfileError;
    }
    expect(error?.missing).toEqual([PROFILE_ENV.apiKey]);
  });

  it('treats an empty key as missing, because a shell exports one on `VAR=`', () => {
    expect(() => remote({ [PROFILE_ENV.apiKey]: '' })).toThrow(/CORTEX_LLM_API_KEY/);
  });

  it('does not fall back to local when the remote backend cannot be configured', () => {
    // The failure mode this module exists to prevent. A downgrade here would let a reading claim
    // `deepseek-chat` while a 0.5B checkpoint produced the data, and nothing in the artefact would
    // show the substitution.
    let resolved: LlmProfile | undefined;
    try {
      resolved = resolveLlmProfile({ backend: 'remote' }, {});
    } catch {
      // The only acceptable outcome: no profile at all.
    }
    expect(resolved).toBeUndefined();
  });

  it('tells the caller that the local backend exists, without choosing it', () => {
    let message = '';
    try {
      resolveLlmProfile({ backend: 'remote' }, {});
    } catch (caught) {
      message = (caught as Error).message;
    }
    expect(message).toContain('backend "local"');
  });

  it('normalises a trailing slash so a caller can append a path', () => {
    expect(remote({ [PROFILE_ENV.baseUrl]: 'https://api.deepseek.com/' })).toMatchObject({
      baseUrl: 'https://api.deepseek.com',
    });
  });

  it('rejects a plaintext base URL that is not loopback', () => {
    // A plausible typo whose failure is silent, remote and permanent: the bearer token goes out in
    // the clear. Loopback is exempt because a local sidecar keeps the traffic on the machine.
    expect(() => remote({ [PROFILE_ENV.baseUrl]: 'http://api.deepseek.com' })).toThrow(/https/);
    expect(remote({ [PROFILE_ENV.baseUrl]: 'http://localhost:8080' })).toMatchObject({
      baseUrl: 'http://localhost:8080',
    });
    expect(remote({ [PROFILE_ENV.baseUrl]: 'http://127.0.0.1:11434' })).toMatchObject({
      baseUrl: 'http://127.0.0.1:11434',
    });
  });

  it('rejects a base URL that is not a URL', () => {
    expect(() => remote({ [PROFILE_ENV.baseUrl]: 'api.deepseek.com' })).toThrow(/not a URL/);
  });
});

describe('the record itself', () => {
  it('cannot carry the key, in any backend', () => {
    // Not redaction: the field does not exist. A record that is safe only because a printer
    // remembered to strip it is one `console.log(profile)` away from a leaked credential.
    const secret = 'sk-must-never-appear-1234';
    const profile = remote({ [PROFILE_ENV.apiKey]: secret });
    expect(JSON.stringify(profile)).not.toContain(secret);
    expect(JSON.stringify(resolveLlmProfile({ backend: 'local' }, REMOTE_ENV))).not.toContain(
      secret,
    );
  });

  it('hands the key to exactly one caller, on request', () => {
    expect(readApiKey(REMOTE_ENV)).toBe('sk-test-not-a-real-key');
    expect(() => readApiKey({})).toThrow(/CORTEX_LLM_API_KEY/);
  });

  it('is a pure function of its arguments', () => {
    // `process.env` is not consulted: a test that had to set variables on the process would be
    // order-dependent, and a resolver that reads globals cannot be printed with confidence.
    const before = process.env[PROFILE_ENV.apiKey];
    process.env[PROFILE_ENV.apiKey] = 'sk-leaked-through-a-global';
    try {
      expect(() => resolveLlmProfile({ backend: 'remote' }, {})).toThrow(ProfileError);
    } finally {
      if (before === undefined) delete process.env[PROFILE_ENV.apiKey];
      else process.env[PROFILE_ENV.apiKey] = before;
    }
  });

  it('rejects an unknown backend instead of treating it as local', () => {
    expect(() => resolveLlmProfile({ backend: 'auto' }, REMOTE_ENV)).toThrow(/"auto"/);
    expect(() => resolveLlmProfile({ backend: 'auto' }, REMOTE_ENV)).toThrow(/local.*remote/);
  });
});

describe('describeProfile', () => {
  it('prints one greppable line per backend, with no secret', () => {
    expect(describeProfile(resolveLlmProfile({ backend: 'local' }, {}))).toBe(
      `local ${DEFAULT_LOCAL_MODEL} dtype=fp32 weights=${DEFAULT_WEIGHT_HOST} inference-network=none`,
    );
    const line = describeProfile(remote());
    expect(line).toBe(
      'remote deepseek-chat base=https://api.deepseek.com inference-network=required',
    );
    expect(line).not.toContain('sk-test');
  });

  it('is stable for equal profiles, so a reading list can be assembled by reading it', () => {
    expect(describeProfile(remote())).toBe(describeProfile(remote()));
  });
});
