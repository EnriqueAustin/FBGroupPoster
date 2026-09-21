/**
 * Local control panel. No framework and no build step — single user, localhost,
 * a bundler would be pure overhead.
 */

// ---------------------------------------------------------------- helpers ---

const api = async (method, url, body) => {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    // "Invalid body" on its own is useless — it was the message shown when a
    // round gap was saved with min above max, which looked exactly like the
    // save silently doing nothing. The server sends {field: [messages]}; say it.
    const detail = data?.details && typeof data.details === 'object'
      ? Object.entries(data.details)
        .map(([k, v]) => `${k === '_' ? '' : `${k}: `}${[].concat(v).join(', ')}`)
        .join(' · ')
      : '';
    throw new Error([data?.error ?? `${res.status} ${res.statusText}`, detail]
      .filter(Boolean).join(' — '));
  }
  return data;
};
const get = (u) => api('GET', u);
const post = (u, b) => api('POST', u, b);
const patch = (u, b) => api('PATCH', u, b);
const put = (u, b) => api('PUT', u, b);

const el = (tag, props = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') || k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of kids.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
};

// ------------------------------------------------------------------ icons ---

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="m10 8.5 5 3.5-5 3.5z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  ok: '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>',
  arrow: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3-3L5 21"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  pointer: '<path d="m4 4 7 17 2.5-7.5L21 11Z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  rotate: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>',
  forward: '<path d="m13 17 5-5-5-5M6 17l5-5-5-5"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7l10-5z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
};
const icon = (name, cls = 'i') => {
  const span = document.createElement('span');
  span.innerHTML = `<svg class="${cls}" viewBox="0 0 24 24">${ICONS[name] ?? ''}</svg>`;
  return span.firstChild;
};
for (const node of document.querySelectorAll('[data-icon]')) node.append(icon(node.dataset.icon));

// ------------------------------------------------------------- components ---

/**
 * Button with a built-in busy state. While its handler runs the button is
 * disabled and shows a spinner, so a slow request cannot be double-submitted
 * and a click that is still working never looks like a click that did nothing.
 */
const btn = (label, onClick, opts = {}) => {
  const b = el('button', {
    class: `btn ${opts.kind ?? ''} ${opts.size ?? ''} ${label ? '' : 'icon'}`.trim(),
    type: opts.type ?? 'button',
    disabled: !!opts.disabled,
    title: opts.title,
  }, opts.icon ? icon(opts.icon) : null, label || null);
  if (onClick) {
    b.onclick = async (e) => {
      if (b.disabled) return;
      b.disabled = true;
      b.classList.add('busy');
      try { await onClick(e); } catch (err) { showError(err); } finally {
        if (b.isConnected) { b.disabled = !!opts.disabled; b.classList.remove('busy'); }
      }
    };
  }
  return b;
};

/** Standard card: header with title, optional subtitle and trailing controls. */
const card = (title, opts = {}, ...body) => {
  const head = title === null ? null : el('header', {},
    opts.icon ? icon(opts.icon) : null,
    el('h2', {}, title),
    opts.sub ? el('span', { class: 'sub' }, opts.sub) : null,
    opts.actions ? el('span', { class: 'spacer' }) : null,
    ...(opts.actions ?? []),
  );
  return el('section', { class: `card ${opts.class ?? ''}`.trim() }, head,
    el('div', { class: `body${opts.flush ? ' flush' : ''}` }, ...body));
};

const pageHead = (title, desc, ...actions) => el('div', { class: 'page-head' },
  el('div', {}, el('h1', {}, title), desc ? el('p', {}, desc) : null),
  actions.length ? el('div', { class: 'actions' }, ...actions) : null);

const field = (label, control, note) => el('label', { class: 'field' },
  el('span', {}, label), control, note ? el('div', { class: 'note' }, note) : null);

const callout = (kind, title, text, ...acts) => el('div', { class: `banner ${kind}` },
  icon({ info: 'info', warn: 'alert', bad: 'alert', ok: 'ok' }[kind] ?? 'info'),
  el('div', { class: 'txt' }, title ? el('strong', {}, title) : null, text ? el('p', {}, text) : null),
  acts.length ? el('div', { class: 'acts' }, ...acts) : null);

const toggle = (checked, onchange, label) => {
  const input = el('input', { type: 'checkbox', checked });
  const wrap = el('label', { class: 'switch' }, input, el('span', { class: 'track' }),
    label ? el('span', { class: 'lbl' }, label) : null);
  input.onchange = async () => {
    input.disabled = true;
    try { await onchange(input.checked); } catch (e) { input.checked = !input.checked; showError(e); }
    finally { input.disabled = false; }
  };
  return wrap;
};

const empty = (ic, title, text, ...acts) => el('div', { class: 'empty' },
  el('div', { class: 'ic' }, icon(ic)), el('b', {}, title), text ? el('div', {}, text) : null,
  acts.length ? el('div', { class: 'row' }, ...acts) : null);

const select = (value, options, onchange, attrs = {}) => {
  const s = el('select', { ...attrs, onchange: (e) => onchange(e.target.value) });
  for (const [v, t] of options) s.append(el('option', { value: v, selected: String(v) === String(value) }, t));
  return s;
};

const fmtTime = (iso) => new Date(iso).toLocaleString(undefined, {
  weekday: 'short', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short',
});
const fmtClock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const relTime = (iso) => {
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  const abs = Math.abs(mins);
  const txt = abs < 60 ? `${abs} min` : abs < 1440 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} d`;
  return mins >= 0 ? `in ${txt}` : `${txt} ago`;
};

/** Uploaded images are stored as data/media/<file> and served at /media/<file>. */
const mediaUrl = (p) => `/media/${String(p).split(/[\\/]/).pop()}`;

const AVATAR_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];
const avatar = (name, id) => el('span', {
  class: 'avatar', style: `background:${AVATAR_COLORS[id % AVATAR_COLORS.length]}`,
}, (name.trim()[0] ?? '?').toUpperCase());

const view = document.getElementById('view');

// ----------------------------------------------------------------- toasts ---

/**
 * Show the result of an action, pinned to the viewport rather than to the page.
 *
 * Settings and Queue are long and their buttons sit at the bottom, so a banner
 * at the top of the view was off-screen: a save the server had REFUSED looked
 * exactly like a save that did nothing. Errors stay until dismissed (or until
 * you move to another screen, where they would describe something no longer
 * visible); successes clear themselves.
 */
const toastHost = el('div', { class: 'toasts' });
document.body.append(toastHost);

const flash = (msg, kind = 'bad') => {
  if (kind === 'bad') toastHost.querySelectorAll('.toast.bad').forEach((n) => n.remove());
  const t = el('div', { class: `toast ${kind}`, role: kind === 'bad' ? 'alert' : 'status' },
    icon(kind === 'bad' ? 'alert' : kind === 'ok' ? 'ok' : 'info'),
    el('div', { class: 'txt' }, msg),
    el('button', { title: 'Dismiss', onclick: () => t.remove() }, icon('x')));
  toastHost.append(t);
  if (kind !== 'bad') setTimeout(() => t.remove(), 3500);
};
const showError = (err) => flash(err?.message ?? String(err));

/**
 * replaceChildren() stringifies null into a literal "null" text node, unlike
 * el() which skips it. Conditional sections are common here, so route every
 * top-level render through this.
 */
const mount = (...nodes) => {
  view.replaceChildren(...nodes.flat().filter((n) => n !== null && n !== undefined && n !== false));
};

// ---------------------------------------------------------------- dialogs ---

/**
 * Styled replacement for confirm()/prompt(). Resolves with the pressed action's
 * value (or null when dismissed). Kept separate from the posting review modal,
 * which is driven by the job poller and must never be closed by one of these.
 */
function dialog({ title, text, body, actions, wide = false, onOpen }) {
  return new Promise((resolve) => {
    const back = el('div', { class: 'modal-back' });
    const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    back.onclick = (e) => { if (e.target === back) close(null); };

    const footer = el('footer', {}, ...actions.map((a) => {
      const b = btn(a.label, async () => {
        if (a.run) { const ok = await a.run(); if (ok === false) return; }
        close(a.value);
      }, { kind: a.kind ?? (a.value ? '' : 'secondary'), icon: a.icon });
      if (a.submit) b.dataset.submit = '1';
      return b;
    }));
    const box = el('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog' },
      el('header', {}, el('h2', {}, title), text ? el('p', {}, text) : null),
      body ? el('div', { class: 'body' }, body) : null,
      footer);
    back.append(box);
    document.body.append(back);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        e.preventDefault();
        footer.querySelector('[data-submit]')?.click();
      }
    });
    onOpen?.(box);
    // Destructive confirmations focus Cancel, so a reflexive Enter is harmless.
    const last = actions[actions.length - 1];
    (box.querySelector('input, textarea, select')
      ?? (/danger/.test(last?.kind ?? '') ? footer.firstChild : footer.lastChild))?.focus();
  });
}

const confirmDialog = (title, text, okLabel = 'Confirm', kind = '') => dialog({
  title, text,
  actions: [{ label: 'Cancel', value: null }, { label: okLabel, value: true, kind, submit: true }],
});

async function promptDialog(title, label, value = '') {
  const input = el('input', { type: 'text', value });
  const ok = await dialog({
    title, body: field(label, input),
    actions: [{ label: 'Cancel', value: null },
      { label: 'Save', value: true, submit: true, run: () => input.value.trim() !== '' }],
  });
  return ok ? input.value.trim() : null;
}

// ------------------------------------------------------------------ state ---

const state = {
  businesses: [], groups: [], ads: [], settings: null, counts: {},
  nextDueAt: null, round: null, assignments: new Map(),
};

async function refreshCore() {
  const [businesses, groups, ads, summary] = await Promise.all([
    get('/api/businesses'), get('/api/groups'), get('/api/ads'), get('/api/summary'),
  ]);
  Object.assign(state, {
    businesses, groups, ads,
    settings: summary.settings, counts: summary.counts, nextDueAt: summary.nextDueAt ?? null,
    round: summary.round ?? null,
  });
  applyAssignments();

  document.getElementById('c-groups').textContent = summary.counts.groupsActive || '';
  document.getElementById('c-ads').textContent = summary.counts.ads || '';
  document.getElementById('c-queue').textContent = summary.counts.queuePending || '';
  const mode = summary.settings.defaultRunnerMode;
  document.getElementById('foot-mode').replaceChildren(
    el('span', { class: `tag ${mode === 'auto' ? 'bad' : 'accent'}` }, icon(mode === 'auto' ? 'zap' : 'pointer'), mode),
    el('span', { class: 'dim' }, `cap ${summary.settings.dailyCap}/day`));

  const bar = document.getElementById('breaker');
  bar.hidden = !summary.settings.breakerTripped;
  if (summary.settings.breakerTripped) {
    document.getElementById('breaker-reason').textContent =
      `${summary.settings.breakerReason ?? 'No reason recorded'}. ` +
      'Check in Facebook that the account is not restricted before clearing it.';
  }
}

/** Groups do not carry their assignments, so fold them in for display. */
async function hydrateAssignments() {
  const lists = await Promise.all(state.businesses.map((b) =>
    get(`/api/businesses/${b.id}/assignments`).then((ids) => [b.id, ids])));
  state.assignments = new Map(lists.map(([id, ids]) => [id, new Set(ids)]));
  applyAssignments();
}

/**
 * refreshCore() replaces state.groups with fresh objects; re-fold the last
 * known assignments into them so a row save cannot blank every business chip
 * and break the business filter until the next full load.
 */
function applyAssignments() {
  for (const g of state.groups) {
    g._businesses = [...state.assignments.entries()].filter(([, ids]) => ids.has(g.id)).map(([id]) => id);
  }
}

const nameOf = (id, list) => list.find((x) => x.id === id)?.name ?? `#${id}`;
/** "V2" — the same numbering the Ads screen shows, rather than a database id. */
const variantLabel = (variantId) => {
  for (const ad of state.ads) {
    const i = (ad.variants ?? []).findIndex((v) => v.id === variantId);
    if (i >= 0) return `V${i + 1}`;
  }
  return `#${variantId}`;
};
const activeVariants = (ad) => (ad.variants ?? []).filter((v) => v.active);

