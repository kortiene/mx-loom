import { describe, expect, it } from 'vitest';

import { methodToArgv } from '../src/cli/method-map.js';
import { TransportError } from '../src/transport.js';

describe('methodToArgv', () => {
  describe('argv generation', () => {
    it('splits daemon.status on dots and appends --json', () => {
      const { argv, stdin } = methodToArgv('daemon.status');
      expect(argv).toEqual(['daemon', 'status', '--json']);
      expect(stdin).toBeUndefined();
    });

    it('splits daemon.ping on dots and appends --json', () => {
      const { argv, stdin } = methodToArgv('daemon.ping');
      expect(argv).toEqual(['daemon', 'ping', '--json']);
      expect(stdin).toBeUndefined();
    });

    it('handles agent.list', () => {
      const { argv, stdin } = methodToArgv('agent.list');
      expect(argv).toEqual(['agent', 'list', '--json']);
      expect(stdin).toBeUndefined();
    });

    it('handles call.start', () => {
      const { argv } = methodToArgv('call.start');
      expect(argv).toEqual(['call', 'start', '--json']);
    });

    it('handles a single-segment method', () => {
      const { argv } = methodToArgv('ping');
      expect(argv).toEqual(['ping', '--json']);
    });

    it('handles a three-segment method', () => {
      const { argv } = methodToArgv('workspace.status.extended');
      expect(argv).toEqual(['workspace', 'status', 'extended', '--json']);
    });

    it('always ends with --json', () => {
      for (const method of ['daemon.status', 'agent.list', 'call.start', 'ping']) {
        const { argv } = methodToArgv(method);
        expect(argv[argv.length - 1]).toBe('--json');
      }
    });
  });

  describe('params → stdin (never on argv)', () => {
    it('appends --input-json - and serializes params to stdin when params are provided', () => {
      const params = { agent_id: 'agent-001', method: 'run_tests' };
      const { argv, stdin } = methodToArgv('call.start', params);
      expect(argv).toContain('--input-json');
      expect(argv).toContain('-');
      expect(stdin).toBe(JSON.stringify(params));
    });

    it('does not embed param values in argv (world-visible path protection)', () => {
      const params = { agent_id: 'super-sensitive-agent-id', room: '!room:example.test' };
      const { argv } = methodToArgv('call.start', params);
      const argvStr = argv.join(' ');
      expect(argvStr).not.toContain('super-sensitive-agent-id');
      expect(argvStr).not.toContain('!room:example.test');
    });

    it('passes no stdin when params is undefined', () => {
      const { argv, stdin } = methodToArgv('daemon.ping', undefined);
      expect(stdin).toBeUndefined();
      expect(argv).not.toContain('--input-json');
    });

    it('passes no stdin when params is null', () => {
      const { argv, stdin } = methodToArgv('daemon.ping', null);
      expect(stdin).toBeUndefined();
      expect(argv).not.toContain('--input-json');
    });

    it('passes stdin for an empty object (caller explicitly provided params)', () => {
      const { argv, stdin } = methodToArgv('agent.list', {});
      expect(stdin).toBe('{}');
      expect(argv).toContain('--input-json');
    });

    it('serializes nested params to JSON in stdin', () => {
      const params = { filter: { active: true, role: 'runner' }, limit: 10 };
      const { stdin } = methodToArgv('agent.list', params);
      expect(JSON.parse(stdin!)).toEqual(params);
    });

    it('places --input-json - after --json in the argv order', () => {
      const { argv } = methodToArgv('call.start', { x: 1 });
      const jsonIdx = argv.indexOf('--json');
      const inputIdx = argv.indexOf('--input-json');
      expect(jsonIdx).toBeGreaterThanOrEqual(0);
      expect(inputIdx).toBeGreaterThan(jsonIdx);
    });

    it('treats boolean false as a provided param (not undefined/null) — writes stdin', () => {
      const { argv, stdin } = methodToArgv('daemon.ping', false);
      expect(argv).toContain('--input-json');
      expect(stdin).toBe('false');
    });

    it('treats numeric 0 as a provided param — writes stdin', () => {
      const { argv, stdin } = methodToArgv('daemon.ping', 0);
      expect(argv).toContain('--input-json');
      expect(stdin).toBe('0');
    });
  });

  describe('invalid method → TransportError("invalid_args")', () => {
    function expectInvalidArgs(method: string): void {
      try {
        methodToArgv(method);
        expect.unreachable(`methodToArgv('${method}') should have thrown`);
      } catch (e) {
        expect(e).toBeInstanceOf(TransportError);
        expect((e as TransportError).code).toBe('invalid_args');
      }
    }

    it('throws on an empty string method', () => {
      expectInvalidArgs('');
    });

    it('throws on a single dot (empty segments)', () => {
      expectInvalidArgs('.');
    });

    it('throws on multiple dots with no content', () => {
      expectInvalidArgs('...');
    });
  });
});
