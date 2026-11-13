// Luau → Lua indirme. Roblox betikleri çoğunlukla Luau'dur; luaparse Luau'ya özgü sözdizimini ayrıştıramaz. Güvenli,
// anlamı koruyan dönüşümlerle Lua'ya indirilir, sonra hat olağan Lua koduyla devam eder (indirmenin davranışı
// luau-web runtime'ında özgün kodla karşılaştırılır: core/pipeline.js):
//   tip açıklamaları (local x: T, (a: T): R, type X = ..., export type, <T> genelleri, e :: T)  → silinir
//   a += b (-=, *=, /=, %=, ^=, ..=)  → a = a + (b); t[k] += v → do local t_, k_ = t, k; t_[k_] = t_[k_] + (v) end
//   continue                          → goto __peel_continue_N (döngü sonunda etiket; Lua 5.2+ gerekir)
//   `a {b} c`                         → ("a " .. tostring(b) .. " c")
//   if c then a elseif d then b else e (ifade) → ((c) and {a} or {((d) and {b} or {e})[1]})[1]
//   0b101, 1_000, "\x41\u{48}\z"      → ondalık sayı, Lua 5.1 kaçışları
// Desteklenmeyen yapı (repeat gövdesinde local + continue, tip fonksiyonları, //) indirmeyi durdurur: null döner.
import { luaString } from './lua.js';

const KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in', 'local',
  'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while']);
