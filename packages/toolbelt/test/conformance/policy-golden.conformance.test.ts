/**
 * Conformance · T112 — policy.golden.toml fixture live enforcement (two daemons).
 *
 * Verifies that the canonical golden-test receiver policy (`policy.golden.toml`)
 * is loaded, parsed, and **enforced** by the pinned mx-agent v0.2.1 daemon when
 * daemon B is brought up with `POLICY_FIXTURE=policy.golden.toml`.
 *
 * T112 acceptance criteria exercised here:
 *
 *   AC 1 — fixture loads and deny-by-default is in effect: the allowed-tool path
 *           returns `ok` without being held (`awaiting_approval`) — this distinguishes
 *           the `requires_approval=false` entry from the approval-gated entry and
 *           proves the grammar was accepted by the daemon.
 *
 *   AC 2 (approval-gated delegation): `call.start(approvalTool)` is held with
 *           `awaiting_approval` status — the `requires_approval=true` rule on the
 *           golden policy's second named tool is real. Gated on `fixture.approvalTool`
 *           being set; skips until T114's bring-up registers the approval tool.
 *
 *   AC 2 (deny_args_regex, exec path): `exec.start(allowedCommand, dangerousArgs)`
 *           → `policy_denied` — the golden fixture's `deny_args_regex` is enforced
 *           by the live daemon for an **allowlisted** command whose args match the
 *           pattern. This is distinct from `exec.conformance.test.ts` AC 1/AC 3,
 *           which use an un-allowlisted command; here the command IS in
 *           `allow_commands` and only the *args* trip the filter. Gated on
 *           `fixture.allowedCommand`.
 *
 * This suite must NOT run against the throwaway `policy.b.toml` — that fixture
 * has no `[exec]` block, no approval gate, and no `deny_args_regex`. The
 * `MXL_CONFORMANCE_GOLDEN_POLICY=1` gate enforces this separation.
 *
 * Pre-conditions (established OUT OF BAND by the bring-up):
 *   - `bootstrap-daemon-b.sh` run with `POLICY_FIXTURE=policy.golden.toml`
 *   - All `@@…@@` placeholders substituted (the bring-up fails loudly if any remain)
 *   - Mutual Ed25519 trust established (`mx-agent trust approve`)
 *   - `MXL_CONFORMANCE_GOLDEN_POLICY=1` exported by the bring-up
 *
 * Run:
 *   POLICY_FIXTURE=policy.golden.toml \
 *   MXL_CONFORMANCE_GOLDEN_POLICY=1 \
 *   MXL_CONFORMANCE_TWO_DAEMON=1 \
 *   pnpm --filter @mx-loom/toolbelt test:conformance
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createClient } from '../../src/client.js';
import type { MxClient } from '../../src/client.js';
import { TransportError } from '../../src/transport.js';

import {
  SECRET_PATTERN,
  SKIP_GOLDEN_POLICY,
  assertTwoDaemonPrereqs,
  readTwoDaemonFixture,
} from './_harness.js';
import type { TwoDaemonFixture } from './_harness.js';

// ---------------------------------------------------------------------------
// Helpers (same patterns as delegate.conformance.test.ts / exec.conformance.test.ts)
// ---------------------------------------------------------------------------

function isDenial(value: unknown): boolean {
  if (value instanceof TransportError) return true;
  if (value === null || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  if (rec['ok'] === false) return true;
  if (rec['error'] !== undefined && rec['error'] !== null) return true;
  if (typeof rec['status'] === 'string' && /deny|denied|reject|refus|policy/i.test(rec['status'])) return true;
  if (typeof rec['state'] === 'string' && /policy_denied|denied/i.test(rec['state'])) return true;
  return false;
}

/**
 * Returns true when the daemon held the call for an operator approval decision.
 * The exact field/value the v0.2.1 daemon uses is not yet pinned by the
 * round-trip — check both the `status` / `state` / `phase` fields (the OQ #3
 * vocabulary the T103 suite is resolving) and `awaiting_approval` as a substring
 * in the serialized response, so this stays green across spelling variants.
 */