document.getElementById('clear-breaker').onclick = async () => {
  const ok = await confirmDialog('Clear the circuit breaker?',
    'Only do this once you have checked in Facebook that the account is not restricted. ' +
    'Posting resumes on the next run.', 'Clear breaker', 'danger');
  if (!ok) return;
  try { await post('/api/breaker/clear', {}); await refreshCore(); await render(); flash('Breaker cleared.', 'ok'); }
  catch (e) { showError(e); }
};

// ------------------------------------------------------------------- jobs ---

let jobTimer = null;
let modalOpen = false;

const modalRoot = document.getElementById('modal-root');
const closeModal = () => { modalRoot.replaceChildren(); modalOpen = false; };

/**
 * Assisted posting blocks here. The caption and the group's own rules are shown
 * together because "does this group allow this" is the decision being made, and
 * it is the one thing the tool cannot judge for you.
 */
function openReviewModal(job) {
  if (modalOpen) return;
  modalOpen = true;
  const p = job.awaiting;
  const c = p.context ?? {};
  const isSignIn = c.kind === 'sign-in';

  const buttons = p.options.map((o, i) => el('button', {
    class: (o.value === 'cancel' || o.value === 'q') ? 'btn danger-outline' : i === 0 ? 'btn big' : 'btn secondary',
    onclick: async () => {
      closeModal();
      try { await post(`/api/jobs/${job.id}/respond`, { answer: o.value }); } catch (e) { showError(e); }
    },
  }, o.label));
  // Primary answer last, where the eye finishes.
  buttons.reverse();

  const body = isSignIn
    ? el('div', { class: 'body' },
      el('p', {}, p.question),
      callout('info', 'Take your time.', 'Nothing is running while this is open, and the browser will not close.'),
      el('p', { class: 'hint' },
        'Press continue only once you can see your normal Facebook feed — not the code screen. ' +
        'This app never sees your password; you type it into Chrome yourself.'))
    : el('div', { class: 'body' },
      c.rulesNotes ? callout('warn', 'Group rules', c.rulesNotes) : null,
      el('div', { class: 'row', style: 'margin-bottom:8px' },
        el('strong', {}, c.adName ?? 'Post'),
        c.images ? el('span', { class: 'tag' }, icon('image'), plural(c.images, 'image')) : null,
        el('span', { class: 'spacer' }),
        c.groupUrl ? el('a', { href: c.groupUrl, target: '_blank', rel: 'noreferrer', class: 'row small' },
          'Open the group', icon('external')) : null),
      el('div', { class: 'preview' }, c.caption ?? ''),
      el('p', { class: 'hint' },
        'The post is already composed in the browser window. Check it there, click Post yourself, ' +
        'then tell me what happened — the answer is what the cooldowns are built from, so it has ' +
        'to be accurate.'));

  modalRoot.replaceChildren(el('div', { class: 'modal-back' },
    el('div', { class: 'modal', role: 'dialog' },
      el('header', {},
        el('h2', {}, isSignIn ? 'Waiting for you to sign in' : (c.groupName ?? 'Ready to post')),
        isSignIn ? null : el('p', {}, p.question)),
      body,
      el('footer', {}, ...buttons))));
}

function setFootJob(job) {
  const foot = document.getElementById('foot-job');
  foot.replaceChildren(
    el('span', { class: `dot ${job ? (job.awaiting ? 'bad' : 'live') : ''}` }),
    el('span', {}, !job ? 'Idle' : job.awaiting ? 'Waiting for you' : job.kind === 'bootstrap' ? 'Importing groups…' : 'Posting run active'));
  foot.style.cursor = job ? 'pointer' : '';
  foot.onclick = job ? () => go('setup') : null;
}

async function pollJob() {
  let job = null;
  try { job = await get('/api/jobs/current'); } catch { /* server restarting */ }

  const console_ = document.getElementById('job-console');
  if (console_ && job) {
    const atBottom = console_.scrollHeight - console_.scrollTop - console_.clientHeight < 40;
    console_.textContent = job.lines.join('\n');
    if (atBottom) console_.scrollTop = console_.scrollHeight;
  }
  const status = document.getElementById('job-status');
  if (status) status.replaceChildren(jobStatusNode(job));
  setFootJob(job);

  if (job?.awaiting) openReviewModal(job);
  else if (!job && modalOpen) closeModal();

  if (!job && jobTimer) {
    clearInterval(jobTimer); jobTimer = null;
    await refreshCore();
    // Never throw away unsaved edits on Safety just because a run finished.
    if (!settingsDirty()) await render();
  }
}

const startPolling = () => { if (!jobTimer) jobTimer = setInterval(pollJob, 1500); };

function jobStatusNode(job) {
  if (!job) return el('span', { class: 'row small dim' }, el('span', { class: 'dot' }), 'Idle');
  return el('span', { class: 'row' },
    el('span', { class: `pill ${job.awaiting ? 'waiting' : job.status}` }, job.awaiting ? 'waiting for you' : job.status),
    el('span', { class: 'muted small' }, job.kind === 'bootstrap' ? 'Importing groups' : 'Posting run'),
    btn('Stop', () => post(`/api/jobs/${job.id}/cancel`, {}), { kind: 'danger-outline', size: 'sm', icon: 'stop' }),
  );
}

async function startJob(url, body) {
  await post(url, body ?? {});
  startPolling();
  await pollJob();
}

const activityCard = (job) => card('Activity', {
  sub: 'Live output from the browser',
  actions: [el('span', { id: 'job-status' }, jobStatusNode(job))],
}, el('pre', { class: 'console', id: 'job-console' }, job ? job.lines.join('\n') : ''));

// -------------------------------------------------------------- dashboard ---

/**
 * The checklist reflects what posting actually needs, per business — a global
 * "two ads exist" tick used to pass while one business had none at all.
 */
function setupSteps() {
  const c = state.counts;
  const activeBiz = state.businesses.filter((b) => b.active);
  const shortBiz = activeBiz.map((b) => {
    const ads = state.ads.filter((a) => a.businessId === b.id && a.active);
    const thin = ads.filter((a) => activeVariants(a).length < 3);
    return { b, ads: ads.length, thin: thin.length };
  }).filter((x) => x.ads < 2 || x.thin > 0);
  const assignedActive = state.groups.filter((g) => g.active
    && (g._businesses ?? []).some((id) => activeBiz.some((b) => b.id === id))).length;

  return [
    { t: 'Import your groups', d: c.groupsTotal ? `${c.groupsTotal} groups in the registry.` : 'Reads the groups you belong to. Nothing is posted.',
      done: c.groupsTotal > 0, to: 'setup' },
    { t: 'Add a business', d: c.businesses ? `${plural(c.businesses, 'business', 'businesses')} set up.` : 'Every ad belongs to a business.',
      done: activeBiz.length > 0, to: 'ads' },
    { t: 'Write ads and caption variants',
      d: activeBiz.length === 0 ? 'At least two ads per business, three variants each.'
        : shortBiz.length === 0 ? 'Every business has enough ads and variants.'
          : shortBiz.map(({ b, ads, thin }) => ads < 2
            ? `${b.name} needs ${plural(2 - ads, 'more ad')}` : `${b.name}: ${plural(thin, 'ad')} under 3 variants`).join(' · '),
      done: activeBiz.length > 0 && shortBiz.length === 0, to: 'ads' },
    { t: 'Assign and switch on groups',
      d: assignedActive ? `${plural(assignedActive, 'active group')} assigned to a business.` : 'Groups arrive inactive on purpose. Pick a business for each.',
      done: assignedActive > 0, to: 'groups' },
    { t: 'Dry-run and commit a plan', d: 'Read the schedule and the exclusions before queueing anything.',
      done: c.queuePending > 0 || c.postedAllTime > 0, to: 'plan' },
    { t: 'Make your first post', d: 'Start with one, then read the log.', done: c.postedAllTime > 0, to: 'setup' },
  ];
}

async function viewDashboard() {
  await hydrateAssignments();
  const c = state.counts, s = state.settings;
  // Two things bound how often a group hears from you, and the SLOWER wins:
  // how long the daily cap takes to work through every group, and the cooldown.
  const capCycle = c.groupsActive / Math.max(1, s.dailyCap);
  const cycle = c.groupsActive ? Math.max(capCycle, s.perGroupCooldownDays) : 0;
  const weekly = c.groupsActive
    ? Math.min(s.dailyCap * 7, Math.round(c.groupsActive * 7 / Math.max(1, s.perGroupCooldownDays))) : 0;

  const steps = setupSteps();
  const doneCount = steps.filter((x) => x.done).length;
  const nowIdx = steps.findIndex((x) => !x.done);

  const stat = (value, label, ic, to, extra) => el('button', { class: 'stat', onclick: () => go(to) },
    el('div', { class: 'top' }, label, el('span', { class: 'ic' }, icon(ic))),
    el('b', {}, value, extra ? el('small', {}, extra) : null));

  let hero;
  if (s.breakerTripped) {
    hero = null; // the breaker banner above already says it, louder
  } else if (c.queueDueNow > 0) {
    hero = heroCard('Ready', `${plural(c.queueDueNow, 'post')} due now`,
      'Start a run from Setup & Run.', btn('Go to Setup & Run', () => go('setup'), { icon: 'arrow' }));
  } else if (state.nextDueAt) {
    hero = heroCard('Next post', `${fmtTime(state.nextDueAt)} · ${relTime(state.nextDueAt)}`,
      `${plural(c.queuePending, 'post')} queued. Nothing is due yet.`,
      btn('View queue', () => go('queue'), { kind: 'secondary', icon: 'list' }));
  } else if (nowIdx >= 0) {
    const nx = steps[nowIdx];
    hero = heroCard(`Step ${nowIdx + 1} of ${steps.length}`, nx.t, nx.d, btn('Continue', () => go(nx.to), { icon: 'arrow' }));
  }

  mount(
    pageHead('Dashboard', 'What the tool will do on your account, and what still needs setting up.'),
    hero,
    el('div', { class: 'statgrid' },
      stat(c.groupsActive, 'Active groups', 'users', 'groups', ` / ${c.groupsTotal}`),
      stat(c.businesses, 'Businesses', 'layers', 'ads'),
      stat(c.ads, 'Ads', 'megaphone', 'ads'),
      stat(c.queuePending, 'Queued', 'clock', 'queue', c.queueDueNow ? ` · ${c.queueDueNow} due` : ''),
      stat(c.postedAllTime, 'Posted all-time', 'send', 'queue'),
    ),
    el('div', { class: 'grid-2' },
      card('Getting set up', {
        sub: `${doneCount} of ${steps.length} done`,
      },
        el('div', { class: 'progress', style: 'margin-bottom:12px' }, el('i', { style: `width:${(doneCount / steps.length) * 100}%` })),
        el('div', { class: 'steps' }, steps.map((st, i) =>
          el('button', { class: `step ${st.done ? 'done' : i === nowIdx ? 'now' : ''}`, onclick: () => go(st.to) },
            el('div', { class: 'n' }, st.done ? icon('check') : String(i + 1)),
            el('div', { class: 't' }, el('b', {}, st.t), el('span', {}, st.d)),
            el('span', { class: 'go' }, icon('arrow')))))),
      card('What your settings mean in practice', {}, c.groupsActive === 0
        ? empty('clock', 'No cadence yet', 'Switch on some groups and this will tell you how often each one hears from you.',
          btn('Open Groups', () => go('groups'), { kind: 'secondary' }))
        : el('div', {},
          el('div', { class: 'row gap4', style: 'margin-bottom:16px' },
            el('div', {}, el('div', { class: 'dim small' }, 'Each group hears from you every'),
              el('div', { style: 'font-size:24px;font-weight:680;letter-spacing:-.02em' }, `${cycle.toFixed(1)} days`)),
            el('div', {}, el('div', { class: 'dim small' }, 'Posts per week'),
              el('div', { style: 'font-size:24px;font-weight:680;letter-spacing:-.02em' }, `≈ ${weekly}`))),
          el('p', { class: 'hint' },
            `Set by ${capCycle > s.perGroupCooldownDays ? 'the daily cap' : 'the per-group cooldown'}. ` +
            `Your ${s.dailyCap}/day cap is a ceiling, not a target; you will normally sit under it because ` +
            'the cooldown runs out of eligible groups first.'),
          capCycle < s.perGroupCooldownDays ? el('p', { class: 'hint' },
            `To actually use ${s.dailyCap} posts a day you would need about ` +
            `${s.dailyCap * s.perGroupCooldownDays} active groups. Joining more groups raises reach; ` +
            'raising the cap raises risk.') : null,
        )),
    ),
  );
}

