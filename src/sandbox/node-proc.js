// Yalıtılmış alt süreç: node --permission ile başlatılır (ağ, alt süreç, worker, dosya yazma kapalı; okuma yalnızca
// node_modules ve sandbox dosyaları). Bu Lua derlemelerinin Node sürümü os.execute'u gerçek child_process'e bağlar:
// prelude onu Lua tarafında kapatır, izin modeli de işletim sistemi düzeyinde engeller.
import { createRequire } from 'node:module';
import { createEngine } from './engine.js';
import { createLuauEngine } from './luau-engine.js';

const require = createRequire(import.meta.url);
const FILES = { '5.1': 'lua.51', '5.2': 'lua.52', '5.3': 'lua.53', '5.4': 'lua.54' };
const loader = async (v) => require(`lua-wasm-bindings/dist/${FILES[v] ?? FILES['5.1']}.js`);
let engine = createEngine(loader);
// Luau (luau-web): version 'luau' istekleri
const luau = createLuauEngine();

process.on('message', async ({ id, ...msg }) => {
  let result;
  try {
    result = await (msg.version === 'luau' ? luau : engine).handle(msg);
  } catch (err) {
    // wasm tuzağı (ör. memory access out of bounds) modül belleğini bozmuş olabilir: modüller yeniden yüklenir,
    // istemci isteği bir kez tekrarlar
    const trap = err instanceof WebAssembly.RuntimeError;
    if (trap) {
      for (const k of Object.keys(require.cache)) if (k.includes('lua-wasm-bindings')) delete require.cache[k];
      engine = createEngine(loader);
    }
    result = { ok: false, crashed: trap, error: String(err?.message ?? err).split('\n').slice(0, 3).join(' | ') };
  }
  process.send({ id, ...result });
});
process.send({ ready: true });
