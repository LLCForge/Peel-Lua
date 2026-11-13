// Benchmark örneklerini gerçek açık kaynak Lua obfuscator'larıyla üretir:
//   node scripts/make-bench.js [filtre]
// Prometheus (github.com/levno-710/Prometheus, Lua ile yazılmış) test/bench/vendor/Prometheus altına shallow clone
// edilir (depoya konmaz, .gitignore). Sistemde lua ikilisi yok: Prometheus bu süreçte lua-wasm-bindings Lua 5.1 VM'inde
// çalışır. Modüller JS'den package.preload'a yüklenir (dosya sistemi gerekmez); os.execute/io.popen kapatılır
// (Prometheus tohum için openssl çağırmayı dener: sabit tohum verildiği için o yol hiç çalışmaz).
// Çıktı diske yalnızca fixture kodlamasıyla (XOR + base64, test/bench/*.lua.x) yazılır. Manifest: test/bench/manifest.json
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFixture } from '../test/fixture-codec.js';
import { SOURCES } from '../test/bench/sources.js';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const vendor = path.join(root, 'test/bench/vendor');
const prometheusDir = path.join(vendor, 'Prometheus');
const outDir = path.join(root, 'test/bench');
const filter = process.argv[2];

// Prometheus adımları ve presetleri; Settings Prometheus'un kendi preset tanımlarındaki gibi
const CA = { Threshold: 1, StringsOnly: true, Shuffle: true, Rotate: true, LocalWrapperThreshold: 0 };
const step = (Name, Settings = {}) => ({ Name, Settings });
export const JOBS = {
  'prom-minify': { preset: 'Minify', sources: ['textutil'] },
  'prom-weak': { preset: 'Weak', sources: ['mini', 'inventory', 'textutil', 'loader'] },
  'prom-medium': { preset: 'Medium', sources: ['mini', 'inventory', 'textutil', 'loader'] },
  'prom-strong': { preset: 'Strong', sources: ['mini', 'inventory', 'textutil'] },
  'prom-encryptstrings': { steps: [step('EncryptStrings')], sources: ['mini', 'textutil', 'loader'] },
  'prom-constantarray': { steps: [step('ConstantArray', CA)], sources: ['inventory', 'textutil'] },
  'prom-wrapinfunction': { steps: [step('WrapInFunction')], sources: ['mini'] },
  'prom-vmify': { steps: [step('Vmify')], sources: ['mini', 'inventory', 'textutil', 'loader'] },
  'prom-proxifylocals': { steps: [step('ProxifyLocals')], sources: ['mini', 'textutil'] },
  'prom-splitstrings': { steps: [step('SplitStrings')], sources: ['inventory'] },
  'prom-numberstoexpressions': { steps: [step('NumbersToExpressions')], sources: ['mini', 'textutil'] },
  'prom-cff': { steps: [step('Cff')], sources: ['mini'] },
};

