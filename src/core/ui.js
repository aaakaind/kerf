// KERF UI kit: tiny DOM builder, icons, toasts, dialogs, menus, inspector fields, command palette.
// SPDX-License-Identifier: AGPL-3.0-or-later

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const uid = (p = 'k') => p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const round = (v, d = 2) => { const m = 10 ** d; return Math.round(v * m) / m; };
export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const modKey = isMac ? '⌘' : 'Ctrl';

// ---------- icons (24×24, stroke = currentColor, square caps: brutalist line work) ----------
const P = {
  select: '<path d="M5 3l13 8-6 1.6L9 19z" fill="currentColor" stroke="none"/>',
  direct: '<path d="M5 3l13 8-6 1.6L9 19z" fill="none"/>',
  pen: '<path d="M12 3l6 9-6 9-6-9z"/><circle cx="12" cy="12" r="1.6"/><path d="M12 3v7"/>',
  pencil: '<path d="M4 20l1-5L16 4l4 4L9 19z"/><path d="M14 6l4 4"/>',
  rect: '<rect x="4" y="6" width="16" height="12"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>',
  polygon: '<path d="M12 3l8.5 6.2-3.2 10H6.7L3.5 9.2z"/>',
  star: '<path d="M12 3l2.6 5.9 6.4.6-4.8 4.3 1.4 6.3L12 16.9 6.4 20.1l1.4-6.3L3 9.5l6.4-.6z"/>',
  line: '<path d="M4 20L20 4"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  eyedrop: '<path d="M14 4l6 6-3 1-7 7-4 2 2-4 7-7z"/>',
  hand: '<path d="M8 12V6a1.5 1.5 0 013 0v5m0-6a1.5 1.5 0 013 0v6m0-4a1.5 1.5 0 013 0v7c0 4-2.5 6-6 6-2.8 0-4.3-1.3-5.7-3.6L4.4 13a1.5 1.5 0 012.6-1.5L8 13"/>',
  frameText: '<rect x="3" y="4" width="18" height="16"/><path d="M7 8h10M7 12h10M7 16h6"/>',
  frameImg: '<rect x="3" y="4" width="18" height="16"/><path d="M3 4l18 16M21 4L3 20"/>',
  thread: '<rect x="3" y="3" width="8" height="8"/><rect x="13" y="13" width="8" height="8"/><path d="M11 7h4v6"/>',
  undo: '<path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 010 12" transform="translate(0 -6)"/>',
  redo: '<path d="M15 7l5 5-5 5"/><path d="M20 12H10a6 6 0 000 12" transform="translate(0 -6)"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  cmd: '<path d="M9 6v12M15 6v12M6 9h12M6 15h12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>',
  eyeOff: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><path d="M4 4l16 16"/>',
  lock: '<rect x="5" y="11" width="14" height="9"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9"/><path d="M8 11V8a4 4 0 017.5-2"/>',
  up: '<path d="M6 14l6-6 6 6"/>',
  down: '<path d="M6 10l6 6 6-6"/>',
  copy: '<rect x="8" y="8" width="12" height="12"/><path d="M4 16V4h12"/>',
  page: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12L4 7.5M12 12v9"/>',
  sphere: '<circle cx="12" cy="12" r="8"/><ellipse cx="12" cy="12" rx="8" ry="3"/>',
  cylinder: '<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6"/>',
  cone: '<path d="M12 3L5 18c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6z"/>',
  torus: '<ellipse cx="12" cy="12" rx="9" ry="5.5"/><ellipse cx="12" cy="11.2" rx="3.6" ry="1.6"/>',
  move: '<path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  rotate: '<path d="M20 12a8 8 0 11-2.3-5.7"/><path d="M20 4v5h-5"/>',
  scale: '<rect x="3" y="11" width="10" height="10"/><path d="M11 3h10v10M21 3l-9 9"/>',
  extrude: '<path d="M4 16l4-3h12l-4 3z"/><path d="M8 13V5h12v8M8 5l-4 3v8M12 9V3M10 5l2-2 2 2"/>',
  revolve: '<path d="M12 3v18"/><path d="M12 6c4 0 7 2.7 7 6s-3 6-7 6"/><path d="M16 16l3 2-1 3"/>',
  hole: '<rect x="3" y="7" width="18" height="12"/><ellipse cx="12" cy="7" rx="4" ry="1.6"/><path d="M8 7v8m8-8v8"/>',
  fillet: '<path d="M4 20V10a6 6 0 016-6h10"/><path d="M4 4h4M4 4v4"/>',
  chamfer: '<path d="M4 20V10l6-6h10"/>',
  shell: '<path d="M3 6v14h18V6"/><path d="M7 6v10h10V6"/>',
  patLin: '<rect x="3" y="9" width="5" height="6"/><rect x="10" y="9" width="5" height="6"/><rect x="17" y="9" width="4" height="6"/>',
  patCirc: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="5" r="1.8" fill="currentColor"/><circle cx="18.1" cy="15.5" r="1.8" fill="currentColor"/><circle cx="5.9" cy="15.5" r="1.8" fill="currentColor"/>',
  mirror: '<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 6L4 18h5zM15 6l5 12h-5z"/>',
  section: '<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M2 14l20-6" />',
  measure: '<path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M4 20h16"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M4 4h16"/>',
  layers: '<path d="M12 4l9 5-9 5-9-5z"/><path d="M3 14l9 5 9-5"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  unlink: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/><path d="M4 4l16 16"/>',
  pledge: '<circle cx="12" cy="12" r="8"/><path d="M8 12l3 3 5-6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  sheet: '<rect x="3" y="4" width="18" height="16"/><path d="M15 4v16"/>',
  boolU: '<rect x="3" y="3" width="11" height="11" fill="currentColor"/><rect x="10" y="10" width="11" height="11" fill="currentColor"/>',
  boolS: '<path d="M3 3h11v7h-4v4H3z" fill="currentColor"/><rect x="10" y="10" width="11" height="11"/>',
  boolI: '<rect x="3" y="3" width="11" height="11"/><rect x="10" y="10" width="11" height="11"/><rect x="10" y="10" width="4" height="4" fill="currentColor"/>',
  boolX: '<path d="M3 3h11v7h-4v4H3zM14 14h-4v7h11V10h-7z" fill="currentColor"/>',
  alignL: '<path d="M4 3v18"/><rect x="6" y="6" width="12" height="4"/><rect x="6" y="14" width="7" height="4"/>',
  alignCH: '<path d="M12 3v18"/><rect x="6" y="6" width="12" height="4"/><rect x="8.5" y="14" width="7" height="4"/>',
  alignR: '<path d="M20 3v18"/><rect x="6" y="6" width="12" height="4"/><rect x="11" y="14" width="7" height="4"/>',
  alignT: '<path d="M3 4h18"/><rect x="6" y="6" width="4" height="12"/><rect x="14" y="6" width="4" height="7"/>',
  alignCV: '<path d="M3 12h18"/><rect x="6" y="6" width="4" height="12"/><rect x="14" y="8.5" width="4" height="7"/>',
  alignB: '<path d="M3 20h18"/><rect x="6" y="6" width="4" height="12"/><rect x="14" y="11" width="4" height="7"/>',
  distH: '<path d="M4 3v18M20 3v18"/><rect x="9" y="8" width="6" height="8"/>',
  distV: '<path d="M3 4h18M3 20h18"/><rect x="8" y="9" width="8" height="6"/>',
  radial: '<circle cx="12" cy="12" r="2"/><circle cx="12" cy="4.5" r="1.6"/><circle cx="19.5" cy="12" r="1.6"/><circle cx="12" cy="19.5" r="1.6"/><circle cx="4.5" cy="12" r="1.6"/>',
  grid: '<rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><rect x="14" y="14" width="6" height="6"/>',
  image: '<rect x="3" y="5" width="18" height="14"/><circle cx="8.5" cy="10" r="1.8"/><path d="M3 17l5-4 4 3 3-2 6 5"/>',
  front: '<rect x="5" y="5" width="14" height="14"/>',
  merge: '<path d="M4 4h6v6H4zM14 14h6v6h-6zM7 10v4h7"/>',
  wand: '<path d="M4 20L16 8"/><path d="M15 3v3M18.5 4.5l-2 2M21 8h-3M14 9l1 1"/>',
  play: '<path d="M7 4l12 8-12 8z"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
};
export function icon(name, size = 22) {
  const body = P[name] || P.x;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${body}</svg>`;
}
export function iconEl(name, size) { const s = document.createElement('span'); s.style.display = 'contents'; s.innerHTML = icon(name, size); return s.firstChild; }

// ---------- toasts ----------
let toastHost;
export function toast(msg, kind = '') {
  if (!toastHost) { toastHost = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' }); document.body.append(toastHost); }
  const t = h('div', { class: 'toast ' + kind }, msg);
  toastHost.append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 5200 : 2800);
}

// ---------- dialogs (alert/confirm/prompt are unavailable inside sandboxed viewers, so everything is in-page) ----------
export function dialog({ title, body, actions = [], wide = false, onClose }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const close = (val) => { bd.remove(); document.removeEventListener('keydown', onKey, true); onClose?.(); prevFocus?.focus?.(); resolve(val); };
    const bodyEl = h('div', { class: 'body' });
    if (typeof body === 'string') bodyEl.innerHTML = body; else if (typeof body === 'function') body(bodyEl, close); else if (body) bodyEl.append(body);
    const foot = h('footer', null, actions.map(a => h('button', {
      class: 'btn ' + (a.primary ? 'primary' : a.danger ? 'danger' : ''), type: 'button',
      onclick: async () => { if (a.onClick) { const r = await a.onClick(bodyEl); if (r === false) return; close(r ?? a.value); } else close(a.value); }
    }, a.label)));
    const dlg = h('div', { class: 'dialog' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('header', null, h('h2', null, title), h('button', { class: 'btn icon ghost x', type: 'button', 'aria-label': 'Close', html: icon('x', 18), onclick: () => close(undefined) })),
      bodyEl, actions.length ? foot : null);
    const bd = h('div', { class: 'backdrop', onpointerdown: (e) => { if (e.target === bd) close(undefined); } }, dlg);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(undefined); }
      if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA') {
        const p = actions.find(a => a.primary); if (p) { e.preventDefault(); e.stopPropagation(); foot.children[actions.indexOf(p)].click(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.append(bd);
    setTimeout(() => (bodyEl.querySelector('input,select,textarea') || foot.querySelector('.primary'))?.focus(), 30);
  });
}
export const confirmDialog = (title, text, okLabel = 'OK', danger = false) =>
  dialog({ title, body: h('p', null, text), actions: [{ label: 'Cancel', value: false }, { label: okLabel, primary: !danger, danger, value: true }] });
export async function promptDialog(title, label, value = '') {
  let inp;
  const r = await dialog({ title, body: (b) => b.append(h('div', { class: 'field' }, h('label', { for: 'kerf-prompt' }, label), inp = h('input', { id: 'kerf-prompt', type: 'text', value }))),
    actions: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, onClick: () => inp.value }] });
  return r ?? null;
}

// ---------- dropdown menu ----------
let openMenu;
export function menu(anchor, items) {
  closeMenu();
  const m = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it === '-') { m.append(h('hr')); continue; }
    if (it.header) { m.append(h('div', { class: 'mh' }, it.header)); continue; }
    m.append(h('button', { role: 'menuitem', type: 'button', disabled: it.disabled, onclick: () => { closeMenu(); it.run(); } },
      it.icon ? h('span', { html: icon(it.icon, 16) }) : null, h('span', null, it.label), it.keys ? h('span', { class: 'kbd' }, it.keys) : null));
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(innerWidth - mw - 8, r.left)) + 'px';
  m.style.top = (r.bottom + 4 + mh > innerHeight - 8 ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + 'px';
  openMenu = m;
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); m.querySelector('button')?.focus(); });
  m.addEventListener('keydown', (e) => {
    const bs = [...m.querySelectorAll('button:not([disabled])')]; const i = bs.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length]?.focus(); }
    if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); anchor.focus?.(); }
  });
  function outside(e) { if (!m.contains(e.target)) closeMenu(); }
  m._outside = outside;
}
export function closeMenu() { if (openMenu) { document.removeEventListener('pointerdown', openMenu._outside, true); openMenu.remove(); openMenu = null; } }

// ---------- inspector fields ----------
// Numeric field with drag-to-scrub label. `parse` lets CAD accept expressions.
export function numField({ label, value, unit = '', step = 1, min = -Infinity, max = Infinity, decimals = 2, onChange, onInput, span, id, parse, display, title }) {
  const fid = id || uid('f');
  const inp = h('input', { type: 'text', id: fid, inputmode: parse ? 'text' : 'decimal', spellcheck: 'false', autocomplete: 'off' });
  const show = (v) => { inp.value = display ? display(v) : (typeof v === 'number' && isFinite(v) ? String(round(v, decimals)) : (v ?? '')); };
  show(value);
  const lab = h('label', { for: fid, class: parse ? '' : 'scrub', title: title || (parse ? '' : 'Drag to scrub') }, h('span', null, label), unit ? h('span', null, unit) : null);
  const commit = () => {
    const raw = inp.value.trim();
    if (parse) { const r = parse(raw); if (r.ok) { inp.classList.remove('bad'); onChange?.(r.value, raw); } else { inp.classList.add('bad'); inp.title = r.error; } return; }
    let v = Number(raw.replace(',', '.'));
    if (!isFinite(v)) { try { v = evalSimple(raw); } catch { show(value); return; } }
    v = clamp(v, min, max); value = v; show(v); onChange?.(v);
  };
  inp.addEventListener('change', commit);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { inp.blur(); }
    if (!parse && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault(); const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
      value = clamp((Number(inp.value) || 0) + d, min, max); show(value); onChange?.(value);
    }
  });
  if (!parse) {
    lab.addEventListener('pointerdown', (e) => {
      e.preventDefault(); const x0 = e.clientX; const v0 = Number(inp.value) || 0; lab.setPointerCapture(e.pointerId);
      const mv = (ev) => { const d = Math.round((ev.clientX - x0) / 3) * step * (ev.shiftKey ? 10 : 1); value = clamp(v0 + d, min, max); show(value); (onInput || onChange)?.(value); };
      const up = () => { lab.removeEventListener('pointermove', mv); lab.removeEventListener('pointerup', up); if (onInput) onChange?.(value); };
      lab.addEventListener('pointermove', mv); lab.addEventListener('pointerup', up);
    });
  }
  const wrap = h('div', { class: 'field' + (span === 2 ? ' span2' : span === 3 ? ' span3' : '') }, lab, inp);
  wrap.set = (v) => { value = v; if (document.activeElement !== inp) show(v); };
  wrap.input = inp;
  return wrap;
}
function evalSimple(s) { // arithmetic only, for "120/3" style entries in plain numeric fields
  if (!/^[\d\s+\-*/().]+$/.test(s)) throw new Error('bad'); // eslint-disable-next-line no-new-func
  return Function('"use strict";return (' + s + ')')();
}
export function textField({ label, value, onChange, span = 2, placeholder, id }) {
  const fid = id || uid('f');
  const inp = h('input', { type: 'text', id: fid, value: value ?? '', placeholder, spellcheck: 'false' });
  inp.addEventListener('change', () => onChange?.(inp.value));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
  const w = h('div', { class: 'field' + (span === 2 ? ' span2' : span === 3 ? ' span3' : '') }, h('label', { for: fid }, label), inp);
  w.input = inp; return w;
}
export function areaField({ label, value, onChange, onInput, rows = 8, id, mono }) {
  const fid = id || uid('f');
  const ta = h('textarea', { id: fid, rows, spellcheck: 'true', style: mono ? { fontFamily: 'var(--mono)', fontSize: '12px' } : null });
  ta.value = value ?? '';
  ta.addEventListener('input', debounce(() => onInput?.(ta.value), 220));
  ta.addEventListener('change', () => onChange?.(ta.value));
  const w = h('div', { class: 'field span3' }, h('label', { for: fid }, label), ta); w.input = ta; return w;
}
export function selectField({ label, value, options, onChange, span = 1, id }) {
  const fid = id || uid('f');
  const sel = h('select', { id: fid }, options.map(o => {
    const [v, l] = Array.isArray(o) ? o : [o, o];
    return h('option', { value: v, selected: String(v) === String(value) }, l);
  }));
  sel.addEventListener('change', () => onChange?.(sel.value));
  const w = h('div', { class: 'field' + (span === 2 ? ' span2' : span === 3 ? ' span3' : '') }, h('label', { for: fid }, label), sel); w.input = sel; return w;
}
export function colorField({ label, value, onChange, onInput, allowNone = false, span = 1, id }) {
  const fid = id || uid('f');
  const none = value == null || value === 'none';
  const pick = h('input', { type: 'color', value: toHex6(none ? '#000000' : value), 'aria-label': label + ' colour picker' });
  const txt = h('input', { type: 'text', id: fid, value: none ? 'none' : toHex6(value), spellcheck: 'false' });
  pick.addEventListener('input', () => { txt.value = pick.value; (onInput || onChange)?.(pick.value); });
  pick.addEventListener('change', () => { onChange?.(pick.value); });
  txt.addEventListener('change', () => {
    const v = txt.value.trim().toLowerCase();
    if (allowNone && (v === 'none' || v === '')) { onChange?.(null); txt.value = 'none'; return; }
    const hx = normalizeHex(v); if (hx) { pick.value = hx; txt.value = hx; onChange?.(hx); } else txt.value = none ? 'none' : toHex6(value);
  });
  txt.addEventListener('keydown', (e) => { if (e.key === 'Enter') txt.blur(); });
  const w = h('div', { class: 'field' + (span === 2 ? ' span2' : span === 3 ? ' span3' : '') }, h('label', { for: fid }, label, allowNone ? h('span', null, 'none ok') : null), h('div', { class: 'color-in' }, pick, txt));
  return w;
}
export function normalizeHex(v) {
  if (!v) return null; v = v.trim();
  if (!v.startsWith('#')) v = '#' + v;
  if (/^#[0-9a-f]{3}$/i.test(v)) v = '#' + [...v.slice(1)].map(c => c + c).join('');
  return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null;
}
export function toHex6(c) {
  if (!c) return '#000000';
  const n = normalizeHex(c); if (n) return n;
  const m = String(c).match(/rgba?\(([^)]+)\)/); if (m) { const [r, g, b] = m[1].split(',').map(Number); return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join(''); }
  return '#000000';
}
export function checkField({ label, value, onChange, id }) {
  const fid = id || uid('f');
  const inp = h('input', { type: 'checkbox', id: fid, checked: !!value });
  inp.addEventListener('change', () => onChange?.(inp.checked));
  return h('label', { class: 'check', for: fid }, inp, label);
}
export function segmented({ options, value, onChange, label }) {
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': label || '' });
  const btns = options.map(o => {
    const b = h('button', { type: 'button', 'aria-pressed': String(o.value === value), title: o.title || o.label, html: o.icon ? icon(o.icon, 16) : '' }, o.icon ? null : o.label);
    b.addEventListener('click', () => { value = o.value; btns.forEach((x, i) => x.setAttribute('aria-pressed', String(options[i].value === value))); onChange?.(o.value); });
    return b;
  });
  seg.append(...btns);
  return seg;
}
export function pane(title, ...kids) {
  return h('section', { class: 'pane' }, h('h3', null, title), ...kids);
}
export function iconBtn(name, title, onclick, cls = '') {
  return h('button', { class: 'btn icon ' + cls, type: 'button', title, 'aria-label': title, html: icon(name, 18), onclick });
}

// ---------- command palette ----------
const commands = new Map();
export function registerCommand(cmd) { commands.set(cmd.id, cmd); }
export function listCommands() { return [...commands.values()]; }
export function runCommand(id) { const c = commands.get(id); if (c && (!c.when || c.when())) c.run(); }
export function openPalette(currentWs, wsColors) {
  const input = h('input', { type: 'text', placeholder: 'Type a command — “export pdf”, “extrude”, “new page”…', 'aria-label': 'Command' });
  const results = h('div', { class: 'results', role: 'listbox' });
  const pal = h('div', { class: 'palette', role: 'dialog', 'aria-label': 'Command palette' }, input, results);
  const bd = h('div', { class: 'backdrop', onpointerdown: (e) => { if (e.target === bd) close(); } }, pal);
  let items = [], sel = 0;
  const score = (c, q) => {
    if (!q) return c.ws === currentWs() ? 2 : 1;
    const t = (c.label + ' ' + (c.ws || '') + ' ' + (c.tags || '')).toLowerCase();
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    let s = 0; for (const w of words) { const i = t.indexOf(w); if (i < 0) return 0; s += i === 0 ? 3 : 1; }
    return s + (c.ws === currentWs() ? 1.5 : 0);
  };
  const render = () => {
    const q = input.value.trim();
    items = listCommands().filter(c => !c.when || c.when()).map(c => [score(c, q), c]).filter(x => x[0] > 0).sort((a, b) => b[0] - a[0]).slice(0, 40).map(x => x[1]);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    clear(results);
    items.forEach((c, i) => results.append(h('div', { class: 'res', role: 'option', 'aria-selected': String(i === sel), onclick: () => { close(); c.run(); } },
      h('span', { class: 'ws-dot', style: { background: c.ws ? wsColors[c.ws] : 'var(--ink)' } }), h('span', null, c.label), c.keys ? h('span', { class: 'kbd' }, c.keys) : null)));
    if (!items.length) results.append(h('div', { class: 'res' }, 'No matching command'));
  };
  const close = () => bd.remove();
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); render(); results.children[sel]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); results.children[sel]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = items[sel]; close(); c?.run(); }
    else if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });
  document.body.append(bd); render(); input.focus();
}

/** Rebuild an inspector panel after changes, but never under the user's fingers: if focus is inside the
 *  panel, wait until it leaves. */
export function panelRebuilder(getPanel, build) {
  let raf = 0, pending = false, bound = null;
  const run = () => { const p = getPanel(); if (!p) return; if (p.contains(document.activeElement) && document.activeElement !== document.body) { pending = true; if (bound !== p) { bound = p; p.addEventListener('focusout', (e) => { if (pending && !p.contains(e.relatedTarget)) { pending = false; setTimeout(build, 0); } }); } return; } pending = false; build(); };
  return () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(run); };
}
export function isTyping(e) {
  const t = e.target; if (!t || !t.tagName) return false;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
}

// file picker
export function pickFile(accept, multiple = false) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, multiple, style: { position: 'fixed', left: '-9999px' } });
    inp.addEventListener('change', () => { resolve(multiple ? [...inp.files] : inp.files[0] || null); inp.remove(); });
    document.body.append(inp); inp.click();
  });
}
export const readAsDataURL = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
export const readAsText = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); });
export const readAsArrayBuffer = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsArrayBuffer(file); });
export function loadImage(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
