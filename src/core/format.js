// StyLua ile biçimlendirme (WebAssembly; tarayıcıda ve Node'da). StyLua UTF-8 metin bekler: bstr yalnızca geçerli
// UTF-8 ise biçimlendirilir (ham ikili bayt içeren kod bozulmasın). Başarısızsa null.
import { toText, fromText, isValidUtf8 } from './bstr.js';

let mod = null;
async function stylua() {
  mod ??= import('@johnnymorganz/stylua').then(async (m) => {
    if (typeof m.default === 'function') await m.default(); // tarayıcı paketinde wasm başlatma
    return m;
  });
  return mod;
}

export async function format(code, version = '5.1') {
  if (!isValidUtf8(code)) return null;
  try {
    const m = await stylua();
    const cfg = m.Config.new();
    cfg.indent_type = m.IndentType.Spaces;
    cfg.indent_width = 4;
    cfg.column_width = 100;
    if (m.LuaVersion) cfg.syntax = version === '5.1' ? m.LuaVersion.Lua51 : version === '5.2' ? m.LuaVersion.Lua52 : version === '5.3' ? m.LuaVersion.Lua53 : m.LuaVersion.Lua54;
    return fromText(m.formatCode(toText(code), cfg, undefined, m.OutputVerification.None));
  } catch {
    return null;
  }
}