function ensurePrometheus() {
  if (existsSync(path.join(prometheusDir, 'src/prometheus/pipeline.lua'))) return;
  mkdirSync(vendor, { recursive: true });
  console.log('Prometheus indiriliyor (shallow clone)...');
  const r = spawnSync('git', ['clone', '--depth', '1', 'https://github.com/levno-710/Prometheus', prometheusDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('Prometheus indirilemedi');
}

// src/ altındaki tüm .lua dosyaları → { 'prometheus.steps.Vmify': kaynak }
function modules() {
  const base = path.join(prometheusDir, 'src');
  const out = {};
  const visit = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f);
      if (statSync(p).isDirectory()) visit(p);
      else if (f.endsWith('.lua')) {
        const rel = path.relative(base, p).replace(/\\/g, '/').replace(/\.lua$/, '');
        out[rel.replace(/\//g, '.')] = readFileSync(p, 'utf8');
        // dizin modülü: require("prometheus.cff") → prometheus/cff.lua zaten dosya; init.lua yok
      }
    }
  };
  visit(base);
  return out;
}

const hex = (s) => Buffer.from(s, 'utf8').toString('hex');

function createProm() {
  const { lua, lauxlib, lualib } = require('lua-wasm-bindings/dist/lua.51.js');
  const mods = modules();
  const exec = (L, src) => {
    if (lauxlib.luaL_dostring(L, src) !== 0) {
      const msg = lua.lua_tostring(L, -1);
      lua.lua_pop(L, 1);
      throw new Error(msg);
    }
  };
  /** @returns {string} bstr (latin1) */
  return function obfuscate(code, config) {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    try {
      exec(L, `
os.execute = nil; io.popen = nil; os.remove = nil; os.rename = nil
arg = {}
function __unhex(h) return (h:gsub('%x%x', function(x) return string.char(tonumber(x, 16)) end)) end
function __hex(s) return (s:gsub('.', function(c) return string.format('%02x', c:byte()) end)) end
__mods = {}`);
      for (const [name, src] of Object.entries(mods)) exec(L, `__mods[${JSON.stringify(name)}] = "${hex(src)}"`);
      exec(L, `
for name, h in pairs(__mods) do
  package.preload[name] = function(...) return assert(loadstring(__unhex(h), '@' .. name))(...) end
end
newproxy = newproxy or function(a) if a then return setmetatable({}, {}) end return {} end
-- prometheus.lua'daki 5.1 math.random düzeltmesi (2^31 üstü aralıklar)
if not pcall(function() return math.random(1, 2^40) end) then
  local r = math.random
  math.random = function(a, b)
    if not a then return r() end
    if not b then return math.random(1, a) end
    if a > b then a, b = b, a end
    if b - a > 2^31 - 1 then return math.floor(r() * (b - a) + a) end
    return r(a, b)
  end
end
local logger = require('logger')
logger.logLevel = logger.LogLevel.Error
logger.logCallback = function() end
logger.warnCallback = function() end
logger.errorCallback = function(...) error(table.concat({...}, ' '), 0) end`);
      exec(L, `
local Pipeline = require('prometheus.pipeline')
local cfg = ${config}
local p = Pipeline:fromConfig(cfg)
__out = __hex((p:apply(__unhex("${hex(code)}"), 'bench.lua')))`);
      lua.lua_getglobal(L, '__out');
      return Buffer.from(lua.lua_tostring(L, -1), 'hex').toString('latin1');
    } finally {
      lua.lua_close(L);
    }
  };
}

// Lua tablo literali (yalnızca dizge/sayı/boolean/tablo)
function luaTable(v) {
  if (Array.isArray(v)) return `{${v.map(luaTable).join(', ')}}`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${k} = ${luaTable(x)}`).join(', ')}}`;
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}

function configOf(spec, seed) {
  if (spec.preset) return `(function() local c = require('presets')[${JSON.stringify(spec.preset)}]; c.Seed = ${seed}; return c end)()`;
  return luaTable({ LuaVersion: 'Lua51', VarNamePrefix: '', NameGenerator: 'MangledShuffled', PrettyPrint: false, Seed: seed, Steps: spec.steps });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  ensurePrometheus();
  const commit = spawnSync('git', ['-C', prometheusDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const obfuscate = createProm();
  mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  let made = 0;
  for (const [job, spec] of Object.entries(JOBS)) {
    if (filter && !job.includes(filter)) continue;
    for (const [i, srcName] of spec.sources.entries()) {
      const name = `${job}--${srcName}`;
      const seed = 7 + i;
      const t0 = Date.now();
      let out;
      try {
        out = obfuscate(SOURCES[srcName].code, configOf(spec, seed));
      } catch (e) {
        console.log(`FAIL ${name}: ${String(e.message).split('\n')[0]}`);
        continue;
      }
      if (existsSync(path.join(outDir, `${name}.lua.x`))) rmSync(path.join(outDir, `${name}.lua.x`));
      writeFileSync(path.join(outDir, `${name}.lua.x`), encodeFixture(Buffer.from(out, 'latin1')));
      manifest[name] = { tool: 'Prometheus', commit, job, preset: spec.preset ?? spec.steps.map((s) => s.Name).join('+'), source: srcName, seed, bytes: out.length };
      made++;
      console.log(`ok   ${name} (${out.length} bayt, ${Date.now() - t0} ms)`);
    }
  }
  writeFileSync(manifestPath, `${JSON.stringify(Object.fromEntries(Object.entries(manifest).sort()), null, 2)}\n`);
  console.log(`${made} örnek yazıldı`);
}
