// Prometheus Vmify devirtualization (kayıt makinesi VM'i). Çıktının biçimi:
//   local function D(list, n, root) ... end                       -- nesne grafiği çözücü (prototipler)
//   return (function(M, ...) <yardımcılar> local function H(proto, upv, env, R, va) ... while true do
//     ins = code[pc] pc = pc + 1 op = ins[1] a, b, c, d = ins[5], ins[3], ins[4], ins[2]
//     if op <= 28 then ... if op == 7 then R[a] = R[b] .. R[c] else error(...) end ... end end
//   ... return (v(M[1], {}, env))(...) end)(D({...}, 118, 34), ...)
// Kaldırma (lifting) statiktir: prototip grafiği sandbox'ta yalnızca çözücü çalıştırılarak alınır (kullanıcı kodu
// çalışmaz), işleyiciler dağıtım ağacından çıkarılır ve her talimat kendi işleyicisinin metnine dönüşür: alan
// değişkenleri talimatın sabitleriyle, kayıtlar __r tablosuyla, pc = x atamaları goto ile değişir. Böylece VM
// döngüsü ve dağıtıcı ortadan kalkar; her prototip düz bir Lua fonksiyonu olur (etiketler ve goto: Lua 5.2+).
// Kapanışlar ağaçtaki yerinde iç fonksiyon olarak yazılır, upvalue kutuları ({değer}) VM'deki gibi korunur.
// Tanınmayan her şeyde (beklenmeyen işleyici, eksik anahtar, çok büyük program) kod olduğu gibi kalır.
import { tryParse, walk, applyEdits, luaString } from '../core/lua.js';

export const id = 'vm';
export const needsSandbox = true;

const MAX_INSTRUCTIONS = 50_000;

const num = (n) => (n?.type === 'NumericLiteral' ? n.value : n?.type === 'UnaryExpression' && n.operator === '-' && n.argument.type === 'NumericLiteral' ? -n.argument.value : null);
const isName = (n, name) => n?.type === 'Identifier' && (name === undefined || n.name === name);

// --- prototip grafiğinin dökümü (Lua tarafı) ---
const DUMP = String.raw`
local __seen, __out, __n = {}, {}, 0
local function __hex(s) return (s:gsub('.', function(c) return string.format('%02x', c:byte()) end)) end
local function __ser(v)
  local t = type(v)
  if t == 'string' then return 's' .. __hex(v) end
  if t == 'number' then return 'n' .. string.format('%.17g', v) end
  if t == 'boolean' then return v and 'T' or 'F' end
  if t == 'table' then
    if __seen[v] then return 'r' .. __seen[v] end
    __n = __n + 1
    local id = __n
    __seen[v] = id
    local parts = {}
    for k, x in pairs(v) do parts[#parts + 1] = __ser(k) .. '=' .. __ser(x) end
    __out[id] = table.concat(parts, ',')
    return 'r' .. id
  end
  return 'x'
end
`;

function parseDump(text) {
  const lines = text.split('\n');
  const tables = new Map();
  const val = (s) => {
    if (s[0] === 's') return Buffer.from(s.slice(1), 'hex').toString('latin1');
    if (s[0] === 'n') return Number(s.slice(1));
    if (s === 'T') return true;
    if (s === 'F') return false;
    if (s[0] === 'r') { const id = Number(s.slice(1)); if (!tables.has(id)) tables.set(id, new Map()); return tables.get(id); }
    return undefined;
  };
  const root = val(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const t = tables.get(i) ?? (tables.set(i, new Map()), tables.get(i));
    for (const kv of lines[i].split(',')) {
      const [k, v] = kv.split('=');
      t.set(val(k), val(v));
    }
  }
  return root;
}

function literal(v) {
  if (v === undefined || v === null) return 'nil';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return luaString(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return Number.isNaN(v) ? '(0/0)' : v > 0 ? '(1/0)' : '(-1/0)';
    return v < 0 || Object.is(v, -0) ? `(${v})` : String(v);
  }
  if (v instanceof Map) {
    const parts = [];
    for (const [k, x] of v) parts.push(`[${literal(k)}] = ${literal(x)}`);
    return `{${parts.join(', ')}}`;
  }
  throw new Error('yazılamayan değer');
}

// Lua # işleci: 1'den başlayan kesintisiz dizinin uzunluğu (sabit talimat tablolarında boşluk yok)
const seqLen = (t) => { let i = 0; while (t.has(i + 1)) i++; return i; };

