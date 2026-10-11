// Safe expression evaluator for parametric values: numbers with units, #variables, + - * / ^ %, parentheses, functions.
// Lengths resolve to millimetres; angles are plain degrees. No eval().
// SPDX-License-Identifier: AGPL-3.0-or-later

const UNIT = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8, pt: 25.4 / 72, deg: 1, '°': 1 };
const FN = {
  sin: (d) => Math.sin(d * Math.PI / 180), cos: (d) => Math.cos(d * Math.PI / 180), tan: (d) => Math.tan(d * Math.PI / 180),
  asin: (x) => Math.asin(x) * 180 / Math.PI, acos: (x) => Math.acos(x) * 180 / Math.PI, atan: (x) => Math.atan(x) * 180 / Math.PI,
  sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  hypot: Math.hypot, pow: Math.pow, clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
};
const CONST = { pi: Math.PI, PI: Math.PI, tau: Math.PI * 2, e: Math.E };

function tokenize(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = s.slice(i).match(/^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i);
    if (num) { out.push({ t: 'n', v: parseFloat(num[0]) }); i += num[0].length; continue; }
    const id = s.slice(i).match(/^#?[A-Za-z_][A-Za-z0-9_]*|^°/);
    if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    if ('+-*/^%(),'.includes(c)) { out.push({ t: c }); i++; continue; }
    throw new Error(`Unexpected “${c}”`);
  }
  return out;
}

export function evaluate(src, vars = {}) {
  if (typeof src === 'number') return src;
  const toks = tokenize(String(src)); let p = 0;
  const peek = () => toks[p], next = () => toks[p++];
  const expect = (t) => { const k = next(); if (!k || k.t !== t) throw new Error(`Expected “${t}”`); };
  function expr() { let v = term(); while (peek() && (peek().t === '+' || peek().t === '-')) { const o = next().t; const r = term(); v = o === '+' ? v + r : v - r; } return v; }
  function term() { let v = power(); while (peek() && ['*', '/', '%'].includes(peek().t)) { const o = next().t; const r = power(); v = o === '*' ? v * r : o === '/' ? v / r : v % r; } return v; }
  function power() { const b = unary(); if (peek() && peek().t === '^') { next(); return Math.pow(b, power()); } return b; }
  function unary() { if (peek() && peek().t === '-') { next(); return -unary(); } if (peek() && peek().t === '+') { next(); return unary(); } return postfix(); }
  function postfix() {
    let v = atom();
    // implicit unit: "40 mm", "2in", "30 deg"
    while (peek() && peek().t === 'id' && UNIT[peek().v] != null) v *= UNIT[next().v];
    return v;
  }
  function atom() {
    const k = next(); if (!k) throw new Error('Unexpected end');
    if (k.t === 'n') return k.v;
    if (k.t === '(') { const v = expr(); expect(')'); return v; }
    if (k.t === 'id') {
      const name = k.v.replace(/^#/, '');
      if (peek() && peek().t === '(' && FN[name]) {
        next(); const args = []; if (peek() && peek().t !== ')') { args.push(expr()); while (peek() && peek().t === ',') { next(); args.push(expr()); } }
        expect(')'); return FN[name](...args);
      }
      if (name in vars) { const v = vars[name]; if (typeof v !== 'number' || !isFinite(v)) throw new Error(`#${name} has no value`); return v; }
      if (name in CONST) return CONST[name];
      throw new Error(`Unknown variable #${name}`);
    }
    throw new Error(`Unexpected “${k.t}”`);
  }
  const v = expr(); if (p < toks.length) throw new Error('Unexpected text after expression');
  if (!isFinite(v)) throw new Error('Result is not a finite number');
  return v;
}
export function tryEval(src, vars) { try { return { ok: true, value: evaluate(src, vars) }; } catch (e) { return { ok: false, error: e.message }; } }

/** Resolve a list of {name, expr} in order, allowing later variables to reference earlier ones. */
export function resolveVars(list, overrides = {}) {
  const vals = {}, errors = {};
  for (const v of list) {
    const src = overrides[v.name] ?? v.expr;
    const r = tryEval(src, vals);
    if (r.ok) vals[v.name] = r.value; else { errors[v.name] = r.error; vals[v.name] = NaN; }
  }
  return { vals, errors };
}
