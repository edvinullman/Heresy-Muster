import { MANIFEST } from './manifest.js';
import { GameData } from './data.js';
import { loadFiles, clearCache } from './loader.js';
import { Roster, newRosterRaw } from './engine.js';
import { loadLists, upsertList, deleteList } from './store.js';
import { encodeShare, decodeShare, loadPresets, addPreset, deletePreset, freshCopy } from './store.js';
import { rosterText } from './export.js';
import { buildHabits, suggestUnits, usualLoadout, usualOptions, loadoutSig, unitId } from './habits.js';
import { POINTS_ID, DATA_COMMIT, DATA_DATE, DATA_REPO, DEFAULT_POINTS } from './config.js';

const app = document.getElementById('app');
const sheetRoot = document.getElementById('sheet-root');
const data = new GameData(MANIFEST);
const GS = MANIFEST.find(m => m.type === 'gameSystem');
const FACTIONS = MANIFEST.filter(m => m.type === 'catalogue' && !m.library).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));

let roster = null;      // current Roster
let sheet = null;       // { type, ... }
let issues = [];        // validation results for current roster
let confirmKey = null;  // pending inline confirmation
let namingKey = null;   // which "save as preset" name field is open
let habits = null;      // what you tend to take, from your other saved lists
let usualHere = null;   // option chains you usually take for the unit being edited

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pts = (n) => (Number.isInteger(n) ? n : Math.round(n * 10) / 10);
function richText(s) {
  const html = esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*(\S.+?\S)\*(?=\s|$|[.,;:])/g, '$1<em>$2</em>');
  return html.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2200);
}
const icon = {
  back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  close: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  menu: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>',
  down: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  right: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  shield: '<svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 4l10 5.5v6.5c0 6.5-4.4 11-10 12-5.6-1-10-5.5-10-12V9.5z" fill="none" stroke="currentColor" stroke-width="2.2" style="color:var(--brass)"/><path d="M16 10v12M11 15h10" stroke="currentColor" stroke-width="2" style="color:var(--brass)"/></svg>',
};

async function ensureData(catIds, label = 'Loading army data') {
  const entries = new Set([GS]);
  for (const id of catIds) for (const m of data.filesNeeded(id)) entries.add(m);
  const todo = [...entries].filter(m => !data.files.has(m.id));
  if (!todo.length) return;
  app.innerHTML = `<div class="wrap loading"><h2 class="hero" style="font-family:var(--font-display)">${esc(label)}</h2>
    <div class="barbox"><div class="barfill" id="lb"></div></div><div class="what" id="lw">Starting…</div>
    <p class="hint">The first load downloads the data from GitHub. After that it opens from this device.</p></div>`;
  await loadFiles(data, todo, (done, total, name) => {
    const b = document.getElementById('lb'), w = document.getElementById('lw');
    if (b) b.style.width = (total ? Math.round(done / total * 100) : 100) + '%';
    if (w) w.textContent = `${name} · ${(done / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB`;
  });
}

function rosterCatIds(raw) {
  const ids = new Set([raw.catalogueId]);
  const walk = (fs) => { for (const f of fs || []) { if (f.catalogueId) ids.add(f.catalogueId); walk(f.forces); } };
  walk(raw.forces);
  return [...ids];
}

function save() {
  if (!roster) return;
  upsertList(roster.raw);
}

function changed() {
  save();
  issues = roster.validate();
  render();
}

// ---------- routing ----------
async function route() {
  const h = location.hash.slice(1);
  closeSheet(false);
  if (h.startsWith('r=')) return importShared(h.slice(2));
  if (h.startsWith('list-')) {
    const raw = loadLists().find(l => l.id === h.slice(5));
    if (!raw) { location.hash = ''; return; }
    try {
      await ensureData(rosterCatIds(raw));
    } catch (e) { return showError(e); }
    roster = new Roster(data, raw);
    habits = buildHabits(loadLists(), raw.id, loadPresets());
    issues = roster.validate();
    return render();
  }
  if (h === 'new') { roster = null; return renderNew(); }
  roster = null;
  renderHome();
}

function showError(e) {
  app.innerHTML = `<div class="wrap hero"><h2>Couldn't load the data</h2><p>${esc(e.message || e)}</p>
  <p class="hint">Check your connection and try again. The files come from github.com.</p>
  <div class="row" style="margin-top:14px"><button class="btn primary" data-act="reload">Try again</button><a class="btn ghost" href="#">Back to lists</a></div></div>`;
}

async function importShared(code) {
  try {
    const raw = await decodeShare(code);
    const existing = loadLists().find(l => l.id === raw.id);
    if (existing) raw.id = raw.id + '-' + Math.random().toString(36).slice(2, 6);
    raw.name = raw.name || 'Shared list';
    upsertList(raw);
    toast('List added to your lists');
    location.replace('#list-' + raw.id);
  } catch (e) {
    toast('That share link is damaged');
    location.replace('#');
  }
}

// ---------- home ----------
function renderHome() {
  const lists = loadLists();
  const facName = (id) => MANIFEST.find(m => m.id === id)?.name || 'Unknown faction';
  app.innerHTML = `
  <div class="bar"><div class="wrap"><div class="brand">${icon.shield}<h1>Heresy Muster</h1></div></div></div>
  <main class="wrap">
    <section class="hero">
      <h2>Your army lists</h2>
      <p>Horus Heresy 3rd edition lists built on the community data, frozen at one version so the rules text stays as it was.</p>
    </section>
    <div class="row"><a class="btn primary" href="#new">New list</a>
      <label class="btn ghost" for="import-file">Open a list file</label><input id="import-file" type="file" accept=".json,application/json" hidden></div>
    <div class="lists">
      ${lists.length ? lists.map(l => `
        <button class="list-card" data-act="open" data-id="${esc(l.id)}">
          <span class="name">${esc(l.name)}</span>
          <span class="meta">${esc(facName(l.catalogueId))} · ${new Date(l.updated || l.created).toLocaleDateString()}</span>
          <span class="pts">${esc(l.limits?.[POINTS_ID] ?? '')} pts</span>
        </button>`).join('') : `<div class="empty">No lists yet. Start one with <strong>New list</strong>, or open a list a friend sent you.</div>`}
    </div>
    <div class="footnote">
      Data: <a href="https://github.com/${DATA_REPO}/tree/${DATA_COMMIT}" target="_blank" rel="noopener">${DATA_REPO}</a>
      at commit <code>${DATA_COMMIT.slice(0, 7)}</code> (${DATA_DATE}). Lists are saved in this browser only.
      <div class="row" style="margin-top:10px"><button class="btn small ghost" data-act="clear-cache">Re-download data</button></div>
    </div>
  </main>`;
  document.getElementById('import-file').addEventListener('change', importFile);
}

