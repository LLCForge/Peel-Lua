// Çalışma anı katmanları: araçlanmış kod sandbox'ta çalıştırılır, her yükleyici sitesinin kodu yerine yazılır.
import { instrument, expandLayers } from '../core/layers.js';

export const id = 'layers';
export const needsSandbox = true;

export async function run(code, ctx) {
  const inst = instrument(code, ctx.version);
  if (!inst?.sites.size) return code;
  const r = await ctx.runRaw(inst.code);
  if (!r?.ok || !r.loads.length) return code;
  // dış girdi sondası: farklı girdiyle farklı kod yükleyen siteler (uzaktan/dosyadan yükleme) açılmaz
  const probe = await ctx.runRaw(inst.code, 1);
  const external = new Set();
  const codes = (run, site) => run.loads.filter((l) => l.site === site).map((l) => l.code).join('\0');
  for (const site of inst.sites.keys()) if (!probe?.ok || codes(r, site) !== codes(probe, site)) external.add(site);
  const loads = r.loads.filter((l) => !external.has(l.site));
  if (external.size && r.loads.some((l) => external.has(l.site))) ctx.log(`layers: ${[...external].filter((s) => r.loads.some((l) => l.site === s)).length} site dış girdiye bağlı, açılmadı`, 'info');
  const ex = expandLayers(code, ctx.version, inst.sites, loads);
  if (ex.opened) ctx.log(`layers: ${ex.opened} katman açıldı${ex.kept.length ? `, ${ex.kept.length} site açılamadı (${ex.kept[0]})` : ''}`, 'info');
  ctx.bump('layers', ex.opened);
  return ex.code;
}
