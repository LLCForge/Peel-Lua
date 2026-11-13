// Dizge çözücüler ve sabit dizileri (Prometheus EncryptStrings / ConstantArray ve benzerleri):
//   local function D(i) return F[i + 53489] end ... print(D(-53483))        → print("Keyboard")
//   function p(s, k) ...şifre çözme... end ... L[p("\168:\014", 19624983)]   → "Hello"
// Aday çözücü: bir kez fonksiyon değeri atanan local. Gövdesi statik olarak denetlenir: küresel yazma yok, yalnızca
// zararsız kütüphaneler (string, math, table, bit...) okunur, dış local'leri (upvalue) "özel durum"dur: her başvurusu
// ilk çağrı sitesinden önceki kurulum kodunda, çözücü gövdelerinde ya da çağrı sitelerinin içindedir ve kurulum
// deyimleri de yalnızca zararsız küresellere dokunur. Böyle bir çözücünün sabit argümanlı çağrısını silmek gözlenebilir
// bir yan etkiyi silmez.
// Değerler sandbox'ta yakalanır: siteler __peel_cap(k, ...) ile sarılıp iki kez çalıştırılır (varyant 2: dış girdi,
// saat ve rastgelelik farklı). Her çalıştırmada aynı tek değeri (dizge/sayı/boolean/nil) üreten site literal olur.
// Hiç çalışmayan ya da farklı değer üreten site olduğu gibi kalır. Sonucu hattın davranış doğrulaması ayrıca denetler.
import { tryParse, walk, applyEdits, luaLiteral, pad } from '../core/lua.js';
import { bind } from '../core/scope.js';

export const id = 'strings';
export const needsSandbox = true;

const ALLOWED = new Set(['string', 'math', 'table', 'bit32', 'bit', 'utf8', 'select', 'type', 'tonumber', 'tostring', 'ipairs',
  'pairs', 'next', 'unpack', 'setmetatable', 'getmetatable', 'rawequal', 'rawlen', 'error', 'assert', 'pcall', 'newproxy']);
const MAX_LITERAL = 1_000_000;

const inside = (n, r) => Boolean(n.range) && n.range[0] >= r[0] && n.range[1] <= r[1];
const isConstArg = (a) => ['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NilLiteral'].includes(a.type)
  || (a.type === 'UnaryExpression' && a.operator === '-' && a.argument.type === 'NumericLiteral')
  // Prometheus SplitStrings: f({2, 1, {"ex", "__ind"}}) — her çağrıda taze, yalnızca sabitlerden tablo
  || (a.type === 'TableConstructorExpression' && a.fields.every((f) => f.type === 'TableValue' && isConstArg(f.value)));