async function importFile(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    if (!raw.forces || !raw.catalogueId) throw new Error('not a list');
    if (loadLists().some(l => l.id === raw.id)) raw.id = raw.id + '-' + Math.random().toString(36).slice(2, 6);
    upsertList(raw);
    location.hash = 'list-' + raw.id;
  } catch {
    toast('That file is not a Heresy Muster list');
  }
}

// ---------- new list ----------
function renderNew() {
  const defaultFaction = FACTIONS.find(f => f.name.includes('Ultramarines'))?.id || FACTIONS[0].id;
  app.innerHTML = `
  <div class="bar"><div class="wrap"><a class="icon-btn" href="#" aria-label="Back">${icon.back}</a><h1>New list</h1></div></div>
  <main class="wrap" style="padding-block:20px">
    <form id="new-form">
      <div class="field"><label for="nl-name">Name</label><input id="nl-name" required value="New army" maxlength="80"></div>
      <div class="field"><label for="nl-fac">Faction</label>
        <select id="nl-fac">${FACTIONS.map(f => `<option value="${f.id}" ${f.id === defaultFaction ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="nl-pts">Points limit</label><input id="nl-pts" type="number" inputmode="numeric" min="0" step="50" value="${DEFAULT_POINTS}"></div>
      <div class="field"><label for="nl-force">Army type</label>
        <select id="nl-force"><option value="crusade">Crusade Force Organization Chart</option><option value="zm">Zone Mortalis</option><option value="none">Start empty</option></select></div>
      <button class="btn primary" type="submit">Create list</button>
    </form>
  </main>`;
  document.getElementById('new-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = newRosterRaw({
      name: document.getElementById('nl-name').value.trim() || 'New army',
      catalogueId: document.getElementById('nl-fac').value,
      gameSystemId: GS.id,
      points: Number(document.getElementById('nl-pts').value) || 0,
    });
    const kind = document.getElementById('nl-force').value;
    try { await ensureData([raw.catalogueId]); } catch (err) { return showError(err); }
    const r = new Roster(data, raw);
    const choice = r.childForceChoices(r.root).find(c => kind === 'zm' ? c.node.name === 'Zone Mortalis' : c.node.name.startsWith('Crusade'));
    if (kind !== 'none' && choice) r.addForce(r.root, choice.node);
    upsertList(raw);
    location.hash = 'list-' + raw.id;
  });
}

// ---------- roster view ----------
function rootUnitOf(obj) {
  let s = obj;
  while (s && s.kind === 'sel' && s.parent?.kind === 'sel') s = s.parent;
  return s;
}

function issuesFor(obj) {
  return issues.filter(i => i.where && (i.where === obj || rootUnitOf(i.where) === obj));
}

// Limits the data keeps as hidden costs, e.g. how many Auxiliary or Apex detachments are allowed.
function allowanceChips(f) {
  const st = roster.forceState(f);
  if (!st) return '';
  const out = [];
  for (const c of st.constraints) {
    const field = c.field || 'selections';
    if (c.type !== 'max' || field === 'selections' || field === 'forces' || field === POINTS_ID || field.startsWith('limit::')) continue;
    const used = roster.count({ ...c, childId: c.owner }, { self: f, parent: f.parent, force: f });
    const name0 = roster.costName(field);
    if (!used && (!c.value || !/detachment/i.test(name0))) continue;
    const name = name0.replace(/\(s\)$/, 's');
    out.push(`<span class="slot ${used > c.value ? 'over' : used === c.value ? 'full' : ''}" title="${esc(name)} used / allowed">${esc(name)} ${pts(used)}/${pts(c.value)}</span>`);
  }
  return out.join('');
}

function slotChips(f) {
  const out = [allowanceChips(f)];
  for (const s of roster.slots(f)) {
    if (s.state.hidden) continue;
    let max = -1, min = 0, n = 0;
    for (const c of s.state.constraints) {
      if ((c.field || 'selections') !== 'selections') continue;
      const cnt = roster.count({ ...c, childId: c.owner }, { self: null, parent: f, force: f });
      if (c.type === 'max') { max = c.value; n = cnt; }
      if (c.type === 'min') { min = c.value; n = Math.max(n, cnt); }
    }
    if (n === 0 && max === 0) continue;
    if (n === 0 && max < 0 && min === 0) continue;
    const cls = max >= 0 && n > max ? 'over' : n < min ? 'need' : (max >= 0 && n === max ? 'full' : '');
    out.push(`<span class="slot ${cls}" title="${esc(s.state.name)}">${esc(s.state.name)} ${n}${max >= 0 ? '/' + max : ''}</span>`);
  }
  return out.join('');
}

function unitSummary(sel) {
  const parts = [];
  for (const c of sel.children) {
    const st = roster.selState(c);
    if (c.node.type === 'model') parts.push(`${c.number}× ${st.name}`);
  }
  if (!parts.length) {
    for (const c of sel.children.slice(0, 4)) parts.push(roster.selState(c).name);
  }
  return parts.join(', ');
}

function presetForm(key, act, uid, suggested) {
  return `<form class="preset-form" data-preset-form="${act}" data-uid="${uid}">
    <label for="pn-${esc(key)}">Preset name</label>
    <div class="row"><input id="pn-${esc(key)}" value="${esc(suggested)}" maxlength="60" required>
    <button class="btn small primary" type="submit">Save preset</button><button class="btn small ghost" type="button" data-act="cancel-name">Cancel</button></div></form>`;
}

function renderForce(f, depth) {
  const st = roster.forceState(f);
  const collapsed = !!f.raw.collapsed;
  const kids = f.node?.childForces().length;
  const forceIssues = issues.filter(i => i.where === f);
  const ownIssues = issues.filter(i => i.where && (i.where === f || (i.where.kind === 'sel' && i.where.force === f)));
  const foreign = f.catalogueId !== roster.raw.catalogueId && f.parent.kind === 'roster' ? ` · ${esc(data.catalogueName(f.catalogueId))}` : '';
  const ck = 'rmf-' + f.uid;
  const nk = 'pf-' + f.uid;
  let body = '';
  if (collapsed) {
    const errs = ownIssues.filter(i => i.level === 'error').length;
    body = `<button class="collapsed-sum" data-act="toggle-force" data-uid="${f.uid}">
      ${f.sels.length} ${f.sels.length === 1 ? 'entry' : 'entries'}${errs ? ` · <span class="err-text">${errs} issue${errs > 1 ? 's' : ''}</span>` : ''} · tap to open</button>
      ${kids ? `<div class="row force-actions"><button class="btn small ghost" data-act="add-det" data-uid="${f.uid}">Add detachment</button></div>` : ''}`;
  } else {
    const units = f.sels.map(s => {
      const st2 = roster.selState(s);
      const iss = issuesFor(s);
      const cls = iss.some(i => i.level === 'error') ? 'has-err' : iss.length ? 'has-warn' : '';
      const cat = st2.primary ? data.categoryName(st2.primary, f.catalogueId) : '';
      return `<button class="unit ${cls}" data-act="unit" data-uid="${s.uid}">
        <span class="uname">${s.number > 1 ? s.number + '× ' : ''}${esc(st2.name)}</span>
        <span class="upts">${pts(roster.selTotal(s, POINTS_ID))}</span>
        <span class="usub">${esc(unitSummary(s))}</span>
        <span class="ucat">${esc(cat)}</span></button>`;
    }).join('');
    const canAddUnits = roster.slots(f).some(s => !s.state.hidden);
    const canSave = f.parent.kind === 'force' && f.sels.length > 0;
    body = `<div class="slots">${slotChips(f)}</div>
    ${forceIssues.length ? `<div class="msgs">${forceIssues.slice(0, 6).map(i => `<div class="msg ${i.level}">${esc(i.msg)}</div>`).join('')}${forceIssues.length > 6 ? `<div class="hint">and ${forceIssues.length - 6} more in the issues list</div>` : ''}</div>` : ''}
    ${units}
    ${namingKey === nk ? presetForm(nk, 'save-det-preset', f.uid, st?.name || f.name) : ''}
    <div class="row force-actions">
      ${canAddUnits ? `<button class="btn small" data-act="add-unit" data-uid="${f.uid}">Add unit</button>` : ''}
      ${kids ? `<button class="btn small ghost" data-act="add-det" data-uid="${f.uid}">Add detachment</button>` : ''}
      ${canSave && namingKey !== nk ? `<button class="btn small ghost" data-act="name-det-preset" data-uid="${f.uid}">Save as preset</button>` : ''}
    </div>`;
  }
  return `<section class="force ${depth ? 'child' : ''} ${collapsed ? 'is-collapsed' : ''}">
    <header>
      <button class="fold" data-act="toggle-force" data-uid="${f.uid}" aria-expanded="${!collapsed}" aria-label="${collapsed ? 'Open' : 'Collapse'} ${esc(f.name)}">${collapsed ? icon.right : icon.down}</button>
      <h3>${esc(st?.name || f.name)}${foreign}</h3><span class="fpts">${pts(roster.forceTotal(f))} pts</span>
      <button class="icon-btn" data-act="force-menu" data-uid="${f.uid}" aria-label="Remove ${esc(f.name)}">${icon.close}</button></header>
    ${confirmKey === ck ? `<div class="confirm">Remove ${esc(f.name)} and everything in it? <div class="row" style="margin-top:8px"><button class="btn small danger" data-act="rm-force" data-uid="${f.uid}">Remove</button><button class="btn small ghost" data-act="cancel">Keep</button></div></div>` : ''}
    ${body}
    ${f.forces.length ? `<div class="children">${f.forces.map(cf => renderForce(cf, depth + 1)).join('')}</div>` : ''}
  </section>`;
}

function render() {
  if (!roster) return;
  const total = roster.total();
  const limit = roster.raw.limits[POINTS_ID] || 0;
  const errs = issues.filter(i => i.level === 'error').length;
  const warns = issues.length - errs;
  app.innerHTML = `
  <div class="bar"><div class="wrap">
    <a class="icon-btn" href="#" aria-label="All lists">${icon.back}</a>
    <h1>${esc(roster.raw.name)}</h1>
    <span class="points ${limit && total > limit ? 'over' : ''}">${pts(total)}${limit ? '/' + limit : ''}</span>
    <button class="chip-err ${errs ? '' : 'ok'}" data-act="issues">${errs ? errs + ' issue' + (errs > 1 ? 's' : '') : warns ? warns + ' note' + (warns > 1 ? 's' : '') : 'Valid'}</button>
    <button class="icon-btn" data-act="list-menu" aria-label="List options">${icon.menu}</button>
  </div></div>
  <main class="wrap">
    <p class="hint" style="margin-top:12px">${esc(data.catalogueName(roster.raw.catalogueId))}</p>
    ${roster.root.forces.map(f => renderForce(f, 0)).join('')}
    <div class="row" style="margin-block:22px 60px"><button class="btn" data-act="add-top">Add force</button></div>
  </main>`;
  renderSheet();
}

// ---------- sheets ----------
function openSheet(s) { sheet = s; renderSheet(); }
function closeSheet(rerender = true) {
  sheet = null; sheetRoot.innerHTML = '';
  document.body.style.overflow = '';
  if (rerender && roster) render();
}

function renderSheet() {
  if (!sheet) { sheetRoot.innerHTML = ''; document.body.style.overflow = ''; return; }
  document.body.style.overflow = 'hidden';
  let title = '', body = '', head = '';
  try {
    ({ title, body, head = '' } = sheetContent());
  } catch (e) {
    console.error(e);
    title = 'Something went wrong'; body = `<p>${esc(e.message)}</p>`;
  }
  if (title === null) { closeSheet(); return; }
  const prevScroll = sheetRoot.querySelector('.sheet-body')?.scrollTop || 0;
  const sameSheet = sheetRoot.dataset.key === sheetKey();
  sheetRoot.innerHTML = `<div class="scrim" data-act="close-sheet"></div>
   <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}" ${sameSheet ? 'style="animation:none"' : ''}>
     <div class="sheet-head">${sheet.back ? `<button class="icon-btn" data-act="sheet-back" aria-label="Back">${icon.back}</button>` : ''}<h2>${esc(title)}</h2>${head}<button class="icon-btn" data-act="close-sheet" aria-label="Close">${icon.close}</button></div>
     <div class="sheet-body">${body}</div></div>`;
  sheetRoot.dataset.key = sheetKey();
  const sb = sheetRoot.querySelector('.sheet-body');
  if (sameSheet) sb.scrollTop = prevScroll;
  const search = sheetRoot.querySelector('.search');
  if (search) {
    search.value = sheet.q || '';
    search.addEventListener('input', () => { sheet.q = search.value; filterPicks(search.value); });
    filterPicks(search.value);
  }
}

function sheetKey() { return sheet ? sheet.type + ':' + (sheet.uid || '') + ':' + (sheet.ruleKey || '') : ''; }

function filterPicks(q) {
  q = q.trim().toLowerCase();
  for (const g of sheetRoot.querySelectorAll('.pick-group')) {
    let any = false;
    for (const p of g.querySelectorAll('.pick')) {
      const hit = !q || p.dataset.name.includes(q);
      p.hidden = !hit; any ||= hit;
    }
    g.hidden = !any;
  }
}

function findSel(uid) { return roster.allSels.find(s => s.uid === uid); }
function findForce(uid) { return roster.allForces.find(f => f.uid === uid); }

function sheetContent() {
  switch (sheet.type) {
    case 'add-unit': return addUnitSheet();
    case 'add-det': return addDetSheet();
    case 'add-top': return addTopSheet();
    case 'unit': return unitSheet();
    case 'rule': return ruleSheet();
    case 'issues': return issuesSheet();
    case 'list-menu': return listMenuSheet();
    case 'export': return exportSheet();
  }
  return { title: null };
}

function presetRows(list, act) {
  if (!list.length) return '';
  return `<div class="pick-group"><h4>Your presets</h4>${list.map(p => {
    const ck = 'rmp-' + p.id;
    if (confirmKey === ck) return `<div class="confirm">Delete preset “${esc(p.name)}”?<div class="row" style="margin-top:8px"><button class="btn small danger" data-act="rm-preset" data-id="${p.id}">Delete</button><button class="btn small ghost" data-act="cancel">Keep</button></div></div>`;
    return `<div class="preset-row"><button class="pick" data-act="${act}" data-id="${p.id}" data-name="${esc((p.name + ' ' + p.what).toLowerCase())}">
      <span>${esc(p.name)}<span class="hint"> · ${esc(p.what)}</span></span><span class="pp">${pts(p.points || 0)}</span></button>
      <button class="icon-btn" data-act="ask-rm-preset" data-id="${p.id}" aria-label="Delete preset ${esc(p.name)}">${icon.close}</button></div>`;
  }).join('')}</div>`;
}

function addUnitSheet() {
  const f = findForce(sheet.uid);
  if (!f) return { title: null };
  const choices = roster.rootChoices(f);
  const order = roster.slots(f).map(s => s.categoryId);
  const groups = new Map();
  for (const c of choices) {
    if (!groups.has(c.categoryId)) groups.set(c.categoryId, []);
    groups.get(c.categoryId).push(c);
  }
  const keys = [...groups.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const keysOk = new Set(choices.map(c => c.node.key));
  const presets = loadPresets().filter(p => p.kind === 'unit' && p.catalogueId === f.catalogueId && keysOk.has(p.key));
  let suggested = '';
  if (habits?.listCount) {
    // Leave out army configuration entries; they are in every list.
    const isConfig = (x) => x.force.parent.kind === 'roster' && x.force.forces.length > 0;
    const current = [...new Set(roster.allSels.filter(x => x.parent.kind === 'force' && !isConfig(x)).map(x => unitId(x.force.catalogueId, x.raw)))];
    const cands = choices.map(c => ({ id: f.catalogueId + '|' + c.node.key, key: c.node.key, name: c.state.name, cost: c.state.costs.get(POINTS_ID) }));
    const sug = suggestUnits(habits, current, cands);
    if (sug.length) suggested = `<div class="pick-group"><h4>From your lists</h4>${sug.map(c => `<button class="pick" data-act="pick-unit" data-key="${esc(c.key)}" data-name="${esc(c.name.toLowerCase())}">
      <span>${esc(c.name)}<span class="hint sub-reason">${esc(c.reason)}</span></span><span class="pp">${c.cost ? pts(c.cost) : ''}</span></button>`).join('')}</div>`;
  }
  const body = `<input class="search" type="search" placeholder="Search units" aria-label="Search units">
    ${presetRows(presets, 'pick-unit-preset')}
    ${suggested}
    ${keys.map(k => `<div class="pick-group"><h4>${esc(data.categoryName(k, f.catalogueId))}</h4>
      ${groups.get(k).sort((a, b) => a.state.name.localeCompare(b.state.name)).map(c => {
        const cost = c.state.costs.get(POINTS_ID);
        return `<button class="pick" data-act="pick-unit" data-key="${esc(c.node.key)}" data-name="${esc(c.state.name.toLowerCase())}"><span>${esc(c.state.name)}</span><span class="pp">${cost ? pts(cost) : ''}</span></button>`;
      }).join('')}</div>`).join('') || '<p class="hint">Nothing can be added here with the current choices.</p>'}`;
  return { title: 'Add to ' + f.name, body };
}

function addDetSheet() {
  const f = findForce(sheet.uid);
  if (!f) return { title: null };
  const choices = roster.childForceChoices(f);
  const okKeys = new Set(choices.map(c => c.node.key));
  const presets = loadPresets().filter(p => p.kind === 'detachment' && p.catalogueId === f.catalogueId && okKeys.has(p.key));
  const body = `<input class="search" type="search" placeholder="Search detachments" aria-label="Search detachments">
    ${presetRows(presets, 'pick-det-preset')}
    <div class="pick-group">${choices.map(c => `<button class="pick" data-act="pick-det" data-key="${esc(c.node.key)}" data-name="${esc(c.state.name.toLowerCase())}"><span>${esc(c.state.name)}</span><span class="pp"></span></button>`).join('')}</div>`;
  return { title: 'Add detachment', body };
}

function addTopSheet() {
  const choices = roster.childForceChoices(roster.root);
  const cur = sheet.cat || roster.raw.catalogueId;
  const body = `<div class="field"><label for="top-cat">Faction for this force</label>
    <select id="top-cat" data-act-change="top-cat">${FACTIONS.map(f => `<option value="${f.id}" ${f.id === cur ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
    <span class="hint">Pick a different faction for an allied detachment.</span></div>
    <div class="pick-group">${choices.map(c => `<button class="pick" data-act="pick-top" data-key="${esc(c.node.key)}" data-name="${esc(c.state.name.toLowerCase())}"><span>${esc(c.state.name)}</span></button>`).join('')}</div>`;
  return { title: 'Add force', body };
}

function costLabel(st, number = 1) {
  const c = st.costs.get(POINTS_ID);
  return c ? `${c > 0 ? '+' : ''}${pts(c * number)}` : '';
}

function limitText(l) {
  if (l.max < 0 && !l.min) return '';
  if (l.min === l.max) return `${l.min}`;
  if (l.max < 0) return `${l.min}+`;
  return `${l.min}–${l.max}`;
}

// Render the options under a parent selection.
function renderOptions(parent, depth = 0) {
  const items = roster.options(parent);
  return `<div class="opts">${renderItems(parent, items, depth)}</div>`;
}

// ctx: { radio: id of the enclosing one-of group or null, room: limits of enclosing groups }
function renderItems(parent, items, depth, ctx = { radio: null, room: [] }) {
  return items.map(it => {
    const visible = (!it.state.hidden && roster.limitsOf(it.state).max !== 0) || it.count > 0;
    if (!visible) return '';
    return it.kind === 'group' ? renderGroup(parent, it, depth, ctx) : renderEntry(parent, it, depth, ctx);
  }).join('');
}

// ---------- condensed weapon profiles ----------
const MELEE_MOD = { IM: 'I', AM: 'A', SM: 'S' };

// Resolve a melee modifier ("+1", "-2", "A", "x2", "6") against a model's stat.
function applyMod(mod, base) {
  const m = String(mod ?? '').trim();
  const b = parseInt(base, 10);
  if (!Number.isFinite(b)) return m;
  if (/^[IAS]$/i.test(m)) return String(b);
  if (/^[+-]\d+$/.test(m)) return String(Math.max(1, b + parseInt(m, 10)));
  if (/^[x×]\d+$/i.test(m)) return String(b * parseInt(m.slice(1), 10));
  return m;
}

// The models that would carry an option chosen under `parent`, grouped by their I/A/S.
function carriers(parent) {
  let p = parent;
  while (p && p.kind === 'sel' && p.node.type !== 'model' && p.node.type !== 'unit') p = p.parent;
  if (!p || p.kind !== 'sel') return [];
  const models = p.node.type === 'model' ? [p] : (p.children.filter(c => c.node.type === 'model').length ? p.children.filter(c => c.node.type === 'model') : [p]);
  const groups = new Map();
  for (const m of models) {
    const prof = roster.infoFor(m).profiles.map(x => x.view).find(v => ['I', 'A', 'S'].every(k => v.chars.some(c => c.name === k)));
    if (!prof) continue;
    const stat = (k) => prof.chars.find(c => c.name === k)?.value;
    const key = `${stat('I')}|${stat('A')}|${stat('S')}`;
    const name = roster.selState(m).name;
    if (!groups.has(key)) groups.set(key, { I: stat('I'), A: stat('A'), S: stat('S'), names: [] });
    if (!groups.get(key).names.includes(name)) groups.get(key).names.push(name);
  }
  return [...groups.values()];
}

// One line per weapon profile; melee lines resolved per distinct carrier.
function weaponSummary(parent, it) {
  const ctx = { self: null, parent, force: parent.force, node: it.node, groupIds: it.groups.flatMap(g => g.ids) };
  const profs = it.node.info().profiles
    .filter(p => /weapon/i.test(p.obj.typeName || ''))
    .map(p => ({ type: p.obj.typeName, view: roster.profileView(p.obj, ctx, [], p.via) }))
    .filter(p => !p.view.hidden);
  if (!profs.length) return '';
  const fmtChars = (chars) => chars.filter(c => c.value !== '')
    .map(c => /special|trait/i.test(c.name) ? (c.value && c.value !== '-' ? `<span class="wp-rules">${esc(c.value)}</span>` : '') : `<span class="wp-stat"><b>${esc(c.name)}</b> ${esc(c.value)}</span>`)
    .join('');
  const lines = [];
  const holders = carriers(parent);
  for (const p of profs) {
    const label = profs.length > 1 ? `<span class="wp-name">${esc(p.view.name)}</span>` : '';
    const isMelee = p.view.chars.some(c => MELEE_MOD[c.name]);
    if (isMelee && holders.length) {
      // Merge carriers whose resolved numbers come out the same.
      const byResult = new Map();
      for (const h of holders) {
        const chars = p.view.chars.map(c => MELEE_MOD[c.name] ? { name: MELEE_MOD[c.name], value: applyMod(c.value, h[MELEE_MOD[c.name]]) } : c);
        const key = chars.map(c => c.value).join('|');
        if (!byResult.has(key)) byResult.set(key, { chars, names: [] });
        byResult.get(key).names.push(...h.names);
      }
      for (const r of byResult.values()) {
        const who = byResult.size > 1 ? `<span class="wp-who">${esc(r.names.join(', '))}</span>` : '';
        lines.push(`<div class="wp-line">${label}${who}${fmtChars(r.chars)}</div>`);
      }
    } else {
      lines.push(`<div class="wp-line">${label}${fmtChars(p.view.chars)}</div>`);
    }
  }
  return lines.join('');
}

// Same chain format habits.js records: each selection's path, joined by '>' from the unit down.
function optionChain(parent, it) {
  const parts = [];
  for (let p = parent; p && p.kind === 'sel' && p.parent?.kind === 'sel'; p = p.parent) parts.unshift(p.raw.path.join('/'));
  parts.push(it.groups.map(g => g.key).concat([it.node.key]).join('/'));
  return parts.join('>');
}

function itemId(parent, it) { return parent.uid + ':' + it.groups.map(g => g.key).join('/') + '/' + it.node.key; }

function hasVisibleEntries(it) {
  return it.children.some(c => ((!c.state.hidden && roster.limitsOf(c.state).max !== 0) || c.count > 0) && (c.kind === 'entry' || hasVisibleEntries(c)));
}

function renderGroup(parent, it, depth, ctx) {
  const l = roster.limitsOf(it.state);
  const gid = itemId(parent, it);
  let inner;
  if (ctx.radio) {
    // Already inside a one-of group: just a sub-heading.
    inner = renderItems(parent, it.children, depth, ctx);
  } else if (l.max === 1 && hasVisibleEntries(it)) {
    // One choice across everything in this group, however deeply nested.
    const none = l.min === 0 ? `<div class="opt"><label><input type="radio" name="${esc(gid)}" data-act="radio" data-parent="${parent.uid}" data-group="${esc(gid)}" data-item="" ${it.count === 0 ? 'checked' : ''}><span class="oname">None</span></label></div>` : '';
    inner = none + renderItems(parent, it.children, depth, { radio: gid, room: ctx.room });
  } else {
    const room = l.max >= 0 ? ctx.room.concat([{ max: l.max, count: it.count }]) : ctx.room;
    inner = renderItems(parent, it.children, depth, { radio: null, room });
  }
  if (!inner.trim()) return '';
  const lt = ctx.radio ? '' : limitText(l);
  return `<fieldset class="ogroup"><legend>${esc(it.state.name)}${lt ? `<span class="lim">${lt}</span>` : ''}</legend>${inner}</fieldset>`;
}

function renderEntry(parent, it, depth, ctx) {
  const l = roster.limitsOf(it.state);
  const id = itemId(parent, it);
  const name = esc(it.state.name);
  const hiddenCls = it.state.hidden ? 'hiddenopt' : '';
  // How many of this entry fit, given its own limit and every enclosing group's limit.
  let cap = l.max >= 0 ? l.max : Infinity;
  for (const g of ctx.room) cap = Math.min(cap, g.max - g.count + it.count);
  let control;
  if (ctx.radio) {
    control = `<label><input type="radio" name="${esc(ctx.radio)}" data-act="radio" data-parent="${parent.uid}" data-group="${esc(ctx.radio)}" data-item="${esc(id)}" ${it.count > 0 ? 'checked' : ''}><span class="oname">${name}</span></label>`;
  } else if (l.max === 1 && it.node.type !== 'model') {
    const locked = (l.min >= 1 && it.count >= 1) || (it.count === 0 && cap < 1);
    control = `<label><input type="checkbox" data-act="check" data-parent="${parent.uid}" data-item="${esc(id)}" ${it.count > 0 ? 'checked' : ''} ${locked ? 'disabled' : ''}><span class="oname">${name}</span></label>`;
  } else {
    control = `<label><span class="oname">${name}</span></label>
      <span class="stepper"><button data-act="step" data-d="-1" data-parent="${parent.uid}" data-item="${esc(id)}" ${it.count <= 0 ? 'disabled' : ''} aria-label="Fewer ${name}">−</button><output>${it.count}</output><button data-act="step" data-d="1" data-parent="${parent.uid}" data-item="${esc(id)}" ${it.count >= cap ? 'disabled' : ''} aria-label="More ${name}">+</button></span>`;
  }
  const cost = costLabel(it.state);
 // Tag only real choices: not mandatory gear or the default pick.
  const isDefault = l.min > 0 || it.state.defaultAmount > 0 || it.groups.some(g => g.target.defaultSelectionEntryId && it.node.ids.includes(g.target.defaultSelectionEntryId));
  const usualTag = !isDefault && usualHere && usualHere.size && usualHere.has(optionChain(parent, it)) ? '<span class="usual-tag" title="You take this in most of your builds of this unit">usual</span>' : '';
  const wsum = weaponSummary(parent, it);
  const winfo = wsum ? `<button class="winfo" type="button" data-act="winfo" aria-label="Show ${name} profile" aria-expanded="false">i</button>` : '';
  let html = `<div class="opt ${hiddenCls}${wsum ? ' has-wp' : ''}">${control}${usualTag}${winfo}<span class="ocost">${cost}</span>${wsum ? `<div class="wprof">${wsum}</div>` : ''}</div>`;
  // Nested options of the chosen entry (e.g. a model's wargear).
  if (depth < 4) {
    for (const s of it.sels || []) {
      const sub = roster.options(s);
      const hasVisible = sub.some(x => !x.state.hidden || x.count > 0);
      if (!hasVisible) continue;
      const many = s.number > 1;
      html += `<div class="sub"><div class="sub-title"><span class="grow">${esc(roster.selState(s).name)}${many ? ` ×${s.number}` : ''}</span>
        ${many ? `<button class="btn small ghost" data-act="split" data-uid="${s.uid}">Change one</button>` : ''}
        ${(it.sels.length > 1) ? `<button class="btn small ghost danger" data-act="rm-sel" data-uid="${s.uid}">Remove</button>` : ''}</div>
        ${many ? `<div class="hint">Choices here apply to all ${s.number}.</div>` : ''}
        ${renderOptions(s, depth + 1)}</div>`;
    }
  }
  return html;
}

function findItem(parentUid, itemKey) {
  const parent = findSel(parentUid);
  if (!parent) return {};
  let hit = null;
  const walk = (items) => { for (const it of items) { if (itemId(parent, it) === itemKey) hit = it; if (it.children) walk(it.children); } };
  walk(roster.options(parent));
  return { parent, item: hit };
}

function collectInfo(sel) {
  const profiles = new Map(), rules = new Map();
  const walk = (s) => {
    const info = roster.infoFor(s);
    for (const p of info.profiles) {
      const key = p.view.name + '|' + (p.obj.typeName || '');
      if (!profiles.has(key)) profiles.set(key, p);
    }
    for (const r of info.rules) if (!rules.has(r.view.name)) rules.set(r.view.name, r);
    s.children.forEach(walk);
  };
  walk(sel);
  return { profiles: [...profiles.values()], rules: [...rules.values()] };
}

function renderProfiles(list) {
  const byType = new Map();
  for (const p of list) {
    const t = p.obj.typeName || 'Profile';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(p);
  }
  let html = '';
  for (const [type, ps] of byType) {
    // Stat lines (weapons, units, vehicles) stay tables; long cells wrap.
    // Only text-style profiles (few fields, or paragraphs of rules) become cards.
    const nChars = ps[0].view.chars.length;
    const long = nChars <= 2 || ps.some(p => p.view.chars.some(c => String(c.value).length > 150));
    if (long) {
      html += ps.map(p => `<div class="longprof"><h4>${esc(p.view.name)} <span class="hint">· ${esc(type)}</span></h4><dl>${p.view.chars.filter(c => c.value !== '').map(c => `<dt>${esc(c.name)}</dt><dd>${richText(c.value)}</dd>`).join('')}</dl></div>`).join('');
      continue;
    }
    const cols = ps[0].view.chars.map(c => c.name);
    html += `<div class="table-scroll"><table class="stats"><thead><tr><th>${esc(type)}</th>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
      ${ps.map(p => `<tr><td>${esc(p.view.name)}</td>${cols.map(cn => { const v = p.view.chars.find(c => c.name === cn)?.value ?? ''; const long = String(v).length > 14 || (String(v).length > 6 && /[a-z]{3}/i.test(v));
          const words = /[a-z]{2}/i.test(v);
          return `<td class="${long ? 'wrap' : words ? 'txt' : ''}">${esc(v)}</td>`; }).join('')}</tr>`).join('')}
    </tbody></table></div>`;
  }
  return html;
}

function unitSheet() {
  const sel = findSel(sheet.uid);
  if (!sel) return { title: null };
  const st = roster.selState(sel);
  const iss = issuesFor(sel);
  const info = collectInfo(sel);
  const ck = 'rmu-' + sel.uid;
  const hid = unitId(sel.force.catalogueId, sel.raw);
  const usual = habits ? usualLoadout(habits, hid) : null;
  const showUsual = usual && JSON.stringify(JSON.parse(loadoutSig({ selections: usual.selections }))) !== loadoutSig(sel.raw);
  usualHere = habits ? usualOptions(habits, hid) : null;
  sheet.rules = info.rules;
  const body = `
    <div class="ustat"><span class="points">${pts(roster.selTotal(sel, POINTS_ID))} pts</span>
      <span class="hint">${esc(st.primary ? data.categoryName(st.primary, sel.force.catalogueId) : '')} · ${esc(sel.force.name)}</span></div>
    ${iss.length ? `<div class="msgs">${iss.map(i => `<div class="msg ${i.level}">${esc(i.msg)}</div>`).join('')}</div>` : ''}
    ${showUsual ? `<div class="usual-bar"><span>${usual.preset ? `Your preset “${esc(usual.preset)}” has a different loadout.` : `You've built this unit the same way ${usual.count} times.`}</span><button class="btn small" data-act="apply-usual" data-uid="${sel.uid}">${usual.preset ? 'Use preset loadout' : 'Use your usual loadout'}</button></div>` : ''}
    ${renderOptions(sel)}
    <h3 class="sec">Profiles</h3>${renderProfiles(info.profiles) || '<p class="hint">No profiles.</p>'}
    <h3 class="sec">Rules</h3><div class="rules">${info.rules.map((r, i) => `<button class="rule-chip" data-act="rule" data-i="${i}">${esc(r.view.name)}</button>`).join('') || '<span class="hint">No rules listed.</span>'}</div>
    <h3 class="sec">Unit</h3>
    ${confirmKey === ck ? `<div class="confirm">Remove ${esc(st.name)}?<div class="row" style="margin-top:8px"><button class="btn small danger" data-act="rm-unit" data-uid="${sel.uid}">Remove</button><button class="btn small ghost" data-act="cancel">Keep</button></div></div>` : ''}
    ${namingKey === 'pu-' + sel.uid ? presetForm('pu-' + sel.uid, 'save-unit-preset', sel.uid, st.name) : ''}
    <div class="row"><button class="btn small" data-act="dup" data-uid="${sel.uid}">Duplicate</button>${namingKey === 'pu-' + sel.uid ? '' : `<button class="btn small" data-act="name-unit-preset" data-uid="${sel.uid}">Save as preset</button>`}<button class="btn small danger" data-act="ask-rm-unit" data-uid="${sel.uid}">Remove</button></div>`;
  return { title: st.name, body };
}

function ruleSheet() {
  const r = sheet.rule;
  const pub = r.obj.publicationId ? data.resolve(r.obj.publicationId, roster?.raw.catalogueId) : null;
  const src = [pub?.shortName || pub?.name, r.view.page ? 'p. ' + r.view.page : ''].filter(Boolean).join(', ');
  const body = `<div class="ruletext">${richText(r.view.description || 'No text in the data for this rule.')}${src ? `<p class="src">${esc(src)}</p>` : ''}</div>`;
  return { title: r.view.name, body };
}

function issuesSheet() {
  const body = issues.length ? `<div class="msgs">${issues.map((i, n) => `<button class="msg ${i.level}" data-act="goto-issue" data-i="${n}">${esc(i.msg)}${i.where ? `<div class="hint">${esc(i.where.kind === 'sel' ? roster.selState(rootUnitOf(i.where)).name : i.where.name || '')}</div>` : ''}</button>`).join('')}</div>` : '<p>No problems found. This list follows every rule the data checks.</p>';
  return { title: 'Issues', body };
}

function listMenuSheet() {
  const limit = roster.raw.limits[POINTS_ID] || 0;
  const ck = 'rml';
  const body = `
    <div class="field"><label for="lm-name">List name</label><input id="lm-name" value="${esc(roster.raw.name)}" maxlength="80"></div>
    <div class="field"><label for="lm-pts">Points limit</label><input id="lm-pts" type="number" inputmode="numeric" min="0" step="50" value="${limit}"></div>
    <div class="row"><button class="btn primary" data-act="save-meta">Save</button></div>
    <h3 class="sec">Share</h3>
    <div class="row"><button class="btn" data-act="export-text">Copy as text</button><button class="btn" data-act="share-link">Copy share link</button><button class="btn" data-act="download">Download list file</button></div>
    <p class="hint">A share link carries the whole list. Anyone who opens it gets their own copy.</p>
    <h3 class="sec">Delete</h3>
    ${confirmKey === ck ? `<div class="confirm">Delete this list for good?<div class="row" style="margin-top:8px"><button class="btn small danger" data-act="rm-list">Delete</button><button class="btn small ghost" data-act="cancel">Keep</button></div></div>` : `<button class="btn danger" data-act="ask-rm-list">Delete list</button>`}`;
  return { title: 'List options', body };
}

function exportSheet() {
  return { title: 'List as text', body: `<textarea class="export" readonly>${esc(rosterText(roster))}</textarea><div class="row" style="margin-top:10px"><button class="btn primary" data-act="copy-text">Copy</button></div>` };
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); return true; }
  catch { return false; }
}