const heroCard = (eyebrow, title, text, ...acts) => el('div', { class: 'hero' },
  el('div', {}, el('div', { class: 'eyebrow' }, eyebrow), el('div', { class: 'title' }, title),
    text ? el('div', { class: 'muted small' }, text) : null),
  el('span', { class: 'spacer' }), ...acts);

// ------------------------------------------------------------------ setup ---

async function viewSetup() {
  const job = await get('/api/jobs/current').catch(() => null);
  if (job) startPolling();
  const s = state.settings, c = state.counts;
  const due = c.queueDueNow ?? 0, queued = c.queuePending ?? 0;

  const bigNum = (n, label) => el('div', {},
    el('div', { style: 'font-size:30px;font-weight:700;letter-spacing:-.03em;line-height:1.1' }, String(n)),
    el('div', { class: 'dim small' }, label));

  mount(
    pageHead('Setup & Run', 'Everything that drives the browser. Chrome opens on its own profile — ' +
      'you sign in there once, and this app never sees your password.'),

    el('div', { class: 'grid-2', style: 'margin-bottom:16px' },
      card('Import your groups', { icon: 'download', sub: 'Safe to re-run' },
        el('p', { class: 'hint' },
          'Opens Chrome and reads the list of groups you belong to. Nothing is posted, and your ' +
          'curation (active, composer, rules, businesses) is kept. It waits up to 10 minutes for you to sign in, including 2FA.'),
        el('div', { class: 'row gap3 mt4' },
          btn('Import groups from Facebook', () => startJob('/api/jobs/bootstrap'),
            { icon: 'download', kind: c.groupsTotal ? 'secondary' : '', disabled: !!job }),
          el('span', { class: 'dim small' }, `${plural(c.groupsTotal, 'group')} in the registry`))),

      card('Start a posting run', {
        icon: 'send',
        actions: [el('span', { class: `tag ${s.defaultRunnerMode === 'auto' ? 'bad' : 'accent'}` },
          icon(s.defaultRunnerMode === 'auto' ? 'zap' : 'pointer'),
          s.defaultRunnerMode === 'auto' ? 'Auto — clicks Post itself' : 'Assisted — you click Post')],
      },
        s.breakerTripped ? callout('bad', 'Blocked.', 'Clear the circuit breaker first.') : null,

        // Pending and due-now are different. A run only touches what is DUE, so
        // showing the pending total alone made a correct "nothing to do" look
        // like a failure.
        el('div', { class: 'row', style: 'gap:40px' }, bigNum(due, 'due now'), bigNum(queued, 'queued in total')),

        queued === 0
          ? callout('info', 'Nothing queued.', 'Build and commit a plan first.',
            btn('Open Plan', () => go('plan'), { kind: 'secondary', size: 'sm' }))
          : due === 0
            ? el('div', { class: 'mt4' }, callout('info',
              state.nextDueAt ? `Next post ${fmtTime(state.nextDueAt)} (${relTime(state.nextDueAt)})` : 'Nothing is due yet.',
              'A run only touches posts that are due, so starting one now would do nothing. ' +
              'To test immediately, bring the next post forward — that overrides the pacing for ' +
              'one post only and leaves every cooldown intact.',
              state.nextDueAt ? btn('Bring next post forward', async () => {
                await post('/api/queue/bring-forward', {});
                await refreshCore(); await render();
                flash('Next post is now due.', 'ok');
              }, { size: 'sm', icon: 'forward' }) : null))
            : null,

        el('div', { class: 'row mt4' },
          ...[1, 3, 5, 15].map((n) => btn(n === 1 ? 'Post just one' : `Up to ${n}`,
            () => startJob('/api/jobs/post-run', { max: n }), {
              kind: n === 1 ? '' : 'secondary',
              icon: n === 1 ? 'send' : undefined,
              disabled: s.breakerTripped || due === 0 || !!job,
            }))),
        el('p', { class: 'hint tight mt2' }, 'Start small — one post, then read the log.')),
    ),

    activityCard(job),
  );
  if (job) pollJob();
}

// ----------------------------------------------------------------- groups ---

/**
 * Filters and selection live outside the view so they survive navigation — and
 * the controls are rebuilt FROM them, so what the inputs show is always what is
 * being applied. Previously the filter survived but the search box came back
 * empty, which made most of the groups look like they had vanished.
 */
const gFilter = { text: '', business: '', composer: '', active: '' };
const gSelected = new Set();

async function viewGroups() {
  await hydrateAssignments();
  for (const id of [...gSelected]) if (!state.groups.some((g) => g.id === id)) gSelected.delete(id);

  const tableHost = el('div', { class: 'scroll' });
  const counter = el('span', { class: 'dim small' });
  const bulk = el('div', { class: 'bulkbar', hidden: true });
  const clearBtn = btn('Clear filters', () => {
    Object.assign(gFilter, { text: '', business: '', composer: '', active: '' });
    viewGroups();
  }, { kind: 'ghost', size: 'sm', icon: 'x' });

  const search = el('input', {
    type: 'search', placeholder: 'Search groups…', value: gFilter.text,
    oninput: (e) => { gFilter.text = e.target.value; draw(); },
  });

  const toolbar = el('div', { class: 'row', style: 'padding:14px 20px;border-bottom:1px solid var(--border)' },
    el('div', { class: 'search', style: 'flex:1 1 220px;max-width:300px' }, icon('search'), search),
    select(gFilter.business, [['', 'All businesses'], ['none', 'No business'], ...state.businesses.map((b) => [String(b.id), b.name])],
      (v) => { gFilter.business = v; draw(); }, { style: 'width:auto;min-width:150px' }),
    select(gFilter.composer, [['', 'Any composer'], ['status', 'Normal'], ['listing', 'Marketplace']],
      (v) => { gFilter.composer = v; draw(); }, { style: 'width:auto;min-width:140px' }),
    select(gFilter.active, [['', 'Any state'], ['1', 'Active'], ['0', 'Inactive']],
      (v) => { gFilter.active = v; draw(); }, { style: 'width:auto;min-width:120px' }),
    clearBtn,
    el('span', { class: 'spacer' }),
    counter);

  mount(
    pageHead('Groups',
      'Marketplace groups need the listing composer (title and price); normal groups take a plain ' +
      'caption. A group only receives ads from the businesses assigned to it.'),
    state.groups.length === 0
      ? card(null, {}, empty('users', 'No groups yet', 'Import the groups you belong to from Facebook. Nothing is posted.',
        btn('Go to Setup & Run', () => go('setup'), { icon: 'download' })))
      : el('section', { class: 'card' }, toolbar, tableHost),
    bulk);

  if (state.groups.length === 0) return;

  function visible() {
    const q = gFilter.text.trim().toLowerCase();
    return state.groups.filter((g) =>
      (!q || g.name.toLowerCase().includes(q))
      && (!gFilter.composer || g.composerType === gFilter.composer)
      && (gFilter.active === '' || String(g.active ? 1 : 0) === gFilter.active)
      && (!gFilter.business
        || (gFilter.business === 'none' ? (g._businesses ?? []).length === 0
          : (g._businesses ?? []).includes(Number(gFilter.business)))));
  }

  function draw() {
    const rows = visible();
    const filtered = Object.values(gFilter).some((v) => v !== '');
    clearBtn.hidden = !filtered;
    counter.textContent = filtered ? `Showing ${rows.length} of ${state.groups.length}` : `${state.groups.length} groups · ${state.counts.groupsActive} active`;

    const allOn = rows.length > 0 && rows.every((r) => gSelected.has(r.id));
    const someOn = rows.some((r) => gSelected.has(r.id));
    const head = el('input', {
      type: 'checkbox', checked: allOn, indeterminate: someOn && !allOn, title: allOn ? 'Deselect all shown' : 'Select all shown',
      onchange: () => {
        for (const r of rows) { if (allOn) gSelected.delete(r.id); else gSelected.add(r.id); }
        draw();
      },
    });

    tableHost.replaceChildren(rows.length === 0
      ? empty('filter', 'No groups match those filters', null, btn('Clear filters', () => clearBtn.click(), { kind: 'secondary' }))
      : el('table', {},
        el('thead', {}, el('tr', {},
          el('th', { class: 'check' }, head),
          el('th', {}, 'Group'), el('th', {}, 'Composer'), el('th', {}, 'Businesses'),
          el('th', { title: `Blank = the default of ${state.settings.perGroupCooldownDays} days` }, 'Cooldown'),
          el('th', {}, 'Rules / notes'), el('th', {}, 'Active'))),
        el('tbody', {}, rows.map(rowFor))));
    syncBulk();
  }

  function rowFor(g) {
    const tr = el('tr', { class: gSelected.has(g.id) ? 'selected' : '' });
    const saved = () => { tr.classList.remove('saved'); void tr.offsetWidth; tr.classList.add('saved'); };
    const save = async (p) => {
      Object.assign(g, await patch(`/api/groups/${g.id}`, p));
      saved();
      await refreshCore().catch(() => {});
      counter.textContent = counter.textContent.replace(/\d+ active/, `${state.counts.groupsActive} active`);
    };
    const quarantined = g.quarantinedUntil && new Date(g.quarantinedUntil) > new Date();

    tr.append(
      el('td', { class: 'check' }, el('input', {
        type: 'checkbox', checked: gSelected.has(g.id),
        onchange: (e) => {
          if (e.target.checked) gSelected.add(g.id); else gSelected.delete(g.id);
          draw();
        },
      })),
      el('td', {}, el('div', { class: 'gname' },
        el('a', { href: g.url, target: '_blank', rel: 'noreferrer' }, g.name, icon('external')),
        el('div', { class: 'meta' },
          g.memberCount != null ? `${g.memberCount.toLocaleString()} members` : 'members unknown',
          quarantined ? el('span', { class: 'tag bad', title: g.quarantineReason ?? '' },
            `quarantined until ${fmtTime(g.quarantinedUntil)}`) : null))),
      el('td', { class: 'tight' }, select(g.composerType, [['status', 'Normal'], ['listing', 'Marketplace']],
        (v) => save({ composerType: v }).catch(showError), { style: 'width:136px' })),
      el('td', { class: 'tight' }, el('div', { class: 'chips' },
        state.businesses.length === 0
          ? el('a', { href: '#ads', class: 'small' }, 'Add a business first')
          : state.businesses.map((b) => {
            const on = (g._businesses ?? []).includes(b.id);
            return el('button', {
              class: `chip${on ? ' on' : ''}`, title: on ? `Unassign ${b.name}` : `Assign ${b.name}`,
              onclick: async (e) => {
                const chip = e.currentTarget;
                chip.disabled = true;
                try {
                  const cur = new Set(await get(`/api/businesses/${b.id}/assignments`));
                  if (on) cur.delete(g.id); else cur.add(g.id);
                  state.assignments.set(b.id, new Set(await put(`/api/businesses/${b.id}/assignments`, { groupIds: [...cur] })));
                  applyAssignments();
                  const fresh = state.groups.find((x) => x.id === g.id) ?? g;
                  const next = rowFor(fresh);
                  tr.replaceWith(next);
                  next.classList.add('saved');
                } catch (err) { showError(err); chip.disabled = false; }
              },
            }, icon(on ? 'check' : 'plus'), b.name);
          }))),
      el('td', { class: 'tight' }, el('input', {
        type: 'number', min: '0', value: g.cooldownDaysOverride ?? '',
        placeholder: `${state.settings.perGroupCooldownDays}d default`, style: 'width:118px',
        title: 'Days before this group can receive anything again. Blank uses the default.',
        onchange: (e) => save({ cooldownDaysOverride: e.target.value === '' ? null : Number(e.target.value) }).catch(showError),
      })),
      el('td', { class: 'tight' }, el('input', {
        type: 'text', value: g.rulesNotes ?? '', placeholder: 'e.g. no links, Tuesdays only', style: 'min-width:190px',
        onchange: (e) => save({ rulesNotes: e.target.value }).catch(showError),
      })),
      el('td', { class: 'tight' }, toggle(g.active, (v) => save({ active: v }))),
    );
    return tr;
  }

  function syncBulk() {
    bulk.hidden = gSelected.size === 0;
    if (bulk.hidden) return;
    const ids = () => [...gSelected];
    const bulkPatch = async (p, msg) => {
      await post('/api/groups/bulk', { ids: ids(), patch: p });
      await refreshCore(); await hydrateAssignments(); draw();
      flash(`${plural(gSelected.size, 'group')} ${msg}.`, 'ok');
    };
    const bulkAssign = async (b, add) => {
      const cur = new Set(await get(`/api/businesses/${b.id}/assignments`));
      for (const id of gSelected) { if (add) cur.add(id); else cur.delete(id); }
      await put(`/api/businesses/${b.id}/assignments`, { groupIds: [...cur] });
      await hydrateAssignments(); draw();
      flash(`${plural(gSelected.size, 'group')} ${add ? 'assigned to' : 'removed from'} ${b.name}.`, 'ok');
    };
    const o = { kind: 'secondary', size: 'sm' };
    bulk.replaceChildren(
      el('strong', {}, `${gSelected.size} selected`),
      btn('Activate', () => bulkPatch({ active: true }, 'activated'), o),
      btn('Deactivate', () => bulkPatch({ active: false }, 'deactivated'), o),
      el('span', { class: 'sep' }),
      btn('Normal', () => bulkPatch({ composerType: 'status' }, 'set to Normal'), o),
      btn('Marketplace', () => bulkPatch({ composerType: 'listing' }, 'set to Marketplace'), o),
      state.businesses.length ? el('span', { class: 'sep' }) : null,
      ...state.businesses.flatMap((b) => [
        btn(b.name, () => bulkAssign(b, true), { ...o, icon: 'plus', title: `Assign to ${b.name}` }),
        btn('', () => bulkAssign(b, false), { kind: 'ghost', size: 'sm', icon: 'minus', title: `Remove from ${b.name}` }),
      ]),
      el('span', { class: 'sep' }),
      btn('', () => { gSelected.clear(); draw(); }, { kind: 'ghost', size: 'sm', icon: 'x', title: 'Clear selection' }),
    );
  }

  draw();
}

