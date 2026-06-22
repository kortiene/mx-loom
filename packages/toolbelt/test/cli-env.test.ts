import { describe, expect, it } from 'vitest';

import { BASE_ENV_ALLOW, ENV_DENY_PREFIXES, safeSubprocessEnv } from '../src/cli/env.js';

describe('safeSubprocessEnv', () => {
  describe('deny-by-default', () => {
    it('forwards only allowlisted keys present in source', () => {
      const env = safeSubprocessEnv({
        source: { HOME: '/home/test', PATH: '/usr/bin', UNLISTED_KEY: 'should-be-dropped' },
      });
      expect(env).toEqual({ HOME: '/home/test', PATH: '/usr/bin' });
      expect(env).not.toHaveProperty('UNLISTED_KEY');
    });

    it('returns an empty object when no allowlisted keys are present in source', () => {
      expect(safeSubprocessEnv({ source: { CUSTOM: 'x', OTHER: 'y' } })).toEqual({});
    });

    it('omits allowlisted keys absent from source', () => {
      const env = safeSubprocessEnv({ source: { HOME: '/home/test' } });
      expect(env).toHaveProperty('HOME');
      expect(env).not.toHaveProperty('PATH');
      expect(env).not.toHaveProperty('XDG_RUNTIME_DIR');
    });

    it('returns an empty object for an empty source', () => {
      expect(safeSubprocessEnv({ source: {} })).toEqual({});
    });
  });

  describe('deny prefixes — MATRIX_* and MX_AGENT_*', () => {
    it('never forwards MATRIX_* keys from source', () => {
      const env = safeSubprocessEnv({
        source: {
          HOME: '/home/test',
          MATRIX_ACCESS_TOKEN: 'syt_fake_shouldnotleak',
          MATRIX_HOMESERVER: 'https://matrix.example.test',
          MATRIX_DEVICE_ID: 'DEVICE_TEST_ABC',
        },
      });
      expect(env).not.toHaveProperty('MATRIX_ACCESS_TOKEN');
      expect(env).not.toHaveProperty('MATRIX_HOMESERVER');
      expect(env).not.toHaveProperty('MATRIX_DEVICE_ID');
    });

    it('never forwards MX_AGENT_* keys from source', () => {
      const env = safeSubprocessEnv({
        source: {
          HOME: '/home/test',
          MX_AGENT_SECRET: 'fake-secret-key',
          MX_AGENT_SIGNING_KEY: 'fake-ed25519-material',
          MX_AGENT_TOKEN: 'fake-token-value',
        },
      });
      expect(env).not.toHaveProperty('MX_AGENT_SECRET');
      expect(env).not.toHaveProperty('MX_AGENT_SIGNING_KEY');
      expect(env).not.toHaveProperty('MX_AGENT_TOKEN');
    });

    it('drops MATRIX_* from extraAllow (deny prefix wins)', () => {
      const env = safeSubprocessEnv({
        source: { HOME: '/home/test', MATRIX_TOKEN: 'syt_shouldnotpass_fake' },
        extraAllow: ['MATRIX_TOKEN'],
      });
      expect(env).not.toHaveProperty('MATRIX_TOKEN');
    });

    it('drops MX_AGENT_* from extraAllow (deny prefix wins)', () => {
      const env = safeSubprocessEnv({
        source: { HOME: '/home/test', MX_AGENT_KEY: 'fake-key-material' },
        extraAllow: ['MX_AGENT_KEY'],
      });
      expect(env).not.toHaveProperty('MX_AGENT_KEY');
    });
  });

  describe('extraAllow', () => {
    it('forwards extra non-denied keys when listed in extraAllow', () => {
      const env = safeSubprocessEnv({
        source: { HOME: '/home/test', TOOL_FLAG: 'enabled', UNLISTED: 'no' },
        extraAllow: ['TOOL_FLAG'],
      });
      expect(env['TOOL_FLAG']).toBe('enabled');
      expect(env).not.toHaveProperty('UNLISTED');
    });

    it('silently skips extra keys absent from source', () => {
      const env = safeSubprocessEnv({
        source: { HOME: '/home/test' },
        extraAllow: ['NON_EXISTENT_KEY'],
      });
      expect(env).not.toHaveProperty('NON_EXISTENT_KEY');
    });

    it('allows multiple extra keys at once', () => {
      const env = safeSubprocessEnv({
        source: { HOME: '/home/test', FLAGX: 'x', FLAGY: 'y' },
        extraAllow: ['FLAGX', 'FLAGY'],
      });
      expect(env['FLAGX']).toBe('x');
      expect(env['FLAGY']).toBe('y');
    });
  });

  describe('source default', () => {
    it('does not throw when called without options', () => {
      expect(() => safeSubprocessEnv()).not.toThrow();
    });
  });

  describe('BASE_ENV_ALLOW coverage', () => {
    it('forwards every key in BASE_ENV_ALLOW that is present in source', () => {
      const source: Record<string, string> = {};
      for (const key of BASE_ENV_ALLOW) {
        source[key] = `synthetic-${key}`;
      }
      const env = safeSubprocessEnv({ source });
      for (const key of BASE_ENV_ALLOW) {
        expect(env[key]).toBe(`synthetic-${key}`);
      }
    });
  });
});

