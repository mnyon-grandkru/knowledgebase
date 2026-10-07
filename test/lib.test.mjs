import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeIssue, isPullRequest, hasResolution, kbStatus, status, needsReview,
  computeStats, allLabels, filterIssues, labelTextColor, relativeTime, fetchIssues,
} from '../admin/lib.js';

const raw = (o = {}) => ({
  number: 1, title: 'T', state: 'open', state_reason: null, created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-02T00:00:00Z', closed_at: null, html_url: 'https://x/1', user: { login: 'm' },
  labels: [], comments: 0, body: '', ...o,
});
const mk = (o = {}, comments = []) => normalizeIssue(raw(o), comments);
const label = (name, color = 'ededed') => ({ name, color });

test('normalizeIssue maps fields and comments', () => {
  const i = mk({ labels: [label('bug', 'd73a4a'), 'plain'] }, [{ user: { login: 'a' }, created_at: 'c', body: 'hi', html_url: 'u' }]);
  assert.equal(i.number, 1);
  assert.deepEqual(i.labels, [{ name: 'bug', color: 'd73a4a' }, { name: 'plain', color: 'cccccc' }]);
  assert.deepEqual(i.comments, [{ author: 'a', createdAt: 'c', body: 'hi', url: 'u' }]);
  assert.equal(i.author, 'm');
});

test('isPullRequest', () => {
  assert.equal(isPullRequest(raw({ pull_request: {} })), true);
  assert.equal(isPullRequest(raw()), false);
});

test('status / hasResolution', () => {
  assert.equal(status(mk()), 'open');
  assert.equal(status(mk({ state: 'closed', comments: 1 }, [{ body: 'Root cause: X' }])), 'resolved');
  assert.equal(status(mk({ state: 'closed', body: 'The solution chosen was Y' })), 'resolved');
  assert.equal(status(mk({ state: 'closed' })), 'unresolved');
  assert.equal(status(mk({ state: 'closed', state_reason: 'not_planned', comments: 1 }, [{ body: 'fixed' }])), 'unresolved');
  assert.equal(hasResolution(mk({ state: 'open', body: 'fix' })), false);
});

test('kbStatus', () => {
  assert.equal(kbStatus(mk()), 'none');
  assert.equal(kbStatus(mk({ labels: [label('kb:candidate')] })), 'candidate');
  assert.equal(kbStatus(mk({ labels: [label('kb:candidate'), label('kb:published')] })), 'published');
});

test('needsReview', () => {
  assert.equal(needsReview(mk()), true, 'open');
  assert.equal(needsReview(mk({ state: 'closed' })), true, 'closed without fix');
  assert.equal(needsReview(mk({ state: 'closed', body: 'fixed it' })), true, 'resolved, untriaged');
  assert.equal(needsReview(mk({ state: 'closed', body: 'fixed it', labels: [label('kb:candidate')] })), false, 'resolved candidate');
  assert.equal(needsReview(mk({ labels: [label('kb:published')] })), false, 'published');
});

const sample = [
  mk({ number: 1, title: 'Docker alpine', updated_at: '2024-01-03T00:00:00Z', labels: [label('docker')] }),
  mk({ number: 2, title: 'KeePassXC alt tab', state: 'closed', updated_at: '2024-01-05T00:00:00Z', labels: [label('windows'), label('keepassxc')], comments: 1 }, [{ body: 'Root cause: Always on Top' }]),
  mk({ number: 3, title: 'Windows hello', updated_at: '2024-01-04T00:00:00Z', labels: [label('windows'), label('kb:candidate')] }),
  mk({ number: 4, title: 'Old', state: 'closed', updated_at: '2023-01-01T00:00:00Z', labels: [label('kb:published')], body: 'fixed' }),
];

test('computeStats', () => {
  assert.deepEqual(computeStats(sample), { total: 4, open: 2, resolved: 2, unresolved: 0, candidate: 1, published: 1, review: 3 });
});

test('allLabels counts and sorts', () => {
  const ls = allLabels(sample);
  assert.equal(ls[0].name, 'windows');
  assert.equal(ls[0].count, 2);
});

test('filterIssues: views, labels, query, sort', () => {
  const nums = (f) => filterIssues(sample, f).map((i) => i.number);
  assert.deepEqual(nums({}), [2, 3, 1, 4], 'default sort updated desc');
  assert.deepEqual(nums({ view: 'review' }), [2, 3, 1]);
  assert.deepEqual(nums({ view: 'open' }), [3, 1]);
  assert.deepEqual(nums({ view: 'resolved' }), [2, 4]);
  assert.deepEqual(nums({ view: 'candidate' }), [3]);
  assert.deepEqual(nums({ view: 'published' }), [4]);
  assert.deepEqual(nums({ labels: ['windows'] }), [2, 3]);
  assert.deepEqual(nums({ labels: ['windows', 'keepassxc'] }), [2]);
  assert.deepEqual(nums({ query: 'always on top' }), [2], 'searches comments');
  assert.deepEqual(nums({ query: '#3' }), [3]);
  assert.deepEqual(nums({ sort: 'number' }), [4, 3, 2, 1]);
  assert.deepEqual(nums({ sort: 'created' }).length, 4);
});

test('labelTextColor contrast', () => {
  assert.equal(labelTextColor('ffffff'), '#1b1f24');
  assert.equal(labelTextColor('000000'), '#ffffff');
  assert.equal(labelTextColor('#d73a4a'), '#ffffff');
});

test('relativeTime', () => {
  const now = Date.parse('2024-01-10T00:00:00Z');
  assert.equal(relativeTime('2024-01-09T00:00:00Z', now), '1d ago');
  assert.equal(relativeTime('2024-01-10T00:00:00Z', now), 'just now');
  assert.equal(relativeTime('2022-01-01T00:00:00Z', now), '2y ago');
  assert.equal(relativeTime(null, now), '');
});

test('fetchIssues paginates, drops PRs, fetches comments, sends token', async () => {
  const page1 = Array.from({ length: 100 }, (_, k) => raw({ number: k + 1, comments: 0 }));
  page1[4] = raw({ number: 5, comments: 2 });
  page1[9] = raw({ number: 10, pull_request: {} });
  const page2 = [raw({ number: 101, comments: 1 })];
  const calls = [];
  const fake = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    const json = url.includes('page=1&') || url.endsWith('page=1') ? page1
      : url.includes('page=2') ? page2
      : url.includes('/issues/5/comments') ? [{ user: { login: 'a' }, body: 'c1' }, { user: { login: 'b' }, body: 'c2' }]
      : url.includes('/issues/101/comments') ? [{ user: { login: 'a' }, body: 'only' }]
      : null;
    if (!json) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => json };
  };
  const out = await fetchIssues({ owner: 'o', repo: 'r', token: 'tok', fetchImpl: fake });
  assert.equal(out.length, 100, '101 issues minus 1 PR');
  assert.equal(out[0].number, 101, 'sorted desc');
  assert.equal(out.find((i) => i.number === 5).comments.length, 2);
  assert.equal(out.find((i) => i.number === 10), undefined);
  assert.ok(calls.every((c) => c.auth === 'Bearer tok'));
  assert.equal(calls.filter((c) => c.url.includes('/comments')).length, 2, 'only issues with comments');
});

test('fetchIssues surfaces HTTP errors', async () => {
  const fake = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(fetchIssues({ owner: 'o', repo: 'r', fetchImpl: fake }), /GitHub 403/);
});
