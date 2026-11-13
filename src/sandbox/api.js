// Bekçili sandbox'a istemci API'si (Node ve tarayıcı ortak). Kod bstr'dir (her karakter bir bayt).
export const VERSIONS = ['5.1', '5.4', '5.3', '5.2'];
export const LOAD_DEADLINE_MS = 60_000;
export const RUN_TIMEOUT_MS = 10_000;

export function sandboxApi(send) {
  const load = async (version) => {
    const r = await send({ type: 'load', version, deadlineMs: LOAD_DEADLINE_MS });
    if (!r.ok) throw new Error(`Lua ${version} yüklenemedi: ${r.error}`);
  };
  return {
    versions: VERSIONS,
    /** variant: 1 → dış girdi sondası (HTTP yanıtı, dosya, ortam değerleri farklı) */
    async run({ code, version = '5.1', platform = null, variant = 0, timeoutMs = RUN_TIMEOUT_MS }) {
      await load(version);
      return send({ type: 'run', code, version, platform, variant, deadlineMs: timeoutMs });
    },
    async evaluate({ exprs, version = '5.1', timeoutMs = RUN_TIMEOUT_MS }) {
      if (!exprs.length) return [];
      await load(version);
      const r = await send({ type: 'evaluate', exprs, version, deadlineMs: timeoutMs });
      return r.ok ? r.results : null;
    },
  };
}
