#!/usr/bin/env node
// Rewrite Tnnn dependency refs in GitHub issue bodies to clickable #N links.
// Builds the T-id -> issue-number map live from GitHub (not assumed sequential),
// re-derives each body from docs/backlog.md, relinks refs, and edits the issue.
// Idempotent: skips issues whose body is already up to date.
// Usage:  node scripts/relink-dependency-refs.mjs [--dry-run] [--repo owner/name]
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const DRY = process.argv.includes('--dry-run');
const repoArg = process.argv.indexOf('--repo');
const REPO = repoArg > -1 ? process.argv[repoArg + 1] : 'kortiene/mx-loom';

const lines = readFileSync(new URL('../docs/backlog.md', import.meta.url), 'utf8').split('\n');

const milestones = [];
for (const line of lines) {
  const m = line.match(/^\|\s*\*\*(M[0-6][^*]*)\*\*\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/);
  if (m) milestones.push({ key: m[1].slice(0, 2), title: m[1].trim() });
}

const issues = [];
let i = 0;
while (i < lines.length) {
  const h = lines[i].match(/^####\s+(T\d+)\s+·\s+(.+?)\s*$/);
  if (!h) { i++; continue; }
  const id = h[1];
  let j = i + 1; while (j < lines.length && lines[j].trim() === '') j++;
  const meta = lines[j] || '';
  const estimate = ([...meta.matchAll(/\*\*([^*]+)\*\*/g)].map((x) => x[1].trim()).find((b) => /^[SML]$/.test(b))) || '';
  const msKey = (meta.replace(/\*\*[^*]+\*\*/g, '').match(/\b(M[0-6])\b/) || [])[1] || '';
  let k = j + 1; const body = [];
  while (k < lines.length && !/^####\s/.test(lines[k]) && lines[k].trim() !== '---' && !/^##\s/.test(lines[k])) { body.push(lines[k]); k++; }
  while (body.length && body[0].trim() === '') body.shift();
  while (body.length && body.at(-1).trim() === '') body.pop();
  const ms = milestones.find((m) => m.key === msKey);
  issues.push({ id, estimate, milestoneTitle: ms ? ms.title : msKey, bodyMd: body.join('\n') });
  i = k;
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const ghIssues = JSON.parse(gh(['issue', 'list', '--repo', REPO, '--state', 'all', '--limit', '400', '--json', 'number,title,body']));
const map = {}, curBody = {};
for (const gi of ghIssues) { const t = (gi.title.match(/^(T\d+)/) || [])[1]; if (t) { map[t] = gi.number; curBody[t] = gi.body; } }

const missing = new Set();
const relink = (text) => text.replace(/\bT(\d{3})\b/g, (m) => { const n = map[m]; if (!n) { missing.add(m); return m; } return `#${n}`; });

console.log(`Repo: ${REPO} · mapped ${Object.keys(map).length} issues${DRY ? '  (DRY RUN)' : ''}\n`);
let changed = 0, unchanged = 0;
for (const it of issues) {
  const num = map[it.id];
  if (!num) { console.log('  ! no GH issue for', it.id); continue; }
  const footer = `\n\n---\n_Estimate: ${it.estimate || 'n/a'} · Milestone: ${it.milestoneTitle} · Source: \`docs/backlog.md\` (\`${it.id}\`)._`;
  const newBody = relink(it.bodyMd) + footer;
  if ((curBody[it.id] || '').trim() === newBody.trim()) { unchanged++; continue; }
  if (DRY) {
    const dep = (it.bodyMd.split('\n').find((l) => /Dependencies/.test(l)) || '(none)').replace(/^- /, '').trim();
    console.log(`  ~ ${it.id} (#${num})  ${dep}  ->  ${relink(dep)}`);
  } else {
    gh(['issue', 'edit', String(num), '--repo', REPO, '--body', newBody]);
    console.log('  ✓ updated', it.id, `(#${num})`);
  }
  changed++;
}
console.log(`\n${DRY ? '(dry) ' : ''}changed=${changed} unchanged=${unchanged}`);
if (missing.size) console.log('Unmapped refs:', [...missing].join(', '));
