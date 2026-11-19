import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { ollamaClient } from './ollama.js';
import { createState } from './state.js';
import { createProxy } from './proxy.js';
import { createApi } from './api.js';
import { createJobs } from './jobs.js';
import { probeHardware } from './hardware.js';
import { checkUpdates } from './updates.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

export async function startServer(cfg) {
  const db = openDb(cfg.dataDir);
  const ollama = ollamaClient(cfg.ollama);
  const hardware = await probeHardware();
  const state = createState({ cfg, db, ollama });
  await state.refresh();
  const jobs = createJobs(ollama);
  const proxy = createProxy({ cfg, db, state });
  const api = createApi({ cfg, db, state, ollama, jobs, hardware, startedAt: Date.now() });

  // Daily model-update check (quiet if offline).
  const updateTick = () => checkUpdates({ db, ollama }).catch(() => {});
  setTimeout(updateTick, 30000).unref();
  setInterval(updateTick, 24 * 3600000).unref();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/corral') {
      res.writeHead(302, { location: '/corral/' });
      return res.end();
    }
    if (p.startsWith('/corral/api/')) {
      return api(req, res, p.slice('/corral/api'.length), Object.fromEntries(url.searchParams));
    }
    if (p.startsWith('/corral/')) return serveUi(res, p.slice('/corral/'.length) || 'index.html');
    return proxy(req, res);
  });
  server.requestTimeout = 0; // long generations must not be cut off
  server.headersTimeout = 60000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, resolve);
  });
  return { server, db, state, close: () => new Promise((r) => server.close(r)) };
}

function serveUi(res, file) {
  const safe = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(UI_DIR, safe);
  if (!full.startsWith(UI_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(full).pipe(res);
}
