#!/usr/bin/env node
// Silence the "SQLite is experimental" warning from node:sqlite; everything else still prints.
const emit = process.emitWarning;
process.emitWarning = (warning, ...args) => {
  if (String(warning).includes('SQLite')) return;
  return emit.call(process, warning, ...args);
};

const { main } = await import('../src/cli.js');
main(process.argv.slice(2)).catch((err) => {
  console.error(`corral: ${err.message}`);
  process.exit(1);
});
