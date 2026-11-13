#!/usr/bin/env node
// Peel-Lua komut satırı. Kullanım: peel-lua <dosya|dizin|-> [-o çıktı] [-d dizin] [-r json|text|rapor.json] ... (peel-lua --help)
import { runCli, EXIT } from '../src/cli/run.js';
import { UsageError } from '../src/cli/args.js';

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError) {
    console.error(e.message);
    process.exitCode = EXIT.USAGE;
  } else {
    console.error(`Hata: ${e.message}`);
    process.exitCode = EXIT.ERROR;
  }
}
