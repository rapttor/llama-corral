import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      if (inline !== undefined) opts[k] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) opts[k] = argv[++i];
      else opts[k] = true;
    } else opts._.push(a);
  }
  return opts;
}

export function loadConfig(opts = {}) {
  const dataDir = path.resolve(
    expandHome(opts.data || process.env.CORRAL_DATA || path.join(os.homedir(), '.corral'))
  );
  fs.mkdirSync(dataDir, { recursive: true });

  const file = path.join(dataDir, 'config.json');
  let stored = {};
  if (fs.existsSync(file)) stored = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (!stored.adminToken) {
    stored.adminToken = 'cra_' + crypto.randomBytes(20).toString('hex');
    stored.machineName = stored.machineName || os.hostname();
    fs.writeFileSync(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
  }

  return {
    dataDir,
    configFile: file,
    adminToken: stored.adminToken,
    machineName: opts.name || stored.machineName || os.hostname(),
    port: Number(opts.port || process.env.CORRAL_PORT || stored.port || 11435),
    host: opts.host || process.env.CORRAL_HOST || stored.host || '127.0.0.1',
    ollama: stripSlash(opts.ollama || process.env.CORRAL_OLLAMA || stored.ollama || 'http://127.0.0.1:11434'),
    // Requests from this machine (127.0.0.1 / ::1) may use the gateway without a token.
    localOpen: opts['require-token'] ? false : stored.localOpen !== false,
    pollMs: Number(opts['poll-ms'] || 10000),
    retentionDays: Number(stored.retentionDays || 90),
  };
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}
function stripSlash(u) {
  return u.replace(/\/+$/, '');
}
