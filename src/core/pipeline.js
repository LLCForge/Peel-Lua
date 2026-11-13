// Çözme hattı: sürüm ve platform seçimi → davranış temeli → değişiklik durana kadar pass turları → biçimlendirme.
// Her pass'ten sonra kod yeniden ayrıştırılır ve sandbox'ta çalıştırılıp çıktısı, denenen yan etkileri ve hata
// durumu temelle karşılaştırılır; fark varsa geri alınır.
import { PASSES } from './registry.js';
import { tryParse, fixSemicolons } from './lua.js';
import { format } from './format.js';
import { toText } from './bstr.js';
import { lowerLuau } from './luau.js';

const MAX_ROUNDS = 20;

// platform: tanınan küresel API adlarından (taklitler yalnızca o platform için yüklenir; diğerleri nil kalır)
const PLATFORMS = [
  ['fivem', /\b(Citizen|PerformHttpRequest|RegisterNetEvent|TriggerServerEvent|TriggerClientEvent|GetCurrentResourceName|RegisterServerEvent|AddEventHandler)\b/],
  ['gmod', /\b(RunString|CompileString|http\.Fetch|hook\.Add|net\.Receive|util\.AddNetworkString|concommand\.Add)\b/],
  ['roblox', /\b(game|workspace|Instance\.new|getgenv|syn\.request|HttpGet|HttpService)\b/],
];
export const detectPlatform = (code) => PLATFORMS.find(([, re]) => re.test(code))?.[0] ?? null;

// hata iletisi: chunk adı ve satır numarası atılır (chunk adı [string "...https://..."] gibi ':' içerebilir)
const norm = (e) => e.replace(/^.*?:\d+: /, '').replace(/:\d+:/g, ':');
function snapshotOf(r) {
  return {
    ok: Boolean(r.ok),
    out: r.stdout ?? '',
    fx: JSON.stringify(r.fx ?? []),
    errors: JSON.stringify((r.errors ?? []).map(norm)),
  };
}
const same = (a, b) => a.ok === b.ok && a.out === b.out && a.fx === b.fx && a.errors === b.errors;

async function pickVersion(sandbox, code, platform, log, order = sandbox.versions) {
  let best = null;
  for (const version of order) {
    if (!tryParse(code, version)) continue;
    const r = await sandbox.run({ code, version, platform });
    const syntax = (r.errors ?? []).some((e) => e.startsWith('syntax:'));
    const score = (r.ok ? 0 : 1000) + (syntax ? 500 : 0) + (r.errors?.length ?? 0);
    if (!best || score < best.score) best = { version, run: r, score };
    if (r.ok && !syntax && !(r.errors?.length)) break;
    if (r.timedOut) break;
    log(`Lua ${version}: ${r.ok ? (r.errors[0] ?? '') : r.error}`, 'info');
  }
  return best;
}

