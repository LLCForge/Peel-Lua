// Luau motoru (luau-web, WebAssembly): Lua motoruyla aynı istek/yanıt sözleşmesi ve aynı prelude kaydı. Alt süreçte
// (node-proc.js, izin modeli) çalışır. Farklar:
// - Luau'da loadstring/load yoktur: yükleyici JS köprüsüyle verilir (kod hex olarak geçer, UTF-8 metin olarak derlenir).
// - Kütüphane tabloları salt okunurdur: prelude onları değiştirebilsin diye açılır.
// - debug.sethook yoktur: sonsuz döngüyü yalnızca bekçi (süreç sonlandırma) keser.
// Her çalıştırma yeni bir LuauState'tir.
import { PRELUDE, RUNNER } from './prelude.js';
import { hexOf, parseRun } from './engine.js';

const LIBS = ['os', 'string', 'math', 'table', 'coroutine', 'debug', 'bit32', 'utf8', 'buffer'];

// prelude'dan önce: Lua 5.x'teki loadstring'in karşılığı
const BRIDGE = String.raw`
loadstring = function(s, name)
  if type(s) ~= 'string' then return nil, 'string expected' end
  local h = (string.gsub(s, '.', function(c) return string.format('%02x', string.byte(c)) end))
  local f = __peel_compile_hex(h, name)
  if type(f) == 'string' then return nil, f end
  return f
end
`;

export function createLuauEngine() {
  let mod = null;
  const lib = () => (mod ??= import('luau-web'));

  async function call(fn) {
    let r = fn();
    if (r && typeof r.then === 'function') r = await r;
    return Array.isArray(r) ? r[0] : r;
  }

  async function run({ code, platform = null, variant = 0 }) {
    const { LuauState } = await lib();
    const L = await LuauState.createAsync();
    try {
      for (const k of LIBS) { const t = L.env.get(k); if (t && typeof t === 'object') L.env.setreadonly(t, false); }
      L.env.set('__peel_compile_hex', (h, name) => {
        const src = Buffer.from(String(h), 'hex').toString('utf8');
        return L.loadstring(src, typeof name === 'string' ? name : 'chunk', false);
      }, true);
      L.env.set('__peel_src_hex', hexOf(code), true);
      if (variant) L.env.set('__peel_variant', Number(variant) | 0, true);
      if (platform) L.env.set('__peel_platform_kind', String(platform).replace(/[^a-z]/g, ''), true);
      await call(L.loadstring(BRIDGE, 'bridge', true));
      await call(L.loadstring(PRELUDE, 'prelude', true));
      let text;
      try {
        text = await call(L.loadstring(RUNNER, 'runner', true));
      } catch (e) {
        const msg = String(e?.message ?? e);
        return { ok: false, error: msg, stdout: '', loads: [], fx: [], errors: [msg], version: 'luau' };
      }
      const r = parseRun(String(text ?? ''));
      r.version = 'luau';
      return r;
    } finally {
      L.destroy();
    }
  }

  async function handle(msg) {
    switch (msg.type) {
      case 'load': await lib(); return { ok: true };
      case 'run': return run(msg);
      case 'evaluate': return { ok: false, error: 'Luau: değerlendirme yok' };
      default: return { ok: false, error: `bilinmeyen mesaj: ${msg.type}` };
    }
  }
  return { run, handle };
}