class Unsupported extends Error {}
const no = (m) => { throw new Unsupported(m); };

// VM yapısını bulur; tanınmazsa null
function locate(ast, code) {
  const last = ast.body.at(-1);
  if (last?.type !== 'ReturnStatement' || last.arguments.length !== 1) return null;
  const call = last.arguments[0];
  const vmFn = call.type === 'CallExpression' ? call.base : null;
  if (vmFn?.type !== 'FunctionDeclaration' || call.arguments.length !== 2 || call.arguments[1].type !== 'VarargLiteral') return null;
  const data = call.arguments[0];
  if (data.type !== 'CallExpression' || !isName(data.base)) return null;
  const deser = ast.body.find((s) => s.type === 'FunctionDeclaration' && s.isLocal && s.identifier?.name === data.base.name);
  if (!deser) return null;
  const protoParam = vmFn.parameters[0];
  if (!isName(protoParam)) return null;
  // yürütücü: içinde while true + dağıtıcı olan local function
  let exec = null;
  let loop = null;
  for (const s of vmFn.body) {
    if (s.type !== 'FunctionDeclaration' || !s.isLocal || s.parameters.length !== 5) continue;
    const w = s.body.find((x) => x.type === 'WhileStatement' && x.condition.type === 'BooleanLiteral' && x.condition.value);
    if (w) { exec = s; loop = w; }
  }
  if (!exec) return null;
  // son deyim: return (v(M[1], {}, env))(...)
  const fin = vmFn.body.at(-1);
  const outer = fin?.type === 'ReturnStatement' ? fin.arguments[0] : null;
  const mk = outer?.type === 'CallExpression' ? outer.base : null;
  if (mk?.type !== 'CallExpression' || mk.arguments.length !== 3 || !isName(mk.arguments[2])) return null;
  const root = mk.arguments[0];
  if (root.type !== 'IndexExpression' || !isName(root.base, protoParam.name) || num(root.index) !== 1) return null;
  return { last, vmFn, data, deser, protoParam, exec, loop, fin, envName: mk.arguments[2].name, src: code };
}

// döngü başı: ins = CODE[pc]; pc = pc + 1; op = ins[1]; a, b, c, d = ins[i], ...
function roles(exec, loop) {
  const [s1, s2, s3, s4] = loop.body;
  if (s1?.type !== 'AssignmentStatement' || s2?.type !== 'AssignmentStatement' || s3?.type !== 'AssignmentStatement' || s4?.type !== 'AssignmentStatement') return null;
  const ins = s1.variables[0]?.name;
  const code = s1.init[0]?.base?.name;
  const pc = s1.init[0]?.index?.name;
  const op = s3.variables[0]?.name;
  if (!ins || !code || !pc || !op || s3.init[0]?.base?.name !== ins || num(s3.init[0]?.index) !== 1) return null;
  const fields = new Map();
  s4.variables.forEach((v, i) => {
    const e = s4.init[i];
    if (e?.type === 'IndexExpression' && isName(e.base, ins) && num(e.index) !== null) fields.set(v.name, num(e.index));
  });
  if (fields.size !== s4.variables.length) return null;
  const dispatch = loop.body.find((s) => s.type === 'IfStatement');
  const params = exec.parameters.map((p) => p.name);
  // local CODE, CONSTS = proto[k1], proto[k2]
  let keys = null;
  for (const s of exec.body) {
    if (s.type === 'LocalStatement' && s.variables.length === 2 && s.variables[0].name === code) {
      const [a, b] = s.init;
      if (isName(a?.base, params[0]) && isName(b?.base, params[0])) keys = { codeKey: num(a.index), constsKey: num(b.index), constsName: s.variables[1].name };
    }
  }
  if (!keys || !dispatch) return null;
  return { ins, code, pc, op, fields, dispatch, params, ...keys };
}

// dağıtım ağacı → opcode → işleyici gövdesi
function handlers(dispatch, op) {
  const out = new Map();
  const visit = (node) => {
    if (node?.type !== 'IfStatement') return;
    const c = node.clauses[0].condition;
    if (c.type !== 'BinaryExpression' || !isName(c.left, op) || num(c.right) === null) return;
    if (c.operator === '<=' || c.operator === '<') {
      node.clauses[0].body.forEach(visit);
      (node.clauses[1]?.body ?? []).forEach(visit);
    } else if (c.operator === '==') out.set(num(c.right), node.clauses[0].body);
  };
  visit(dispatch);
  return out;
}

