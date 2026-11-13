// Yürütme sandbox'ının Lua katmanı (Lua 5.1-5.4 uyumlu). Her çalıştırma yeni bir lua_State'tir: çalıştırmalar arası
// durum sızmaz. Kod ve sonuçlar hex olarak taşınır (bağlama dizgeleri UTF-8'e çevirir; ikili veri ve NUL bozulmasın).
// - load / loadstring / dofile / loadfile kancalanır: giden kod kaydedilir. Kaynakta doğrudan yapılan çağrılar
//   JS tarafında __peel_load(N, ...) olarak numaralandırılır (aynı satırdaki birden çok çağrı ayırt edilir); takma adla
//   yapılan çağrılar küresel kancadan site 0 ile kaydedilir.
// - os.execute / io.popen / os.remove / os.rename / os.exit / os.getenv kaydedilir, yapılmaz. Asıl yalıtım süreç
//   düzeyindedir (Node izin modeli / tarayıcı Web Worker): bu derlemelerde os.execute gerçek komut çalıştırabilir.
// - Platform taklitleri (Roblox, FiveM, Garry's Mod): tanınan küresel API'ler her çağrıyı kaydeden metatable
//   taklitleridir; HttpGet gibi dizge döndürmesi beklenenler boş dizge döner.
// - Belirlenimlilik: sabit saat, tohumlu rastgelelik; komut sayısı bütçesi aşılırsa program durdurulur.

