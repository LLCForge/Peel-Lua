// Metatable vekilleri (Prometheus ProxifyLocals): local değer bir tablonun alanında tutulur, okuma ve yazma
// metamethod'lu işleçlerle yapılır:
//   local x = setmetatable({po = 0}, {__mul = function(t, v) t.po = v end, __sub = function(t, k) return t.po end})
//   print(x - "G6")         okuma            → print(x)
//   E(x * (x - "a") + 1)    yazma (E boş)    → x = (x) + 1        (E: local E = function() end)
//   x.po = 5                çoklu atama      → x = 5
// Vekil local'in her başvurusu bu biçimlerden biri olmalıdır; değilse dokunulmaz. Kurulum setmetatable({...}, {...})
// başlangıç değeriyle değişir.
import { tryParse, walk, applyEdits, pad } from '../core/lua.js';
import { bind } from '../core/scope.js';

export const id = 'proxify';

const OPS = { __add: '+', __sub: '-', __mul: '*', __div: '/', __mod: '%', __pow: '^', __concat: '..', __index: '[]' };

const keyName = (f) => (f.type === 'TableKeyString' ? f.key.name : f.type === 'TableKey' && f.key.type === 'StringLiteral' ? f.key.value : null);
// alan erişimi t.K / t["K"] (t: verilen parametre)
const fieldOf = (n, param, k) => n && ((n.type === 'MemberExpression' && n.indexer === '.' && n.identifier.name === k)
  || (n.type === 'IndexExpression' && n.index.type === 'StringLiteral' && n.index.value === k)) && n.base.type === 'Identifier' && n.base.name === param;

function setterOf(fn, k) {
  if (fn?.type !== 'FunctionDeclaration' || fn.parameters.length !== 2 || fn.body.length !== 1) return false;
  const [t, v] = fn.parameters.map((p) => p.name);
  const s = fn.body[0];
  return s.type === 'AssignmentStatement' && s.variables.length === 1 && s.init.length === 1 && fieldOf(s.variables[0], t, k)
    && s.init[0].type === 'Identifier' && s.init[0].name === v;
}
function getterOf(fn, k) {
  if (fn?.type !== 'FunctionDeclaration' || !fn.parameters.length || fn.body.length !== 1) return false;
  const t = fn.parameters[0].name;
  const s = fn.body[0];
  if (s.type !== 'ReturnStatement' || s.arguments.length !== 1) return false;
  const e = s.arguments[0];
  if (fieldOf(e, t, k)) return true;
  // rawget(t, "K")
  return e.type === 'CallExpression' && e.base.type === 'Identifier' && e.base.name === 'rawget' && e.arguments.length === 2
    && e.arguments[0].type === 'Identifier' && e.arguments[0].name === t && e.arguments[1].type === 'StringLiteral' && e.arguments[1].value === k;
}

