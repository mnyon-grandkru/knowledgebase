import {
  KB_LABELS, normalizeIssue, status, kbStatus, needsReview, computeStats, allLabels,
  filterIssues, labelTextColor, relativeTime, fetchIssues,
} from './lib.js';

const REPO = { owner: 'mnyon-grandkru', repo: 'knowledgebase' };
const API = `https://api.github.com/repos/${REPO.owner}/${REPO.repo}`;
const TOKEN_KEY = 'kb_admin_token';

const VIEWS = [
  { id: 'review', name: 'Needs review', color: 'var(--accent)' },
  { id: 'all', name: 'All issues', color: 'var(--muted)' },
  { id: 'open', name: 'Open', color: 'var(--open)' },
  { id: 'resolved', name: 'Resolved', color: 'var(--resolved)' },
  { id: 'unresolved', name: 'Closed, no fix', color: 'var(--unresolved)' },
  { id: 'candidate', name: 'KB candidates', color: 'var(--candidate)' },
  { id: 'published', name: 'KB published', color: 'var(--published)' },
];
const STATUS_TEXT = { open: 'Open', resolved: 'Resolved', unresolved: 'No fix' };

const state = {
  issues: [],
  meta: null,
  filters: { view: 'review', query: '', labels: [], sort: 'updated' },
  visible: [],
  selected: null,
  token: readToken(),
};

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : String(kid));
  return n;
};

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
function writeToken(v) {
  try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch {}
  state.token = v;
}

function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 2500);
}

function renderMarkdown(src) {
  const box = el('div', { class: 'md' });
  if (window.marked && window.DOMPurify) {
    box.innerHTML = window.DOMPurify.sanitize(window.marked.parse(src || '', { gfm: true, breaks: true }));
    box.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  } else {
    box.append(el('pre', {}, src || ''));
  }
  if (!src) box.append(el('p', { class: 'muted' }, 'No description.'));
  return box;
}

function labelEl(l) {
  return el('span', { class: 'label', style: `background:#${l.color};color:${labelTextColor(l.color)}` }, l.name);
}

/* ---------- Sidebar ---------- */
function renderViews() {
  const stats = computeStats(state.issues);
  const counts = { review: stats.review, all: stats.total, open: stats.open, resolved: stats.resolved, unresolved: stats.unresolved, candidate: stats.candidate, published: stats.published };
  const nav = $('views');
  nav.replaceChildren(...VIEWS.map((v) => el('button', {
    class: 'view-btn', type: 'button', 'data-view': v.id, 'aria-pressed': String(state.filters.view === v.id),
    onclick: () => { state.filters.view = v.id; update(); },
  }, el('span', {}, el('span', { class: 'dot', style: `background:${v.color}` }), v.name), el('span', { class: 'count' }, counts[v.id]))));
}

function renderLabels() {
  const box = $('labels');
  box.replaceChildren(...allLabels(state.issues).map((l) => {
    const on = state.filters.labels.includes(l.name);
    return el('button', {
      class: 'chip', type: 'button', 'aria-pressed': String(on), 'data-label': l.name,
      style: `background:#${l.color};color:${labelTextColor(l.color)}`,
      onclick: () => {
        const f = state.filters.labels;
        state.filters.labels = on ? f.filter((x) => x !== l.name) : [...f, l.name];
        update();
      },
    }, l.name, el('span', { class: 'n' }, l.count));
  }));
}

/* ---------- List ---------- */
function renderList() {
  state.visible = filterIssues(state.issues, state.filters);
  $('result-count').textContent = `${state.visible.length} of ${state.issues.length}`;
  const list = $('list');
  if (!state.visible.length) {
    list.replaceChildren(el('li', { class: 'issue-row' }, el('span'), el('span', { class: 'muted' }, 'Nothing matches these filters.')));
    return;
  }
  list.replaceChildren(...state.visible.map((i) => {
    const s = status(i), kb = kbStatus(i);
    return el('li', {
      class: 'issue-row', 'data-number': i.number, 'aria-selected': String(state.selected === i.number),
      onclick: () => select(i.number, true),
    },
      el('span', { class: 'num' }, '#' + i.number),
      el('span', { class: 'title' }, i.title),
      el('span', { class: 'meta' },
        el('span', { class: `pill ${s}` }, STATUS_TEXT[s]),
        kb !== 'none' && el('span', { class: `pill ${kb}` }, kb === 'published' ? 'KB' : 'KB?'),
        i.labels.filter((l) => !l.name.startsWith('kb:')).slice(0, 3).map(labelEl),
        el('span', {}, `💬 ${i.commentCount}`),
        el('span', { title: i.updatedAt }, relativeTime(i.updatedAt)),
      ));
  }));
}

/* ---------- Detail ---------- */
function current() { return state.issues.find((i) => i.number === state.selected) || null; }

