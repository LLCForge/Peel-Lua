// Peel-Lua kütüphane API'si. Lua sandbox'ı WebAssembly içinde çalışır: Node'da izin modeliyle yalıtılmış alt süreçte,
// tarayıcıda Web Worker'da.
//   import { deobfuscate, analyze, peel } from 'peel-lua';
import { deobfuscate as runPipeline } from './core/pipeline.js';
import { analyze as runAnalyze } from './core/analyze.js';
import { PASSES } from './core/registry.js';
import { fromBytes, fromText } from './core/bstr.js';

let shared = null;

export async function createSandbox() {
  if (typeof process !== 'undefined' && process.versions?.node) {
    const path = './sandbox/node-host.js';
    const { createNodeSandbox } = await import(/* @vite-ignore */ path);
    return createNodeSandbox();
  }
  const path = './sandbox/web-host.js';
  const { createWebSandbox } = await import(/* @vite-ignore */ path);
  return createWebSandbox();
}

async function sandboxOf(option) {
  if (option && typeof option === 'object') return option;
  shared ??= createSandbox();
  return shared;
}

/** Girdi: Lua kaynak metni (string, UTF-8 olarak kodlanır) ya da bayt dizisi (Uint8Array, olduğu gibi) */
const toBstr = (input) => (input instanceof Uint8Array ? fromBytes(input) : fromText(String(input)));

export async function deobfuscate(input, { sandbox, ...options } = {}) {
  return runPipeline(toBstr(input), { ...options, sandbox: await sandboxOf(sandbox) });
}

export async function peel(input, { sandbox, lang = 'tr', ...options } = {}) {
  const src = toBstr(input);
  const r = await runPipeline(src, { ...options, sandbox: await sandboxOf(sandbox) }).catch((e) => ({ error: e.message }));
  if (r.error) return { ...r, code: src, report: runAnalyze({ input: src, output: src, lang }) };
  return { ...r, report: runAnalyze({ input: src, output: r.code, trace: r.trace, events: r.events, stats: r.stats, version: r.version, platform: r.platform, lang }) };
}

export const analyze = runAnalyze;
export const passes = () => PASSES.map(({ id }) => ({ id }));
