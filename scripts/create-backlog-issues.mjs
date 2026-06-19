#!/usr/bin/env node
// Parse docs/backlog.md and create GitHub milestones + labels + issues in kortiene/mx-loom.
// Idempotent: existing milestones (by title) and issues (by leading T-id) are skipped.
// Usage:  node scripts/create-backlog-issues.mjs [--dry-run] [--repo owner/name]
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const DRY = process.argv.includes('--dry-run');
const repoArg = process.argv.indexOf('--repo');
const REPO = repoArg > -1 ? process.argv[repoArg + 1] : 'kortiene/mx-loom';

const md = readFileSync(new URL('../docs/backlog.md', import.meta.url), 'utf8');
const lines = md.split('\n');

// ---- parse milestones table ----
const milestones = [];
for (const line of lines) {
  const m = line.match(/^\|\s*\*\*(M[0-6][^*]*)\*\*\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/);
  if (m) milestones.push({ key: m[1].slice(0, 2), title: m[1].trim(), goal: m[2].trim(), dod: m[3].trim() });
}

// ---- parse issue blocks ----
const issues = [];
let i = 0;
while (i < lines.length) {
  const h = lines[i].match(/^####\s+(T\d+)\s+·\s+(.+?)\s*$/);
  if (!h) { i++; continue; }
  const id = h[1];
  const title = `${id} · ${h[2]}`;
  let j = i + 1;
  while (j < lines.length && lines[j].trim() === '') j++;
  const meta = lines[j] || '';
  const tokens = [...meta.matchAll(/`([^`]+)`/g)].map((x) => x[1]);
  const labels = [];
  for (const t of tokens) {
    if (/^(area|type)\/[a-z-]+$/.test(t)) labels.push(t);
    else if (/^P[0-2]$/.test(t)) labels.push(`priority/${t}`);
  }
  const bolds = [...meta.matchAll(/\*\*([^*]+)\*\*/g)].map((x) => x[1].trim());
  const estimate = bolds.find((b) => /^[SML]$/.test(b)) || '';
  const msKey = (meta.replace(/\*\*[^*]+\*\*/g, '').match(/\b(M[0-6])\b/) || [])[1] || '';
  let k = j + 1;
  const body = [];
  while (k < lines.length && !/^####\s/.test(lines[k]) && lines[k].trim() !== '---' && !/^##\s/.test(lines[k])) {
    body.push(lines[k]); k++;
  }
  while (body.length && body[0].trim() === '') body.shift();
  while (body.length && body.at(-1).trim() === '') body.pop();
  const ms = milestones.find((m) => m.key === msKey);
  const footer = `\n\n---\n_Estimate: ${estimate || 'n/a'} · Milestone: ${ms ? ms.title : msKey} · Source: \`docs/backlog.md\` (\`${id}\`). Dependency refs (\`Tnnn\`) are issue titles in this repo._`;
  issues.push({ id, title, labels, milestoneTitle: ms ? ms.title : '', body: body.join('\n') + footer });
  i = k;
}

const allLabels = [...new Set(issues.flatMap((x) => x.labels))].sort();
const color = (n) =>
  n.startsWith('area/') ? '1d76db' :
  n.startsWith('type/') ? '5319e6' :
  n === 'priority/P0' ? 'b60205' :
  n === 'priority/P1' ? 'd93f0b' :
  n === 'priority/P2' ? 'fbca04' : 'ededed';

function gh(args) {
  if (DRY) { console.log('  DRY: gh ' + args.join(' ')); return ''; }
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

console.log(`Repo: ${REPO}`);
console.log(`Parsed: ${milestones.length} milestones, ${issues.length} issues, ${allLabels.length} labels${DRY ? '  (DRY RUN)' : ''}\n`);

// ---- labels ----
console.log('Labels:');
for (const n of allLabels) { gh(['label', 'create', n, '--repo', REPO, '--color', color(n), '--force']); console.log('  ✓', n); }

// ---- milestones ----
console.log('\nMilestones:');
const existingMs = DRY ? [] : JSON.parse(gh(['api', `repos/${REPO}/milestones?state=all&per_page=100`]) || '[]').map((m) => m.title);
for (const m of milestones) {
  if (existingMs.includes(m.title)) { console.log('  • exists:', m.title); continue; }
  gh(['api', `repos/${REPO}/milestones`, '-f', `title=${m.title}`, '-f', `description=**Goal:** ${m.goal}\n\n**Definition of done:** ${m.dod}`]);
  console.log('  ✓ created:', m.title);
}

// ---- issues ----
console.log('\nIssues:');
const existing = DRY ? [] : JSON.parse(gh(['issue', 'list', '--repo', REPO, '--state', 'all', '--limit', '400', '--json', 'title']) || '[]').map((x) => x.title);
const existingIds = new Set(existing.map((t) => (t.match(/^(T\d+)/) || [])[1]).filter(Boolean));
let created = 0, skipped = 0;
for (const it of issues) {
  if (existingIds.has(it.id)) { console.log('  • skip (exists):', it.id); skipped++; continue; }
  const args = ['issue', 'create', '--repo', REPO, '--title', it.title, '--body', it.body];
  if (it.milestoneTitle) args.push('--milestone', it.milestoneTitle);
  for (const l of it.labels) args.push('--label', l);
  const out = gh(args);
  console.log('  ✓', it.id, '→', out.trim());
  created++;
}
console.log(`\nDone. milestones=${milestones.length} labels=${allLabels.length} issues_created=${created} issues_skipped=${skipped}`);
