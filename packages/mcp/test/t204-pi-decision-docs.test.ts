/**
 * T204 / #26 focused non-e2e coverage: the Pi tool-surface spike is a
 * documentation decision, not runtime code. These tests keep the decision
 * record, backlog/design docs, and MCP package docs aligned so a future edit
 * cannot silently re-open the MCP-vs-native question or imply that Pi can mount
 * `@mx-loom/mcp` directly today.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function between(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  expect(startIndex, `missing section start ${start}`).toBeGreaterThanOrEqual(0);
  const endIndex = text.indexOf(end, startIndex + start.length);
  expect(endIndex, `missing section end ${end}`).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

describe('T204 Pi tool-surface decision docs', () => {
  it('records native Pi tool registration as the accepted decision, with MCP only extension-mediated', () => {
    const decision = readRepoFile('docs/pi-tool-surface-capability.md');

    expect(decision).toContain('**Decided — native tool registration**');
    expect(decision).toContain('Pi has no built-in MCP client today');
    expect(decision).toContain('native Pi tool registration for T205');
    expect(decision).toContain('MCP via a Pi extension — POSSIBLE, but build-it-yourself');
    expect(decision).toMatch(/Do \*\*not\*\* run `@mx-loom\/mcp`\s+inside Pi/);
    expect(decision).toContain('SDK `customTools` / `defineTool`');
    expect(decision).toContain('extension-time `pi.registerTool()`');
  });

  it('keeps backlog T204/T205/T206 aligned on native registration and reference-only MCP reuse', () => {
    const backlog = readRepoFile('docs/backlog.md');
    const t204 = between(backlog, '#### T204 · spike: Pi tool-surface capability', '#### T205 · binding: Pi');
    const t205 = between(backlog, '#### T205 · binding: Pi', '#### T206 · test: portability matrix');
    const t206 = between(backlog, '#### T206 · test: portability matrix', '#### T207 · docs: per-runtime integration guide');

    expect(t204).toContain('Decision recorded: MCP vs native registration for Pi — **native tool registration**');
    expect(t204).toContain('No runtime binding code lands in T204 (spike only)');
    expect(t204).toContain('packages/golden/test/t204-pi-capability.e2e.test.ts');

    expect(t205).toContain('**T204 decided native registration**');
    expect(t205).toContain('not MCP-protocol consumption');
    expect(t205).toContain('Reuse `@mx-loom/mcp`\'s dispatch/context/serialize as a *pattern* only');
    expect(t205).toContain('**T109 is reference-only**');
    expect(t205).toContain('because Pi consumes native tools, not MCP');

    expect(t206).toContain('The **Pi arm uses native registration**');
    expect(t206).toContain('not an MCP mount');
  });

  it('keeps the design document from over-promising MCP support for Pi', () => {
    const design = readRepoFile('docs/mx-agent-tool-fabric-design.md');
    const runtimeSection = between(design, '## 3. How each runtime consumes the tools', '## 4. The minimum common tool contract');
    const roadmapSection = between(design, '## 10. Roadmap', '## The shape of the win');

    expect(runtimeSection).toContain('MCP is the universal binding for MCP-capable runtimes');
    expect(runtimeSection).toContain('where the runtime has no built-in MCP client (Pi)');
    expect(runtimeSection).toContain('Resolved by T204');
    expect(runtimeSection).toContain('Pi has no built-in MCP client today');
    expect(runtimeSection).toContain('native tool-registration');
    expect(runtimeSection).toContain('cannot consume `@mx-loom/mcp` directly');
    expect(runtimeSection).toContain('Pi `ToolDefinition[]`');

    expect(roadmapSection).toContain('Pi binding via **native tool registration**');
    expect(roadmapSection).toContain('Pi has no built-in MCP client');
  });

  it('keeps user-facing/runtime package docs from saying Pi can use the MCP server directly', () => {
    const rootReadme = readRepoFile('README.md');
    const mcpReadme = readRepoFile('packages/mcp/README.md');
    const mcpIndex = readRepoFile('packages/mcp/src/index.ts');
    const mcpPackage = JSON.parse(readRepoFile('packages/mcp/package.json')) as { description: string };

    expect(rootReadme).toContain('**Pi** — native tool registration');
    expect(rootReadme).not.toContain('**Pi** — MCP or native tool registration.');

    expect(mcpReadme).toContain('**Pi is the exception:** T204');
    expect(mcpReadme).toContain('uses native tool registration (`ToolDefinition[]`) instead of\nmounting this server');
    expect(mcpReadme).toContain('T205/Pi to use as reference code, not a runtime dependency');

    expect(mcpIndex).toContain('Pi is the documented exception from T204');
    expect(mcpIndex).toContain('uses native tool registration');

    expect(mcpPackage.description).toContain('universal binding for MCP-capable target runtimes');
    expect(mcpPackage.description).toContain('Pi uses native registration per T204');
  });
});
