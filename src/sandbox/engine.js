// Lua motoru: worker/süreç içinde çalışır. Her istek yeni bir lua_State açar ve kapatır (çalıştırmalar arası sızıntı yok).
// Kod ve sonuçlar hex olarak taşınır: bağlama (cwrap 'string') dizgeleri UTF-8'e çevirir; ikili veri ve NUL bozulmasın.
import { PRELUDE, RUNNER } from './prelude.js';

export const VERSIONS = ['5.1', '5.4', '5.3', '5.2'];

export const hexOf = (bstr) => {
  let s = '';
  for (let i = 0; i < bstr.length; i++) s += (bstr.charCodeAt(i) & 0xff).toString(16).padStart(2, '0');
  return s;
};
export const unhex = (h) => {
  let s = '';
  for (let i = 0; i + 1 < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
  return s;
};

/** RUNNER çıktısı (sekmeyle ayrılmış satırlar) → sonuç nesnesi; Lua ve Luau motorları ortak kullanır */
export function parseRun(text) {
  const r = { ok: true, stdout: '', loads: [], fx: [], errors: [], caps: {}, version: '' };
  for (const line of text.split('\n')) {
    const [tag, a, b2, c, d] = line.split('\t');
    // değer yakalama: C k adet tür hex | C k *
    if (tag === 'C') { r.caps[a] = b2 === '*' ? null : { n: Number(b2), type: c, value: unhex(d ?? '') }; continue; }
    if (tag === 'L') r.loads.push({ site: Number(a), kind: b2, code: unhex(c ?? '') });
    else if (tag === 'F') r.fx.push([a, (b2 ?? '').split(',').filter((x) => x !== '' || b2 === '').map(unhex)]);
    else if (tag === 'O') r.stdout = unhex(a ?? '');
    else if (tag === 'E') r.errors.push(unhex(a ?? ''));
    else if (tag === 'V') r.version = a;
  }
  if (r.errors.some((e) => e.includes('__peel_timeout'))) r.timedOut = true;
  return r;
}

/** @param {(version: string) => Promise<{ lauxlib, lua, lualib }>} loadBindings */
export function createEngine(loadBindings) {
  const cache = new Map();
  const bindings = (v) => {
    if (!cache.has(v)) cache.set(v, loadBindings(v));
    return cache.get(v);
  };

  async function withState(version, fn) {
    const b = await bindings(version);
    const L = b.lauxlib.luaL_newstate();
    b.lualib.luaL_openlibs(L);
    try {
      return fn(b, L);
    } finally {
      b.lua.lua_close(L);
    }
  }

  const doString = (b, L, src) => {
    const st = b.lauxlib.luaL_dostring(L, src);
    if (st !== 0) {
      const msg = b.lua.lua_tostring(L, -1);
      b.lua.lua_pop(L, 1);
      throw new Error(`lua: ${msg}`);
    }
  };

  /** kod: bstr. Dönüş: { ok, stdout, loads[{site, kind, code}], fx[[api, args]], errors[], version } (dizgeler bstr) */
  async function run({ code, version = '5.1', platform = null, variant = 0 }) {
    return withState(version, (b, L) => {
      doString(b, L, `__peel_src_hex = "${hexOf(code)}"`);
      if (variant) doString(b, L, `__peel_variant = ${Number(variant) | 0}`);
      if (platform) doString(b, L, `__peel_platform_kind = "${String(platform).replace(/[^a-z]/g, '')}"`);
      doString(b, L, PRELUDE);
      const st = b.lauxlib.luaL_dostring(L, RUNNER);
      const text = b.lua.lua_tostring(L, -1) ?? '';
      if (st !== 0) return { ok: false, error: text, stdout: '', loads: [], fx: [], errors: [text], version };
      return parseRun(text);
    });
  }

  /** Saf ifadeleri toplu değerlendirir (her ifade hex'ten derlenir). Dönüş: [[ok, type, value(bstr)]] */
  async function evaluate({ exprs, version = '5.1' }) {
    return withState(version, (b, L) => {
      const items = exprs.map((e) => `"${hexOf(e)}"`).join(',');
      doString(b, L, `local function unhex(h) return (h:gsub('%x%x', function(x) return string.char(tonumber(x, 16)) end)) end
local function hex(s) return (s:gsub('.', function(c) return string.format('%02x', c:byte()) end)) end
local load = loadstring or load
local out = {}
for i, h in ipairs({${items}}) do
  local f = load('return ' .. unhex(h))
  local ok, v = false, nil
  if f then ok, v = pcall(f) end
  local t = type(v)
  if ok and (t == 'string' or t == 'number' or t == 'boolean' or t == 'nil') then
    local s = t == 'number' and string.format('%.17g', v) or tostring(v)
    if t == 'number' and math.type and math.type(v) == 'integer' then t = 'integer' end
    out[#out + 1] = '1\\t' .. t .. '\\t' .. hex(s)
  else
    out[#out + 1] = '0'
  end
end
__peel_eval_result = table.concat(out, '\\n')`);
      b.lua.lua_getglobal(L, '__peel_eval_result');
      const text = b.lua.lua_tostring(L, -1) ?? '';
      return text.split('\n').map((l) => {
        const [ok, type, h] = l.split('\t');
        return ok === '1' ? [true, type, unhex(h ?? '')] : [false];
      });
    });
  }

  async function handle(msg) {
    switch (msg.type) {
      case 'load': await bindings(msg.version ?? '5.1'); return { ok: true };
      case 'run': return run(msg);
      case 'evaluate': return { ok: true, results: await evaluate(msg) };
      default: return { ok: false, error: `bilinmeyen mesaj: ${msg.type}` };
    }
  }

  return { run, evaluate, handle };
}
