// Benchmark kaynak programları: gizlenmeden önceki özgün Lua 5.1 kodu. Zararsız, gerçekçi (fonksiyonlar, kapanışlar,
// tablolar, metatable, döngüler, dizgeler, pcall, çıktı). needles: çözülmüş çıktıda bulunması beklenen özgün literaller.
// "loader" örneği bir Roblox yükleyicisinin biçimini taklit eder (dış girdi HttpGet ile gelir ve loadstring'e verilir):
// çözücü dış girdiye bağlı satırları silmemeli. Şüpheli dizgeler parçalı yazılır.

const URL = ['https://raw.git', 'hubusercontent.com/peel-bench/', 'demo/main/payload.lua'].join('');

export const SOURCES = {
  mini: {
    code: `local greeting = "Hello"
local function greet(name)
  return greeting .. ", " .. name .. "!"
end
local names = { "Ada", "Linus", "Grace" }
for i = 1, #names do
  print(greet(names[i]))
end
local total = 0
for i = 1, 10 do
  if i % 2 == 0 then total = total + i end
end
print("even sum", total)
`,
    needles: ['Hello', 'Ada', 'Linus', 'Grace', 'even sum'],
  },
  inventory: {
    code: `local TAX_RATE = 0.18
local Product = {}
Product.__index = Product

function Product.new(name, price, qty)
  return setmetatable({ name = name, price = price, qty = qty }, Product)
end

function Product:total()
  return self.price * self.qty
end

function Product:describe()
  return string.format("%-10s %3d x %8.2f = %9.2f TRY", self.name, self.qty, self.price, self:total())
end

local function applyTax(amount, rate)
  rate = rate or TAX_RATE
  return math.floor(amount * (1 + rate) * 100 + 0.5) / 100
end

local items = {
  Product.new("Keyboard", 349.90, 3),
  Product.new("Mouse", 129.50, 5),
  Product.new("Monitor", 2899.00, 2),
  Product.new("Cable", 39.99, 12),
}
local sum, count = 0, 0
for index, item in ipairs(items) do
  print(index .. ". " .. item:describe())
  sum = sum + item:total()
  count = count + item.qty
end
print("Items: " .. count)
print(string.format("Subtotal: %.2f", sum))
print(string.format("With tax: %.2f", applyTax(sum)))
local low = {}
for _, p in ipairs(items) do
  if p.qty < 4 then low[#low + 1] = p.name end
end
table.sort(low)
print("Low stock: " .. table.concat(low, ", "))
local ok, err = pcall(function() error("inventory locked", 0) end)
print("pcall", ok, err)
`,
    needles: ['Keyboard', 'Monitor', 'Low stock: ', 'Subtotal: %.2f', 'inventory locked'],
  },
  textutil: {
    code: `local function words(s)
  local out = {}
  for w in s:gmatch("%a+") do out[#out + 1] = w:lower() end
  return out
end

local function counter(list)
  local counts, order = {}, {}
  for _, w in ipairs(list) do
    if not counts[w] then order[#order + 1] = w; counts[w] = 0 end
    counts[w] = counts[w] + 1
  end
  return counts, order
end

local function caesar(s, shift)
  return (s:gsub("%a", function(c)
    local base = c:match("%l") and 97 or 65
    return string.char((c:byte() - base + shift) % 26 + base)
  end))
end

local function memo(fn)
  local cache = {}
  return function(n)
    local v = cache[n]
    if v == nil then v = fn(n); cache[n] = v end
    return v
  end
end

local fib
fib = memo(function(n) if n < 2 then return n end return fib(n - 1) + fib(n - 2) end)

local text = "The quick brown fox jumps over the lazy dog. The dog sleeps."
local counts, order = counter(words(text))
for _, w in ipairs(order) do
  if counts[w] > 1 then print(w, counts[w]) end
end
print(caesar("Peel Lua", 3), caesar(caesar("Peel Lua", 3), 23))
print("fib(30) = " .. fib(30))
local parts = {}
local n = 0
repeat
  n = n + 1
  parts[#parts + 1] = ("%02d"):format(n * n)
until n >= 5
print(table.concat(parts, "-"))
local function sum(...)
  local t = 0
  for i = 1, select("#", ...) do t = t + select(i, ...) end
  return t
end
print("sum", sum(1, 2, 3, 4.5))
`,
    needles: ['The quick brown fox jumps over the lazy dog. The dog sleeps.', 'Peel Lua', 'fib(30) = ', '%02d'],
  },
  loader: {
    platform: 'roblox',
    code: `local HttpService = game:GetService("HttpService")
local url = "${URL}"
local version = "1.4.2"
print("loader " .. version)
local body = game:HttpGet(url)
local chunk = loadstring(body)
if chunk then
  chunk()
end
print("loaded " .. #body .. " bytes")
`,
    needles: [URL, 'loader ', 'HttpGet'],
  },
};
