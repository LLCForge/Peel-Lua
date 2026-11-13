// Web Worker tarafı: Lua 5.1-5.4 (lua-wasm-bindings, Emscripten/WebAssembly). Motor (engine.js) burada çalışır;
// sonsuz döngüde ana thread'deki bekçi worker'ı sonlandırır.
//
// Yükleme: Emscripten yapıştırıcısı (CJS, Vite tarafından ESM'e çevrilir) ve .wasm dosyası (Vite ?url ile dist/assets
// altına kopyalanır) ilk istekte dört sürüm için birlikte alınır. Yapıştırıcıya wasmBinary verilir: kendi senkron
// XHR'ını kullanmaz. Tarayıcıda ENVIRONMENT_IS_NODE yanlıştır, os.execute child_process'e bağlanmaz (prelude zaten taklit eder).
//
// Yalıtım worker düzeyindedir:
//  1. CSP: worker betiğinin yanıt başlığı (dev/preview: vite.config.js ara katmanı, üretim: public/_headers)
//     default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'
//  2. JS kilidi: dosyalar yüklendikten sonra ağ API'leri, eval/Function kurucuları, dizge zamanlayıcıları ve iç içe
//     worker kaldırılır. Başlık veremeyen barındırmada tek katman budur; durum ana thread'e 'env' iletisiyle bildirilir.
import { createLua, createLauxLib, createLuaLib } from 'lua-wasm-bindings/dist/binding-factory.js';
import { createEngine } from './engine.js';

const ASSETS = {
  '5.1': { semver: '5.1.5', glue: () => import('lua-wasm-bindings/dist/glue/glue-lua-5.1.5.js'), wasm: () => import('lua-wasm-bindings/dist/glue/glue-lua-5.1.5.wasm?url') },
  '5.2': { semver: '5.2.4', glue: () => import('lua-wasm-bindings/dist/glue/glue-lua-5.2.4.js'), wasm: () => import('lua-wasm-bindings/dist/glue/glue-lua-5.2.4.wasm?url') },
  '5.3': { semver: '5.3.6', glue: () => import('lua-wasm-bindings/dist/glue/glue-lua-5.3.6.js'), wasm: () => import('lua-wasm-bindings/dist/glue/glue-lua-5.3.6.wasm?url') },
  '5.4': { semver: '5.4.7', glue: () => import('lua-wasm-bindings/dist/glue/glue-lua-5.4.7.js'), wasm: () => import('lua-wasm-bindings/dist/glue/glue-lua-5.4.7.wasm?url') },
};

// CSP sınaması: bu betiğin kendi yanıtı yeniden (aynı köken) okunur ve başlıkta connect-src 'self' aranır
const cspProbe = fetch(self.location.href, { method: 'HEAD', cache: 'no-store' })
  .then((r) => /(^|;)\s*connect-src 'self'\s*(;|$)/.test(r.headers.get('content-security-policy') ?? ''), () => false);

// Kaldırılan genel adlar: ağ, kod üretme, iç içe worker, kalıcı depolama
const BLOCKED = [
  'fetch', 'fetchLater', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport',
  'importScripts', 'Worker', 'SharedWorker', 'caches', 'BroadcastChannel', 'indexedDB',
];
const denied = () => { throw new EvalError('Peel sandbox: kod üretimi kapalı'); };

function lockdown() {
  const ctorProtos = [
    Function.prototype,
    Object.getPrototypeOf(async function () {}),
    Object.getPrototypeOf(function* () {}),
    Object.getPrototypeOf(async function* () {}),
  ];
  for (const name of BLOCKED) {
    for (let o = self; o; o = Object.getPrototypeOf(o)) {
      if (Object.prototype.hasOwnProperty.call(o, name)) {
        Object.defineProperty(o, name, { value: undefined, writable: false, configurable: false });
      }
    }
  }
  // Function silinmez ('x instanceof Function' çalışsın): aynı prototipi taşıyan, çağrılınca hata veren sahte.
  // Kuruculara prototip üzerinden de ulaşılmasın: (async () => {}).constructor('...')
  const BlockedFunction = function Function() { denied(); };
  BlockedFunction.prototype = Function.prototype;
  const freeze = (o, k, value) => Object.defineProperty(o, k, { value, writable: false, configurable: false });
  freeze(self, 'eval', denied);
  freeze(self, 'Function', BlockedFunction);
  for (const proto of ctorProtos) freeze(proto, 'constructor', BlockedFunction);
  for (const name of ['setTimeout', 'setInterval']) {
    const real = self[name];
    Object.defineProperty(self, name, {
      value: (fn, ...rest) => (typeof fn === 'function' ? real(fn, ...rest) : 0),
      writable: false,
      configurable: false,
    });
  }
}

const quiet = () => {};
let loading = null;
// tüm sürümlerin yapıştırıcı modülü ve wasm baytları birlikte alınır; ardından kilit kurulur (sonra ağ yok)
const loadAll = () => (loading ??= (async () => {
  const entries = await Promise.all(Object.entries(ASSETS).map(async ([v, a]) => {
    const [glue, url] = await Promise.all([a.glue(), a.wasm()]);
    const res = await fetch(url.default);
    if (!res.ok) throw new Error(`${url.default}: HTTP ${res.status}`);
    return [v, { semver: a.semver, factory: glue.default ?? glue, wasmBinary: new Uint8Array(await res.arrayBuffer()) }];
  }));
  const csp = await cspProbe;
  lockdown();
  self.postMessage({ type: 'env', csp, locked: true });
  return new Map(entries);
})());

const engine = createEngine(async (version) => {
  const all = await loadAll();
  const a = all.get(version) ?? all.get('5.1');
  // derleme senkron (Emscripten WASM_ASYNC_COMPILATION=0); worker'da boyut sınırı yoktur
  const glue = a.factory({ wasmBinary: a.wasmBinary, print: quiet, printErr: quiet });
  const lua = createLua(glue, a.semver);
  return { lua, lauxlib: createLauxLib(glue, lua, a.semver), lualib: createLuaLib(glue, a.semver) };
});

self.addEventListener('message', async ({ data }) => {
  const { id, ...msg } = data ?? {};
  let result;
  try {
    result = await engine.handle(msg);
  } catch (err) {
    result = { ok: false, error: String(err?.message ?? err).split('\n').filter(Boolean).slice(-3).join(' | ') };
  }
  self.postMessage({ id, ...result });
});
