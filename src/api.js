import { once } from 'node:events';
import { createToken, kvGet } from './db.js';
import { isAdmin } from './auth.js';
import { createAgents } from './agents.js';
import { catalogView } from './catalog.js';
import { checkUpdates, skipUpdate } from './updates.js';

const VERSION = '0.1.0';

export function createApi({ cfg, db, state, ollama, jobs, hardware, startedAt }) {
  const routes = [];
  const on = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern}$`), fn });
  const agents = createAgents(db);

  // ---------- agents (saved system prompt + params; shape the test chat) ----------
  on('GET', '/agents', () => agents.list());
  on('POST', '/agents', ({ body }) => agents.create(body));
  on('PUT', '/agents/(\\d+)', ({ params, body }) => agents.update(Number(params[0]), body));
  on('DELETE', '/agents/(\\d+)', ({ params }) => agents.remove(Number(params[0])));

  // ---------- overview & usage ----------
  on('GET', '/overview', () => {
    const since = startOfDay();
    const today = db
      .prepare(
        `SELECT COUNT(*) requests, COALESCE(SUM(prompt_tokens),0) prompt, COALESCE(SUM(output_tokens),0) output,
                AVG(tps) tps, SUM(status >= 400) errors, SUM(overflow) overflows
         FROM requests WHERE ts >= ?`
      )
      .get(since);
    return {
      corral: VERSION,
      machine: cfg.machineName,
      online: state.online,
      ollamaVersion: state.version,
      ollamaUrl: cfg.ollama,
      ollamaError: state.lastError,
      gateway: { host: cfg.host, port: cfg.port, localOpen: cfg.localOpen },
      hardware,
      loaded: state.loaded.map((m) => ({
        name: m.name,
        size: m.size,
        sizeVram: m.size_vram,
        contextLength: m.context_length ?? null,
        expiresAt: m.expires_at,
      })),
      today: { ...today, tps: today.tps ? Math.round(today.tps * 10) / 10 : null },
      tokens: db.prepare('SELECT COUNT(*) n FROM tokens WHERE revoked_at IS NULL').get().n,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    };
  });

  on('GET', '/usage', ({ query }) => {
    const days = clamp(Number(query.days) || 7, 1, 365);
    const since = startOfDay() - (days - 1) * 86400000;
    const agg = `COUNT(*) requests, COALESCE(SUM(prompt_tokens),0) prompt, COALESCE(SUM(output_tokens),0) output,
                 ROUND(AVG(tps),1) tps, ROUND(AVG(ttft_ms)) ttft, SUM(status >= 400) errors, SUM(overflow) overflows`;
    return {
      days,
      totals: db.prepare(`SELECT ${agg} FROM requests WHERE ts >= ?`).get(since),
      byDay: db
        .prepare(
          `SELECT date(ts/1000,'unixepoch','localtime') day, ${agg} FROM requests WHERE ts >= ? GROUP BY day ORDER BY day`
        )
        .all(since),
      byModel: db
        .prepare(`SELECT model, ${agg} FROM requests WHERE ts >= ? GROUP BY model ORDER BY output DESC, requests DESC`)
        .all(since),
      byClient: db
        .prepare(`SELECT client, ${agg} FROM requests WHERE ts >= ? GROUP BY client ORDER BY output DESC, requests DESC`)
        .all(since),
      overflowing: db
        .prepare(
          `SELECT model, client, COUNT(*) n, MAX(prompt_tokens) maxPrompt, MAX(ctx_limit) ctx
           FROM requests WHERE ts >= ? AND overflow = 1 GROUP BY model, client ORDER BY n DESC LIMIT 20`
        )
        .all(since),
    };
  });

  on('GET', '/requests', ({ query }) => {
    const limit = clamp(Number(query.limit) || 100, 1, 1000);
    const where = [];
    const args = [];
    if (query.model) where.push('model = ?') && args.push(query.model);
    if (query.client) where.push('client = ?') && args.push(query.client);
    if (query.overflow) where.push('overflow = 1');
    const sql = `SELECT * FROM requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    return db.prepare(sql).all(...args, limit);
  });

  on('GET', '/requests.csv', ({ query }) => {
    const days = clamp(Number(query.days) || 30, 1, 365);
    const rows = db.prepare('SELECT * FROM requests WHERE ts >= ? ORDER BY id').all(Date.now() - days * 86400000);
    const cols = rows[0] ? Object.keys(rows[0]) : ['id'];
    const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const body = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(c === 'ts' ? new Date(r.ts).toISOString() : r[c])).join(','))].join('\n');
    return { __raw: body, type: 'text/csv', filename: `corral-requests-${cfg.machineName}.csv` };
  });

  on('GET', '/memory', ({ query }) => {
    const hours = clamp(Number(query.hours) || 6, 1, 336);
    return db
      .prepare(
        `SELECT ts, SUM(size_vram) vram, SUM(size) total, GROUP_CONCAT(model) models
         FROM ps_samples WHERE ts >= ? GROUP BY ts ORDER BY ts`
      )
      .all(Date.now() - hours * 3600000);
  });

  // ---------- models ----------
  on('GET', '/models', async () => {
    const { models = [] } = await ollama.tags();
    const updates = kvGet(db, 'updates', {});
    const loaded = new Set(state.loaded.map((m) => m.name));
    const usage = Object.fromEntries(
      db
        .prepare('SELECT model, COUNT(*) n, MAX(ts) last FROM requests WHERE ts >= ? GROUP BY model')
        .all(Date.now() - 30 * 86400000)
        .map((r) => [r.model, r])
    );
    return models.map((m) => {
      const u = updates[m.name];
      return {
        name: m.name,
        size: m.size,
        digest: m.digest,
        modifiedAt: m.modified_at,
        family: m.details?.family,
        params: m.details?.parameter_size,
        quant: m.details?.quantization_level,
        format: m.details?.format,
        remote: Boolean(m.remote_model || m.remote_host),
        loaded: loaded.has(m.name),
        update: u && u.status === 'update' && u.skipped !== u.remoteDigest ? true : false,
        requests30d: usage[m.name]?.n || 0,
        lastUsed: usage[m.name]?.last || null,
      };
    });
  });

  on('GET', '/models/show', ({ query }) => ollama.show(query.name));
  on('POST', '/models/pull', ({ body }) => need(body.model, 'model') && jobs.pull(body.model.trim()));
  on('POST', '/models/delete', async ({ body }) => need(body.model, 'model') && (await ollama.remove(body.model), { ok: true }));
  on('POST', '/models/unload', async ({ body }) => {
    need(body.model, 'model');
    await ollama.unload(body.model);
    await state.refresh();
    return { ok: true };
  });
  on('POST', '/models/copy', async ({ body }) => (await ollama.copy(body.source, body.destination), { ok: true }));
  // Model Factory: new model from an existing one with a system prompt and parameters.
  on('POST', '/models/create', async ({ body }) => {
    need(body.model, 'model');
    need(body.from, 'from');
    const req = { model: body.model, from: body.from };
    if (body.system) req.system = body.system;
    if (body.parameters && Object.keys(body.parameters).length) req.parameters = body.parameters;
    await ollama.create(req);
    return { ok: true };
  });

  on('GET', '/jobs', () => jobs.list());
  on('POST', '/jobs/(\\d+)/cancel', ({ params }) => jobs.cancel(params[0]) || { error: 'no such job' });

  on('GET', '/updates', () => kvGet(db, 'updates', {}));
  on('POST', '/updates/check', () => checkUpdates({ db, ollama, force: true }));
  on('POST', '/updates/skip', ({ body }) => skipUpdate(db, body.model));

  on('GET', '/catalog', async () => {
    let installed = [];
    try {
      installed = (await ollama.tags()).models || [];
    } catch {
      /* catalog still works offline */
    }
    return catalogView(hardware, installed);
  });

  // ---------- app tokens ----------
  on('GET', '/tokens', () =>
    db
      .prepare(
        `SELECT t.id, t.name, t.prefix, t.created_at, t.last_used_at,
                (SELECT COUNT(*) FROM requests r WHERE r.token_id = t.id) requests
         FROM tokens t WHERE revoked_at IS NULL ORDER BY t.id DESC`
      )
      .all()
  );
  on('POST', '/tokens', ({ body }) => {
    const name = String(body.name || '').trim().slice(0, 60);
    need(name, 'name');
    return createToken(db, name);
  });
  on('DELETE', '/tokens/(\\d+)', ({ params }) => {
    db.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ?').run(Date.now(), Number(params[0]));
    return { ok: true };
  });

  // ---------- other machines (hub) ----------
  on('GET', '/remotes', () => db.prepare('SELECT id, name, url, created_at FROM remotes ORDER BY name').all());
  on('POST', '/remotes', async ({ body }) => {
    const url = String(body.url || '').trim().replace(/\/+$/, '');
    need(url, 'url');
    need(body.adminToken, 'adminToken');
    let ov;
    try {
      ov = await remoteCall({ url, admin_token: body.adminToken }, 'GET', '/overview');
    } catch (e) {
      throw Object.assign(new Error(`could not connect to ${url}: ${e.message}`), { status: 400 });
    }
    const name = String(body.name || ov.machine || url).slice(0, 60);
    const info = db
      .prepare('INSERT INTO remotes (name, url, admin_token, created_at) VALUES (?, ?, ?, ?)')
      .run(name, url, body.adminToken, Date.now());
    return { id: Number(info.lastInsertRowid), name, url };
  });
  on('DELETE', '/remotes/(\\d+)', ({ params }) => {
    db.prepare('DELETE FROM remotes WHERE id = ?').run(Number(params[0]));
    return { ok: true };
  });

  on('GET', '/machines', async () => {
    const local = { id: 'local', name: cfg.machineName, url: null, ...summary(await routeLocal('GET', '/overview')) };
    const remotes = db.prepare('SELECT * FROM remotes ORDER BY name').all();
    const others = await Promise.all(
      remotes.map(async (r) => {
        const t0 = Date.now();
        try {
          const ov = await remoteCall(r, 'GET', '/overview');
          return { id: r.id, name: r.name, url: r.url, latencyMs: Date.now() - t0, ...summary(ov) };
        } catch (e) {
          return { id: r.id, name: r.name, url: r.url, reachable: false, error: e.message };
        }
      })
    );
    return [local, ...others];
  });

  function summary(ov) {
    return {
      reachable: true,
      online: ov.online,
      ollamaVersion: ov.ollamaVersion,
      hardware: ov.hardware,
      loaded: ov.loaded,
      today: ov.today,
    };
  }

  async function remoteCall(r, method, path, body) {
    const res = await fetch(`${r.url}/corral/api${path}`, {
      method,
      headers: { 'x-corral-admin': r.admin_token, 'content-type': 'application/json' },
      body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (!res.ok) throw new Error(data.error || `remote ${res.status}`);
    return data;
  }

  async function routeLocal(method, path, query = {}, body = {}) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = path.match(r.re);
      if (m) return r.fn({ params: m.slice(1), query, body });
    }
    const err = new Error('not found');
    err.status = 404;
    throw err;
  }

  // Streams a test-chat request to another machine's gateway and pipes the NDJSON back unchanged.
  async function relayChat(r, body, res) {
    const ctrl = new AbortController();
    res.on('close', () => ctrl.abort());
    try {
      const up = await fetch(`${r.url}/api/chat`, {
        method: 'POST',
        headers: { 'x-corral-admin': r.admin_token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/x-ndjson', 'cache-control': 'no-store' });
      for await (const chunk of up.body ?? []) if (!res.write(chunk)) await once(res, 'drain');
      res.end();
    } catch (e) {
      if (res.headersSent) return res.end();
      send(res, 502, { error: `machine unreachable: ${e.message}` });
    }
  }

  // ---------- dispatcher ----------
  return async function api(req, res, subpath, query) {
    if (!isAdmin(req, cfg)) return send(res, 401, { error: 'admin token required' });
    try {
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req);
      // /r/<id>/... runs the same call on another machine.
      const rm = subpath.match(/^\/r\/(\d+)(\/.*)$/);
      let out;
      if (rm) {
        const r = db.prepare('SELECT * FROM remotes WHERE id = ?').get(Number(rm[1]));
        if (!r) return send(res, 404, { error: 'unknown machine' });
        if (rm[2] === '/chat' && req.method === 'POST') return relayChat(r, body, res);
        const qs = new URLSearchParams(query).toString();
        out = await remoteCall(r, req.method, rm[2] + (qs ? `?${qs}` : ''), body);
      } else {
        out = await routeLocal(req.method, subpath, query, body);
      }
      if (out && out.__raw !== undefined) {
        res.writeHead(200, {
          'content-type': out.type,
          'content-disposition': `attachment; filename="${out.filename}"`,
        });
        return res.end(out.__raw);
      }
      send(res, 200, out ?? { ok: true });
    } catch (e) {
      send(res, e.status || 500, { error: e.message });
    }
  };
}

function need(v, name) {
  if (!v) {
    const e = new Error(`${name} is required`);
    e.status = 400;
    throw e;
  }
  return true;
}
function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function startOfDay() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
