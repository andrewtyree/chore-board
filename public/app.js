// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Estrella Tyree
//
// app.js — UI, state, storage, rendering. Imports the pure engine from scheduler.js.
import {
  UNITS, DOW, SIZE_FACTORS, parseISO, toISO, addDays, isWeekend, mondayOf,
  addCadence, nextDue, rollForward, buildInstances, assignInstances, applyMatrix,
} from './scheduler.js';

/* ===================== STORAGE (shared via server, local fallback) ===================== */
const LS_KEY = 'choreboard.state';
const CAN_SHARE = location.protocol !== 'file:'; // opened as a file -> there is no server to reach, ever
let syncMode = 'shared'; // 'shared' | 'local' | 'error'
function setSync(mode, label) {
  syncMode = mode; const el = document.getElementById('syncState');
  el.className = 'sync ' + mode;
  el.textContent = label || (mode === 'shared' ? 'Shared' : mode === 'local' ? 'Local only' : 'Offline');
}
function httpError(verb, r) { const e = new Error(`${verb} ${r.status}`); e.status = r.status; return e; }
async function apiGet() { const r = await fetch('/api/state', { cache: 'no-store' }); if (!r.ok) throw httpError('GET', r); return r.json(); }
async function apiPut(state) { const r = await fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) }); if (!r.ok) throw httpError('PUT', r); return r.json(); }