// -------------------------------------------------------------------- ads ---

function viewAds() {
  const businessesCard = card('Businesses', {
    sub: 'Rename or pause a business. Paused businesses are never planned.',
  },
    state.businesses.length === 0
      ? empty('layers', 'No businesses yet', 'Add the first business you want to advertise.')
      : el('div', {}, state.businesses.map((b) => {
        const ads = state.ads.filter((a) => a.businessId === b.id);
        return el('div', { class: 'biz-row' },
          avatar(b.name, b.id),
          el('div', { style: 'flex:1;min-width:0' },
            el('div', { style: 'font-weight:600' }, b.name),
            el('div', { class: 'dim small' }, `${plural(ads.length, 'ad')} · ${plural(ads.reduce((n, a) => n + activeVariants(a).length, 0), 'active variant')}`)),
          btn('', async () => {
            const name = await promptDialog('Rename business', 'Business name', b.name);
            if (!name || name === b.name) return;
            await patch(`/api/businesses/${b.id}`, { name });
            await refreshCore(); await render();
            flash('Business renamed.', 'ok');
          }, { kind: 'ghost', size: 'sm', icon: 'edit', title: 'Rename' }),
          toggle(b.active, async (v) => {
            await patch(`/api/businesses/${b.id}`, { active: v });
            await refreshCore(); await render();
          }, b.active ? 'Active' : 'Paused'));
      })),
    el('form', {
      class: 'row mt4',
      onsubmit: async (e) => {
        e.preventDefault();
        const input = e.target.elements.name;
        const name = input.value.trim();
        if (!name) { input.classList.add('invalid'); input.focus(); return; }
        const b = e.target.querySelector('button');
        b.disabled = true;
        try { await post('/api/businesses', { name }); await refreshCore(); await render(); flash(`Added ${name}.`, 'ok'); }
        catch (err) { showError(err); b.disabled = false; }
      },
    },
      el('input', { type: 'text', name: 'name', placeholder: 'New business name', style: 'max-width:280px',
        oninput: (e) => e.target.classList.remove('invalid') }),
      el('button', { class: 'btn', type: 'submit' }, icon('plus'), 'Add business')));

  const parts = [
    pageHead('Businesses & Ads',
      'Variants exist so no two nearby posts read identically — that is the single strongest ' +
      'automation signal. Write genuinely different wordings, not shuffled words.'),
    businessesCard,
  ];

  for (const biz of state.businesses) {
    const ads = state.ads.filter((a) => a.businessId === biz.id);
    const liveAds = ads.filter((a) => a.active).length;
    parts.push(card(biz.name, {
      sub: `${plural(ads.length, 'ad')}${biz.active ? '' : ' · paused'}`,
      actions: [btn('New ad', () => newAdDialog(biz), { size: 'sm', icon: 'plus' })],
    },
      liveAds < 2 ? callout('warn',
        liveAds === 0 ? 'Add at least two ads.' : 'Add a second ad.',
        `An ad cannot return to the same group for ${state.settings.perGroupAdCooldownDays} days, so with fewer than two most of your daily cap goes unused.`) : null,
      ads.length === 0
        ? empty('megaphone', `No ads for ${biz.name}`, 'An ad is one offer; its variants are different wordings of it.',
          btn('Create the first ad', () => newAdDialog(biz), { icon: 'plus' }))
        : ads.map(adBlock)));
  }

  mount(...parts);
}

async function newAdDialog(biz) {
  const name = el('input', { type: 'text', placeholder: 'e.g. Spring deep-clean offer' });
  let composer = 'status';
  const choices = el('div', { class: 'choices' },
    ...[['status', 'Normal groups', 'A plain post with caption and images.'],
      ['listing', 'Marketplace groups', 'A listing with title, price and description.']].map(([v, t, d]) =>
      el('label', { class: 'choice' },
        el('input', { type: 'radio', name: 'composer', value: v, checked: v === composer, onchange: () => { composer = v; } }),
        el('div', {}, el('b', {}, t), el('span', {}, d)))));
  const ok = await dialog({
    title: `New ad for ${biz.name}`,
    body: el('div', {}, field('Ad name', name), el('div', { class: 'field' }, el('span', { class: 'dim small' }, 'Posts into'), choices)),
    actions: [{ label: 'Cancel', value: null }, {
      label: 'Create ad', value: true, submit: true, run: async () => {
        if (!name.value.trim()) { name.classList.add('invalid'); name.focus(); return false; }
        try {
          await post('/api/ads', { businessId: biz.id, name: name.value.trim(), composerType: composer });
          return true;
        } catch (e) { showError(e); return false; }
      },
    }],
  });
  if (ok) { await refreshCore(); await render(); flash('Ad created — now add at least three variants.', 'ok'); }
}

function adBlock(ad) {
  const live = activeVariants(ad).length;
  const isListing = ad.composerType === 'listing';
  return el('div', { class: `ad${ad.active ? '' : ' off'}` },
    el('div', { class: 'head' },
      el('b', {}, ad.name),
      el('span', { class: 'tag' }, isListing ? 'Marketplace' : 'Normal'),
      el('span', { class: `tag ${live < 3 ? 'warn' : 'ok'}`, title: 'Active variants' },
        live < 3 ? `${live}/3 variants` : plural(live, 'variant')),
      el('span', { class: 'spacer' }),
      btn('', async () => {
        const name = await promptDialog('Rename ad', 'Ad name', ad.name);
        if (!name || name === ad.name) return;
        await patch(`/api/ads/${ad.id}`, { name });
        await refreshCore(); await render();
      }, { kind: 'ghost', size: 'sm', icon: 'edit', title: 'Rename ad' }),
      btn('Add variant', () => variantDialog(ad), { kind: 'secondary', size: 'sm', icon: 'plus' }),
      toggle(ad.active, async (v) => {
        await patch(`/api/ads/${ad.id}`, { active: v });
        await refreshCore(); await render();
      }, ad.active ? 'Active' : 'Paused')),
    (ad.variants ?? []).length === 0
      ? el('div', { class: 'variants' }, el('div', { class: 'variant dim small' },
        'No variants yet. Write three or more genuinely different wordings.'))
      : el('div', { class: 'variants' }, ad.variants.map((v, i) =>
        el('div', { class: `variant${v.active ? '' : ' off'}` },
          el('span', { class: 'vn' }, `V${i + 1}`),
          el('div', { class: 'cap' },
            isListing && v.listingTitle ? el('div', { class: 'lt' }, v.listingTitle,
              v.listingPriceCents != null ? el('span', { class: 'dim' }, ` · ${(v.listingPriceCents / 100).toFixed(2)}`) : null) : null,
            el('div', { class: 'clamp2' }, v.caption),
            v.imagePaths.length ? el('div', { class: 'thumbs mt2' },
              v.imagePaths.map((p) => el('img', { class: 'thumb', src: mediaUrl(p), alt: '', loading: 'lazy' }))) : null),
          v.weight > 1 ? el('span', { class: 'tag', title: 'Picked more often' }, `×${v.weight}`) : null,
          btn('', () => variantDialog(ad, v), { kind: 'ghost', size: 'sm', icon: 'edit', title: 'Edit variant' }),
          toggle(v.active, async (on) => {
            await patch(`/api/variants/${v.id}`, { active: on });
            await refreshCore(); await render();
          })))),
  );
}

/**
 * Create or edit a variant. There is deliberately no delete: history rows point
 * at the variant, and removing it would take that history — and the cooldowns
 * computed from it — with it. Switching a variant off is the safe equivalent.
 */
