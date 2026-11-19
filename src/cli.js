import { parseArgs, loadConfig } from './config.js';
import { openDb, createToken } from './db.js';
import { startServer } from './server.js';

const HELP = `
corral: the control plane for your Ollama machines

Usage
  corral [start]                 Start the gateway + dashboard
  corral token create <name>     Create an app token (shown once)
  corral token list              List active tokens
  corral token revoke <id|name>  Revoke a token
  corral admin                   Print the dashboard URL with admin token

Options (start)
  --port <n>          Gateway port (default 11435)
  --host <addr>       Bind address (default 127.0.0.1; use 0.0.0.0 to serve other machines)
  --ollama <url>      Upstream Ollama (default http://127.0.0.1:11434)
  --name <name>       Machine name shown in the hub (default hostname)
  --require-token     Also require a token for requests from this machine
  --data <dir>        Data directory (default ~/.corral)
`;

export async function main(argv) {
  const opts = parseArgs(argv);
  const [cmd = 'start', sub, arg] = opts._;
  if (opts.help || cmd === 'help') return console.log(HELP);

  const cfg = loadConfig(opts);

  if (cmd === 'token') {
    const db = openDb(cfg.dataDir);
    if (sub === 'create') {
      if (!arg) throw new Error('usage: corral token create <name>');
      const t = createToken(db, arg);
      console.log(`\n  Token for "${t.name}" (copy it now, it won't be shown again):\n\n    ${t.token}\n`);
      return;
    }
    if (sub === 'list') {
      const rows = db.prepare('SELECT id, name, prefix, created_at, last_used_at FROM tokens WHERE revoked_at IS NULL').all();
      if (!rows.length) return console.log('No tokens yet. Create one: corral token create cursor');
      for (const r of rows)
        console.log(
          `  #${r.id}  ${r.name.padEnd(20)} ${r.prefix}…  last used: ${r.last_used_at ? new Date(r.last_used_at).toLocaleString() : 'never'}`
        );
      return;
    }
    if (sub === 'revoke') {
      const info = db
        .prepare('UPDATE tokens SET revoked_at = ? WHERE (id = ? OR name = ?) AND revoked_at IS NULL')
        .run(Date.now(), Number(arg) || -1, arg);
      return console.log(info.changes ? `Revoked ${info.changes} token(s).` : 'No matching token.');
    }
    throw new Error('usage: corral token create|list|revoke');
  }

  if (cmd === 'admin') return console.log(dashboardUrl(cfg));

  if (cmd !== 'start') throw new Error(`unknown command "${cmd}" (try: corral help)`);

  const { state } = await startServer(cfg);
  const exposed = cfg.host === '0.0.0.0' || cfg.host === '::';
  console.log(`
  🦙 corral ${'0.1.0'} on ${cfg.machineName}

  Gateway     http://${exposed ? '<this-machine-ip>' : cfg.host}:${cfg.port}   → ${cfg.ollama}
  Dashboard   ${dashboardUrl(cfg)}
  Ollama      ${state.online ? `online, v${state.version}` : `NOT reachable (${state.lastError})`}

  Point your tools at the gateway instead of :11434, using an app token as the API key.
  ${exposed ? 'Other machines need a token; create one with: corral token create <name>' : 'Bound to localhost. Use --host 0.0.0.0 to serve other machines.'}
`);

  const stop = () => process.exit(0);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function dashboardUrl(cfg) {
  const host = cfg.host === '0.0.0.0' || cfg.host === '::' ? 'localhost' : cfg.host;
  return `http://${host}:${cfg.port}/corral/#admin=${cfg.adminToken}`;
}