async function loadState() {
  if (CAN_SHARE) {
    try { const s = await apiGet(); setSync('shared'); return s && Object.keys(s).length ? s : null; }
    catch (e) {
      // 503 = the server holds a state file it can't parse. Stay local so we never seed over it;
      // reconnect() keeps probing and picks the board back up once it's restored.
      if (e.status === 503) setSync('error', 'Server data unreadable');
      else setSync('local', 'Local only');       // NAS unreachable
    }
  } else setSync('local', 'Local only');
  try { const raw = localStorage.getItem(LS_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
async function persist() {
  S.rev = (S.rev || 0) + 1;
  if (syncMode === 'shared') {
    try { await apiPut(S); return; }
    catch { setSync('error', 'Saved locally'); }   // server dropped mid-session; degrade gracefully
  }
  try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) { console.warn('local save failed', e); }
}

/* ===================== DEFAULT DATA ===================== */
function uid(p) { return p + Math.random().toString(36).slice(2, 8); }
const PCOLORS = ['var(--p-me)', 'var(--p-gabby)', 'var(--p-kid10)', 'var(--p-kid6)', '#7a5cc0', '#3f9e8f', '#b5852a', '#5b6b7a'];
function defaultPeople() {
  return [
    { id: 'me', name: 'Me', color: 'var(--p-me)', isAdult: true, weekdayBudget: 30, weekendBudget: 60, maxTaskMinutes: 0, active: true },
    { id: 'gabby', name: 'Gabby', color: 'var(--p-gabby)', isAdult: true, weekdayBudget: 30, weekendBudget: 60, maxTaskMinutes: 0, active: true },
    { id: 'kid10', name: 'Son (10)', color: 'var(--p-kid10)', isAdult: false, weekdayBudget: 20, weekendBudget: 40, maxTaskMinutes: 20, active: true },
    { id: 'kid6', name: 'Daughter (6)', color: 'var(--p-kid6)', isAdult: false, weekdayBudget: 10, weekendBudget: 20, maxTaskMinutes: 10, active: true },
  ];
}
function mkChore(name, minutes, priority, intervalCount, intervalUnit, adultOnly) {
  return { id: uid('c'), name, minutes, priority, intervalCount, intervalUnit, adultOnly, assignee: null, lastDone: null, holder: null, assignedOn: null, escalated: false, enabled: true, matrixKey: null };
}
function defaultChores() {
  return [
    mkChore('Load / run dishwasher', 10, 5, 1, 'days', false),
    mkChore('Wipe kitchen counters', 5, 3, 1, 'days', false),
    mkChore('Make beds', 5, 2, 1, 'days', false),
    mkChore('Feed pet & refill water', 5, 4, 1, 'days', false),
    mkChore('Take out trash', 5, 4, 3, 'days', false),
    mkChore('Water the garden', 10, 2, 2, 'days', false),
    mkChore('Laundry: wash, dry, fold', 30, 4, 3, 'days', true),
    mkChore('Take out recycling', 5, 3, 1, 'weeks', false),
    mkChore('Clean a bathroom', 25, 4, 1, 'weeks', true),
    mkChore('Clean toilets', 10, 4, 1, 'weeks', true),
    mkChore('Change bed sheets', 15, 2, 1, 'weeks', true),
    mkChore('Wipe down fridge shelves', 30, 2, 1, 'months', true),
    mkChore('Clean oven', 30, 2, 1, 'months', true),
  ];
}
function defaultRooms() {
  return [
    { id: 'r_living', name: 'Living room', size: 'large' },
    { id: 'r_kitchen', name: 'Kitchen', size: 'medium' },
    { id: 'r_game', name: 'Game room', size: 'medium' },
  ];
}
function defaultTypes() {
  return [
    { id: 't_tidy', name: 'Tidy', minutes: 5, priority: 3, intervalCount: 1, intervalUnit: 'days', adultOnly: false, assignee: null },
    { id: 't_vac', name: 'Vacuum', minutes: 15, priority: 3, intervalCount: 1, intervalUnit: 'weeks', adultOnly: false, assignee: null },
    { id: 't_mop', name: 'Mop', minutes: 20, priority: 3, intervalCount: 2, intervalUnit: 'weeks', adultOnly: true, assignee: null },
  ];
}
function seedState() {
  const rooms = defaultRooms(), types = defaultTypes();
  const exclude = ['t_mop:r_game']; // demo: carpeted game room can be vacuumed but not mopped
  return {
    rev: 0, people: defaultPeople(), rooms, matrixTypes: types, matrixExclude: exclude,
    chores: applyMatrix(defaultChores(), rooms, types, exclude),
    settings: { graceDays: 3, escalateAfter: 2, weekStartISO: null },
    week: null,
  };
}

/* ===================== STATE ===================== */
let S = null;            // the whole persisted blob
let activeView = 'week';
const get = { people: () => S.people, chores: () => S.chores, rooms: () => S.rooms, types: () => S.matrixTypes };

function normalize() {
  S.rev = S.rev || 0;
  S.people ||= defaultPeople(); S.rooms ||= defaultRooms(); S.matrixTypes ||= defaultTypes(); S.matrixExclude ||= [];
  S.settings = Object.assign({ graceDays: 3, escalateAfter: 2, weekStartISO: null }, S.settings || {});
  for (const r of S.rooms) if (!r.size) r.size = 'medium';
  for (const c of (S.chores ||= [])) {
    if (c.intervalCount === undefined) { c.intervalCount = c.intervalDays || 1; c.intervalUnit = 'days'; delete c.intervalDays; }
    c.intervalUnit ??= 'days'; c.assignee ??= null; c.holder ??= null; c.assignedOn ??= null;
    c.escalated = !!c.escalated; c.matrixKey ??= null;
  }
}

/* ===================== HELPERS ===================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const personById = id => S.people.find(p => p.id === id);
const choreById = id => S.chores.find(c => c.id === id);
function priColor(p) { return p >= 5 ? '#bf3b2e' : p >= 4 ? '#d98324' : p >= 3 ? '#2f6f5e' : '#9aa6a0'; }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function assigneeOptions(sel) { return `<option value="">Auto</option>` + S.people.map(p => `<option value="${p.id}" ${sel === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join(''); }
function unitOptions(sel, count) { return UNITS.map(u => `<option value="${u}" ${sel === u ? 'selected' : ''}>${u.slice(0, -1)}${(count || 1) > 1 ? 's' : ''}</option>`).join(''); }
function sizeOptions(sel) { return Object.keys(SIZE_FACTORS).map(s => `<option value="${s}" ${sel === s ? 'selected' : ''}>${s} ×${SIZE_FACTORS[s]}</option>`).join(''); }
let toastT; function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1900); }
async function save() { await persist(); }

/* ===================== WEEK ===================== */
function renderWeek() {
  const body = $('#weekBody'), week = S.week;
  if (!week || !week.assignments) {
    body.innerHTML = `<div class="gridwrap"><div class="loading">No slate yet for this week.<br><br><button class="btn primary" id="emptyGen">Refresh week</button></div></div>`;
    $('#emptyGen')?.addEventListener('click', generate); return;
  }
  const ws = parseISO(week.weekStartISO), we = addDays(ws, 6), fmt = dt => dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const delinq = week.assignments.filter(a => a.delinquent).length, escal = week.assignments.filter(a => a.escalated).length;
  $('#weekTitle').textContent = `Week of ${fmt(ws)}`;
  $('#weekMeta').textContent = `${fmt(ws)} – ${fmt(we)} · ${week.assignments.length} tasks`
    + (delinq ? ` · ${delinq} delinquent` : '') + (escal ? ` · ${escal} escalated` : '');
  const todayISO = toISO(new Date());
  const active = S.people.filter(p => p.active);
  const loadById = Object.fromEntries((week.load || []).map(l => [l.id, l]));

  let bal = '<div class="balance">';
  for (const p of active) {
    const l = loadById[p.id] || { used: 0, cap: 1 }; const pct = l.cap ? Math.round(l.used / l.cap * 100) : 0; const over = l.used > l.cap;
    bal += `<div class="bcard"><div class="who"><span class="dot" style="background:${p.color}"></span>${esc(p.name)}</div>
      <div class="nums">${l.used} / ${l.cap} min · ${pct}%</div>
      <div class="meter ${over ? 'over' : ''}"><span style="width:${Math.min(100, pct)}%;background:${p.color}"></span></div></div>`;
  }
  bal += '</div>';

  let g = '<div class="gridwrap"><div class="grid"><div class="gcell ghead"></div>';
  for (let d = 0; d < 7; d++) { const date = addDays(ws, d); g += `<div class="gcell ghead ${isWeekend(d) ? 'weekend' : ''} ${toISO(date) === todayISO ? 'today' : ''}"><div class="dow">${DOW[d]}</div><div class="dnum">${date.getDate()}</div></div>`; }
  for (const p of active) {
    g += `<div class="gcell rowlabel"><div class="who"><span class="dot" style="background:${p.color}"></span>${esc(p.name)}</div><div class="role">${p.isAdult ? 'Adult' : 'Child'}</div></div>`;
    for (let d = 0; d < 7; d++) {
      const cap = isWeekend(d) ? p.weekendBudget : p.weekdayBudget;
      const items = week.assignments.filter(a => a.personId === p.id && a.dayIndex === d).sort((a, b) => (b.delinquent - a.delinquent) || (b.priority - a.priority));
      const used = items.reduce((s, a) => s + a.minutes, 0); const pct = cap ? Math.round(used / cap * 100) : 0; const over = used > cap;
      let cell = `<div class="gcell daycell ${isWeekend(d) ? 'weekend' : ''}">`;
      if (items.length) cell += `<div class="cellmeter ${over ? 'over' : ''}"><span style="width:${Math.min(100, pct)}%;background:${p.color}"></span></div>`;
      if (!items.length) cell += '<div class="empty-cell">—</div>';
      else for (const a of items) {
        const done = week.completion && week.completion[a.uid];
        let flags = '';
        if (a.delinquent && !done) flags += `<span class="flag del">DELINQUENT${a.lateCycles > 1 ? ' ×' + a.lateCycles : ''}</span>`;
        if (a.escalated && !done) flags += `<span class="flag esc">ESCALATED</span>`;
        cell += `<div class="task ${done ? 'done' : ''} ${a.delinquent && !done ? 'delinquent' : ''}" style="--c:${p.color}">
          <div class="tname"><input type="checkbox" class="check" data-uid="${a.uid}" ${done ? 'checked' : ''}><span>${esc(a.name)}</span></div>
          <div class="tmin"><span class="pri" style="background:${priColor(a.priority)}"></span>${a.minutes} min ${flags}</div></div>`;
      }
      cell += '</div>'; g += cell;
    }
  }
  g += '</div></div>';

  let of = '';
  if (week.unassigned && week.unassigned.length) {
    of = '<div class="overflow no-print"><h3>Couldn’t fit ' + week.unassigned.length + ' task' + (week.unassigned.length > 1 ? 's' : '') + '</h3><p>Raise a time budget, lower a chore’s priority, or relax an adult-only flag.</p><ul>'
      + week.unassigned.map(u => `<li><b>${esc(u.inst.name)}</b> (${u.inst.minutes} min) — ${esc(u.reason)}</li>`).join('') + '</ul></div>';
  }
  body.innerHTML = bal + g + of;
  $$('#weekBody .check').forEach(cb => cb.addEventListener('change', onCheck));
}
async function onCheck(e) {
  const uid = e.target.dataset.uid, a = S.week.assignments.find(x => x.uid === uid); if (!a) return;
  const ch = choreById(a.choreId); S.week.completion ||= {};
  if (e.target.checked) {
    S.week.completion[uid] = { date: toISO(new Date()), snap: ch ? { lastDone: ch.lastDone, holder: ch.holder, assignedOn: ch.assignedOn, escalated: ch.escalated } : null };
    if (ch) { ch.lastDone = toISO(new Date()); ch.holder = null; ch.assignedOn = null; ch.escalated = false; } // clear obligation
  } else {
    const rec = S.week.completion[uid]; if (ch && rec && rec.snap) Object.assign(ch, rec.snap);
    delete S.week.completion[uid];
  }
  e.target.closest('.task').classList.toggle('done', e.target.checked);
  await save();
}
async function generate() {
  S.settings.weekStartISO = $('#weekStart').value || toISO(mondayOf(new Date()));
  S.settings.graceDays = Math.max(1, Number($('#graceDays').value) || 3);
  S.settings.escalateAfter = Math.max(1, Number($('#escalateAfter').value) || 2);
  const todayISO = toISO(new Date());
  const ws = parseISO(S.settings.weekStartISO), we = addDays(ws, 6);
  const horizonISO = toISO(we > parseISO(todayISO) ? we : parseISO(todayISO));
  rollForward(S.chores, { todayISO, horizonISO, grace: S.settings.graceDays, escalateAfter: S.settings.escalateAfter, people: S.people });
  const inst = buildInstances(S.chores, S.settings.weekStartISO, todayISO, S.settings.graceDays);
  const res = assignInstances(inst, S.people);
  for (const c of S.chores) if (res.holderOf[c.id]) c.holder = res.holderOf[c.id]; // lock holder so delinquency/escalation track the person
  S.week = { weekStartISO: S.settings.weekStartISO, assignments: res.assignments, unassigned: res.unassigned, load: res.load, completion: {} };
  await save(); renderWeek();
  toast(`Built ${res.assignments.length} tasks` + (res.unassigned.length ? ` · ${res.unassigned.length} didn’t fit` : ''));
}

/* ===================== CHORES ===================== */
function renderChores() {
  const tb = $('#choreRows'); tb.innerHTML = '';
  for (const c of S.chores) {
    const m = !!c.matrixKey;
    const tr = document.createElement('tr'); if (!c.enabled) tr.classList.add('disabled-row');
    tr.innerHTML = `
      <td>${m ? `<span class="pill" title="Managed in Rooms">matrix</span> ` : ''}<input type="text" data-f="name" value="${esc(c.name)}" ${m ? 'disabled' : ''}></td>
      <td class="col-c"><select data-f="priority" ${m ? 'disabled' : ''}>${[5, 4, 3, 2, 1].map(n => `<option value="${n}" ${c.priority === n ? 'selected' : ''}>${n}</option>`).join('')}</select></td>
      <td class="col-c"><input type="number" min="1" data-f="minutes" value="${c.minutes}" ${m ? 'disabled' : ''}></td>
      <td class="col-c"><div class="cadence"><input type="number" min="1" data-f="intervalCount" value="${c.intervalCount}" ${m ? 'disabled' : ''}><select data-f="intervalUnit" ${m ? 'disabled' : ''}>${unitOptions(c.intervalUnit, c.intervalCount)}</select></div></td>
      <td class="col-c"><label class="sw"><input type="checkbox" data-f="adultOnly" ${c.adultOnly ? 'checked' : ''} ${m ? 'disabled' : ''}><span class="track"></span></label></td>
      <td class="col-c"><select data-f="assignee">${assigneeOptions(c.assignee)}</select></td>
      <td class="col-c"><input type="date" data-f="lastDone" value="${c.lastDone || ''}"></td>
      <td class="col-c"><label class="sw"><input type="checkbox" data-f="enabled" ${c.enabled ? 'checked' : ''}><span class="track"></span></label></td>
      <td class="col-c">${m ? '' : '<button class="btn ghost sm danger" data-del>✕</button>'}</td>`;
    tr.querySelectorAll('[data-f]').forEach(el => el.addEventListener('change', async () => {
      const f = el.dataset.f;
      if (f === 'adultOnly' || f === 'enabled') c[f] = el.checked;
      else if (f === 'priority' || f === 'minutes' || f === 'intervalCount') c[f] = Math.max(1, Number(el.value) || 1);
      else if (f === 'assignee') c[f] = el.value || null;
      else if (f === 'lastDone') c[f] = el.value || null;
      else c[f] = el.value;
      await save(); renderChores();
    }));
    tr.querySelector('[data-del]')?.addEventListener('click', async () => { S.chores = S.chores.filter(x => x.id !== c.id); await save(); renderChores(); });
    tb.appendChild(tr);
  }
}

/* ===================== ROOMS / MATRIX ===================== */
function renderRooms() {
  const rl = $('#roomList'); rl.innerHTML = '';
  S.rooms.forEach(r => {
    const chip = document.createElement('div'); chip.className = 'roomchip';
    chip.innerHTML = `<input type="text" value="${esc(r.name)}"><select>${sizeOptions(r.size)}</select><button title="Remove room">✕</button>`;
    const [name, size, btn] = [chip.querySelector('input'), chip.querySelector('select'), chip.querySelector('button')];
    name.addEventListener('change', async e => { r.name = e.target.value; await save(); updateMatrixCount(); });
    size.addEventListener('change', async e => { r.size = e.target.value; await save(); });
    btn.addEventListener('click', async () => { S.rooms = S.rooms.filter(x => x.id !== r.id); await save(); renderRooms(); });
    rl.appendChild(chip);
  });

  const tb = $('#matrixRows'); tb.innerHTML = '';
  S.matrixTypes.forEach(t => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" data-f="name" value="${esc(t.name)}"></td>
      <td class="col-c"><input type="number" min="1" data-f="minutes" value="${t.minutes}"></td>
      <td class="col-c"><select data-f="priority">${[5, 4, 3, 2, 1].map(n => `<option value="${n}" ${t.priority === n ? 'selected' : ''}>${n}</option>`).join('')}</select></td>
      <td class="col-c"><div class="cadence"><input type="number" min="1" data-f="intervalCount" value="${t.intervalCount}"><select data-f="intervalUnit">${unitOptions(t.intervalUnit, t.intervalCount)}</select></div></td>
      <td class="col-c"><label class="sw"><input type="checkbox" data-f="adultOnly" ${t.adultOnly ? 'checked' : ''}><span class="track"></span></label></td>
      <td class="col-c"><select data-f="assignee">${assigneeOptions(t.assignee)}</select></td>
      <td class="col-c"><button class="btn ghost sm danger" data-del>✕</button></td>`;
    tr.querySelectorAll('[data-f]').forEach(el => el.addEventListener('change', async () => {
      const f = el.dataset.f;
      if (f === 'adultOnly') t[f] = el.checked;
      else if (f === 'minutes' || f === 'priority' || f === 'intervalCount') t[f] = Math.max(1, Number(el.value) || 1);
      else if (f === 'assignee') t[f] = el.value || null; else t[f] = el.value;
      await save(); renderRooms();
    }));
    tr.querySelector('[data-del]').addEventListener('click', async () => { S.matrixTypes = S.matrixTypes.filter(x => x.id !== t.id); await save(); renderRooms(); });
    tb.appendChild(tr);
  });

  renderCompat(); updateMatrixCount();
}
function renderCompat() {
  const wrap = $('#compatWrap');
  if (!S.rooms.length || !S.matrixTypes.length) { wrap.innerHTML = '<div style="padding:14px" class="tag">Add at least one room and one chore type.</div>'; return; }
  const excl = new Set(S.matrixExclude);
  let h = '<table class="compat"><thead><tr><th></th>' + S.rooms.map(r => `<th>${esc(r.name)}</th>`).join('') + '</tr></thead><tbody>';
  for (const t of S.matrixTypes) {
    h += `<tr><th>${esc(t.name)}</th>`;
    for (const r of S.rooms) { const key = `${t.id}:${r.id}`; h += `<td><input type="checkbox" data-key="${key}" ${excl.has(key) ? '' : 'checked'}></td>`; }
    h += '</tr>';
  }
  h += '</tbody></table>';
  wrap.innerHTML = h;
  wrap.querySelectorAll('input[data-key]').forEach(cb => cb.addEventListener('change', async () => {
    const key = cb.dataset.key, set = new Set(S.matrixExclude);
    if (cb.checked) set.delete(key); else set.add(key);
    S.matrixExclude = [...set]; await save(); updateMatrixCount();
  }));
}
function updateMatrixCount() {
  const total = S.rooms.length * S.matrixTypes.length, excl = S.matrixExclude.filter(k => {
    const [tid, rid] = k.split(':'); return S.matrixTypes.some(t => t.id === tid) && S.rooms.some(r => r.id === rid);
  }).length;
  $('#matrixCount').textContent = `${total - excl} chores (${total} cells − ${excl} excluded)`;
}

/* ===================== TEAM ===================== */
function renderTeam() {
  const tb = $('#teamRows'); tb.innerHTML = '';
  for (const p of S.people) {
    const tr = document.createElement('tr'); if (!p.active) tr.classList.add('disabled-row');
    const colorOpts = PCOLORS.map(c => `<option value="${c}" ${p.color === c ? 'selected' : ''}>●</option>`).join('');
    tr.innerHTML = `
      <td><input type="text" data-f="name" value="${esc(p.name)}"></td>
      <td><span class="dot" style="background:${p.color};margin-right:6px"></span><select data-f="color" style="width:54px">${colorOpts}</select></td>
      <td class="col-c"><label class="sw"><input type="checkbox" data-f="isAdult" ${p.isAdult ? 'checked' : ''}><span class="track"></span></label></td>
      <td class="col-c"><input type="number" min="0" data-f="weekdayBudget" value="${p.weekdayBudget}"></td>
      <td class="col-c"><input type="number" min="0" data-f="weekendBudget" value="${p.weekendBudget}"></td>
      <td class="col-c"><input type="number" min="0" data-f="maxTaskMinutes" value="${p.maxTaskMinutes}"></td>
      <td class="col-c"><label class="sw"><input type="checkbox" data-f="active" ${p.active ? 'checked' : ''}><span class="track"></span></label></td>
      <td class="col-c"><button class="btn ghost sm danger" data-del>✕</button></td>`;
    tr.querySelectorAll('[data-f]').forEach(el => el.addEventListener('change', async () => {
      const f = el.dataset.f;
      if (f === 'isAdult' || f === 'active') p[f] = el.checked;
      else if (['weekdayBudget', 'weekendBudget', 'maxTaskMinutes'].includes(f)) p[f] = Math.max(0, Number(el.value) || 0);
      else p[f] = el.value;
      await save(); renderTeam();
    }));
    tr.querySelector('[data-del]').addEventListener('click', async () => { if (S.people.length <= 1) { toast('Keep at least one person'); return; } S.people = S.people.filter(x => x.id !== p.id); await save(); renderTeam(); });
    tb.appendChild(tr);
  }
}

/* ===================== WIRING ===================== */
function switchView(v) {
  activeView = v;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  $$('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
  if (v === 'week') renderWeek(); else if (v === 'chores') renderChores(); else if (v === 'rooms') renderRooms(); else renderTeam();
}
function renderActive() { switchView(activeView); }

$('#tabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (b) switchView(b.dataset.view); });
$('#generateBtn').addEventListener('click', generate);
$('#printBtn').addEventListener('click', () => window.print());
$('#graceDays').addEventListener('change', async () => { S.settings.graceDays = Math.max(1, Number($('#graceDays').value) || 3); await save(); });
$('#escalateAfter').addEventListener('change', async () => { S.settings.escalateAfter = Math.max(1, Number($('#escalateAfter').value) || 2); await save(); });
$('#addChore').addEventListener('click', async () => { S.chores.unshift(mkChore('New chore', 10, 3, 1, 'weeks', false)); await save(); renderChores(); });
$('#addRoom').addEventListener('click', async () => { S.rooms.push({ id: uid('r'), name: 'New room', size: 'medium' }); await save(); renderRooms(); });
$('#addType').addEventListener('click', async () => { S.matrixTypes.push({ id: uid('t'), name: 'New type', minutes: 10, priority: 3, intervalCount: 1, intervalUnit: 'weeks', adultOnly: false, assignee: null }); await save(); renderRooms(); });
$('#addPerson').addEventListener('click', async () => { S.people.push({ id: uid('p'), name: 'New person', color: PCOLORS[S.people.length % PCOLORS.length], isAdult: true, weekdayBudget: 30, weekendBudget: 60, maxTaskMinutes: 0, active: true }); await save(); renderTeam(); });
$('#applyMatrix').addEventListener('click', async () => {
  const before = S.chores.filter(c => c.matrixKey).length;
  S.chores = applyMatrix(S.chores, S.rooms, S.matrixTypes, S.matrixExclude);
  const after = S.chores.filter(c => c.matrixKey).length;
  await save(); renderRooms();
  toast(`Matrix applied · ${after} chore${after === 1 ? '' : 's'}` + (after > before ? ` (+${after - before})` : after < before ? ` (−${before - after})` : ''));
});
$('#resetBtn').addEventListener('click', async () => {
  if (!confirm('Erase all chores, rooms, team, and the current week, and reload the sample setup?')) return;
  S = seedState(); syncBudgetInputs();
  await save(); renderActive(); toast('Reset to sample data');
});

function syncBudgetInputs() {
  $('#weekStart').value = S.settings.weekStartISO || toISO(mondayOf(new Date()));
  $('#graceDays').value = S.settings.graceDays;
  $('#escalateAfter').value = S.settings.escalateAfter;
}

/* ===================== LIVE SYNC (poll for other devices) ===================== */
// The server went away mid-session (or was down at load) and we've been saving to localStorage.
// Rejoin when it comes back, reconciling by `rev` — the same whole-document last-write-wins rule
// the app uses everywhere else. Offline edits on two devices still can't merge; see TODO.md.
async function reconnect() {
  try { const h = await fetch('/api/health', { cache: 'no-store' }); if (!h.ok) return; }
  catch { return; }                                  // still down; the next tick tries again
  try {
    const remote = await apiGet();
    if (remote && Object.keys(remote).length && (remote.rev || 0) > (S.rev || 0)) {
      S = remote; normalize(); syncBudgetInputs(); setSync('shared'); renderActive();
      toast('Back online — loaded the newer board from the server');
    } else {
      await apiPut(S); setSync('shared');            // our copy is newer; push the offline edits up
      toast('Back online — your offline changes were saved');
    }
  } catch (e) {
    if (e.status === 503) setSync('error', 'Server data unreadable');
    else setSync('local', 'Local only');
  }
}
async function pull() {
  if (!CAN_SHARE) return;
  const ae = document.activeElement;
  if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return; // don't clobber an in-progress edit
  if (syncMode !== 'shared') return reconnect();
  try {
    const remote = await apiGet();
    if (remote && (remote.rev || 0) > (S.rev || 0)) { S = remote; normalize(); syncBudgetInputs(); renderActive(); }
  } catch (e) {
    if (e.status === 503) setSync('error', 'Server data unreadable'); // don't keep PUTting at a broken store
  }
}
setInterval(pull, 15000);
window.addEventListener('focus', pull);

/* ===================== INIT ===================== */
(async function init() {
  S = await loadState();
  if (!S) { S = seedState(); await persist(); }
  normalize();
  syncBudgetInputs();
  renderWeek();
})();