async function variantDialog(ad, v = null) {
  const isListing = ad.composerType === 'listing';
  const caption = el('textarea', { placeholder: 'A distinct wording…', value: v?.caption ?? '' });
  const counter = el('div', { class: 'note' });
  const syncCount = () => { counter.textContent = `${caption.value.length} characters`; };
  caption.oninput = () => { caption.classList.remove('invalid'); syncCount(); };
  syncCount();
  const title = el('input', { type: 'text', value: v?.listingTitle ?? '' });
  const price = el('input', { type: 'number', step: '0.01', min: '0', value: v?.listingPriceCents != null ? (v.listingPriceCents / 100).toFixed(2) : '' });
  const category = el('input', { type: 'text', value: v?.listingCategory ?? '' });
  const location = el('input', { type: 'text', value: v?.listingLocation ?? '' });
  const weight = el('input', { type: 'number', min: '1', value: String(v?.weight ?? 1), style: 'max-width:100px' });
  const files = el('input', { type: 'file', accept: 'image/*', multiple: true });

  let kept = [...(v?.imagePaths ?? [])];
  const thumbs = el('div', { class: 'thumbs' });
  const drawThumbs = () => thumbs.replaceChildren(...kept.map((p) => el('span', { class: 'thumb-edit' },
    el('img', { class: 'thumb', src: mediaUrl(p), alt: '' }),
    el('button', { type: 'button', title: 'Remove image', onclick: () => { kept = kept.filter((x) => x !== p); drawThumbs(); } }, icon('x')))));
  drawThumbs();
  const newThumbs = el('div', { class: 'thumbs' });
  files.onchange = () => newThumbs.replaceChildren(...[...files.files].map((f) =>
    el('img', { class: 'thumb', src: URL.createObjectURL(f), alt: '' })));

  const body = el('div', {},
    isListing ? el('div', { class: 'grid2' },
      field('Title *', title), field('Price', price), field('Category', category), field('Location', location)) : null,
    el('label', { class: 'field' }, el('span', {}, isListing ? 'Description' : 'Caption'), caption, counter),
    el('div', { class: 'field' }, el('span', { class: 'dim small', style: 'display:block;margin-bottom:6px;font-weight:600' }, 'Images'),
      el('div', { class: 'row gap3' }, thumbs, newThumbs), el('div', { class: 'mt2' }, files)),
    field('Weight', weight, 'Higher means this variant is picked more often. 1 is normal.'));

  const saved = await dialog({
    title: v ? 'Edit variant' : `New variant · ${ad.name}`,
    text: v ? 'Changes apply to posts planned from now on.' : 'Write something that reads differently from the other variants, not the same words shuffled.',
    wide: true,
    body,
    actions: [{ label: 'Cancel', value: null }, {
      label: v ? 'Save changes' : 'Save variant', value: true, run: async () => {
        if (!caption.value.trim()) { caption.classList.add('invalid'); caption.focus(); return false; }
        if (isListing && !title.value.trim()) { title.classList.add('invalid'); title.focus(); flash('A marketplace listing needs a title.'); return false; }
        try {
          const imagePaths = [...kept];
          for (const file of files.files) {
            const fd = new FormData();
            fd.append('file', file);
            const res = await fetch('/api/media', { method: 'POST', body: fd });
            if (!res.ok) throw new Error(`Uploading ${file.name} failed`);
            imagePaths.push((await res.json()).path);
          }
          const payload = { caption: caption.value, imagePaths, weight: Math.max(1, Number(weight.value || 1)) };
          if (isListing) {
            payload.listingTitle = title.value.trim() || null;
            payload.listingPriceCents = price.value ? Math.round(Number(price.value) * 100) : null;
            payload.listingCategory = category.value.trim() || null;
            payload.listingLocation = location.value.trim() || null;
          }
          if (v) await patch(`/api/variants/${v.id}`, payload);
          else await post('/api/variants', { adId: ad.id, ...payload });
          return true;
        } catch (e) { showError(e); return false; }
      },
    }],
  });
  if (saved) { await refreshCore(); await render(); flash(v ? 'Variant updated.' : 'Variant added.', 'ok'); }
}

// ------------------------------------------------------------------- plan ---

const REASONS = {
  cooldown: { t: 'Inside the per-group cooldown', d: 'These groups heard from you recently. They come back on their own.' },
  'ad-cooldown': { t: 'Every fitting ad is on cooldown here', d: 'Each ad has already run in these groups recently.', fix: ['Write another ad', 'ads'] },
  'group-inactive': { t: 'Switched off', d: 'Inactive groups are never planned.', fix: ['Open Groups', 'groups'] },
  'group-quarantined': { t: 'Quarantined', d: 'Paused after a problem — they return when the quarantine ends.', fix: ['Open Groups', 'groups'] },
  'no-eligible-ad': { t: 'No ad fits this group', d: 'No active ad matches the group’s composer (Normal vs Marketplace).', fix: ['Create a matching ad', 'ads'] },
  'daily-cap': { t: 'Eligible, but out of slots', d: 'The window ran out of daily-cap slots before reaching these groups.', fix: ['Review the cap', 'settings'] },
  'outside-active-hours': { t: 'Outside active hours', d: 'No slot inside your active hours.', fix: ['Review active hours', 'settings'] },
  'no-assignment': { t: 'No business assigned', d: 'A group only receives ads from businesses assigned to it.', fix: ['Assign in Groups', 'groups'] },
  'rounds-today': { t: 'Round allowance used up today', d: 'These groups already had their rounds for today.' },
  'round-too-soon': { t: 'Resting between rounds', d: 'Still inside the rest period since their last round.' },
  'round-daily-cap': { t: 'Round daily ceiling reached', d: 'The overall limit on round posts per day is used up.', fix: ['Review round limits', 'settings'] },
};

function exclusionList(exclusions) {
  const byReason = new Map();
  for (const e of exclusions) {
    if (!byReason.has(e.reason)) byReason.set(e.reason, []);
    byReason.get(e.reason).push(e);
  }
  return [...byReason.entries()].sort((a, b) => b[1].length - a[1].length).map(([reason, list]) => {
    const r = REASONS[reason] ?? { t: reason, d: '' };
    return el('div', { class: 'reason' },
      el('div', { class: 'row' },
        el('b', {}, r.t), el('span', { class: 'tag' }, String(list.length)),
        el('span', { class: 'spacer' }),
        r.fix ? btn(r.fix[0], () => go(r.fix[1]), { kind: 'ghost', size: 'sm', icon: 'arrow' }) : null),
      r.d ? el('p', { class: 'hint tight' }, r.d) : null,
      el('div', { class: 'chips mt3' },
        list.slice(0, 60).map((e) => el('span', { class: 'tag', title: e.detail ?? '' }, nameOf(e.groupId, state.groups))),
        list.length > 60 ? el('span', { class: 'dim small' }, `+${list.length - 60} more`) : null));
  });
}

/** The last dry run, so Commit queues exactly what was reviewed. */
const planState = { days: 7, plan: null, result: null };

function viewPlan() {
  const out = el('div');
  const days = el('input', {
    type: 'number', value: String(planState.days), min: '1', max: '60', style: 'width:90px',
    oninput: () => {
      planState.days = Number(days.value) || 7;
      if (planState.plan && planState.plan._days !== planState.days) { planState.plan = null; planState.result = null; draw(); }
    },
  });

  const dryBtn = btn('Dry run', async () => {
    const p = await post(`/api/plan/dry-run?days=${planState.days}`);
    p._days = planState.days;
    planState.plan = p; planState.result = null;
    draw();
  }, { icon: 'eye' });

  const commitBtn = el('span');

  function draw() {
    const plan = planState.plan;
    const r = planState.result;
    dryBtn.className = `btn ${plan ? 'secondary' : ''}`;
    commitBtn.replaceChildren(btn(plan && !r ? `Queue ${plural(plan.posts.length, 'post')}` : 'Commit plan', async () => {
      const pending = state.counts.queuePending ?? 0;
      const ok = await confirmDialog(`Queue ${plural(plan.posts.length, 'post')}?`,
        pending
          ? `This replaces the ${plural(pending, 'post')} currently waiting in the queue. History and cooldowns are untouched.`
          : 'They go into the queue and post when due — assisted runs still stop for you at each one.',
        'Queue them');
      if (!ok) return;
      const res = await post(`/api/plan/commit?days=${plan._days}&seed=${plan.seed}`, { replacePending: true });
      res.plan._days = plan._days;
      res.reviewed = plan.posts.length;
      planState.plan = res.plan; planState.result = res;
      await refreshCore();
      draw();
    }, { disabled: !plan || !!r || plan.posts.length === 0, icon: 'check',
      title: !plan ? 'Run a dry run first — you commit exactly what it shows' : undefined }));

    if (!plan) {
      out.replaceChildren(card(null, {}, empty('calendar', 'No plan yet',
        'Run a dry run to see every post the tool would make, and why each left-out group was left out. Nothing is written until you commit.')));
      return;
    }

    const days_ = new Map();
    for (const p of plan.posts) {
      const k = new Date(p.scheduledFor).toDateString();
      if (!days_.has(k)) days_.set(k, []);
      days_.get(k).push(p);
    }

    out.replaceChildren(
      r
        ? r.committed > 0
          ? callout('ok', `Queued ${plural(r.committed, 'post')}.`,
            (r.cleared ? `Replaced ${plural(r.cleared, 'post')} that were waiting. ` : '') +
            (r.reviewed !== r.committed ? `The schedule shifted slightly since your dry run (${r.reviewed} → ${r.committed}); what is shown below is what was queued.` : 'Exactly the schedule you reviewed.'),
            btn('Go to Setup & Run', () => go('setup'), { size: 'sm', icon: 'arrow' }))
          : callout('warn', 'Nothing was queued.', 'The plan came out empty, so your existing queue was left exactly as it was.')
        : callout('info', 'Dry run — nothing has been queued yet.',
          plan.posts.length ? 'Review the schedule and the exclusions, then queue it.' : 'This plan has no posts. The exclusions below explain why.'),

      card(r ? 'Queued schedule' : 'Proposed schedule', { flush: true, sub: `${plural(plan.posts.length, 'post')} over ${plural(plan._days, 'day')}` },
        plan.posts.length === 0
          ? empty('calendar', 'Nothing to post', 'The exclusions below explain why.')
          : el('div', { class: 'scroll' }, el('table', {},
            el('thead', {}, el('tr', {}, el('th', {}, 'Time'), el('th', {}, 'Group'),
              el('th', {}, 'Business'), el('th', {}, 'Ad'), el('th', {}, 'Variant'))),
            el('tbody', {}, [...days_.values()].flatMap((list) => [
              el('tr', { class: 'day' }, el('td', { colspan: '5' }, `${fmtDay(list[0].scheduledFor)} · ${plural(list.length, 'post')}`)),
              ...list.map((p) => el('tr', {},
                el('td', { class: 'nowrap mono dim' }, fmtClock(p.scheduledFor)),
                el('td', {}, nameOf(p.groupId, state.groups)),
                el('td', {}, nameOf(p.businessId, state.businesses)),
                el('td', {}, nameOf(p.adId, state.ads)),
                el('td', { class: 'dim mono' }, variantLabel(p.variantId))))]))))),

      plan.exclusions.length ? card(`Left out`, { sub: `${plural(plan.exclusions.length, 'group')} — and the rule that stopped each` },
        exclusionList(plan.exclusions)) : null,
    );
  }

  mount(
    pageHead('Plan',
      'A dry run computes the whole schedule and writes nothing. Commit queues exactly the schedule you reviewed.'),
    card(null, {},
      el('div', { class: 'row gap3', style: 'align-items:flex-end' },
        el('label', { class: 'field', style: 'margin:0' }, el('span', {}, 'Days ahead'), days),
        dryBtn, commitBtn,
        el('span', { class: 'spacer' }),
        el('span', { class: 'dim small' }, `${state.counts.groupsActive} active groups · cap ${state.settings.dailyCap}/day`))),
    out);
  draw();
}

