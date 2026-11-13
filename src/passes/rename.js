// Anlamsız local adlarını kullanımdan türetilen adlarla değiştirir: l_0_, IlIlIl, _0x1f, karıştırılmış tek/iki harfli
// adlar (Prometheus: E, P, Hh). Türetme: for i/j/k, pairs → k, v; local function / fonksiyon değeri → fn (dizge
// baytlarıyla döngü kuran → decode); başlangıç değerinden str/num/tbl/flag, kütüphane alanı adı (local floor =
// math.floor), Roblox servisi (game:GetService("Players") → Players), require("x") → x; kullanımdan tbl/fn/str/num.
// Yeni adlar dosya genelinde benzersizdir (hiçbir local'i ya da küreseli gölgelemez). Küresellere dokunulmaz; debug
// kütüphanesi (debug.getlocal adları görür) varsa ya da _ENV local ise hiçbir şey değişmez.
import { tryParse, walk, applyEdits } from '../core/lua.js';
import { bind } from '../core/scope.js';

export const id = 'rename';

const KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in', 'local',
  'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while', 'continue', 'type', 'export']);
const COMMON = new Set(['id', 'ok', 'fn', 'cb', 'ip', 'db', 'ui', 'dx', 'dy', 'op', 'el', 'ex', 'to', 'at']);
const SHORT_OK = new Set(['i', 'j', 'k', 'v', 'x', 'y', 'z', 'n', 's', 't', '_']);

/** Okunmaz ad mı (bench ölçümü de bunu kullanır) */
export const meaningless = (n) => /^(l_\d+_|_0x[0-9a-f]+$|_+$)/i.test(n) && n !== '_'
  || /^[Il1]{4,}$/.test(n) || /^[Il1_]{5,}$/.test(n)
  || (n.length <= 2 && !COMMON.has(n) && !SHORT_OK.has(n));
// tek harfli geleneksel adlar ancak daha iyi bir ad türetilebiliyorsa değişir
const weak = (n) => SHORT_OK.has(n) && n !== '_';

const LIB_FIELD = /^(string|table|math|bit32|bit|utf8|os|io|coroutine)$/;