// ---------- events ----------
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (el.tagName === 'INPUT' || el.tagName === 'SELECT') return; // handled on change
  const uid = el.dataset.uid;
  if (act === 'winfo') {
    const box = el.closest('.opt')?.querySelector('.wprof');
    if (box) {
      const open = !box.classList.contains('open');
      box.classList.toggle('open', open);
      el.setAttribute('aria-expanded', String(open));
    }
    return;
  }
  switch (act) {
    case 'open': location.hash = 'list-' + el.dataset.id; return;
    case 'reload': route(); return;
    case 'clear-cache': await clearCache(); toast('Data will download again next time'); return;
    case 'close-sheet': confirmKey = null; namingKey = null; closeSheet(); return;
    case 'sheet-back': sheet = sheet.back; renderSheet(); return;
    case 'cancel': confirmKey = null; render(); return;
    case 'issues': openSheet({ type: 'issues' }); return;
    case 'list-menu': openSheet({ type: 'list-menu' }); return;
    case 'add-unit': openSheet({ type: 'add-unit', uid }); return;
    case 'add-det': openSheet({ type: 'add-det', uid }); return;
    case 'add-top': openSheet({ type: 'add-top' }); return;
    case 'unit': confirmKey = null; namingKey = null; openSheet({ type: 'unit', uid }); return;
    case 'force-menu': confirmKey = 'rmf-' + uid; render(); return;
    case 'toggle-force': { const f = findForce(uid); if (f) { f.raw.collapsed = !f.raw.collapsed; save(); render(); } return; }
    case 'name-det-preset': namingKey = 'pf-' + uid; render(); sheetFocus('#pn-pf-' + uid, app); return;
    case 'name-unit-preset': namingKey = 'pu-' + uid; renderSheet(); sheetFocus('#pn-pu-' + uid, sheetRoot); return;
    case 'cancel-name': namingKey = null; sheet ? renderSheet() : render(); return;
    case 'ask-rm-preset': confirmKey = 'rmp-' + el.dataset.id; renderSheet(); return;
    case 'rm-preset': deletePreset(el.dataset.id); confirmKey = null; habits = buildHabits(loadLists(), roster.raw.id, loadPresets()); renderSheet(); toast('Preset deleted'); return;
    case 'pick-unit-preset': {
      const f = findForce(sheet.uid);
      const p = loadPresets().find(x => x.id === el.dataset.id);
      if (!f || !p) return;
      const raw = freshCopy(p.raw);
      f.raw.selections.push(raw);
      roster.refresh(); save(); issues = roster.validate();
      sheet = { type: 'unit', uid: raw.id };
      render(); toast(`Added ${p.name}`);
      return;
    }
    case 'pick-det-preset': {
      const f = findForce(sheet.uid);
      const p = loadPresets().find(x => x.id === el.dataset.id);
      if (!f || !p) return;
      const raw = freshCopy(p.raw);
      raw.catalogueId = f.catalogueId; raw.collapsed = false;
      f.raw.forces.push(raw);
      roster.refresh(); sheet = null; changed(); toast(`Added ${p.name}`);
      return;
    }
    case 'rm-force': { const f = findForce(uid); confirmKey = null; if (f) roster.removeForce(f); changed(); return; }
    case 'pick-unit': {
      const f = findForce(sheet.uid);
      const node = roster.rootChoices(f).find(c => c.node.key === el.dataset.key)?.node;
      if (!node) return;
      const raw = roster.addRoot(f, node);
      save(); issues = roster.validate();
      sheet = { type: 'unit', uid: raw.id };
      render();
      return;
    }
    case 'pick-det': {
      const f = findForce(sheet.uid);
      const c = roster.childForceChoices(f).find(c => c.node.key === el.dataset.key);
      if (c) roster.addForce(f, c.node);
      sheet = null; changed(); toast(`Added ${c?.state.name || 'detachment'}`); return;
    }
    case 'pick-top': {
      const cat = sheetRoot.querySelector('#top-cat')?.value || roster.raw.catalogueId;
      const key = el.dataset.key;
      sheet = null;
      try { await ensureData([cat], 'Loading allied faction'); } catch (e) { return showError(e); }
      roster.refresh();
      const c = roster.childForceChoices(roster.root).find(c => c.node.key === key);
      if (c) roster.addForce(roster.root, c.node, cat);
      changed(); return;
    }
    case 'step': {
      const { parent, item } = findItem(el.dataset.parent, el.dataset.item);
      if (!item) return;
      roster.setOptionCount(parent, item, Math.max(0, item.count + Number(el.dataset.d)));
      changed(); return;
    }
    case 'apply-usual': {
      const s = findSel(uid);
      const u = s && usualLoadout(habits, unitId(s.force.catalogueId, s.raw));
      if (!u) return;
      s.raw.selections = freshCopy({ selections: u.selections }).selections;
      roster.refresh(); changed(); toast('Applied your usual loadout');
      return;
    }
    case 'split': { const s = findSel(uid); if (s) roster.splitOne(s); changed(); return; }
    case 'rm-sel': { const s = findSel(uid); if (s) roster.removeSel(s); changed(); return; }
    case 'dup': { const s = findSel(uid); if (s) { const raw = roster.duplicate(s); sheet = { type: 'unit', uid: raw.id }; toast('Duplicated'); } changed(); return; }
    case 'ask-rm-unit': confirmKey = 'rmu-' + uid; renderSheet(); return;
    case 'rm-unit': { const s = findSel(uid); confirmKey = null; if (s) roster.removeSel(s); sheet = null; changed(); return; }
    case 'rule': {
      const r = sheet.rules[Number(el.dataset.i)];
      openSheet({ type: 'rule', rule: r, ruleKey: r.view.name, back: sheet });
      return;
    }
    case 'goto-issue': {
      const i = issues[Number(el.dataset.i)];
      const u = i?.where?.kind === 'sel' ? rootUnitOf(i.where) : null;
      if (u) openSheet({ type: 'unit', uid: u.uid }); else closeSheet();
      return;
    }
    case 'save-meta': {
      roster.raw.name = sheetRoot.querySelector('#lm-name').value.trim() || roster.raw.name;
      roster.raw.limits[POINTS_ID] = Number(sheetRoot.querySelector('#lm-pts').value) || 0;
      roster.refresh(); sheet = null; changed(); toast('Saved'); return;
    }
    case 'export-text': openSheet({ type: 'export', back: sheet }); return;
    case 'copy-text': {
      const ta = sheetRoot.querySelector('textarea.export');
      if (!(await copy(ta.value))) { ta.focus(); ta.select(); toast('Select all and copy'); }
      return;
    }
    case 'share-link': {
      const code = await encodeShare(roster.raw);
      const url = location.href.split('#')[0] + '#r=' + code;
      if (!(await copy(url))) {
        openSheet({ type: 'export', back: sheet });
        const ta = sheetRoot.querySelector('textarea.export'); ta.value = url; ta.select();
      }
      return;
    }
    case 'download': {
      const blob = new Blob([JSON.stringify(roster.raw, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (roster.raw.name || 'army').replace(/[^\w\- ]+/g, '') + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      return;
    }
    case 'ask-rm-list': confirmKey = 'rml'; renderSheet(); return;
    case 'rm-list': deleteList(roster.raw.id); confirmKey = null; sheet = null; location.hash = ''; return;
  }
});

document.addEventListener('change', (ev) => {
  const el = ev.target;
  const act = el.dataset.act;
  if (act === 'check') {
    const { parent, item } = findItem(el.dataset.parent, el.dataset.item);
    if (!item) return;
    roster.setOptionCount(parent, item, el.checked ? 1 : 0);
    changed();
  } else if (act === 'radio') {
    const { parent, item: group } = findItem(el.dataset.parent, el.dataset.group);
    if (!group) return;
    const item = el.dataset.item ? findItem(el.dataset.parent, el.dataset.item).item : null;
    roster.chooseInGroup(parent, group, item);
    changed();
  } else if (el.dataset.actChange === 'top-cat') {
    sheet.cat = el.value;
  }
});

function sheetFocus(sel, root) { setTimeout(() => { const i = root.querySelector(sel); if (i) { i.focus(); i.select(); } }, 30); }

document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('[data-preset-form]');
  if (!form) return;
  ev.preventDefault();
  const name = form.querySelector('input').value.trim();
  if (!name) return;
  const kind = form.dataset.presetForm;
  const uid = form.dataset.uid;
  let preset = null;
  if (kind === 'save-unit-preset') {
    const s = findSel(uid);
    if (!s) return;
    const raw = JSON.parse(JSON.stringify(s.raw));
    preset = { kind: 'unit', key: s.node.key, what: roster.selState(s).name, points: roster.selTotal(s, POINTS_ID), raw, catalogueId: s.force.catalogueId };
  } else {
    const f = findForce(uid);
    if (!f) return;
    const raw = JSON.parse(JSON.stringify(f.raw));
    delete raw.collapsed;
    preset = { kind: 'detachment', key: f.raw.entryId, what: roster.forceState(f)?.name || f.name, points: roster.forceTotal(f), raw, catalogueId: f.catalogueId };
  }
  preset.id = Math.random().toString(36).slice(2, 10);
  preset.name = name;
  preset.created = Date.now();
  if (!addPreset(preset)) { toast('Could not save: browser storage is full'); return; }
  namingKey = null;
  habits = buildHabits(loadLists(), roster.raw.id, loadPresets());
  sheet ? renderSheet() : render();
  toast(`Saved preset “${name}”`);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheet) { confirmKey = null; closeSheet(); }
});

window.addEventListener('hashchange', route);
route();