/** @param {string} input bstr */
export async function deobfuscate(input, { sandbox, only = null, onLog = () => {}, onPass = () => {}, onSnapshot = () => {}, signal = null, formatOutput = true, platform = undefined } = {}) {
  if (!sandbox) throw new Error('sandbox gerekli');
  const t0 = Date.now();
  const stats = {};
  const events = [];
  const log = (m, level = 'info') => onLog(m, level);
  const checkAbort = () => { if (signal?.aborted) throw new Error('Durduruldu'); };
  let code = input.replace(/^\xEF\xBB\xBF/, '');
  // #!/usr/bin/lua satırı Lua'da geçerlidir ama luaparse kabul etmez: ayrılır, çıktıya geri konur
  const shebang = /^#[^\n]*/.exec(code)?.[0] ?? null;
  if (shebang) code = code.slice(shebang.length);

  // Luau: Lua sürümlerinin hiçbiri ayrıştıramıyorsa Luau'ya özgü sözdizimi Lua'ya indirilir (core/luau.js)
  let luau = null;
  if (!sandbox.versions.some((v) => tryParse(code, v))) {
    const low = lowerLuau(code);
    if (low.code && tryParse(low.code, low.goto ? '5.2' : '5.1')) {
      luau = { source: code, goto: low.goto, verified: false };
      code = low.code;
      log(`Luau sözdizimi Lua'ya indirildi${low.goto ? ' (continue → goto: Lua 5.2+)' : ''}`, 'info');
    } else if (low.error) log(`Luau indirilemedi: ${low.error}`, 'warn');
  }
  const origin = code; // indirilmiş (Luau) ya da özgün kod: platform tanınınca temel bunun üzerinde yeniden alınır
  const plat = platform === undefined ? detectPlatform(code) : platform;
  // Luau sayıları tek türlüdür (float): tam sayı/float ayrımı olmayan 5.1/5.2 önce denenir
  const picked = await pickVersion(sandbox, code, plat, log, luau ? ['5.1', '5.2', '5.3', '5.4'].filter((v) => sandbox.versions.includes(v)) : sandbox.versions);
  if (!picked) return { error: 'Kod ayrıştırılamadı (Lua sözdizimi hatası)', code: input, events, stats };
  let version = picked.version;
  let baseline = picked.run.ok ? snapshotOf(picked.run) : null;
  // indirmenin davranış denetimi: özgün Luau kodu luau-web runtime'ında, indirilmiş kod Lua'da aynı davranmalı
  if (luau && baseline) {
    const lr = await sandbox.run({ code: luau.source, version: 'luau', platform: plat }).catch((e) => ({ ok: false, error: e.message }));
    luau.verified = Boolean(lr?.ok) && same(baseline, snapshotOf(lr));
    log(luau.verified ? "Luau indirmesi luau-web runtime'ında doğrulandı"
      : `Luau indirmesi doğrulanamadı (${lr?.ok ? 'davranış farklı' : lr?.error ?? 'runtime yok'}); sonraki adımlar indirilmiş koda göre denetlenir`,
    luau.verified ? 'info' : 'warn');
  }
  log(`Lua ${version}${plat ? ` · platform: ${plat}` : ''}${baseline ? '' : ' (çalıştırılamadı, yalnızca statik dönüşümler)'}`, 'info');

  const runs = new Map();
  const runCode = async (c, variant = 0, ver = version) => {
    const key = `${ver}\u0001${variant}\u0001${c}`;
    if (!runs.has(key)) {
      if (runs.size > 64) runs.delete(runs.keys().next().value);
      runs.set(key, await sandbox.run({ code: c, version: ver, platform: ctx.platform, variant }));
    }
    return runs.get(key);
  };

  const ctx = {
    version,
    platform: plat,
    log,
    bump: (k, n = 1) => { if (n) stats[k] = (stats[k] ?? 0) + n; },
    runRaw: async (c, variant = 0) => (baseline ? runCode(c, variant) : null),
    evaluate: (exprs) => sandbox.evaluate({ exprs, version }),
    // pass çıktısı daha yeni bir Lua sürümü gerektiriyorsa (ör. goto: 5.2): çıktı o sürümde ayrıştırılıp doğrulanır,
    // kabul edilirse hat o sürümle devam eder
    pendingVersion: null,
    switchVersion: (v) => { ctx.pendingVersion = v; },
  };

  const passes = PASSES.filter((p) => (!only || only.includes(p.id)) && (!p.needsSandbox || baseline));
  const seen = new Set([code]);
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let changed = false;
    for (const p of passes) {
      checkAbort();
      const t = Date.now();
      onPass(p.id, 'run');
      let next;
      let ver = version;
      ctx.pendingVersion = null;
      try {
        next = await p.run(code, ctx);
        ver = ctx.pendingVersion ?? version;
        if (next != null && next !== code) next = fixSemicolons(next, ver);
      } catch (e) {
        log(`${p.id}: ${e.message}, geri alındı`, 'warn');
        events.push({ id: p.id, round, state: 'fail', reason: e.message, ms: Date.now() - t });
        onPass(p.id, 'fail');
        continue;
      }
      checkAbort();
      if (next == null || next === code) {
        events.push({ id: p.id, round, state: 'skip', ms: Date.now() - t });
        onPass(p.id, 'skip');
        continue;
      }
      if (!tryParse(next, ver)) {
        log(`${p.id}: çıktı ayrıştırılamadı, geri alındı`, 'warn');
        events.push({ id: p.id, round, state: 'fail', reason: 'parse', ms: Date.now() - t });
        onPass(p.id, 'fail');
        continue;
      }
      if (baseline && !same(baseline, snapshotOf(await runCode(next, 0, ver)))) {
        log(`${p.id}: davranış değişti, geri alındı`, 'warn');
        events.push({ id: p.id, round, state: 'fail', reason: 'davranış', ms: Date.now() - t });
        onPass(p.id, 'fail');
        continue;
      }
      code = next;
      changed = true;
      if (ver !== version) {
        log(`${p.id}: hat Lua ${ver} ile devam ediyor`, 'info');
        version = ver;
        ctx.version = ver;
      }
      events.push({ id: p.id, round, state: 'ok', ms: Date.now() - t });
      onPass(p.id, 'ok');
      onSnapshot({ id: p.id, round, code });
    }
    // açılan katman yeni bir platform API'si gösterdiyse (FiveM/GMod/Roblox) taklitler yüklenir ve davranış temeli
    // özgün kod üzerinde o platformla yeniden alınır
    const now = ctx.platform ? null : detectPlatform(code);
    if (now) {
      const rerun = await sandbox.run({ code: origin, version, platform: now });
      if (rerun.ok) {
        ctx.platform = now;
        baseline = snapshotOf(rerun);
        picked.run = rerun;
        runs.clear();
        log(`platform tanındı: ${now} (açılan katmandan), davranış temeli yeniden alındı`, 'info');
        changed = true;
      }
    }
    if (!changed || seen.has(code)) break;
    seen.add(code);
  }

  let out = code;
  if (formatOutput) {
    const f = await format(code, version);
    if (f && f !== code && tryParse(f, version) && (!baseline || same(baseline, snapshotOf(await runCode(f))))) out = f;
  }
  if (shebang) out = `${shebang}\n${out.replace(/^\s*\n/, '')}`;
  return {
    code: out,
    text: toText(out),
    stats,
    events,
    version,
    platform: ctx.platform,
    verified: Boolean(baseline),
    luau: luau ? { lowered: true, verified: luau.verified, goto: luau.goto } : null,
    trace: { first: picked.run, final: baseline ? await runCode(code) : null },
    ms: Date.now() - t0,
  };
}