export async function run(code, ctx) {
  if (!code.includes('unknown VM opcode')) return code;
  const ast = tryParse(code, ctx.version);
  if (!ast) return code;
  const vm = locate(ast, code);
  if (!vm) return code;
  const R = roles(vm.exec, vm.loop);
  if (!R) return code;
  const hs = handlers(R.dispatch, R.op);
  if (!hs.size) return code;
  const vmSrc = code.slice(...vm.vmFn.range);
  // giriş fonksiyonu anahtarları: parametre listesi, vararg bayrağı; paket sayaç anahtarı
  const pk = /local\s+\w+\s*=\s*\w+\[(-?\d+)\]\s*local\s+\w+\s+if\s+not\s+\w+\[(-?\d+)\]\s*and\s*#/.exec(vmSrc);
  const ck = /\{\s*\[(-?\d+)\]\s*=\s*\w+\(\s*"#"\s*,\s*\.\.\.\s*\)\s*[,;]\s*\.\.\.\s*\}/.exec(vmSrc);
  if (!pk || !ck) return code;
  const keys = { params: Number(pk[1]), vararg: Number(pk[2]), count: Number(ck[1]) };

  // prototip grafiği: yalnızca çözücü çağrısı çalıştırılır
  const dump = `${code.slice(...vm.deser.range)}\n${DUMP}\nlocal __root = __ser(${code.slice(...vm.data.range)})\nprint(__root) for i = 1, __n do print(__out[i]) end`;
  const dr = await ctx.runRaw(dump);
  if (!dr?.ok || dr.errors.length || !dr.stdout) return code;
  let root;
  try { root = parseDump(dr.stdout.trimEnd()); } catch { return code; }
  const mainProto = root instanceof Map ? root.get(1) : null;
  if (!(mainProto instanceof Map)) return code;

  try {
    const lifted = lift(mainProto, { vm, R, hs, keys, code });
    // VM girişi kaldırılmış ana fonksiyonla değişir; prototip verisi artık kullanılmaz (parametreye nil gider)
    const protoUses = [];
    walk(vm.vmFn, (n) => { if (isName(n, vm.protoParam.name)) protoUses.push(n); return true; });
    const edits = [{ start: vm.fin.range[0], end: vm.fin.range[1], text: `local __u0 = {}\nreturn (${lifted})(...)` }];
    if (protoUses.length === 2) edits.push({ start: vm.data.range[0], end: vm.data.range[1], text: 'nil' });
    const out = applyEdits(code, edits).code;
    ctx.log(`vm: Prometheus VM kaldırıldı (${lift.stats.protos} prototip, ${lift.stats.instructions} talimat)`, 'info');
    ctx.bump('vm', lift.stats.protos);
    ctx.switchVersion(['5.1', 'LuaJIT'].includes(ctx.version) ? '5.2' : ctx.version);
    return out;
  } catch (e) {
    if (e instanceof Unsupported) { ctx.log(`vm: Prometheus VM tanındı, kaldırılamadı (${e.message})`, 'warn'); return code; }
    throw e;
  }
}