// -------------------------------------------------------------- queue/log ---

/**
 * Row selection for the two tables on this screen. Kept outside viewQueue so a
 * re-render after a delete does not silently resurrect a stale selection —
 * every entry point that reloads the screen clears them.
 */
const picked = { queue: new Set(), log: new Set() };
const qState = { tab: 'queue', filter: '' };

async function viewQueue() {
  const [queue, log] = await Promise.all([get('/api/queue'), get('/api/log?limit=200')]);

  // Rows can disappear between renders (deleted, or run to completion); a
  // selection holding ids that no longer exist would send them to the server.
  const alive = { queue: new Set(queue.map((q) => q.id)), log: new Set(log.map((l) => l.id)) };
  for (const bucket of ['queue', 'log']) {
    for (const id of [...picked[bucket]]) if (!alive[bucket].has(id)) picked[bucket].delete(id);
  }

  const reload = async () => { await refreshCore(); await viewQueue(); };
  const rerender = () => { void viewQueue(); };
  const countOf = (rows, key, values) => rows.filter((r) => values.includes(r[key])).length;

  const tabs = el('div', { class: 'seg' },
    ...[['queue', 'Queue', queue.length], ['log', 'History', log.length]].map(([k, t, n]) =>
      el('button', { class: qState.tab === k ? 'on' : '', onclick: () => { qState.tab = k; qState.filter = ''; rerender(); } },
        t, el('span', { class: 'n' }, String(n)))));

  const filterChips = (rows, key, values) => el('div', { class: 'seg' },
    el('button', { class: qState.filter === '' ? 'on' : '', onclick: () => { qState.filter = ''; rerender(); } }, 'All'),
    ...values.filter((v) => countOf(rows, key, [v]) > 0).map((v) =>
      el('button', { class: qState.filter === v ? 'on' : '', onclick: () => { qState.filter = v; rerender(); } },
        v, el('span', { class: 'n' }, String(countOf(rows, key, [v]))))));

  const checkAll = (bucket, rows) => {
    const all = rows.length > 0 && rows.every((r) => picked[bucket].has(r.id));
    const some = rows.some((r) => picked[bucket].has(r.id));
    return el('input', {
      type: 'checkbox', checked: all, indeterminate: some && !all,
      onchange: () => { for (const r of rows) { if (all) picked[bucket].delete(r.id); else picked[bucket].add(r.id); } rerender(); },
    });
  };
  const checkOne = (bucket, id) => el('td', { class: 'check' }, el('input', {
    type: 'checkbox', checked: picked[bucket].has(id),
    onchange: (e) => { if (e.target.checked) picked[bucket].add(id); else picked[bucket].delete(id); rerender(); },
  }));

  let body;
  if (qState.tab === 'queue') {
    const rows = qState.filter ? queue.filter((q) => q.status === qState.filter) : queue;
    const sel = picked.queue.size;
    const deletable = ['cancelled', 'failed', 'skipped'];

    const deleteQueue = async (payload, text) => {
      if (!await confirmDialog('Delete from the queue?', `${text} History of anything already posted is kept.`, 'Delete', 'danger')) return;
      await post('/api/queue/delete', payload);
      picked.queue.clear();
      await reload();
      flash('Deleted.', 'ok');
    };

    body = card(null, { flush: true },
      el('div', { class: 'row', style: 'padding:12px 16px;border-bottom:1px solid var(--border)' },
        filterChips(queue, 'status', ['pending', 'due', 'running', 'failed', 'cancelled', 'skipped', 'posted']),
        el('span', { class: 'spacer' }),
        sel ? btn(`Delete ${sel} selected`, () => deleteQueue({ ids: [...picked.queue] }, `${plural(sel, 'item')} will be removed.`),
          { kind: 'danger-outline', size: 'sm', icon: 'trash' }) : null,
        ...deletable.map((st) => {
          const n = countOf(queue, 'status', [st]);
          return n ? btn(`Clear ${st} (${n})`, () => deleteQueue({ statuses: [st] }, `All ${plural(n, `${st} item`)} will be removed.`),
            { kind: 'ghost', size: 'sm' }) : null;
        })),
      rows.length === 0
        ? empty('list', queue.length ? 'Nothing with that status' : 'Nothing queued', queue.length ? null : 'Dry-run and commit a plan to fill the queue.',
          queue.length ? null : btn('Open Plan', () => go('plan'), { kind: 'secondary' }))
        : el('div', { class: 'scroll' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', { class: 'check' }, checkAll('queue', rows)), el('th', {}, 'When'),
            el('th', {}, 'Group'), el('th', {}, 'Ad'), el('th', {}, 'Mode'), el('th', {}, 'Status'), el('th', {}, ''))),
          el('tbody', {}, rows.map((q) => el('tr', { class: picked.queue.has(q.id) ? 'selected' : '' },
            checkOne('queue', q.id),
            el('td', { class: 'nowrap' }, el('div', { class: 'mono' }, fmtTime(q.scheduledFor)),
              el('div', { class: 'dim small' }, relTime(q.scheduledFor))),
            el('td', {}, nameOf(q.groupId, state.groups), q.roundId ? el('span', { class: 'tag accent', style: 'margin-left:6px' }, 'round') : null),
            el('td', {}, nameOf(q.adId, state.ads)),
            el('td', { class: 'dim' }, q.runnerMode),
            el('td', {}, el('span', { class: `pill ${q.status}`, title: q.lastError ?? '' }, q.status)),
            el('td', { class: 'nowrap', style: 'text-align:right' },
              q.status === 'pending' ? btn('Cancel', async () => {
                await patch(`/api/queue/${q.id}`, { status: 'cancelled' }); await reload();
              }, { kind: 'secondary', size: 'sm' }) : null,
              // A failed or cancelled item is terminal until you say otherwise.
              // Retrying re-dates it to now so the next run picks it straight up.
              (q.status === 'failed' || q.status === 'cancelled') ? btn('Retry now', async () => {
                await patch(`/api/queue/${q.id}`, { status: 'pending', scheduledFor: new Date().toISOString() });
                await reload();
              }, { kind: 'secondary', size: 'sm', icon: 'rotate' }) : null,
              el('span', { style: 'display:inline-block;width:8px' }),
              q.status !== 'running' ? btn('', () => deleteQueue({ ids: [q.id] }, 'This item will be removed.'),
                { kind: 'ghost danger-hover', size: 'sm', icon: 'trash', title: 'Delete' }) : null)))))));
  } else {
    const rows = qState.filter ? log.filter((l) => l.outcome === qState.filter) : log;
    const sel = picked.log.size;
    const selectedHasPosted = log.some((l) => picked.log.has(l.id) && l.outcome === 'posted');

    const deleteLog = async (payload, describe) => {
      if (!await confirmDialog('Delete history?', `Permanently delete ${describe}?`, 'Delete', 'danger')) return;
      try {
        await post('/api/log/delete', payload);
      } catch (e) {
        // The server refuses to drop successful posts unless asked by name,
        // because those rows are what every cooldown is computed from.
        if (!String(e.message).includes('confirmPosted')) throw e;
        if (!await confirmDialog('This includes successful posts',
          'Cooldowns are computed from these rows — deleting them makes the planner believe those groups ' +
          'never heard from you, and they become eligible again immediately.',
          'Delete anyway', 'danger')) return;
        await post('/api/log/delete', { ...payload, confirmPosted: true });
      }
      picked.log.clear();
      await reload();
      flash('History deleted.', 'ok');
    };

    body = card(null, { flush: true },
      el('div', { class: 'row', style: 'padding:12px 16px;border-bottom:1px solid var(--border)' },
        filterChips(log, 'outcome', ['posted', 'failed', 'skipped', 'blocked']),
        el('span', { class: 'spacer' }),
        sel ? btn(`Delete ${sel} selected`, () => deleteLog({ ids: [...picked.log] }, plural(sel, 'history row')),
          { kind: 'danger-outline', size: 'sm', icon: 'trash' }) : null,
        ...['failed', 'skipped', 'blocked'].map((oc) => {
          const n = countOf(log, 'outcome', [oc]);
          return n ? btn(`Clear ${oc} (${n})`, () => deleteLog({ outcomes: [oc] }, `all ${plural(n, `${oc} row`)}`),
            { kind: 'ghost', size: 'sm' }) : null;
        })),
      selectedHasPosted ? el('div', { style: 'padding:12px 16px 0' }, callout('warn', null,
        'Your selection includes successful posts — deleting those resets their cooldowns.')) : null,
      rows.length === 0
        ? empty('send', log.length ? 'Nothing with that outcome' : 'Nothing posted yet', log.length ? null : 'Every attempt — posted, skipped or failed — is recorded here.')
        : el('div', { class: 'scroll' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', { class: 'check' }, checkAll('log', rows)), el('th', {}, 'When'),
            el('th', {}, 'Group'), el('th', {}, 'Ad'), el('th', {}, 'Outcome'), el('th', {}, 'Detail'), el('th', {}, ''))),
          el('tbody', {}, rows.map((l) => el('tr', { class: picked.log.has(l.id) ? 'selected' : '' },
            checkOne('log', l.id),
            el('td', { class: 'nowrap mono' }, fmtTime(l.postedAt)),
            el('td', {}, nameOf(l.groupId, state.groups)),
            el('td', {}, nameOf(l.adId, state.ads)),
            el('td', {}, el('span', { class: `pill ${l.outcome}` }, l.outcome)),
            el('td', { class: 'dim', style: 'max-width:340px' },
              l.fbPostUrl ? el('a', { href: l.fbPostUrl, target: '_blank', rel: 'noreferrer', class: 'row small' }, 'View post', icon('external')) : null,
              el('div', { class: 'clamp2', title: l.error ?? l.detail ?? '' }, l.error ?? l.detail ?? '')),
            el('td', { style: 'text-align:right' }, btn('', () => deleteLog({ ids: [l.id] }, 'this history row'),
              { kind: 'ghost danger-hover', size: 'sm', icon: 'trash', title: 'Delete' }))))))),
    );
  }

  mount(
    pageHead('Queue & Log', qState.tab === 'queue'
      ? 'What is scheduled. Deleting a queue item removes the plan, not the record that it posted.'
      : 'What actually happened. Cooldowns are computed from this table.', tabs),
    body,
  );
}

// --------------------------------------------------------------- settings ---

/** Set while Safety has edits that are not saved, so leaving can ask first. */
let settingsDraft = null;
const settingsDirty = () => current === 'settings' && settingsDraft?.dirty();

