// Tarayıcı sandbox'ının yükleme yolu (Node'da taklit): web-worker.js'teki gibi Emscripten yapıştırıcısına wasmBinary
// verilir, bağlamalar binding-factory ile kurulur ve motor dört sürümde çalışır. Örnek kod (src/sample.js) çözülebilir
// olmalı, _headers kuralları ayrıştırılmalı ve worker CSP'si dış ağı kapatmalı.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createEngine } from '../src/sandbox/engine.js';
import { sandboxApi } from '../src/sandbox/api.js';
import { deobfuscate } from '../src/core/pipeline.js';
import { fromText, toText } from '../src/core/bstr.js';
import { SAMPLE } from '../src/sample.js';
import { parseHeaders } from '../vite.config.js';

const require = createRequire(import.meta.url);
const { createLua, createLauxLib, createLuaLib } = require('lua-wasm-bindings/dist/binding-factory.js');
const SEMVER = { '5.1': '5.1.5', '5.2': '5.2.4', '5.3': '5.3.6', '5.4': '5.4.7' };
const quiet = () => {};

const engine = createEngine(async (v) => {
  const semver = SEMVER[v];
  const factory = require(`lua-wasm-bindings/dist/glue/glue-lua-${semver}.js`);
  const wasmBinary = readFileSync(require.resolve(`lua-wasm-bindings/dist/glue/glue-lua-${semver}.wasm`));
  const glue = factory({ wasmBinary, print: quiet, printErr: quiet });
  const lua = createLua(glue, semver);
  return { lua, lauxlib: createLauxLib(glue, lua, semver), lualib: createLuaLib(glue, semver) };
});

for (const v of Object.keys(SEMVER)) {
  const r = await engine.run({ code: fromText('print(_VERSION)'), version: v });
  assert.equal(r.ok, true, `Lua ${v} çalışmadı: ${r.error}`);
  assert.equal(r.stdout.trim(), `Lua ${v}`);
}

// örnek: string.char döngüsü + loadstring katmanı açılmalı
const sandbox = sandboxApi((msg) => engine.handle(msg));
const res = await deobfuscate(fromText(SAMPLE), { sandbox });
assert.equal(res.verified, true, 'örnek davranış doğrulanamadı');
assert.ok(res.text.includes('Merhaba, Peel-Lua!'), `örnek açılmadı:\n${res.text}`);
assert.ok(!/string\.char\(_b/.test(res.text), 'çözücü döngü çıktıda kaldı');

// barındırma başlıkları
const rules = parseHeaders(readFileSync(new URL('../public/_headers', import.meta.url), 'utf8'));
const worker = rules.find((r) => r.path === '/assets/web-worker-*')?.headers['Content-Security-Policy'] ?? '';
assert.match(worker, /default-src 'none'/);
assert.match(worker, /connect-src 'self'/);
assert.doesNotMatch(worker, /\s'unsafe-eval'|'unsafe-inline'/);
assert.ok(rules.find((r) => r.path === '/index.html')?.headers['Content-Security-Policy'].includes("frame-ancestors 'none'"));
console.log(`web: 4 sürüm, örnek ${toText(res.code).split('\n').length} satır, ${rules.length} başlık kuralı`);