export const PRELUDE = String.raw`
local __real = {
  load = load, loadstring = loadstring, dofile = dofile, loadfile = loadfile, require = require,
  setmetatable = setmetatable, getmetatable = getmetatable, type = type, tostring = tostring, pairs = pairs,
  select = select, error = error, pcall = pcall, rawget = rawget, rawset = rawset, sfmt = string.format,
  sbyte = string.byte, schar = string.char, sgsub = string.gsub, ssub = string.sub, tconcat = table.concat,
  unpack = unpack or table.unpack, getenv = os.getenv, ioopen = io.open,
}
local P = { loads = {}, fx = {}, out = {}, outlen = 0, errors = {}, obs = {} }
-- dış girdi sondası: varyant 1'de dışarıdan gelen her değer (HTTP yanıtı, dosya, ortam) farklıdır. İki çalıştırmada
-- farklı kod yükleyen site dış girdiye bağlıdır ve açılmaz (uzaktan kod yükleyen satır silinmesin).
local V = __peel_variant or 0
local EXT = V == 1 and '-- peel dis girdi' or ''
__peel_state = P

local function hex(s)
  return (__real.sgsub(s, '.', function(c) return __real.sfmt('%02x', __real.sbyte(c)) end))
end
local function unhex(h)
  return (__real.sgsub(h, '%x%x', function(x) return __real.schar(tonumber(x, 16)) end))
end
__peel_hex, __peel_unhex = hex, unhex

local function str(v)
  local t = __real.type(v)
  if t == 'string' then return v end
  if t == 'number' or t == 'boolean' or t == 'nil' then return __real.tostring(v) end
  return '<' .. t .. '>'
end

local function fx(api, ...)
  if #P.fx >= 2000 then return end
  local args = {}
  for i = 1, __real.select('#', ...) do
    local s = str((__real.select(i, ...)))
    args[#args + 1] = hex(s:sub(1, 4000))
  end
  P.fx[#P.fx + 1] = api .. '\t' .. __real.tconcat(args, ',')
end
__peel_fx = fx

local function out(s)
  if P.outlen > 1000000 then return end
  P.outlen = P.outlen + #s
  P.out[#P.out + 1] = s
end

-- yüklenen kodu kaydeder; fonksiyon okuyucu (load(fn)) parçaları birleştirilir
local function record(site, kind, chunk)
  if __real.type(chunk) == 'function' then
    local parts = {}
    while true do
      local p = chunk()
      if p == nil or p == '' then break end
      parts[#parts + 1] = p
      if #parts > 100000 then break end
    end
    chunk = __real.tconcat(parts)
  end
  if __real.type(chunk) == 'string' and #P.loads < 5000 then
    P.loads[#P.loads + 1] = site .. '\t' .. kind .. '\t' .. hex(chunk:sub(1, 4000000))
  end
  return chunk
end

local real_load = __real.loadstring or __real.load
__peel_realload = real_load
local function do_load(kind, chunk, a, b, c)
  if kind == 'loadstring' or (kind == 'load' and __real.loadstring and __real.type(chunk) == 'string' and a == nil) then
    return real_load(chunk, a)
  end
  return __real.load(chunk, a, b, c)
end

-- kaynakta doğrudan yapılan çağrılar (JS tarafı numaralandırır)
function __peel_load(site, kind, chunk, a, b, c)
  chunk = record(site, kind, chunk)
  return do_load(kind, chunk, a, b, c)
end

if __real.loadstring then loadstring = function(chunk, a) return do_load('loadstring', record(0, 'loadstring', chunk), a) end end
load = function(chunk, a, b, c) return do_load('load', record(0, 'load', chunk), a, b, c) end
dofile = function(f) fx('dofile', f) return nil end
loadfile = function(f) fx('loadfile', f) return nil, 'sandbox: dosya yok' end

print = function(...)
  local parts = {}
  for i = 1, __real.select('#', ...) do parts[#parts + 1] = __real.tostring((__real.select(i, ...))) end
  out(__real.tconcat(parts, '\t') .. '\n')
end
io.write = function(...)
  for i = 1, __real.select('#', ...) do out(str((__real.select(i, ...)))) end
  return io
end
os.execute = function(cmd) fx('os.execute', cmd) return 0 end
io.popen = function(cmd) fx('io.popen', cmd) return nil, 'sandbox: komut kapalı' end
os.remove = function(f) fx('os.remove', f) return true end
os.rename = function(a, b) fx('os.rename', a, b) return true end
os.getenv = function(k) fx('os.getenv', k) if V == 1 then return EXT end return nil end
os.exit = function(code) fx('os.exit', code) __real.error('__peel_exit', 0) end
io.open = function(f, mode)
  if mode and (mode:find('w') or mode:find('a') or mode:find('+')) then fx('io.open', f, mode) end
  return __real.ioopen(f, mode)
end
os.time = function(t) if t then return 1704067200 end return 1704067200 end
os.clock = function() return 0 end
local real_date = os.date
os.date = function(f, t) return real_date(f, t or 1704067200) end
math.randomseed(1)
math.randomseed = function() end

-- platform taklitleri: her erişim bir yol, her çağrı bir kayıt
local FAKE = {}
local function fake(path)
  local o = {}
  FAKE[o] = path
  return __real.setmetatable(o, FAKE)
end
local STRING_RET = { HttpGet = true, HttpGetAsync = true, GetAsync = true, PostAsync = true, HttpPost = true, HttpPostAsync = true,
  GetCurrentResourceName = true, GetConvar = true, LoadResourceFile = true }
FAKE.__index = function(o, k)
  local path = FAKE[o] .. '.' .. __real.tostring(k)
  if STRING_RET[k] then
    return function(first, ...)
      if FAKE[first] then fx(path, ...) else fx(path, first, ...) end
      return EXT
    end
  end
  return fake(path)
end
FAKE.__newindex = function(o, k, v) fx(FAKE[o] .. '.' .. __real.tostring(k) .. '=', v) end
FAKE.__call = function(o, ...)
  local path = FAKE[o]
  -- yöntem çağrısı (obj:M(...)) ilk argüman olarak taklidin kendisini verir: kayda geçmez
  local first = ...
  if FAKE[first] then fx(path, __real.select(2, ...)) else fx(path, ...) end
  return fake(path .. '()')
end
FAKE.__tostring = function(o) return '' end
FAKE.__concat = function(a, b) return str(FAKE[a] and '' or a) .. str(FAKE[b] and '' or b) end
FAKE.__len = function() return 0 end
FAKE.__eq = function() return false end
FAKE.__lt = function() return false end
FAKE.__le = function() return false end
FAKE.__unm = function() return 0 end
FAKE.__add = function() return 0 end
FAKE.__sub = FAKE.__add
FAKE.__mul = FAKE.__add
FAKE.__div = FAKE.__add
FAKE.__mod = FAKE.__add
FAKE.__pow = FAKE.__add
__peel_fake = fake

-- işlev olarak çağrılan platform API'leri (yanıt geri çağrısı çağrılmaz: ağ yok)
local function api(name, ret)
  return function(...) fx(name, ...) if ret ~= nil then return ret end return fake(name .. '()') end
end
function __peel_platform(kind)
  if kind == 'roblox' then
    game = fake('game'); workspace = fake('workspace'); script = fake('script'); Instance = fake('Instance')
    Vector3 = fake('Vector3'); CFrame = fake('CFrame'); Color3 = fake('Color3'); UDim2 = fake('UDim2'); Enum = fake('Enum')
    shared = shared or {}; getgenv = function() return _G end; getrenv = getgenv; getreg = function() return {} end
    syn = fake('syn'); request = function(...) fx('request', ...) return { StatusCode = 200, Body = EXT } end; http_request = request
    setclipboard = api('setclipboard'); writefile = api('writefile'); readfile = function(...) fx('readfile', ...) return EXT end; isfile = api('isfile', false)
    wait = function() return 0 end; task = { wait = wait, spawn = function(f, ...) return f(...) end, delay = function() end, defer = function() end }
    spawn = function(f) return f() end
  elseif kind == 'fivem' then
    Citizen = fake('Citizen'); PerformHttpRequest = api('PerformHttpRequest'); RegisterNetEvent = api('RegisterNetEvent')
    AddEventHandler = api('AddEventHandler'); TriggerEvent = api('TriggerEvent'); TriggerServerEvent = api('TriggerServerEvent')
    TriggerClientEvent = api('TriggerClientEvent'); RegisterCommand = api('RegisterCommand'); GetCurrentResourceName = api('GetCurrentResourceName', 'resource')
    GetConvar = function(...) fx('GetConvar', ...) return EXT end; LoadResourceFile = function(...) fx('LoadResourceFile', ...) return EXT end; SaveResourceFile = api('SaveResourceFile', true)
    ExecuteCommand = api('ExecuteCommand'); GetPlayers = api('GetPlayers', {}); GetPlayerName = api('GetPlayerName', 'player')
    CreateThread = function(f) return f() end; Wait = function() end; SetTimeout = function() end
  elseif kind == 'gmod' then
    http = { Fetch = api('http.Fetch'), Post = api('http.Post') }; HTTP = api('HTTP')
    RunString = function(code, ...) fx('RunString', code) record(0, 'RunString', code) return true end
    CompileString = function(code, ...) fx('CompileString', code) record(0, 'CompileString', code) return real_load(code) end
    hook = fake('hook'); net = fake('net'); util = fake('util'); timer = fake('timer'); concommand = fake('concommand')
    player = fake('player'); game = fake('game'); file = fake('file'); SERVER = true; CLIENT = false
  end
end

-- komut bütçesi: sonsuz döngüde program durdurulur (bekçi süreci yalnızca son çare)
local budget = 0
if debug and debug.sethook then
  debug.sethook(function() budget = budget + 1 if budget > 400 then __real.error('__peel_timeout', 0) end end, '', 1000000)
end

function __peel_finish()
  local lines = {}
  for _, l in __real.pairs(P.loads) do lines[#lines + 1] = 'L\t' .. l end
  for _, l in __real.pairs(P.fx) do lines[#lines + 1] = 'F\t' .. l end
  lines[#lines + 1] = 'O\t' .. hex(__real.tconcat(P.out))
  for _, e in __real.pairs(P.errors) do lines[#lines + 1] = 'E\t' .. hex(e) end
  lines[#lines + 1] = 'V\t' .. _VERSION
  return __real.tconcat(lines, '\n')
end
`;

// Çalıştırıcı: kod hex'ten çözülür, '=main' adıyla derlenir, korumalı çağrılır; sonuç satırları döner
export const RUNNER = String.raw`
local src = __peel_unhex(__peel_src_hex)
__peel_src_hex = nil
if __peel_platform_kind then __peel_platform(__peel_platform_kind) end
local f, err = __peel_realload(src, '=main')
if not f then
  __peel_state.errors[#__peel_state.errors + 1] = 'syntax: ' .. tostring(err)
else
  local ok, e = pcall(f)
  if not ok and e ~= '__peel_exit' then
    __peel_state.errors[#__peel_state.errors + 1] = tostring(e)
  end
end
return __peel_finish()
`;