function viewSettings() {
  const s = state.settings;
  const f = {};
  const errs = {};
  const bar = el('div', { class: 'savebar', hidden: true });

  const num = (key, min, max, extra = {}) => {
    const input = el('input', { type: 'number', value: s[key] ?? '', min, max, ...extra });
    input.oninput = () => { validate(); sync(); };
    errs[key] = el('div', { class: 'err', hidden: true });
    f[key] = input;
    return el('div', {}, input, errs[key]);
  };
  const fieldN = (label, key, min, max, extra) => el('label', { class: 'field' }, el('span', {}, label), num(key, min, max, extra));

  f.timezone = el('input', { type: 'text', value: s.timezone, oninput: () => { validate(); sync(); } });
  errs.timezone = el('div', { class: 'err', hidden: true });
  let mode = s.defaultRunnerMode;

  const read = () => ({
    dailyCap: +f.dailyCap.value,
    perGroupCooldownDays: +f.perGroupCooldownDays.value,
    perGroupAdCooldownDays: +f.perGroupAdCooldownDays.value,
    minGapMinutes: +f.minGapMinutes.value,
    maxGapMinutes: +f.maxGapMinutes.value,
    activeHourStart: +f.activeHourStart.value,
    activeHourEnd: +f.activeHourEnd.value,
    timezone: f.timezone.value.trim(),
    defaultRunnerMode: mode,
    roundsPerDay: +f.roundsPerDay.value,
    minHoursBetweenRounds: +f.minHoursBetweenRounds.value,
    roundMinGapMinutes: +f.roundMinGapMinutes.value,
    roundMaxGapMinutes: +f.roundMaxGapMinutes.value,
    roundDailyCap: f.roundDailyCap.value === '' ? null : +f.roundDailyCap.value,
  });

  /** Checked in the browser first, so a bad value is pointed at, not just refused. */
  function validate() {
    const v = read();
    const problems = {};
    const range = (k, lo, hi) => {
      if (f[k].value === '' || !Number.isInteger(v[k]) || v[k] < lo || (hi !== undefined && v[k] > hi)) {
        problems[k] = hi === undefined ? `Whole number, ${lo} or more` : `Whole number from ${lo} to ${hi}`;
      }
    };
    range('dailyCap', 1, 200); range('perGroupCooldownDays', 0, 365); range('perGroupAdCooldownDays', 0, 365);
    range('minGapMinutes', 1, 1440); range('maxGapMinutes', 1, 1440);
    range('activeHourStart', 0, 23); range('activeHourEnd', 1, 24);
    range('roundsPerDay', 1, 8); range('minHoursBetweenRounds', 1, 24);
    range('roundMinGapMinutes', 1, 1440); range('roundMaxGapMinutes', 1, 1440);
    if (f.roundDailyCap.value !== '') range('roundDailyCap', 1, 500);
    if (!problems.minGapMinutes && !problems.maxGapMinutes && v.minGapMinutes > v.maxGapMinutes) problems.maxGapMinutes = 'Must be at least the minimum gap';
    if (!problems.activeHourStart && !problems.activeHourEnd && v.activeHourStart >= v.activeHourEnd) problems.activeHourEnd = 'Must be after the start hour';
    if (!problems.roundMinGapMinutes && !problems.roundMaxGapMinutes && v.roundMinGapMinutes > v.roundMaxGapMinutes) problems.roundMaxGapMinutes = 'Must be at least the minimum gap';
    try { new Intl.DateTimeFormat('en', { timeZone: v.timezone }); } catch { problems.timezone = 'Not a timezone — use a name like Europe/London'; }

    for (const [k, node] of Object.entries(errs)) {
      node.hidden = !problems[k];
      node.textContent = problems[k] ?? '';
      f[k].classList.toggle('invalid', !!problems[k]);
    }
    return problems;
  }

  // Snapshotted after mount below — read() needs every input to exist.
  let original = null;
  const dirty = () => original !== null && JSON.stringify(read()) !== original;

  const roundTime = el('span');
  const roundCapNote = el('div', { class: 'note' });
  function sync() {
    const v = read();
    bar.hidden = !dirty();
    const n = state.counts.groupsActive || 0;
    roundTime.textContent = `At ${v.roundMinGapMinutes}–${v.roundMaxGapMinutes} minutes apart, a round through ${plural(n, 'active group')} takes roughly ${Math.round(n * (v.roundMinGapMinutes + v.roundMaxGapMinutes) / 2)} minutes. The run window has to stay open that long.`;
    roundCapNote.replaceChildren(v.roundDailyCap === null
      ? el('span', { style: 'color:var(--warn)' }, 'No ceiling — nothing limits total round posts per day.')
      : `Only round posts count against this. The ${v.dailyCap}/day cap still governs planned posting.`);
  }

  const save = async () => {
    const problems = validate();
    if (Object.keys(problems).length) {
      f[Object.keys(problems)[0]].focus();
      flash('Fix the highlighted fields before saving.');
      return;
    }
    await patch('/api/settings', read());
    settingsDraft = null;
    await refreshCore();
    await render();
    flash('Settings saved.', 'ok');
  };

  bar.append(el('span', { class: 'row small' }, el('span', { class: 'dot live' }), 'Unsaved changes'),
    btn('Discard', () => { settingsDraft = null; viewSettings(); }, { kind: 'ghost', size: 'sm' }),
    btn('Save changes', save, { size: 'sm', icon: 'check' }));

  const sec = (title, desc, ...controls) => el('div', { class: 'settings-sec' },
    el('div', {}, el('h2', {}, title), el('div', { class: 'desc' }, ...[].concat(desc).map((d) => el('p', {}, d)))),
    el('div', {}, ...controls));

  const modeChoices = el('div', { class: 'choices' },
    ...[['assisted', 'Assisted', 'Fills in the post and waits. You click Post yourself.', 'pointer'],
      ['auto', 'Auto', 'Clicks Post itself. Faster, and riskier.', 'zap']].map(([v, t, d]) =>
      el('label', { class: `choice${v === 'auto' ? ' danger' : ''}` },
        el('input', { type: 'radio', name: 'mode', value: v, checked: v === mode, onchange: () => { mode = v; autoWarn.hidden = mode !== 'auto'; sync(); } }),
        el('div', {}, el('b', {}, t), el('span', {}, d)))));
  const autoWarn = callout('bad', 'Auto mode posts without you.',
    'It breaks Facebook’s terms, and the realistic failure mode is a posting block or removal from groups. Use it on a few low-stakes groups first.');
  autoWarn.classList.add('mt3');
  autoWarn.hidden = mode !== 'auto';

  mount(
    pageHead('Safety',
      'These are not preferences. They keep your posting pattern below the level that gets an ' +
      'account restricted or gets you removed from groups by their admins.'),

    el('section', { class: 'card' },
      sec('Volume',
        'Blocks are commonly reported around 10–20 group posts a day for an established account. The real threshold is undocumented and moves — raising this is the fastest way to get restricted.',
        fieldN('Posts per day, all businesses combined', 'dailyCap', 1, 200)),
      sec('Cooldowns',
        ['The group cooldown is what stops admins removing you — the risk that costs something permanent.',
          'If the ad cooldown leaves your cap unused, the fix is more ads, not a shorter cooldown.'],
        el('div', { class: 'grid2' },
          fieldN('Days before a group hears from you again', 'perGroupCooldownDays', 0, 365),
          fieldN('Days before the same ad returns to a group', 'perGroupAdCooldownDays', 0, 365))),
      sec('Rhythm',
        'Each gap is randomised between the minimum and maximum. A fixed cadence is a machine signature. Nothing posts outside active hours.',
        el('div', { class: 'grid2' },
          fieldN('Minimum gap (minutes)', 'minGapMinutes', 1, 1440),
          fieldN('Maximum gap (minutes)', 'maxGapMinutes', 1, 1440),
          fieldN('Active from (hour, 0–23)', 'activeHourStart', 0, 23),
          fieldN('Active until (hour, 1–24)', 'activeHourEnd', 1, 24)),
        el('label', { class: 'field' }, el('span', {}, 'Timezone'), f.timezone, errs.timezone,
          el('div', { class: 'note' }, 'Drives the active-hours window and where the daily cap resets.'))),
      sec('Runner mode',
        'Saving this also updates posts already in the queue, and a run re-reads it at the moment it posts — so a change takes effect on the very next post.',
        modeChoices, autoWarn),
      sec('Round posting',
        ['A round overrides the cooldowns above on purpose. These numbers replace them, so they are the only thing between a round and a posting block.'],
        el('div', { class: 'grid2' },
          fieldN('Rounds per group per day', 'roundsPerDay', 1, 8),
          fieldN('Hours a group rests between rounds', 'minHoursBetweenRounds', 1, 24),
          fieldN('Minimum gap inside a round (min)', 'roundMinGapMinutes', 1, 1440),
          fieldN('Maximum gap inside a round (min)', 'roundMaxGapMinutes', 1, 1440)),
        el('p', { class: 'hint tight', style: 'margin:-4px 0 16px' }, roundTime),
        el('label', { class: 'field' }, el('span', {}, 'Round posts per day, all groups'),
          num('roundDailyCap', 1, 500, { placeholder: 'No limit' }), roundCapNote)),
    ),
    bar,
    storageSection(),
  );
  original = JSON.stringify(read());
  settingsDraft = { dirty };
  sync();
}