// işleyici gövdesi + talimat → Lua metni
function lift(main, env) {
  const { R, hs, keys, code } = env;
  const stats = { protos: 0, instructions: 0 };
  lift.stats = stats;
  const [P1, P2, P3, P4, P5] = R.params;
  let nextId = 0;
  const closureKeys = { child: null, upv: null };

  // işleyicinin dış adları: yürütücüdeki geçiciler (çağrı başında local olarak bildirilir)
  const temps = new Set();
  for (const s of env.vm.exec.body) if (s.type === 'LocalStatement' && !s.init.length) s.variables.forEach((v) => temps.add(v.name));
  for (const n of [R.ins, R.op, ...R.fields.keys()]) temps.delete(n);

  function liftProto(proto, pid) {
    if (++stats.protos > 2000) no('çok fazla prototip');
    const id = ++nextId;
    const instrs = proto.get(R.codeKey);
    if (!(instrs instanceof Map)) no('talimat listesi yok');
    const consts = proto.get(R.constsKey);
    const n = Math.max(0, ...[...instrs.keys()].filter((k) => typeof k === 'number'));
    stats.instructions += n;
    if (stats.instructions > MAX_INSTRUCTIONS) no('program çok büyük');
    const targets = new Set();
    const bodies = [];
    for (let pc = 1; pc <= n; pc++) {
      const insn = instrs.get(pc);
      if (!(insn instanceof Map)) no(`talimat ${pc} yok`);
      const op = insn.get(1);
      const body = hs.get(op);
      if (!body) no(`işleyicisi olmayan opcode ${op}`);
      bodies.push(emit(body, insn, { id, pid, proto, consts, targets }));
    }
    // giriş: parametreler ve vararg (VM'deki giriş fonksiyonunun yaptığı gibi)
    const params = proto.get(keys.params);
    const plist = params instanceof Map ? [...params.entries()].filter(([k]) => typeof k === 'number').sort((a, b) => a[0] - b[0]).map(([, v]) => v) : [];
    const head = [`local __a = {[${literal(keys.count)}] = select("#", ...), ...}`, `local __r = {}`, `local __v${id} = {[${literal(keys.count)}] = 0}`];
    if ([...temps].length) head.push(`local ${[...temps].map((t) => tempName(t)).join(', ')}`);
    plist.forEach((p, i) => {
      if (!(p instanceof Map)) no('parametre biçimi');
      const reg = literal(p.get(1));
      head.push(p.get(2) ? `__r[${reg}] = {__a[${i + 1}]}` : `__r[${reg}] = __a[${i + 1}]`);
    });
    if (proto.get(keys.vararg)) {
      head.push(`if __a[${literal(keys.count)}] > ${plist.length} then __v${id}[${literal(keys.count)}] = __a[${literal(keys.count)}] - ${plist.length} end`,
        `for __i = 1, __v${id}[${literal(keys.count)}] do __v${id}[__i] = __a[${plist.length} + __i] end`);
    }
    const lines = bodies.map((b, i) => `${targets.has(i + 1) ? `::__L${i + 1}:: ` : ''}do ${b} end`);
    // son talimattan sonra düşme olmaz (VM döngüsü return'e kadar sürer)
    return `function(...)\n${head.join('\n')}\n${lines.join('\n')}\nend`;
  }
  const tempName = (t) => `__t_${t}`;

  // gövde metni: tanımlayıcılar AST aralıklarıyla değiştirilir
  function emit(body, insn, p) {
    const src = code;
    const start = body[0].range[0];
    const end = body.at(-1).range[1];
    const edits = [];
    const field = (name) => insn.get(R.fields.get(name));
    let closure = null;
    const declared = new Set();
    walk(body, (n) => {
      if (n.type === 'LocalStatement') n.variables.forEach((v) => declared.add(v.name));
      if (n.type === 'ForNumericStatement') declared.add(n.variable.name);
      if (n.type === 'ForGenericStatement') n.variables.forEach((v) => declared.add(v.name));
      return true;
    });
    // kapanış oluşturma: T = proto[CHILD][f] ... R[a] = mk(T, ups, env)
    const text = src.slice(start, end);
    if (new RegExp(`\\b${P1}\\s*\\[`).test(text)) closure = closureOf(body, insn, p);
    if (closure !== null) return closure;
    const isField = (x) => isName(x) && R.fields.has(x.name) && !declared.has(x.name);
    walk(body, (n, parent, key) => {
      // alan sabit tabloysa: f[2] → öğe, #f → uzunluk; for i = 1, #f do R[f[i]] = nil end → R[a], R[b] = nil, nil
      if (n.type === 'IndexExpression' && isField(n.base) && num(n.index) !== null) {
        const t = field(n.base.name);
        if (t instanceof Map) { edits.push({ start: n.range[0], end: n.range[1], text: literal(t.get(num(n.index))) }); return false; }
      }
      if (n.type === 'UnaryExpression' && n.operator === '#' && isField(n.argument)) {
        const t = field(n.argument.name);
        if (t instanceof Map) { edits.push({ start: n.range[0], end: n.range[1], text: String(seqLen(t)) }); return false; }
      }
      if (n.type === 'ForNumericStatement' && n.end.type === 'UnaryExpression' && n.end.operator === '#' && isField(n.end.argument) && n.body.length === 1) {
        const t = field(n.end.argument.name);
        const s = n.body[0];
        const target = s.type === 'AssignmentStatement' && s.variables.length === 1 ? s.variables[0] : null;
        if (t instanceof Map && num(n.start) === 1 && (!n.step || num(n.step) === 1) && target?.type === 'IndexExpression' && isName(target.base, P4)
          && target.index.type === 'IndexExpression' && isName(target.index.base, n.end.argument.name) && isName(target.index.index, n.variable.name)
          && s.init[0]?.type === 'NilLiteral') {
          const regs = Array.from({ length: seqLen(t) }, (_, i) => `__r[${literal(t.get(i + 1))}]`);
          edits.push({ start: n.range[0], end: n.range[1], text: regs.length ? `${regs.join(', ')} = nil` : '' });
          return false;
        }
      }
      // pc = alan → goto
      if (n.type === 'AssignmentStatement' && n.variables.length === 1 && isName(n.variables[0], R.pc)) {
        const v = n.init[0];
        if (!isName(v) || !R.fields.has(v.name)) no('hesaplanan atlama');
        const t = field(v.name);
        if (typeof t !== 'number') no('atlama hedefi');
        p.targets.add(t);
        edits.push({ start: n.range[0], end: n.range[1], text: ` goto __L${t} ` });
        return false;
      }
      if (n.type !== 'Identifier') return true;
      if ((parent?.type === 'MemberExpression' && key === 'identifier') || (parent?.type === 'TableKeyString' && key === 'key')) return true;
      if (declared.has(n.name)) return true;
      let rep = null;
      if (R.fields.has(n.name)) rep = literal(field(n.name));
      else if (n.name === P4) rep = '__r';
      else if (n.name === R.constsName) rep = `__k${p.id}`;
      else if (n.name === P2) rep = `__u${p.id}`;
      else if (n.name === P3) rep = env.vm.envName;
      else if (n.name === P5) rep = `__v${p.id}`;
      else if (temps.has(n.name)) rep = tempName(n.name);
      else if ([P1, R.pc, R.ins, R.op, R.code].includes(n.name)) no(`işleyici ${n.name} kullanıyor`);
      if (rep !== null) edits.push({ start: n.range[0], end: n.range[1], text: rep.startsWith('{') ? `(${rep})` : rep });
      return true;
    });
    let out = applyEdits(src.slice(0, end), edits.filter((e) => e.start >= start)).code.slice(start);
    // sabitler: __kN[<sayı>] → literal
    out = out.replace(new RegExp(`__k${p.id}\\[\\s*(\\(?-?[\\d.]+\\)?)\\s*\\]`, 'g'), (m, k) => {
      const v = p.consts instanceof Map ? p.consts.get(Number(k.replace(/[()]/g, ''))) : undefined;
      if (v === undefined && !(p.consts instanceof Map && p.consts.has(Number(k.replace(/[()]/g, ''))))) return m;
      return literal(v);
    });
    if (new RegExp(`__k${p.id}\\b`).test(out)) out = `local __k${p.id} = ${literal(p.consts ?? new Map())} ${out}`;
    return out;
  }

  // kapanış talimatı: alt prototip + upvalue tanımları ({0, kayıt} | {1, upvalue})
  function closureOf(body, insn, p) {
    const text = code.slice(body[0].range[0], body.at(-1).range[1]);
    const m = new RegExp(`\\b${P1}\\s*\\[\\s*(-?\\d+)\\s*\\]\\s*\\[\\s*(\\w+)\\s*\\]`).exec(text);
    const u = /#\s*\w+\s*\[\s*(-?\d+)\s*\]/.exec(text);
    const dest = new RegExp(`\\b${P4}\\s*\\[\\s*(\\w+)\\s*\\]\\s*=\\s*\\w+\\s*\\(\\s*\\w+\\s*,\\s*\\w+\\s*,\\s*${P3}\\s*\\)\\s*$`).exec(text);
    if (!m || !u || !dest || !R.fields.has(m[2]) || !R.fields.has(dest[1])) no('kapanış biçimi');
    closureKeys.child = Number(m[1]);
    closureKeys.upv = Number(u[1]);
    const child = p.proto.get(closureKeys.child)?.get(insn.get(R.fields.get(m[2])));
    if (!(child instanceof Map)) no('alt prototip yok');
    const descs = child.get(closureKeys.upv);
    const ups = descs instanceof Map ? [...descs.entries()].filter(([k]) => typeof k === 'number').sort((a, b) => a[0] - b[0]).map(([, d]) => d) : [];
    const cid = nextId + 1;
    const items = ups.map((d) => (d.get(1) === 0 ? `__r[${literal(d.get(2))}]` : `__u${p.id}[${literal(d.get(2))}]`));
    const fn = liftProto(child, p.id);
    return `local __u${cid} = {${items.join(', ')}} __r[${literal(insn.get(R.fields.get(dest[1])))}] = ${fn}`;
  }

  return liftProto(main, 0);
}