export async function run(code, ctx) {
  const ast = tryParse(code, ctx.version);
  if (!ast) return code;
  const b = bind(ast);
  const rebound = (name) => b.decls.some((d) => d.name === name) || (b.globals.get(name)?.writes.length ?? 0) > 0;
  if (rebound('setmetatable') || rebound('rawget')) return code;
  const parent = new Map();
  walk(ast, (n, p, key) => { parent.set(n, { p, key }); return true; });

  // boş fonksiyonlar (yazma sarmalayıcısı): local E = function() end, başka yazma yok
  const empty = new Set(b.decls.filter((d) => d.kind === 'local' && !d.writes.length && d.init?.type === 'FunctionDeclaration'
    && !d.init.parameters.length && !d.init.body.length));

  // kurulum: { decl, call, field, init, set, get }
  const proxies = new Map();
  const consider = (v, call) => {
    if (v?.type !== 'Identifier' || call?.type !== 'CallExpression' || call.base.type !== 'Identifier' || call.base.name !== 'setmetatable') return;
    const [obj, meta] = call.arguments;
    if (call.arguments.length !== 2 || obj.type !== 'TableConstructorExpression' || meta.type !== 'TableConstructorExpression') return;
    if (obj.fields.length !== 1 || meta.fields.length !== 2) return;
    const k = keyName(obj.fields[0]);
    if (!k) return;
    const d = b.declOf.get(v);
    if (!d || d.kind !== 'local' || proxies.has(d)) return;
    let set = null;
    let get = null;
    for (const f of meta.fields) {
      const op = OPS[keyName(f)];
      if (!op) return;
      if (setterOf(f.value, k)) set = op;
      else if (getterOf(f.value, k)) get = op;
    }
    if (!set || !get || set === get) return;
    proxies.set(d, { d, call, k, init: obj.fields[0].value, set, get });
  };
  walk(ast, (n) => {
    if (n.type === 'LocalStatement' && n.variables.length === 1 && n.init.length === 1) consider(n.variables[0], n.init[0]);
    if (n.type === 'AssignmentStatement' && n.variables.length === 1 && n.init.length === 1) consider(n.variables[0], n.init[0]);
    return true;
  });
  if (!proxies.size) return code;

  const edits = [];
  let count = 0;
  for (const p of proxies.values()) {
    const name = p.d.name;
    const local = [];
    let ok = true;
    // kurulum dışında yazma yok (local x; x = setmetatable(...) biçiminde tek yazma kurulumun kendisi)
    for (const w of p.d.writes) {
      const { p: st } = parent.get(w) ?? {};
      if (!(st?.type === 'AssignmentStatement' && st.init[0] === p.call)) { ok = false; break; }
    }
    for (const r of p.d.reads) {
      if (!ok) break;
      const { p: up, key } = parent.get(r) ?? {};
      if (!up) { ok = false; break; }
      // okuma: x <op> literal / x[literal]
      if (p.get !== '[]' && up.type === 'BinaryExpression' && up.operator === p.get && key === 'left') {
        local.push({ start: up.range[0], end: up.range[1], text: name });
        continue;
      }
      if (p.get === '[]' && up.type === 'IndexExpression' && key === 'base' && (parent.get(up)?.key !== 'variables')) {
        local.push({ start: up.range[0], end: up.range[1], text: name });
        continue;
      }
      // çoklu atamada hedef: x.K = v
      if ((up.type === 'MemberExpression' || up.type === 'IndexExpression') && key === 'base' && fieldOf(up, name, p.k) && parent.get(up)?.key === 'variables') {
        local.push({ start: up.range[0], end: up.range[1], text: name });
        continue;
      }
      // yazma: E(x <op> v) deyimi
      const wrap = parent.get(up);
      const call = wrap?.p;
      const stmt = parent.get(call ?? {})?.p;
      const isSet = p.set === '[]' ? up.type === 'IndexExpression' && key === 'base' : up.type === 'BinaryExpression' && up.operator === p.set && key === 'left';
      if (isSet && call?.type === 'CallExpression' && call.arguments.length === 1 && call.arguments[0] === up && call.base.type === 'Identifier'
        && empty.has(b.declOf.get(call.base)) && stmt?.type === 'CallStatement') {
        const value = p.set === '[]' ? up.index : up.right;
        local.push({ start: stmt.range[0], end: stmt.range[1], prefix: `${name} = `, vRange: value.range });
        continue;
      }
      ok = false;
    }
    if (!ok) continue;
    edits.push(...local);
    edits.push({ start: p.call.range[0], end: p.call.range[1], prefix: '', vRange: p.init?.range, text: 'nil' });
    count++;
  }
  if (!edits.length) return code;
  // iç içe düzenlemeler (yazılan değerin ya da başlangıç değerinin içindeki vekil okumaları) dıştakinin metnine işlenir
  edits.sort((x, y) => (x.end - x.start) - (y.end - y.start));
  for (const e of edits) {
    if (!e.vRange) continue;
    const [vs, ve] = e.vRange;
    const inner = edits.filter((x) => x !== e && !x.drop && x.start >= vs && x.end <= ve);
    inner.forEach((x) => { x.drop = true; });
    e.text = e.prefix + applyEdits(code.slice(vs, ve), inner.map((x) => ({ start: x.start - vs, end: x.end - vs, text: pad(code, x.start, x.end, x.text) }))).code;
  }
  const r = applyEdits(code, edits.filter((e) => !e.drop).map((e) => ({ ...e, text: pad(code, e.start, e.end, e.text) })));
  ctx.log(`proxify: ${count} metatable vekili local'e çevrildi`, 'info');
  ctx.bump('proxify', count);
  return r.code;
}