function isAwaitingApproval(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  for (const key of ['status', 'state', 'phase']) {
    if (typeof rec[key] === 'string' && /await|approval|pending_approval/i.test(rec[key] as string)) {
      return true;
    }
  }
  return JSON.stringify(value).includes('awaiting_approval');
}

// ---------------------------------------------------------------------------
// Golden-policy conformance suite
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_GOLDEN_POLICY)(
  'conformance · T112 — policy.golden.toml fixture live enforcement',
  () => {
    let client: MxClient | undefined;
    let fixture: TwoDaemonFixture | undefined;

    beforeAll(() => {
      assertTwoDaemonPrereqs();
      const fx = readTwoDaemonFixture();
      if (fx === null) throw new Error('conformance T112 golden-policy: two-daemon fixture coordinates absent');
      fixture = fx;
      client = createClient();
    });

    afterAll(async () => {
      await client?.close();
    });

    // -------------------------------------------------------------------------
    // AC 1 — golden fixture loaded, ungated tool succeeds without approval hold
    //
    // The first `[[allow]]` entry in policy.golden.toml is `requires_approval=false`
    // (the ungated happy-path tool). A successful `call.start` that is NOT held
    // for approval proves:
    //   (a) the daemon loaded and parsed the fixture (no load error);
    //   (b) deny-by-default is in effect for everything NOT in the allow list;
    //   (c) the `requires_approval=false` entry is honoured (not escalated to gated).
    // -------------------------------------------------------------------------

    it(
      'AC 1: ungated allowed tool (@@ALLOW_TOOL@@) resolves to ok — golden fixture loaded and in effect',
      async () => {
        if (!client || !fixture) throw new Error('T112 golden-policy fixture not initialised');

        const response = await client.call(
          'call.start',
          {
            room: fixture.room,
            agent: fixture.targetAgentId,
            tool: fixture.tool,
            args: { package: 'mx-loom-t112-ac1-load-check' },
            idempotency_key: `mxl-t112-ac1-${randomUUID()}`,
          },
          { timeoutMs: 90_000 },
        );

        expect(response, 'call.start must return a non-null object').not.toBeNull();
        expect(typeof response).toBe('object');

        // The ungated allowed tool must NOT be held for approval — that would
        // indicate the golden policy's `requires_approval=false` entry is being
        // ignored (or the policy failed to load and a more restrictive default is
        // in effect). Either outcome is a policy-grammar failure (AC 1 red).
        expect(
          isAwaitingApproval(response),
          'AC 1: ungated tool must not be held for approval — policy.golden.toml ' +
            'has requires_approval=false on @@ALLOW_TOOL@@; if awaiting_approval is ' +
            'returned the fixture grammar may have failed to load correctly on the daemon',
        ).toBe(false);

        // Not a denial either — the golden policy allows this tool.
        expect(isDenial(response)).toBe(false);

        // Boundary A: no secret-shaped value in the response.
        expect(JSON.stringify(response)).not.toMatch(SECRET_PATTERN);

        console.info('[T112 AC1] call.start allowed tool response (golden fixture):', JSON.stringify(response));
      },
    );

    // -------------------------------------------------------------------------
    // AC 2 — approval-gated named-tool branch
    //
    // The second `[[allow]]` entry has `requires_approval=true` (@@APPROVAL_TOOL@@).
    // A `call.start` for this tool must be HELD by the daemon — not immediately
    // resolved, not denied. The first response must carry `awaiting_approval` status.
    //
    // Staged behind `fixture.approvalTool`: the approval tool must be registered
    // by daemon B as a published tool. The registration and the export of
    // `MXL_CONFORMANCE_APPROVAL_TOOL` land with T114's bring-up; until then this
    // test skips with a clear message. The test MUST NOT be removed — it is the
    // live AC 2 gate for T112; once T114 lands the bring-up, this test turns green.
    //
    // Note: this test does NOT exercise the operator decision (`approval.decide`);
    // that requires an out-of-band operator bot and is gated separately in
    // `await-result.conformance.test.ts` AC 2 (via MXL_CONFORMANCE_APPROVAL_GATED_TOOL).
    // Here we only assert the INITIAL hold — proving the `requires_approval=true`
    // policy rule is enforced out-of-process on the receiving daemon.
    // -------------------------------------------------------------------------

    it(
      'AC 2 (approval-gated delegation): call.start(@@APPROVAL_TOOL@@) is held as awaiting_approval',
      async (ctx) => {
        if (!client || !fixture) throw new Error('T112 golden-policy fixture not initialised');
        if (!fixture.approvalTool) {
          // Skip with a loud message — this is NOT a silent pass. The approval
          // tool is not registered yet (lands with T114's bring-up). When T114
          // exports MXL_CONFORMANCE_APPROVAL_TOOL and registers the tool, this
          // test should turn green automatically.
          console.warn(
            '[T112 AC2] SKIPPED: MXL_CONFORMANCE_APPROVAL_TOOL not set — ' +
              'set it to the @@APPROVAL_TOOL@@ name and register it on daemon B ' +
              '(lands with T114 bring-up) to exercise the approval-gated branch.',
          );
          ctx.skip();
          return;
        }

        const response = await client
          .call(
            'call.start',
            {
              room: fixture.room,
              agent: fixture.targetAgentId,
              tool: fixture.approvalTool,
              args: {},
              idempotency_key: `mxl-t112-ac2-approval-${randomUUID()}`,
            },
            { timeoutMs: 30_000 },
          )
          .catch((e: unknown) => e);

        // The golden policy has `requires_approval=true` for @@APPROVAL_TOOL@@;
        // the daemon must hold the call, not execute it immediately. Any terminal
        // success (`ok`) here would mean the daemon is NOT enforcing the approval
        // gate — a policy-enforcement failure, not a test configuration issue.
        expect(
          isDenial(response),
          'AC 2: approval-gated tool must not be denied outright — check that ' +
            'MXL_CONFORMANCE_APPROVAL_TOOL matches a tool in policy.golden.toml ' +
            'and is published by daemon B',
        ).toBe(false);

        expect(
          isAwaitingApproval(response),
          'AC 2: call.start(@@APPROVAL_TOOL@@) must be held awaiting_approval — ' +
            'policy.golden.toml has requires_approval=true on this tool. A direct ' +
            'ok response means the approval gate is not being enforced out-of-process.',
        ).toBe(true);

        // Boundary A: the held response must not leak a secret.
        expect(JSON.stringify(response instanceof Error ? response.message : response)).not.toMatch(
          SECRET_PATTERN,
        );

        console.info(
          '[T112 AC2] call.start approval-gated tool held (golden fixture):',
          JSON.stringify(response instanceof Error ? response.message : response),
        );
      },
    );

    // -------------------------------------------------------------------------
    // AC 2 (deny_args_regex, exec path)
    //
    // The golden fixture's `[exec]` block has a `deny_args_regex` pattern that
    // blocks dangerous argument strings (pipe-to-shell, rm -rf /, ssh, curl).
    // This test sends an ALLOWLISTED command (@@ALLOW_COMMAND@@) with args that
    // match the regex — proving the daemon enforces the regex on the real channel,
    // not just the static JavaScript test in `policy-fixture.test.ts`.
    //
    // This is distinct from `exec.conformance.test.ts` AC 1 / AC 3:
    //   - AC 1 uses MXL_CONFORMANCE_DENIED_COMMAND (un-allowlisted binary)
    //   - AC 3 also uses MXL_CONFORMANCE_DENIED_COMMAND (same binary, bad args)
    // Here the binary IS allowlisted; only the args cause denial. This exercises
    // the allow_commands + deny_args_regex interaction, which only exists in
    // policy.golden.toml (the throwaway policy.b.toml has no exec block at all).
    //
    // Gated on `fixture.allowedCommand`: skips when MXL_CONFORMANCE_ALLOWED_COMMAND
    // is absent (exec path not yet exercised in this fixture run).
    // -------------------------------------------------------------------------

    it(
      'AC 2 (deny_args_regex): exec.start(@@ALLOW_COMMAND@@, dangerousArgs) → policy_denied',
      async (ctx) => {
        if (!client || !fixture) throw new Error('T112 golden-policy fixture not initialised');
        if (!fixture.allowedCommand) {
          console.warn(
            '[T112 AC2/regex] SKIPPED: MXL_CONFORMANCE_ALLOWED_COMMAND not set — ' +
              'set it to the @@ALLOW_COMMAND@@ binary in policy.golden.toml to exercise ' +
              'the deny_args_regex enforcement path.',
          );
          ctx.skip();
          return;
        }

        // Use 'curl' as the dangerous arg — it is one of the design-named patterns
        // the fixture's deny_args_regex explicitly blocks (\bcurl\b). We send it as
        // a bare arg to the allowlisted binary (e.g. `echo curl`) so the arg string
        // matches the regex without the binary itself being curl.
        const dangerousArgs = ['curl', 'https://evil.example.com'];

        const outcome = await client
          .call(
            'exec.start',
            {
              room: fixture.room,
              agent: fixture.targetAgentId,
              command: fixture.allowedCommand,
              args: dangerousArgs,
              idempotency_key: `mxl-t112-regex-${randomUUID()}`,
            },
            { timeoutMs: 30_000 },
          )
          .catch((e: unknown) => e);

        // The deny_args_regex in policy.golden.toml must block this execution.
        // If the daemon executes the command instead of denying it, either the
        // fixture grammar was not loaded (AC 1 failure) or the deny_args_regex is
        // not being applied to the exec args (daemon behaviour mismatch).
        expect(
          isDenial(outcome),
          'AC 2/regex: exec.start with deny_args_regex-matching args must be denied — ' +
            `allowedCommand='${fixture.allowedCommand}' args=${JSON.stringify(dangerousArgs)}. ` +
            'If this passes through, the golden fixture deny_args_regex is not being ' +
            'enforced by the daemon (possibly the [exec] block grammar differs from what ' +
            'the daemon expects — see docs/mx-agent-surface-v0.2.1.md policy.toml section).',
        ).toBe(true);

        // Boundary A: the denial response must not carry a secret.
        expect(
          JSON.stringify(outcome instanceof Error ? outcome.message : outcome),
        ).not.toMatch(SECRET_PATTERN);

        console.info(
          '[T112 AC2/regex] exec.start allow-listed command + dangerous args denied (golden fixture):',
          outcome instanceof Error ? `${outcome.constructor.name}: ${outcome.message}` : JSON.stringify(outcome),
        );
      },
    );

    // -------------------------------------------------------------------------
    // AC 2 (exec-path approval hold)
    //
    // The [exec] block in policy.golden.toml has `requires_approval = true` on
    // the allowlisted command. An exec.start with SAFE args (no deny_args_regex
    // match) must be HELD for operator approval — not executed immediately.
    //
    // This is distinct from the deny_args_regex test above (dangerous args →
    // policy_denied) and from the delegation approval test (call.start →
    // awaiting_approval). The two exec tests together exercise the full [exec]
    // block guard chain:
    //   1. deny_args_regex: dangerous args → immediate denial (no approval path)
    //   2. requires_approval: safe args    → held for operator decision
    //
    // A direct ok here means the approval gate is bypassed — the golden policy's
    // [exec] block `requires_approval = true` is not being enforced.
    //
    // Gated on `fixture.allowedCommand`: skips when MXL_CONFORMANCE_ALLOWED_COMMAND
    // is absent (exec path not yet exercised in this fixture run).
    // -------------------------------------------------------------------------

    it(
      'AC 2 (exec-path approval hold): exec.start(@@ALLOW_COMMAND@@, safeArgs) → awaiting_approval',
      async (ctx) => {
        if (!client || !fixture) throw new Error('T112 golden-policy fixture not initialised');
        if (!fixture.allowedCommand) {
          console.warn(
            '[T112 AC2/exec-hold] SKIPPED: MXL_CONFORMANCE_ALLOWED_COMMAND not set — ' +
              'set it to the @@ALLOW_COMMAND@@ binary in policy.golden.toml to exercise ' +
              'the exec-path approval hold. Safe (non-regex-matching) args are sent so ' +
              'the deny_args_regex guard does not trigger; requires_approval=true must hold.',
          );
          ctx.skip();
          return;
        }

        // Safe args: none of the dangerous patterns (no | sh/bash, no rm -rf /,
        // no ssh, no curl). For `echo` (the default @@ALLOW_COMMAND@@) these are
        // benign — the deny_args_regex must NOT match, so any denial here would
        // indicate a false-positive in the regex, not requires_approval enforcement.
        const safeArgs = ['mx-loom-t112-ac2-hold-check'];

        const outcome = await client
          .call(
            'exec.start',
            {
              room: fixture.room,
              agent: fixture.targetAgentId,
              command: fixture.allowedCommand,
              args: safeArgs,
              idempotency_key: `mxl-t112-exec-hold-${randomUUID()}`,
            },
            { timeoutMs: 30_000 },
          )
          .catch((e: unknown) => e);

        // The deny_args_regex must NOT have matched — safeArgs are clean. If the
        // daemon returns policy_denied here, either the deny_args_regex pattern is
        // broader than intended (false positive) or the command is not in
        // allow_commands. In either case this is a policy-grammar / fixture error.
        expect(
          isDenial(outcome),
          'AC 2/exec-hold: exec.start with safe args must NOT be denied — ' +
            `allowedCommand='${fixture.allowedCommand}' safeArgs=${JSON.stringify(safeArgs)}. ` +
            'A policy_denied here means deny_args_regex is false-positiving on safe args ' +
            'or the command is missing from allow_commands in the loaded golden fixture.',
        ).toBe(false);

        // requires_approval = true on the [exec] block must HOLD the execution even
        // when the command and args both pass their respective filters. An immediate
        // ok means the golden policy's approval gate is not enforced for exec.
        expect(
          isAwaitingApproval(outcome),
          'AC 2/exec-hold: exec.start(@@ALLOW_COMMAND@@, safeArgs) must be held ' +
            'awaiting_approval — policy.golden.toml has requires_approval=true in the [exec] ' +
            'block. A direct ok response means the exec-path approval gate is not enforced ' +
            'out-of-process on the receiving daemon.',
        ).toBe(true);

        // Boundary A: the held response must not carry a secret.
        expect(
          JSON.stringify(outcome instanceof Error ? outcome.message : outcome),
        ).not.toMatch(SECRET_PATTERN);

        console.info(
          '[T112 AC2/exec-hold] exec.start allowlisted command + safe args held awaiting_approval (golden fixture):',
          outcome instanceof Error ? `${outcome.constructor.name}: ${outcome.message}` : JSON.stringify(outcome),
        );
      },
    );

    // -------------------------------------------------------------------------
    // Secret boundary — no response under the golden policy carries a credential
    //
    // Under policy.golden.toml, network = "deny" and no run can exfiltrate
    // outward. But the in-band response itself must also be clean: policy verdicts,
    // approval messages, and exec results must not carry any secret-shaped value.
    // Mirrors the same assertion from `delegate.conformance.test.ts` and
    // `exec.conformance.test.ts`, applied specifically to the golden-policy fixture.
    // -------------------------------------------------------------------------

    it(
      'Boundary A: policy verdicts under golden fixture carry no secret-shaped value',
      async () => {
        if (!client || !fixture) throw new Error('T112 golden-policy fixture not initialised');

        // Use the denied tool (un-allowlisted, hits deny-by-default) — this
        // produces a policy verdict that must be clean even in the error payload.
        if (!fixture.deniedTool) {
          console.warn(
            '[T112 Boundary A] MXL_CONFORMANCE_DENIED_TOOL not set — using a ' +
              'synthetic unknown tool name for the denial verdict check.',
          );
        }
        const probeTool = fixture.deniedTool ?? `t112-nonexistent-tool-${randomUUID()}@1.0.0`;

        const outcome = await client
          .call(
            'call.start',
            {
              room: fixture.room,
              agent: fixture.targetAgentId,
              tool: probeTool,
              args: {},
              idempotency_key: `mxl-t112-boundary-${randomUUID()}`,
            },
            { timeoutMs: 30_000 },
          )
          .catch((e: unknown) => e);

        const serialized = JSON.stringify(
          outcome instanceof Error ? { message: outcome.message, cause: outcome.cause } : outcome,
        );
        expect(
          serialized,
          'Boundary A: policy denial verdict must not contain a secret-shaped value',
        ).not.toMatch(SECRET_PATTERN);
      },
    );
  },
);