export async function run(code, ctx) {
  const ast = tryParse(code, ctx.version);
  if (!ast) return code;
  const b = bind(ast);
  if (b.globals.has('debug') || b.decls.some((d) => d.name === '_ENV')) return code;
  const parent = new Map();
  walk(ast, (n, p, key) => { parent.set(n, { p, key }); return true; });

  // ad çakışması: yeni ad, kapsamı örtüşen hiçbir local'in adı olmamalı ve kapsamda o adla küresel okunmamalı
  const scopeOf = (d) => {
    if (d.kind === 'param' || d.kind === 'for') { const p = parent.get(d.id)?.p; return p ? p.range : [0, code.length]; }
    const owner = parent.get(d.stmt)?.p;
    return [d.id.range[0], owner?.range ? owner.range[1] : code.length];
  };
  const taken = new Map(); // ad → kapsam aralıkları
  const claim = (name, r) => taken.set(name, [...(taken.get(name) ?? []), r]);
  for (const d of b.decls) if (d.id.range) claim(d.name, scopeOf(d));
  const globalRefs = new Map();
  for (const [node, name] of b.globalOf) if (node.range) globalRefs.set(name, [...(globalRefs.get(name) ?? []), node.range[0]]);
  const overlap = (a, c) => a[0] < c[1] && c[0] < a[1];
  const free = (name, r) => !KEYWORDS.has(name) && !(taken.get(name) ?? []).some((x) => overlap(x, r))
    && !(globalRefs.get(name) ?? []).some((o) => o >= r[0] && o < r[1]);
  const fresh = (base, r) => {
    let name = base;
    for (let i = 2; !free(name, r); i++) name = `${base}${i}`;
    claim(name, r);
    return name;
  };

  const loopDepth = (node) => {
    let depth = 0;
    for (let n = parent.get(node)?.p; n; n = parent.get(n)?.p) {
      if (n.type === 'ForNumericStatement') depth++;
      if (n.type === 'FunctionDeclaration') break;
    }
    return depth;
  };
  const decodes = (fn) => {
    let bytes = false;
    let loop = false;
    walk(fn.body ?? [], (n) => {
      if (n.type === 'MemberExpression' && ['byte', 'char'].includes(n.identifier.name)) bytes = true;
      if (/^For|While|Repeat/.test(n.type)) loop = true;
      return true;
    });
    return bytes && loop;
  };
  const fromInit = (e) => {
    if (!e) return null;
    switch (e.type) {
      case 'StringLiteral': return 'str';
      case 'NumericLiteral': return 'num';
      case 'BooleanLiteral': return 'flag';
      case 'TableConstructorExpression': return 'tbl';
      case 'FunctionDeclaration': return decodes(e) ? 'decode' : 'fn';
      case 'BinaryExpression': return e.operator === '..' ? 'str' : ['==', '~=', '<', '>', '<=', '>='].includes(e.operator) ? 'flag' : 'num';
      case 'UnaryExpression': return e.operator === '#' ? 'len' : e.operator === 'not' ? 'flag' : 'num';
      case 'MemberExpression':
        if (e.base.type === 'Identifier' && LIB_FIELD.test(e.base.name) && /^[A-Za-z_]\w*$/.test(e.identifier.name)) return e.identifier.name;
        return /^[A-Za-z_]\w{2,}$/.test(e.identifier.name) ? e.identifier.name : null;
      case 'CallExpression': case 'StringCallExpression': {
        const args = e.arguments ?? [e.argument];
        const base = e.base;
        const name = base.type === 'Identifier' ? base.name : base.type === 'MemberExpression' ? base.identifier.name : null;
        const s0 = args?.[0]?.type === 'StringLiteral' ? args[0].value : null;
        if (name === 'GetService' && s0 && /^[A-Za-z]\w*$/.test(s0)) return s0;
        if (name === 'require' && s0) { const m = /([A-Za-z_]\w*)$/.exec(s0.replace(/\.lua$/, '')); if (m) return m[1]; }
        if (['tostring', 'char', 'concat', 'format', 'rep', 'sub', 'gsub', 'lower', 'upper', 'reverse'].includes(name)) return 'str';
        if (['tonumber', 'floor', 'ceil', 'byte', 'len', 'random', 'abs', 'max', 'min'].includes(name)) return 'num';
        if (name === 'setmetatable') return 'obj';
        if (name === 'pcall') return 'ok';
        if (name === 'open') return 'file';
        return null;
      }
      default: return null;
    }
  };
  const fromUse = (d) => {
    for (const r of d.reads) {
      const { p, key } = parent.get(r) ?? {};
      if (!p) continue;
      if ((p.type === 'IndexExpression' || p.type === 'MemberExpression') && key === 'base' && p.indexer !== ':') return 'tbl';
      if (p.type === 'UnaryExpression' && p.operator === '#') return 'tbl';
      if ((p.type === 'CallExpression' || p.type === 'StringCallExpression') && key === 'base') return 'fn';
      if (p.type === 'MemberExpression' && p.indexer === ':' && key === 'base') return 'str';
      if (p.type === 'BinaryExpression' && p.operator === '..') return 'str';
      if (p.type === 'BinaryExpression' && ['+', '-', '*', '/', '%', '^'].includes(p.operator)) return 'num';
    }
    return null;
  };

  const edits = [];
  let count = 0;
  for (const d of b.decls) {
    if (!d.id.range || d.name === '_ENV' || d.name === 'self') continue;
    const bad = meaningless(d.name);
    if (!bad && !weak(d.name)) continue;
    let name = null;
    if (d.kind === 'for') {
      const s = parent.get(d.id)?.p;
      if (s?.type === 'ForNumericStatement') name = ['i', 'j', 'k'][loopDepth(s)] ?? 'idx';
      else if (s?.type === 'ForGenericStatement') {
        const idx = s.variables.indexOf(d.id);
        const it = s.iterators[0];
        const fn = it?.type === 'CallExpression' && it.base.type === 'Identifier' ? it.base.name : null;
        name = idx === 0 ? (fn === 'ipairs' ? 'i' : 'k') : idx === 1 ? 'v' : `v${idx}`;
      }
    } else if (d.kind === 'localfunction') name = decodes(d.init) ? 'decode' : 'fn';
    else if (d.kind === 'param') name = 'arg';
    else name = fromInit(d.init) ?? fromUse(d);
    if (!name) {
      if (!bad) continue;
      name = 'var';
    }
    if (name === d.name) continue;
    // tek harfli geleneksel ad yalnızca anlamlı bir türetmeyle değişir (i → i değil, x → tbl)
    if (!bad && ['var', 'arg', 'num', 'i', 'j', 'k', 'v'].includes(name)) continue;
    const next = fresh(name, scopeOf(d));
    for (const n of [d.id, ...d.reads, ...d.writes]) if (n.range) edits.push({ start: n.range[0], end: n.range[1], text: next });
    count++;
  }
  if (!edits.length) return code;
  const r = applyEdits(code, edits);
  ctx.log(`rename: ${count} local yeniden adlandırıldı`, 'info');
  ctx.bump('rename', count);
  return r.code;
}
