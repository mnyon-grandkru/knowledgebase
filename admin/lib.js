// Pure helpers shared by the browser panel and the Node snapshot script.

export const KB_LABELS = {
  candidate: 'kb:candidate',
  published: 'kb:published',
};

const RESOLUTION_RE = /\b(solution|solved|fix(ed|es)?|resolved|workaround|root cause|the answer)\b/i;

export function normalizeIssue(raw, comments = []) {
  return {
    number: raw.number,
    title: raw.title || '',
    state: raw.state,
    stateReason: raw.state_reason || null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at || null,
    url: raw.html_url,
    author: raw.user ? raw.user.login : null,
    labels: (raw.labels || []).map((l) =>
      typeof l === 'string' ? { name: l, color: 'cccccc' } : { name: l.name, color: l.color || 'cccccc' }
    ),
    commentCount: raw.comments || 0,
    body: raw.body || '',
    comments: comments.map((c) => ({
      author: c.user ? c.user.login : null,
      createdAt: c.created_at,
      body: c.body || '',
      url: c.html_url,
    })),
  };
}

export function isPullRequest(raw) {
  return Boolean(raw && raw.pull_request);
}

export function labelNames(issue) {
  return issue.labels.map((l) => l.name);
}

export function hasResolution(issue) {
  if (issue.state !== 'closed') return false;
  if (issue.stateReason === 'not_planned') return false;
  if (issue.comments.some((c) => RESOLUTION_RE.test(c.body))) return true;
  if (RESOLUTION_RE.test(issue.body)) return true;
  return issue.commentCount > 0;
}

export function kbStatus(issue) {
  const names = labelNames(issue);
  if (names.includes(KB_LABELS.published)) return 'published';
  if (names.includes(KB_LABELS.candidate)) return 'candidate';
  return 'none';
}

// open      -> still unsolved
// resolved  -> closed with a recorded fix
// unresolved-> closed but nothing recorded (or not planned)
export function status(issue) {
  if (issue.state === 'open') return 'open';
  return hasResolution(issue) ? 'resolved' : 'unresolved';
}

// Review queue: anything that still needs a decision.
export function needsReview(issue) {
  const kb = kbStatus(issue);
  if (kb === 'published') return false;
  const s = status(issue);
  if (s === 'open' || s === 'unresolved') return true;
  return kb === 'none'; // resolved but not yet triaged for the KB
}

export function computeStats(issues) {
  const out = { total: issues.length, open: 0, resolved: 0, unresolved: 0, candidate: 0, published: 0, review: 0 };
  for (const i of issues) {
    out[status(i)] += 1;
    const kb = kbStatus(i);
    if (kb !== 'none') out[kb] += 1;
    if (needsReview(i)) out.review += 1;
  }
  return out;
}

export function allLabels(issues) {
  const counts = new Map();
  for (const i of issues) for (const l of i.labels) {
    const cur = counts.get(l.name) || { name: l.name, color: l.color, count: 0 };
    cur.count += 1;
    counts.set(l.name, cur);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// filters: { query, view: 'all'|'review'|'open'|'resolved'|'unresolved'|'candidate'|'published', labels: string[], sort }
export function filterIssues(issues, filters = {}) {
  const q = (filters.query || '').trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  const want = filters.labels || [];
  const view = filters.view || 'all';
  let out = issues.filter((i) => {
    if (view === 'review' && !needsReview(i)) return false;
    if (['open', 'resolved', 'unresolved'].includes(view) && status(i) !== view) return false;
    if (['candidate', 'published'].includes(view) && kbStatus(i) !== view) return false;
    const names = labelNames(i);
    if (want.length && !want.every((w) => names.includes(w))) return false;
    if (terms.length) {
      const hay = [
        '#' + i.number,
        i.title,
        i.body,
        names.join(' '),
        ...i.comments.map((c) => c.body),
      ].join('\n').toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
  const sort = filters.sort || 'updated';
  const key = {
    updated: (i) => i.updatedAt || '',
    created: (i) => i.createdAt || '',
    number: (i) => String(i.number).padStart(8, '0'),
  }[sort] || ((i) => i.updatedAt || '');
  out = out.slice().sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
  return out;
}

// Readable text color for a GitHub label hex.
export function labelTextColor(hex) {
  const h = (hex || 'cccccc').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#1b1f24' : '#ffffff';
}

export function relativeTime(iso, now = Date.now()) {
  if (!iso) return '';
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  const units = [[31536000, 'y'], [2592000, 'mo'], [86400, 'd'], [3600, 'h'], [60, 'm']];
  for (const [secs, u] of units) if (s >= secs) return Math.floor(s / secs) + u + ' ago';
  return 'just now';
}

// Fetch all issues + comments from the GitHub REST API.
// fetchImpl lets tests inject a fake; token optional for public repos.
export async function fetchIssues({ owner, repo, token, fetchImpl = fetch, concurrency = 6 }) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const get = async (url) => {
    const res = await fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}`);
    return res.json();
  };
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const raws = [];
  for (let page = 1; ; page++) {
    const batch = await get(`${base}/issues?state=all&per_page=100&page=${page}`);
    raws.push(...batch);
    if (batch.length < 100) break;
  }
  const issuesOnly = raws.filter((r) => !isPullRequest(r));
  const result = new Array(issuesOnly.length);
  let idx = 0;
  const worker = async () => {
    while (idx < issuesOnly.length) {
      const my = idx++;
      const r = issuesOnly[my];
      const comments = r.comments > 0 ? await get(`${base}/issues/${r.number}/comments?per_page=100`) : [];
      result[my] = normalizeIssue(r, comments);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, issuesOnly.length) }, worker));
  return result.sort((a, b) => b.number - a.number);
}