function renderDetail() {
  const pane = $('detail');
  const i = current();
  if (!i) {
    pane.replaceChildren(el('div', { class: 'empty' },
      el('p', {}, 'Select an issue to review.'),
      el('p', { class: 'muted keys' }, 'j/k move · / search · c KB candidate · p publish · o open on GitHub')));
    return;
  }
  const s = status(i), kb = kbStatus(i), canWrite = Boolean(state.token);
  const btn = (label, fn, opts = {}) => el('button', {
    class: 'btn ' + (opts.cls || ''), type: 'button', disabled: !canWrite && !opts.always, 'data-action': opts.id,
    title: !canWrite && !opts.always ? 'Add a GitHub token to enable' : null, onclick: fn,
  }, label);

  pane.replaceChildren(...[
    el('button', { class: 'btn ghost back', type: 'button', onclick: () => showList() }, '← Back'),
    el('header', { class: 'detail-head' },
      el('span', { class: 'num' }, `#${i.number}`),
      el('h2', {}, i.title),
      el('div', { class: 'detail-meta' },
        el('span', { class: `pill ${s}` }, STATUS_TEXT[s]),
        kb !== 'none' && el('span', { class: `pill ${kb}` }, kb === 'published' ? 'KB published' : 'KB candidate'),
        el('span', {}, `opened ${relativeTime(i.createdAt)} by ${i.author || 'unknown'}`),
        i.closedAt && el('span', {}, `closed ${relativeTime(i.closedAt)}`),
        i.labels.map(labelEl),
      )),
    el('div', { class: 'actions' },
      btn('Open on GitHub', () => window.open(i.url, '_blank', 'noopener'), { always: true, cls: 'ghost', id: 'open' }),
      kb === 'candidate'
        ? btn('Publish to KB', () => setKb(i, 'published'), { cls: 'primary', id: 'publish' })
        : kb === 'none'
          ? btn('Mark KB candidate', () => setKb(i, 'candidate'), { cls: 'primary', id: 'candidate' })
          : btn('Unpublish', () => setKb(i, 'candidate'), { id: 'unpublish' }),
      kb !== 'none' && btn('Remove from KB', () => setKb(i, 'none'), { cls: 'ghost', id: 'remove-kb' }),
      i.state === 'open'
        ? btn('Close as resolved', () => setState(i, 'closed', 'completed'), { id: 'close' })
        : btn('Reopen', () => setState(i, 'open'), { cls: 'ghost', id: 'reopen' }),
      i.state === 'open' && btn('Close: not planned', () => setState(i, 'closed', 'not_planned'), { cls: 'ghost danger', id: 'close-np' }),
      !canWrite && el('span', { class: 'hint' }, 'Read-only. Add a token to act on issues.'),
    ),
    el('section', { class: 'post' },
      el('div', { class: 'post-head' }, el('span', {}, `${i.author || 'unknown'} · ${new Date(i.createdAt).toLocaleString()}`)),
      renderMarkdown(i.body)),
    i.comments.map((c) => el('section', { class: 'post' },
      el('div', { class: 'post-head' },
        el('span', {}, `${c.author || 'unknown'} · ${new Date(c.createdAt).toLocaleString()}`),
        c.url && el('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer' }, 'link')),
      renderMarkdown(c.body))),
    i.commentCount > i.comments.length && el('p', { class: 'muted' }, `${i.commentCount - i.comments.length} more comment(s) on GitHub.`),
    canWrite && el('form', { class: 'comment-form', onsubmit: (e) => { e.preventDefault(); addComment(i, e.target.elements.body); } },
      el('label', { class: 'sr-only', for: 'comment-body' }, 'Add a comment'),
      el('textarea', { id: 'comment-body', name: 'body', placeholder: 'Record the fix or a note (Markdown)…' }),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'submit' }, 'Comment'))),
  ].flat().filter(Boolean));
  pane.scrollTop = 0;
}

function select(n, fromClick = false) {
  state.selected = n;
  try { history.replaceState(null, '', '#' + n); } catch {}
  document.querySelectorAll('.issue-row').forEach((r) => r.setAttribute('aria-selected', String(Number(r.dataset.number) === n)));
  const row = document.querySelector(`.issue-row[data-number="${n}"]`);
  if (row && !fromClick) row.scrollIntoView({ block: 'nearest' });
  renderDetail();
  if (fromClick) $('layout').classList.add('show-detail');
}
function showList() { $('layout').classList.remove('show-detail'); }

function update() {
  renderViews();
  renderLabels();
  renderList();
  renderDetail();
}