const OPS = ['...', '..=', '//=', '..', '::', '->', '==', '~=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '^=', '//'];
const COMPOUND = { '+=': '+', '-=': '-', '*=': '*', '/=': '/', '%=': '%', '^=': '^', '..=': '..' };
const BINOPS = new Set(['+', '-', '*', '/', '%', '^', '..', '==', '~=', '<', '<=', '>', '>=', 'and', 'or']);

class LuauSyntax extends Error {}
const fail = (m) => { throw new LuauSyntax(m); };

// --- sözcük çözümleyici ---
function longBracket(src, i) {
  // [==[ ... ]==] : açılış seviyesi, kapanışın sonu
  const m = /^\[(=*)\[/.exec(src.slice(i, i + 64));
  if (!m) return null;
  const close = `]${m[1]}]`;
  const end = src.indexOf(close, i + m[0].length);
  if (end < 0) fail('kapanmamış uzun köşeli parantez');
  return end + close.length;
}

function readQuoted(src, i, q) {
  let j = i + 1;
  while (j < src.length && src[j] !== q) {
    if (src[j] === '\\') j += 2;
    else if (src[j] === '\n') fail('kapanmamış dizge');
    else j++;
  }
  if (j >= src.length) fail('kapanmamış dizge');
  return j + 1;
}

/** Luau dizge kaçışlarını çözer (\x, \u{}, \z dahil) → bstr */
function unescape(body, interp = false) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { out += c; continue; }
    const n = body[++i];
    const simple = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', "'": "'", '\n': '\n', '`': '`', '{': '{' };
    if (n in simple && (interp || (n !== '`' && n !== '{'))) { out += simple[n]; continue; }
    if (n === '\r') { out += '\n'; if (body[i + 1] === '\n') i++; continue; }
    if (n === 'x') { out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16)); i += 2; continue; }
    if (n === 'z') { while (/\s/.test(body[i + 1] ?? '')) i++; continue; }
    if (n === 'u') {
      const m = /^\{([0-9a-fA-F]+)\}/.exec(body.slice(i + 1));
      if (!m) fail('geçersiz \\u kaçışı');
      out += Buffer.from(String.fromCodePoint(parseInt(m[1], 16)), 'utf8').toString('latin1');
      i += m[0].length;
      continue;
    }
    if (/\d/.test(n)) {
      const m = /^\d{1,3}/.exec(body.slice(i));
      out += String.fromCharCode(Number(m[0]) & 255);
      i += m[0].length - 1;
      continue;
    }
    fail(`geçersiz kaçış \\${n}`);
  }
  return out;
}

function tokenize(src, start = 0, stopAtBrace = false) {
  const toks = [];
  let i = start;
  let depth = 0;
  for (;;) {
    const s = i;
    // boşluk ve yorumlar (önceki trivia)
    for (;;) {
      if (/\s/.test(src[i] ?? '')) { i++; continue; }
      if (src.startsWith('--', i)) {
        const lb = src[i + 2] === '[' ? longBracket(src, i + 2) : null;
        if (lb) { i = lb; continue; }
        const nl = src.indexOf('\n', i);
        i = nl < 0 ? src.length : nl;
        continue;
      }
      break;
    }
    const pre = src.slice(s, i);
    if (i >= src.length) { toks.push({ type: 'eof', v: '', pre, at: i }); return { toks, end: i }; }
    const c = src[i];
    const at = i;
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_]\w*/.exec(src.slice(i, i + 256));
      i += m[0].length;
      toks.push({ type: KEYWORDS.has(m[0]) ? 'kw' : 'name', v: m[0], pre, at });
      continue;
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1] ?? ''))) {
      const m = /^(0[xX][0-9a-fA-F_]*(\.[0-9a-fA-F_]*)?([pP][+-]?\d+)?|0[bB][01_]+|[\d_]*\.?[\d_]*([eE][+-]?[\d_]+)?)/.exec(src.slice(i, i + 256));
      i += m[0].length;
      let v = m[0].replace(/_/g, '');
      if (/^0[bB]/.test(v)) v = String(parseInt(v.slice(2), 2));
      toks.push({ type: 'num', v, pre, at });
      continue;
    }
    if (c === '"' || c === "'") {
      const e = readQuoted(src, i, c);
      const raw = src.slice(i, e);
      // Lua 5.1 \x, \z, \u{} bilmez: bu kaçışları içeren dizge çözülüp yeniden yazılır
      const v = /\\[xzu]/.test(raw) ? luaString(unescape(raw.slice(1, -1))) : raw;
      i = e;
      toks.push({ type: 'str', v, pre, at });
      continue;
    }
    if (c === '[' && /^\[=*\[/.test(src.slice(i, i + 64))) {
      const e = longBracket(src, i);
      toks.push({ type: 'str', v: src.slice(i, e), pre, at });
      i = e;
      continue;
    }
    if (c === '`') {
      // enterpolasyonlu dizge: metin ve { ifade } parçaları
      const parts = [];
      let text = '';
      let j = i + 1;
      while (src[j] !== '`') {
        if (j >= src.length) fail('kapanmamış ` dizgesi');
        if (src[j] === '\\') { text += src.slice(j, j + 2); j += 2; continue; }
        if (src[j] === '{') {
          parts.push({ text: unescape(text, true) });
          text = '';
          const inner = tokenize(src, j + 1, true);
          parts.push({ toks: inner.toks });
          j = inner.end + 1;
          continue;
        }
        text += src[j++];
      }
      parts.push({ text: unescape(text, true) });
      i = j + 1;
      toks.push({ type: 'interp', v: '', parts, pre, at });
      continue;
    }
    if (stopAtBrace) {
      if (c === '{') depth++;
      if (c === '}') {
        if (depth === 0) { toks.push({ type: 'eof', v: '', pre, at: i }); return { toks, end: i }; }
        depth--;
      }
    }
    const op = OPS.find((o) => src.startsWith(o, i)) ?? c;
    if (!/^[-+*/%^#&~|<>=(){}[\];:,.?@]/.test(op) && !OPS.includes(op)) fail(`beklenmeyen karakter ${JSON.stringify(c)}`);
    i += op.length;
    toks.push({ type: 'op', v: op, pre, at });
  }
}

// --- ayrıştırıcı / yazıcı ---
function lowerTokens(toks, state) {
  let p = 0;
  const tk = () => toks[p];
  const peek = (k = 1) => toks[Math.min(p + k, toks.length - 1)];
  const is = (v, t = tk()) => (t.type === 'op' || t.type === 'kw') && t.v === v;
  const take = () => { const t = toks[p++]; return t.pre + t.v; };
  const drop = () => toks[p++].pre; // tip belirteçleri: yalnızca boşluk/yorum kalır
  const expect = (v) => { if (!is(v)) fail(`'${v}' bekleniyordu, '${tk().v || tk().type}' bulundu`); return take(); };
  const name = () => { if (tk().type !== 'name') fail(`ad bekleniyordu, '${tk().v}' bulundu`); return take(); };
  let loops = [];

  // tipler: içerikleri atlanır
  function balanced(open, close) {
    let out = drop();
    let d = 1;
    while (d > 0) {
      if (tk().type === 'eof') fail('kapanmamış tip');
      if (is(open)) d++;
      else if (is(close)) d--;
      out += drop();
    }
    return out;
  }
  function typeAtom() {
    let out = '';
    if (is('...')) out += drop();
    if (is('<')) out += balanced('<', '>');
    if (is('(')) {
      out += balanced('(', ')');
      if (is('->')) { out += drop(); out += type(); }
      return out;
    }
    if (is('{')) return out + balanced('{', '}');
    if (tk().type === 'name' && tk().v === 'typeof' && is('(', peek())) { out += drop(); return out + balanced('(', ')'); }
    if (tk().type === 'name' || is('nil') || is('true') || is('false') || tk().type === 'str') {
      out += drop();
      while (is('.') && peek().type === 'name') { out += drop(); out += drop(); }
      if (is('<')) out += balanced('<', '>');
      return out;
    }
    fail(`tip bekleniyordu, '${tk().v}' bulundu`);
    return out;
  }
  function type() {
    let out = '';
    if (is('|') || is('&')) out += drop();
    out += typeAtom();
    for (;;) {
      if (is('?')) { out += drop(); continue; }
      if (is('|') || is('&')) { out += drop(); out += typeAtom(); continue; }
      return out;
    }
  }
  const annotation = () => (is(':') ? drop() + type() : '');
  const generics = () => (is('<') ? balanced('<', '>') : '');

  const blockEnd = () => tk().type === 'eof' || ['end', 'else', 'elseif', 'until'].some((k) => is(k));

  function block() {
    let out = '';
    while (!blockEnd()) {
      if (is('return')) { out += retstat(); break; }
      out += stat();
    }
    return out;
  }
  function retstat() {
    let out = take();
    if (!blockEnd() && !is(';')) out += explist();
    if (is(';')) out += take();
    return out;
  }
  function loopBody(kind) {
    const loop = { id: ++state.loop, used: false, kind };
    loops.push(loop);
    const start = p;
    const body = block();
    loops.pop();
    if (!loop.used) return body;
    state.goto = true;
    // repeat gövdesinin local'leri until koşulunda görünür: etikete atlama local kapsamına girer
    if (kind === 'repeat' && toks.slice(start, p).some((t) => t.type === 'kw' && t.v === 'local')) fail('repeat içinde local ile continue');
    return `${body} ::__peel_continue_${loop.id}:: `;
  }
  function funcbody() {
    let out = generics();
    out += expect('(');
    while (!is(')')) {
      if (is('...')) out += take();
      else out += name();
      out += annotation();
      if (is(',')) out += take();
      else break;
    }
    out += expect(')');
    out += annotation();
    const saved = loops;
    loops = [];
    out += block();
    loops = saved;
    return out + expect('end');
  }
  function attributes() {
    let out = '';
    while (is('@')) {
      out += drop();
      out += drop(); // ad
      if (is('[')) out += balanced('[', ']');
    }
    return out;
  }

  function stat() {
    const t = tk();
    if (is(';')) return take();
    if (is('@')) return attributes() + stat();
    if (is('if')) {
      let out = take() + exp() + expect('then') + block();
      while (is('elseif')) out += take() + exp() + expect('then') + block();
      if (is('else')) out += take() + block();
      return out + expect('end');
    }
    if (is('while')) return take() + exp() + expect('do') + loopBody('while') + expect('end');
    if (is('do')) return take() + block() + expect('end');
    if (is('for')) {
      let out = take() + name() + annotation();
      if (is('=')) {
        out += take() + exp() + expect(',') + exp();
        if (is(',')) out += take() + exp();
      } else {
        while (is(',')) out += take() + name() + annotation();
        out += expect('in') + explist();
      }
      return out + expect('do') + loopBody('for') + expect('end');
    }
    if (is('repeat')) return take() + loopBody('repeat') + expect('until') + exp();
    if (is('function')) {
      let out = take() + name();
      while (is('.')) out += take() + name();
      if (is(':')) out += take() + name();
      return out + funcbody();
    }
    if (is('local')) {
      let out = take();
      if (is('function')) return out + take() + name() + funcbody();
      out += name() + annotation();
      while (is(',')) out += take() + name() + annotation();
      if (is('=')) out += take() + explist();
      return out;
    }
    if (is('break')) return take();
    if (t.type === 'name' && t.v === 'continue' && peekStat()) {
      if (!loops.length) fail('döngü dışında continue');
      const loop = loops.at(-1);
      loop.used = true;
      p++;
      return `${t.pre}goto __peel_continue_${loop.id} `;
    }
    if (t.type === 'name' && (t.v === 'type' || t.v === 'export') && aliasAhead()) {
      let out = drop();
      if (t.v === 'export') out += drop();
      if (tk().type === 'name' && tk().v === 'function') fail('tip fonksiyonu');
      out += drop(); // ad
      out += generics();
      if (!is('=')) fail('tip takma adı');
      out += drop();
      return out + type();
    }
    // ifade deyimi: çağrı, atama ya da bileşik atama
    const lhs = [suffixed()];
    if (COMPOUND[tk().v] && tk().type === 'op') return compound(lhs[0]);
    if (is('=') || is(',')) {
      let out = lhs[0].text;
      while (is(',')) { out += take(); const x = suffixed(); out += x.text; }
      return out + expect('=') + explist();
    }
    if (lhs[0].kind !== 'call') fail('ifade deyim olamaz');
    return lhs[0].text;
  }
  // continue'dan sonra yeni bir deyim mi başlıyor (continue bir değişken adı da olabilir)
  function peekStat() {
    const n = peek();
    if (n.type === 'eof' || n.type === 'kw') return !['and', 'or'].includes(n.v);
    if (n.type === 'name') return true;
    return n.type === 'op' && n.v === ';';
  }
  function aliasAhead() {
    const t = tk();
    const n = peek();
    if (t.v === 'export') return n.type === 'name' && n.v === 'type';
    return n.type === 'name' && (is('=', peek(2)) || is('<', peek(2)));
  }

  function compound(lhs) {
    const op = COMPOUND[tk().v];
    const opPre = tk().pre;
    p++;
    const rhs = exp();
    const lead = /^\s*/.exec(lhs.text)[0];
    const target = lhs.text.slice(lead.length);
    if (lhs.kind === 'name') return `${lead}${target}${opPre}= ${target} ${op} (${rhs})`;
    if (lhs.kind === 'index') {
      return `${lead}do local __peel_t, __peel_k = ${lhs.base.trim()}, ${lhs.key.trim()}; __peel_t[__peel_k] = __peel_t[__peel_k] ${op} (${rhs}) end`;
    }
    return fail('bileşik atamanın hedefi');
  }

  function explist() {
    let out = exp();
    while (is(',')) out += take() + exp();
    return out;
  }
  function exp() {
    let out = '';
    for (;;) {
      while (is('not') || is('-') || is('#')) out += take();
      out += simple();
      while (is('::')) { out += drop(); out += type(); }
      if (is('//')) fail('// işleci');
      if ((tk().type === 'op' || tk().type === 'kw') && BINOPS.has(tk().v)) { out += take(); continue; }
      return out;
    }
  }
  function simple() {
    const t = tk();
    if (t.type === 'num' || t.type === 'str' || is('nil') || is('true') || is('false') || is('...')) return take();
    if (t.type === 'interp') { p++; return t.pre + interp(t); }
    if (is('{')) return table();
    if (is('function')) return take() + funcbody();
    if (is('if')) return ifexp();
    return suffixed().text;
  }
  function ifexp() {
    const pre = tk().pre;
    p++;
    const cond = exp();
    if (!is('then')) fail("'then' bekleniyordu");
    p++;
    const a = exp();
    let b;
    if (is('elseif')) b = ifexp();
    else { if (!is('else')) fail("'else' bekleniyordu"); p++; b = exp(); }
    return `${pre}((${cond}) and {${a}} or {${b}})[1]`;
  }
  function interp(t) {
    const pieces = [];
    for (const part of t.parts) {
      if (part.toks) {
        const sub = { ...state, expr: true };
        pieces.push(`tostring(${lowerTokens(part.toks, sub).code})`);
        state.loop = sub.loop;
        state.goto ||= sub.goto;
      }
      else if (part.text) pieces.push(luaString(part.text));
    }
    return pieces.length ? `(${pieces.join(' .. ')})` : '""';
  }
  function table() {
    let out = take();
    while (!is('}')) {
      if (is('[')) out += take() + exp() + expect(']') + expect('=') + exp();
      else if (tk().type === 'name' && is('=', peek())) out += take() + take() + exp();
      else out += exp();
      if (is(',') || is(';')) out += take();
      else break;
    }
    return out + expect('}');
  }
  function args() {
    if (tk().type === 'str') return take();
    if (tk().type === 'interp') fail('enterpolasyonlu dizge argümanı');
    if (is('{')) return table();
    let out = expect('(');
    if (!is(')')) out += explist();
    return out + expect(')');
  }
  // { text, kind: name|member|index|call|paren, base, key }
  function suffixed() {
    let r;
    if (tk().type === 'name') r = { text: take(), kind: 'name' };
    else if (is('(')) r = { text: take() + exp() + expect(')'), kind: 'paren' };
    else fail(`beklenmeyen '${tk().v || tk().type}'`);
    for (;;) {
      if (is('.')) {
        const base = r.text;
        const dot = take();
        const n = name();
        r = { text: base + dot + n, kind: 'index', base, key: JSON.stringify(n.trim()) };
      } else if (is('[')) {
        const base = r.text;
        const open = take();
        const key = exp();
        r = { text: base + open + key + expect(']'), kind: 'index', base, key };
      } else if (is(':') && peek().type === 'name' && (is('(', peek(2)) || peek(2).type === 'str' || is('{', peek(2)))) {
        r = { text: r.text + take() + name() + args(), kind: 'call' };
      } else if (is('(') || tk().type === 'str' || is('{')) {
        r = { text: r.text + args(), kind: 'call' };
      } else return r;
    }
  }

  const code = toks.length === 1 ? toks[0].pre : (() => {
    // ifade parçası (enterpolasyon) ya da tam kod
    if (state.expr) { const e = explist(); if (tk().type !== 'eof') fail('ifade sonu bekleniyordu'); return e + tk().pre; }
    const b = block();
    if (tk().type !== 'eof') fail(`'${tk().v}' beklenmiyordu`);
    return b + tk().pre;
  })();
  return { code };
}

/** Luau kodunu Lua'ya indirir. Dönüş: { code, goto } ya da { error } */
export function lowerLuau(src) {
  try {
    const state = { loop: 0, goto: false };
    const { toks } = tokenize(src);
    const { code } = lowerTokens(toks, state);
    return { code, goto: state.goto };
  } catch (e) {
    if (e instanceof LuauSyntax) return { error: e.message };
    throw e;
  }
}

