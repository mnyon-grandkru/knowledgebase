#!/usr/bin/env node
// Snapshot all issues + comments into admin/data/issues.json for the admin panel.
// Usage: GITHUB_TOKEN=... node scripts/build-data.mjs [owner/repo] [outfile]
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fetchIssues } from '../admin/lib.js';

const [owner, repo] = (process.argv[2] || process.env.GITHUB_REPOSITORY || 'mnyon-grandkru/knowledgebase').split('/');
const out = process.argv[3] || 'admin/data/issues.json';

const issues = await fetchIssues({ owner, repo, token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN });
const payload = { repo: `${owner}/${repo}`, generatedAt: new Date().toISOString(), count: issues.length, issues };
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(payload, null, 1) + '\n');
console.log(`wrote ${issues.length} issues to ${out}`);