const fmtBytes = (n) => n < 1024 ? `${n} B`
  : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB`
    : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;

/**
 * Storage: sweep uploads no variant references any more.
 *
 * Every save of an ad re-uploads its images under a new timestamped name, so
 * data/media grows with copies nothing points at. Its own card, outside the
 * Safety form: it acts immediately rather than through Save, so it must not
 * look like one of the draft fields the save bar tracks.
 *
 * Numbers come from the server's dry run and the confirm repeats them; the
 * cleanup itself recomputes the list server-side, so what the page shows can
 * only ever be an over-estimate of what gets deleted, never an instruction.
 */
function storageSection() {
  const body = el('div', {}, el('p', { class: 'dim small' }, 'Checking unused images…'));
  const sec = el('section', { class: 'card mt3' },
    el('div', { class: 'settings-sec' },
      el('div', {}, el('h2', {}, 'Storage'), el('div', { class: 'desc' },
        el('p', {}, 'Re-saving an ad uploads its images again, so old copies pile up in data/media. Images any variant still uses — including paused ones — are never touched, nor is anything uploaded in the last hour.'),
        el('p', {}, 'Failure screenshots in data/media/diagnostics can be cleared too once they are more than 30 days old.'))),
      body));

  async function load() {
    let d;
    try { d = await get('/api/media/unused'); } catch (err) {
      body.replaceChildren(callout('bad', 'Could not check storage.', err.message));
      return;
    }
    const nFiles = d.files.length, nDiag = d.diagnostics.length;
    const incl = el('input', { type: 'checkbox', checked: nDiag > 0, disabled: nDiag === 0 });

    const clean = async () => {
      const withDiag = incl.checked && nDiag > 0;
      const count = nFiles + (withDiag ? nDiag : 0);
      const bytes = d.unusedBytes + (withDiag ? d.diagnosticsBytes : 0);
      const ok = await confirmDialog('Delete unused files?',
        `This permanently deletes ${plural(nFiles, 'unused image')}` +
        (withDiag ? ` and ${plural(nDiag, 'old diagnostics file')}` : '') +
        ` (${plural(count, 'file')}, ${fmtBytes(bytes)}). Images used by any ad variant are kept.`,
        `Delete ${plural(count, 'file')}`, 'danger');
      if (!ok) return;
      const r = await post('/api/media/cleanup', { includeDiagnostics: withDiag });
      const done = r.deletedFiles + r.deletedDiagnostics;
      flash(`Deleted ${plural(done, 'file')}, freed ${fmtBytes(r.bytesFreed)}.` +
        (r.skipped.length ? ` ${plural(r.skipped.length, 'file')} could not be removed (in use?).` : ''),
      r.skipped.length ? 'info' : 'ok');
      await load();
    };

    body.replaceChildren(
      el('div', { class: 'row' },
        el('span', {}, el('b', {}, plural(nFiles, 'unused image')), ` · ${fmtBytes(d.unusedBytes)}`)),
      el('div', { class: 'row small dim', style: 'margin-top:6px' },
        `${plural(nDiag, 'diagnostics file')} older than ${d.diagnosticsOlderThanDays} days · ${fmtBytes(d.diagnosticsBytes)}`),
      el('label', { class: 'row small', style: 'margin-top:10px' }, incl, 'Include old diagnostics'),
      el('div', { class: 'row', style: 'margin-top:12px' },
        btn('Clean up', clean, { kind: 'danger-outline', size: 'sm', icon: 'trash', disabled: nFiles + nDiag === 0 }),
        btn('Recheck', load, { kind: 'ghost', size: 'sm', icon: 'rotate' })));
  }
  load();
  return sec;
}

// ----------------------------------------------------------------- rounds ---

/**
 * Round posting: send one ad through every group selected for its business,
 * now, and again in a few hours.
 *
 * On its own screen rather than folded into Setup & Run because it bypasses the
 * cooldowns the rest of the tool is built around. That should mean walking
 * somewhere deliberate, not sitting one stray click away from a normal run —
 * so the start button stays locked until a dry run of the same selection has
 * shown at least one eligible group.
 */
const roundPick = { businessId: null, adId: null, plan: null, planKey: '' };

async function viewRounds() {
  const job = await get('/api/jobs/current').catch(() => null);
  if (job) startPolling();
  await hydrateAssignments();

  const s = state.settings;
  const businesses = state.businesses.filter((b) => b.active);
  if (!businesses.some((b) => b.id === roundPick.businessId)) roundPick.businessId = businesses[0]?.id ?? null;

  // An ad with no active variant cannot go out, so it is not offered.
  const ads = state.ads.filter((a) => a.businessId === roundPick.businessId && a.active && activeVariants(a).length > 0);
  if (!ads.some((a) => a.id === roundPick.adId)) roundPick.adId = ads[0]?.id ?? null;
  const chosenAd = ads.find((a) => a.id === roundPick.adId) ?? null;
  const key = `${roundPick.businessId}:${roundPick.adId}`;
  if (roundPick.planKey !== key) { roundPick.plan = null; roundPick.planKey = key; }

  const assignedIds = state.assignments.get(roundPick.businessId) ?? new Set();
  const assignedActive = state.groups.filter((g) => g.active && assignedIds.has(g.id)).length;

  const dryRun = async () => {
    roundPick.plan = await post('/api/rounds/dry-run', { businessId: roundPick.businessId, adId: roundPick.adId });
    await viewRounds();
  };

  const plan = roundPick.plan;
  const canStart = !s.breakerTripped && !!chosenAd && !!plan && plan.posts.length > 0 && !job;

  const startRound = async () => {
    const auto = s.defaultRunnerMode === 'auto';
    const ok = await confirmDialog(`Start a round of “${chosenAd.name}”?`,
      `${plural(plan.posts.length, 'group')}, ${s.roundMinGapMinutes}–${s.roundMaxGapMinutes} minutes apart. ` +
      (auto ? 'AUTO: it posts to every eligible group without asking you. ' : 'Assisted: it stops at each group and waits for you to click Post. ') +
      'Keep this window and the browser open until it finishes.',
      auto ? 'Start AUTO round' : 'Start round', auto ? 'danger' : 'warn');
    if (!ok) return;
    await startJob('/api/jobs/post-round', { businessId: roundPick.businessId, adId: roundPick.adId });
    roundPick.plan = null;
    await viewRounds();
  };

  const rulesStrip = el('div', { class: 'chips mt3' },
    el('span', { class: 'tag' }, `≤ ${s.roundsPerDay} rounds / group / day`),
    el('span', { class: 'tag' }, `${s.minHoursBetweenRounds}h rest between rounds`),
    el('span', { class: 'tag' }, `${s.roundMinGapMinutes}–${s.roundMaxGapMinutes} min between posts`),
    el('span', { class: `tag ${s.roundDailyCap === null ? 'warn' : ''}` },
      s.roundDailyCap === null ? 'no daily ceiling' : `ceiling ${s.roundDailyCap} posts / day`),
    state.round?.postedToday ? el('span', { class: 'tag accent' }, `${state.round.postedToday} round posts today`) : null,
    state.round?.queued ? el('span', { class: 'tag accent' }, `${state.round.queued} still queued`) : null,
    btn('Change in Safety', () => go('settings'), { kind: 'ghost', size: 'sm', icon: 'arrow' }));

  let previewBody;
  if (!plan) {
    previewBody = empty('eye', 'Dry-run first', 'See exactly which groups this round would reach, when, and why any are left out. Posting unlocks after that.');
  } else {
    previewBody = el('div', {},
      plan.warning ? callout('warn', null, plan.warning) : null,
      plan.posts.length === 0
        ? callout('bad', 'No group is eligible right now.',
          assignedActive === 0 ? `No active groups are assigned to ${nameOf(roundPick.businessId, state.businesses)}.` : 'Every assigned group is excluded — reasons below.',
          assignedActive === 0 ? btn('Assign in Groups', () => go('groups'), { size: 'sm', kind: 'secondary' }) : null)
        : el('p', {}, el('strong', {}, plural(plan.posts.length, 'post')),
          ` — ${fmtTime(plan.posts[0].scheduledFor)} to ${fmtTime(plan.windowEnd)}`),
      plan.posts.length ? el('div', { class: 'scroll', style: 'border:1px solid var(--border);border-radius:10px' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Group'), el('th', {}, 'Caption'))),
        el('tbody', {}, ...plan.posts.map((x) => el('tr', {},
          el('td', { class: 'nowrap mono dim' }, fmtClock(x.scheduledFor)),
          el('td', {}, nameOf(x.groupId, state.groups)),
          el('td', { class: 'dim' }, el('div', { class: 'clamp2' },
            state.ads.flatMap((a) => a.variants ?? []).find((v) => v.id === x.variantId)?.caption ?? ''))))))) : null,
      plan.exclusions.length ? el('div', { class: 'mt4' },
        el('h3', {}, `Left out · ${plan.exclusions.length}`), exclusionList(plan.exclusions)) : null);
  }

  mount(
    pageHead('Rounds',
      'Send one ad to every group assigned to a business, then again a few hours later. This is the one part of the tool that deliberately ignores the day-scale cooldowns.'),

    callout('warn', 'Members will see the same business several times a day.',
      'Whether that costs you the groups is a judgement about your groups, not something the tool can check. What still applies inside a round:'),
    rulesStrip,
    el('div', { style: 'height:16px' }),

    card('Send a round', { icon: 'repeat' },
      s.breakerTripped ? callout('bad', 'Blocked.', 'Clear the circuit breaker first.') : null,
      businesses.length === 0
        ? empty('layers', 'No active business', 'Add a business and its ads first.', btn('Open Ads', () => go('ads'), { kind: 'secondary' }))
        : el('div', {},
          el('div', { class: 'grid2' },
            field('Business', select(roundPick.businessId, businesses.map((b) => [b.id, b.name]),
              (v) => { roundPick.businessId = +v; roundPick.adId = null; viewRounds(); })),
            ads.length
              ? field('Ad', select(roundPick.adId, ads.map((a) => [a.id, `${a.name} — ${plural(activeVariants(a).length, 'variant')}`]),
                (v) => { roundPick.adId = +v; viewRounds(); }))
              : el('div', { class: 'field' }, el('span', { class: 'dim small' }, 'Ad'),
                callout('warn', null, 'This business has no active ad with an active variant.'))),
          el('p', { class: 'hint tight' },
            assignedActive
              ? `${plural(assignedActive, 'active group')} assigned to ${nameOf(roundPick.businessId, state.businesses)}.`
              : el('span', { style: 'color:var(--warn)' }, `No active groups are assigned to ${nameOf(roundPick.businessId, state.businesses)} yet.`)),
          el('div', { class: 'row gap3 mt4' },
            btn(plan ? 'Refresh dry run' : 'Dry run — show me the round', dryRun,
              { kind: plan ? 'secondary' : '', icon: 'eye', disabled: !chosenAd }),
            btn(s.defaultRunnerMode === 'auto' ? 'Start round — AUTO' : 'Start round — assisted', startRound, {
              kind: s.defaultRunnerMode === 'auto' ? 'danger' : 'warn', icon: 'send', disabled: !canStart,
              title: !plan ? 'Run a dry run first' : plan.posts.length === 0 ? 'No eligible groups' : undefined,
            }),
            el('span', { class: 'dim small' }, !plan ? 'Unlocks after a dry run.' : `Runner mode: ${s.defaultRunnerMode}.`)))),

    card('Preview', { sub: 'A dry run posts nothing' }, previewBody),
    activityCard(job),
  );
  if (job) pollJob();
}

// ---------------------------------------------------------------- routing ---

const VIEWS = {
  dashboard: viewDashboard, setup: viewSetup, groups: viewGroups,
  ads: viewAds, plan: viewPlan, rounds: viewRounds, queue: viewQueue, settings: viewSettings,
};
let current = 'dashboard';

const render = () => VIEWS[current]();

/**
 * Navigation goes through the URL hash, so a reload keeps you on the same
 * screen. Leaving Safety with unsaved edits asks first, and stale error toasts
 * are cleared — they describe a screen you are no longer looking at.
 */
async function go(name) {
  if (!VIEWS[name]) name = 'dashboard';
  if (location.hash.slice(1) !== name) { location.hash = name; return; }
  await show(name);
}

let showing = false;
async function show(name) {
  if (settingsDirty() && name !== 'settings') {
    const leave = await confirmDialog('Discard unsaved changes?', 'Your edits on Safety have not been saved.', 'Discard', 'danger');
    if (!leave) { history.replaceState(null, '', '#settings'); return; }
  }
  settingsDraft = null;
  if (showing) return;
  showing = true;
  // Dry runs describe the moment they were made. Arriving from elsewhere —
  // likely after changing groups or ads — must not offer a stale one to commit.
  if (name !== current) {
    if (name === 'rounds') roundPick.plan = null;
    if (name === 'plan') { planState.plan = null; planState.result = null; }
  }
  current = name;
  for (const b of document.querySelectorAll('#nav button')) {
    b.classList.toggle('active', b.dataset.view === name);
    // On narrow screens the nav is a horizontal strip; keep the current tab visible.
    if (b.dataset.view === name) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  toastHost.querySelectorAll('.toast.bad').forEach((n) => n.remove());
  if (name !== 'groups') gSelected.clear();
  view.replaceChildren(el('div', { class: 'skeleton', style: 'height:64px;width:40%' }), el('div', { class: 'skeleton' }), el('div', { class: 'skeleton', style: 'height:220px' }));
  try {
    await refreshCore();
    await render();
    view.classList.remove('view-enter'); void view.offsetWidth; view.classList.add('view-enter');
    window.scrollTo(0, 0);
  } catch (err) {
    showError(err);
  } finally {
    showing = false;
    // A click that landed while this screen was loading changed the hash but
    // was ignored above; honour it now.
    const wanted = location.hash.slice(1);
    if (VIEWS[wanted] && wanted !== current) show(wanted);
  }
}

document.getElementById('nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) go(b.dataset.view);
});
window.addEventListener('hashchange', () => show(VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard'));
window.addEventListener('beforeunload', (e) => { if (settingsDirty()) e.preventDefault(); });

try {
  await refreshCore();
  await show(VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard');
  // A job may already be running from a previous page load.
  const job = await get('/api/jobs/current').catch(() => null);
  setFootJob(job);
  if (job) startPolling();
} catch (err) {
  mount(callout('bad', 'Could not reach the server.', err.message));
}
