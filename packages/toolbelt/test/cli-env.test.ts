import { describe, expect, it } from 'vitest';

import {
  BASE_ENV_ALLOW,
  ENV_DENY_EXACT,
  ENV_DENY_PREFIXES,
  ENV_DENY_SUFFIXES,
  isDeniedEnvKey,
  safeSubprocessEnv,
} from '../src/cli/env.js';

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

describe('hardened known-secret deny (T008) — extraAllow cannot re-admit a known secret', () => {
  const reAdmitCases: Array<[string, string]> = [
    ['GH_TOKEN (exact + _TOKEN suffix)', 'GH_TOKEN'],
    ['GITHUB_TOKEN (_TOKEN suffix)', 'GITHUB_TOKEN'],
    ['ANTHROPIC_API_KEY (_API_KEY suffix)', 'ANTHROPIC_API_KEY'],
    ['OPENAI_API_KEY (_API_KEY suffix)', 'OPENAI_API_KEY'],
    ['AWS_SECRET_ACCESS_KEY (_ACCESS_KEY suffix)', 'AWS_SECRET_ACCESS_KEY'],
    ['CLIENT_SECRET (_SECRET suffix)', 'CLIENT_SECRET'],
    ['MATRIX_ACCESS_TOKEN (MATRIX_ prefix)', 'MATRIX_ACCESS_TOKEN'],
    ['MX_AGENT_SIGNING_KEY (MX_AGENT_ prefix)', 'MX_AGENT_SIGNING_KEY'],
  ];

  for (const [label, key] of reAdmitCases) {
    it(`drops ${label} even when listed in extraAllow`, () => {
      const env = safeSubprocessEnv({
        source: { HOME: '/home/test', [key]: 'fake-secret-value' },
        extraAllow: [key],
      });
      expect(env).not.toHaveProperty(key);
    });
  }

  it('still forwards the non-secret MXL_AGENT_BIN override via extraAllow', () => {
    const env = safeSubprocessEnv({
      source: { HOME: '/home/test', MXL_AGENT_BIN: '/opt/mx-agent' },
      extraAllow: ['MXL_AGENT_BIN'],
    });
    expect(env['MXL_AGENT_BIN']).toBe('/opt/mx-agent');
  });

  it('matches deny suffixes case-insensitively (lowercase env names)', () => {
    const env = safeSubprocessEnv({
      source: { HOME: '/home/test', custom_token: 'x', service_secret: 'y' },
      extraAllow: ['custom_token', 'service_secret'],
    });
    expect(env).not.toHaveProperty('custom_token');
    expect(env).not.toHaveProperty('service_secret');
  });
});

describe('isDeniedEnvKey', () => {
  it('denies deny-prefixed keys (MATRIX_*, MX_AGENT_*)', () => {
    expect(isDeniedEnvKey('MATRIX_ACCESS_TOKEN')).toBe(true);
    expect(isDeniedEnvKey('MX_AGENT_SIGNING_KEY')).toBe(true);
  });

  it('denies credential suffixes (_TOKEN, _API_KEY, _SECRET, _ACCESS_KEY)', () => {
    expect(isDeniedEnvKey('GH_TOKEN')).toBe(true);
    expect(isDeniedEnvKey('ANTHROPIC_API_KEY')).toBe(true);
    expect(isDeniedEnvKey('CLIENT_SECRET')).toBe(true);
    expect(isDeniedEnvKey('AWS_SECRET_ACCESS_KEY')).toBe(true);
  });

  it('allows non-secret keys, including the MXL_* namespace and base resolution vars', () => {
    expect(isDeniedEnvKey('MXL_AGENT_BIN')).toBe(false);
    expect(isDeniedEnvKey('HOME')).toBe(false);
    expect(isDeniedEnvKey('PATH')).toBe(false);
    expect(isDeniedEnvKey('XDG_RUNTIME_DIR')).toBe(false);
  });

  it('does not deny any key in BASE_ENV_ALLOW (no accidental allowlist poisoning)', () => {
    for (const key of BASE_ENV_ALLOW) {
      expect(isDeniedEnvKey(key), `${key} is incorrectly denied`).toBe(false);
    }
  });
});

describe('ENV_DENY_SUFFIXES / ENV_DENY_EXACT', () => {
  it('cover the credential suffixes the rule names', () => {
    expect(ENV_DENY_SUFFIXES).toContain('_TOKEN');
    expect(ENV_DENY_SUFFIXES).toContain('_API_KEY');
    expect(ENV_DENY_SUFFIXES).toContain('_SECRET');
    expect(ENV_DENY_SUFFIXES).toContain('_ACCESS_KEY');
  });

  it('name GH_TOKEN explicitly', () => {
    expect(ENV_DENY_EXACT).toContain('GH_TOKEN');
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