describe('ENV_DENY_PREFIXES', () => {
  it('contains MATRIX_ (blocks Matrix session tokens and homeserver URLs)', () => {
    expect(ENV_DENY_PREFIXES).toContain('MATRIX_');
  });

  it('contains MX_AGENT_ (blocks daemon signing keys and secrets)', () => {
    expect(ENV_DENY_PREFIXES).toContain('MX_AGENT_');
  });

  it('does not match any key in BASE_ENV_ALLOW (no accidental allowlist poisoning)', () => {
    for (const prefix of ENV_DENY_PREFIXES) {
      for (const allowKey of BASE_ENV_ALLOW) {
        expect(allowKey.startsWith(prefix), `${allowKey} starts with deny prefix ${prefix}`).toBe(false);
      }
    }
  });
});

describe('BASE_ENV_ALLOW', () => {
  const REQUIRED_KEYS = [
    'HOME',
    'PATH',
    'XDG_RUNTIME_DIR',
    'XDG_DATA_HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'TERM',
  ] as const;

  it('contains all minimal keys the mx-agent CLI needs', () => {
    for (const key of REQUIRED_KEYS) {
      expect(BASE_ENV_ALLOW).toContain(key);
    }
  });

  it('does not include credential-shaped keys', () => {
    const credRe = /token|secret|password|key|matrix|mx_agent/i;
    for (const key of BASE_ENV_ALLOW) {
      expect(key, `${key} looks credential-shaped`).not.toMatch(credRe);
    }
  });

  it('does not include USER (username reveals identity — excluded by design)', () => {
    expect(BASE_ENV_ALLOW).not.toContain('USER');
  });

  it('does not include SHELL (child resolves its own shell if needed)', () => {
    expect(BASE_ENV_ALLOW).not.toContain('SHELL');
  });
});

describe('deny-by-default for common credential env vars (not deny-prefix, just not allowlisted)', () => {
  it('does not forward GH_TOKEN (not in allowlist)', () => {
    const env = safeSubprocessEnv({
      source: { HOME: '/home/test', GH_TOKEN: 'ghp_fakeghtoken123456789' },
    });
    expect(env).not.toHaveProperty('GH_TOKEN');
  });

  it('does not forward ANTHROPIC_API_KEY (not in allowlist)', () => {
    const env = safeSubprocessEnv({
      source: { HOME: '/home/test', ANTHROPIC_API_KEY: 'sk-ant-fake-key-material' },
    });
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('does not forward OPENAI_API_KEY (not in allowlist)', () => {
    const env = safeSubprocessEnv({
      source: { HOME: '/home/test', OPENAI_API_KEY: 'sk-fakeopenaikey12345' },
    });
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
  });

  it('does not forward GITHUB_TOKEN (not in allowlist)', () => {
    const env = safeSubprocessEnv({
      source: { HOME: '/home/test', GITHUB_TOKEN: 'ghp_fakegithubtoken123' },
    });
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
  });
});