export async function run(code, ctx) {
  const ast = tryParse(code, ctx.version);
  if (!ast) return code;
  const b = bind(ast);
  const writtenGlobals = new Set([...b.globals].filter(([, g]) => g.writes.length).map(([n]) => n));
  const safeGlobal = (name) => ALLOWED.has(name) && !writtenGlobals.has(name);

  // her local'e atanan fonksiyon değerleri ve deyimler (en içteki kapsayan deyimi bulmak için)
  const fnDefs = new Map();
  const statements = [];
  const addDef = (d, fn) => { if (d) fnDefs.set(d, [...(fnDefs.get(d) ?? []), fn]); };
  walk(ast, (n) => {
    if (Array.isArray(n.body)) for (const s of n.body) statements.push(s);
    if (n.type === 'IfStatement') for (const c of n.clauses) for (const s of c.body) statements.push(s);
    if (n.type === 'FunctionDeclaration' && n.identifier?.type === 'Identifier') addDef(b.declOf.get(n.identifier), n);
    if (n.type === 'LocalStatement' || n.type === 'AssignmentStatement') {
      n.variables.forEach((v, i) => { if (v.type === 'Identifier' && n.init[i]?.type === 'FunctionDeclaration') addDef(b.declOf.get(v), n.init[i]); });
    }
    return true;
  });

  // kirli konumlar: zararsız olmayan küresel başvuruları (kurulum deyimlerinde bulunmamalı)
  const dirty = [];
  for (const [node, name] of b.globalOf) if (!safeGlobal(name) && node.range) dirty.push(node.range[0]);
  dirty.sort((x, y) => x - y);
  const hasDirty = (r) => {
    let lo = 0;
    let hi = dirty.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (dirty[m] < r[0]) lo = m + 1; else hi = m; }
    return lo < dirty.length && dirty[lo] < r[1];
  };
  statements.sort((x, y) => x.range[0] - y.range[0] || y.range[1] - x.range[1]);
  const innermost = (node) => {
    let best = null;
    for (const s of statements) {
      if (s.range[0] > node.range[0]) break;
      if (s.range[1] >= node.range[1] && (!best || s.range[1] - s.range[0] <= best.range[1] - best.range[0])) best = s;
    }
    return best;
  };

  // çözücü adayları: tek fonksiyon değeri, başka yazma yok, gövde zararsız
  const decoders = new Map(); // decl → { fn, upvalues:Set<decl> }
  for (const [d, defs] of fnDefs) {
    if (defs.length !== 1) continue;
    const fn = defs[0];
    const otherWrites = d.writes.filter((w) => w !== fn.identifier);
    if (otherWrites.length) continue;
    if (d.kind === 'local' && d.init && d.init !== fn && d.init.type !== 'NilLiteral') continue;
    const upvalues = new Set();
    let ok = true;
    walk(fn, (n) => {
      if (!ok || n.type !== 'Identifier') return ok;
      const dd = b.declOf.get(n);
      if (dd) {
        if (dd !== d && dd.id.range && !inside(dd.id, fn.range)) upvalues.add(dd);
      } else if (b.globalOf.has(n) && !safeGlobal(b.globalOf.get(n))) ok = false;
      return true;
    });
    if (ok) decoders.set(d, { fn, upvalues });
  }
  if (!decoders.size) return code;


  // çağrı siteleri: çözücü(sabitler); dışında yerel tablo indeksi varsa (L[p(...)]) o da denenir
  const sites = [];
  walk(ast, (n, parent, key) => {
    if (n.type !== 'CallExpression' || n.base.type !== 'Identifier') return true;
    const d = b.declOf.get(n.base);
    if (!decoders.has(d) || !n.arguments.every(isConstArg)) return true;
    if (key === 'expression' && parent?.type === 'CallStatement') return true;
    const site = { node: n, key, d, outer: null };
    if (parent?.type === 'IndexExpression' && key === 'index' && parent.base.type === 'Identifier') {
      const t = b.declOf.get(parent.base);
      if (t) site.outer = { node: parent, table: t };
    }
    sites.push(site);
    return true;
  });
  if (!sites.length) return code;

  // özel durum denetimi (çözücü ve dıştaki tablolar için)
  const fnRanges = [...decoders.values()].map((x) => x.fn.range);
  const siteRanges = sites.map((s) => (s.outer ?? s).node.range);
  const firstSite = new Map();
  for (const s of sites) firstSite.set(s.d, Math.min(firstSite.get(s.d) ?? Infinity, s.node.range[0]));
  const privateOk = (u, first) => [u.id, ...u.reads, ...u.writes].every((r) => {
    if (!r.range) return true;
    if (fnRanges.some((fr) => inside(r, fr)) || siteRanges.some((sr) => inside(r, sr))) return true;
    if (r.range[0] >= first) return false;
    const s = innermost(r);
    return Boolean(s) && !hasDirty(s.range);
  });
  const okDecoder = new Map();
  const isOk = (d) => {
    if (!okDecoder.has(d)) okDecoder.set(d, [...decoders.get(d).upvalues].every((u) => privateOk(u, firstSite.get(d) ?? Infinity)));
    return okDecoder.get(d);
  };
  const live = sites.filter((s) => isOk(s.d));
  if (!live.length) return code;
  for (const s of live) if (s.outer && !privateOk(s.outer.table, firstSite.get(s.d))) s.outer = null;

  // araçlama: her site (ve dış indeks) numaralandırılır
  let k = 0;
  const edits = [];
  for (const s of live) {
    s.k = ++k;
    const inner = `__peel_cap(${s.k}, ${code.slice(...s.node.range)})`;
    if (s.outer) {
      s.outer.k = ++k;
      const o = s.outer.node.range;
      edits.push({ start: o[0], end: o[1], text: `__peel_cap(${s.outer.k}, ${code.slice(o[0], s.node.range[0])}${inner}${code.slice(s.node.range[1], o[1])})` });
    } else edits.push({ start: s.node.range[0], end: s.node.range[1], text: inner });
  }
  const inst = applyEdits(code, edits).code;
  const r0 = await ctx.runRaw(inst);
  if (!r0?.ok || !r0.caps) return code;
  const r2 = await ctx.runRaw(inst, 2);
  const value = (key) => {
    const a = r0.caps[key];
    const c = r2?.caps?.[key];
    if (!a || !c || a.n !== 1 || c.n !== 1 || a.type !== c.type || a.value !== c.value) return null;
    if (a.type === 'string' && a.value.length > MAX_LITERAL) return null;
    return luaLiteral(a.type, a.value);
  };

  const out = [];
  for (const s of live) {
    let target = s.outer && value(s.outer.k) !== null ? s.outer.node : null;
    let lit = target ? value(s.outer.k) : null;
    if (!target) { lit = value(s.k); target = lit !== null ? s.node : null; }
    if (!target) continue;
    const [start, end] = target.range;
    // literal çağrı/indeks/yöntem tabanı olamaz: ("abc"):upper(); ".." birleştirme taban değildir
    const after = code.slice(end).match(/^\s*(\.\.|.)/)?.[1] ?? '';
    const isBase = (target === s.node && s.key === 'base') || /^[:[.("'{]$/.test(after);
    out.push({ start, end, text: pad(code, start, end, isBase && !lit.startsWith('(') ? `(${lit})` : lit) });
  }
  if (!out.length) return code;
  const res = applyEdits(code, out);
  ctx.log(`strings: ${res.applied} çözücü çağrısı literale çevrildi`, 'info');
  ctx.bump('strings', res.applied);
  return res.code;
}
