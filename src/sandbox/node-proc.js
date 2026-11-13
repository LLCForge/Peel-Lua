// Yalıtılmış alt süreç: node --permission ile başlatılır (ağ, alt süreç, worker, dosya yazma kapalı; okuma yalnızca
// node_modules ve sandbox dosyaları). Bu Lua derlemelerinin Node sürümü os.execute'u gerçek child_process'e bağlar:
// prelude onu Lua tarafında kapatır, izin modeli de işletim sistemi düzeyinde engeller.
import { createRequire } from 'node:module';
import { createEngine } from './engine.js';

const require = createRequire(import.meta.url);
const FILES = { '5.1': 'lua.51', '5.2': 'lua.52', '5.3': 'lua.53', '5.4': 'lua.54' };
const engine = createEngine(async (v) => require(`lua-wasm-bindings/dist/${FILES[v] ?? FILES['5.1']}.js`));

process.on('message', async ({ id, ...msg }) => {
  let result;
  try {
    result = await engine.handle(msg);
  } catch (err) {
    result = { ok: false, error: String(err?.message ?? err).split('\n').slice(0, 3).join(' | ') };
  }
  process.send({ id, ...result });
});
process.send({ ready: true });
