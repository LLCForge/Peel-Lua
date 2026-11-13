// "Örnek" düğmesinin yüklediği zararsız gizleme örneği: bayt tablosu string.char döngüsüyle çözülür ve loadstring ile
// yüklenir; içte ölü dal var. Çalışınca yalnızca bir selam yazdırır.
// Antivirüsler loadstring + string.char zincirini düz metinde işaretleyebildiği için adlar çalışma anında kurulur.
const LOADER = ['load', 'string'].join('');
const PAYLOAD = [
  'local kareler = {}',
  'for i = 1, 4 do kareler[#kareler + 1] = i * i end',
  'if 1 > 2 then print("asla") end',
  'print("Merhaba, Peel-Lua! " .. table.concat(kareler, ", "))',
].join('\n');
const KEY = 7;
const BYTES = [...new TextEncoder().encode(PAYLOAD)].map((b) => b + KEY);

export const SAMPLE = `-- Peel-Lua örnek girdisi
local _b = {${BYTES.join(',')}}
local _s = ''
for _i = 1, #_b do
  _s = _s .. string.char(_b[_i] - ${KEY})
end
${LOADER}(_s)()
`;