/* ---------- GitHub writes ---------- */
async function gh(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    try { msg = (await res.json()).message || msg; } catch {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

async function run(label, fn) {
  try { await fn(); toast(label); update(); }
  catch (e) { toast('GitHub: ' + e.message, true); }
}

function setKb(issue, target) {
  const keep = issue.labels.map((l) => l.name).filter((n) => n !== KB_LABELS.candidate && n !== KB_LABELS.published);
  if (target !== 'none') keep.push(KB_LABELS[target]);
  return run(target === 'none' ? 'Removed from KB' : target === 'published' ? 'Published to KB' : 'Marked KB candidate', async () => {
    const labels = await gh('PUT', `/issues/${issue.number}/labels`, { labels: keep });
    issue.labels = labels.map((l) => ({ name: l.name, color: l.color }));
    issue.updatedAt = new Date().toISOString();
  });
}

function setState(issue, newState, reason) {
  return run(newState === 'open' ? 'Reopened' : 'Closed', async () => {
    const raw = await gh('PATCH', `/issues/${issue.number}`, reason ? { state: newState, state_reason: reason } : { state: newState });
    Object.assign(issue, normalizeIssue(raw, []), { comments: issue.comments });
  });
}

function addComment(issue, textarea) {
  const body = textarea.value.trim();
  if (!body) return;
  return run('Comment added', async () => {
    const c = await gh('POST', `/issues/${issue.number}/comments`, { body });
    issue.comments.push({ author: c.user && c.user.login, createdAt: c.created_at, body: c.body, url: c.html_url });
    issue.commentCount += 1;
    issue.updatedAt = c.created_at;
  });
}

async function refreshLive() {
  const btn = $('refresh-btn');
  btn.disabled = true; btn.textContent = 'Refreshing…';
  try {
    state.issues = await fetchIssues({ ...REPO, token: state.token });
    state.meta = { generatedAt: new Date().toISOString(), live: true };
    renderMeta();
    update();
    toast(`Loaded ${state.issues.length} issues live`);
  } catch (e) {
    toast('Refresh failed: ' + e.message + (state.token ? '' : ' (add a token to raise the rate limit)'), true);
  } finally {
    btn.disabled = false; btn.textContent = 'Refresh';
  }
}

/* ---------- Boot ---------- */
function renderMeta() {
  const m = state.meta;
  $('snapshot-meta').textContent = m
    ? `${REPO.owner}/${REPO.repo} · ${m.live ? 'live' : 'snapshot'} ${relativeTime(m.generatedAt)}${state.token ? ' · write enabled' : ' · read-only'}`
    : `${REPO.owner}/${REPO.repo}`;
}

function bindUi() {
  const search = $('search');
  let t;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.filters.query = search.value; update(); }, 120); });
  $('sort').addEventListener('change', (e) => { state.filters.sort = e.target.value; update(); });
  $('clear-labels').addEventListener('click', () => { state.filters.labels = []; update(); });
  $('refresh-btn').addEventListener('click', refreshLive);

  const dlg = $('settings');
  $('settings-btn').addEventListener('click', () => {
    $('token-input').value = '';
    $('token-status').textContent = state.token ? 'A token is saved in this browser.' : 'No token saved.';
    dlg.showModal();
  });
  $('token-save').addEventListener('click', () => {
    const v = $('token-input').value.trim();
    if (!v) return;
    writeToken(v); renderMeta(); update(); dlg.close(); toast('Token saved');
  });
  $('token-clear').addEventListener('click', () => { writeToken(''); renderMeta(); update(); dlg.close(); toast('Token removed'); });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || dlg.open;
    if (e.key === 'Escape' && document.activeElement === search) { search.blur(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const idx = state.visible.findIndex((i) => i.number === state.selected);
    const i = current();
    if (e.key === '/') { e.preventDefault(); search.focus(); }
    else if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); const n = state.visible[Math.min(idx + 1, state.visible.length - 1)]; if (n) select(n.number); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); const n = state.visible[Math.max(idx - 1, 0)]; if (n) select(n.number); }
    else if (e.key === 'o' && i) window.open(i.url, '_blank', 'noopener');
    else if (e.key === 'c' && i && state.token && kbStatus(i) === 'none') setKb(i, 'candidate');
    else if (e.key === 'p' && i && state.token && kbStatus(i) !== 'published') setKb(i, 'published');
  });
}

async function boot() {
  bindUi();
  try {
    const res = await fetch('data/issues.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('snapshot ' + res.status);
    const data = await res.json();
    state.issues = data.issues;
    state.meta = { generatedAt: data.generatedAt, live: false };
  } catch (e) {
    toast('Snapshot unavailable, loading live…', true);
    await refreshLive();
  }
  renderMeta();
  const fromHash = Number(location.hash.slice(1));
  if (fromHash && state.issues.some((i) => i.number === fromHash)) {
    state.selected = fromHash;
    if (!filterIssues(state.issues, state.filters).some((i) => i.number === fromHash)) state.filters.view = 'all';
  }
  update();
  document.body.dataset.ready = 'true';
}

// Re-render markdown once the deferred CDN libs arrive.
window.addEventListener('load', () => { if (state.selected) renderDetail(); });
boot();

export { state, needsReview };
