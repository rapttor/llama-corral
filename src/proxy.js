import http from 'node:http';
import https from 'node:https';
import { Meter } from './meter.js';
import { findToken } from './db.js';
import { isAdmin } from './auth.js';

// Endpoints that run a model. Only these are written to the usage log.
const INFERENCE = new Set([
  '/api/chat',
  '/api/generate',
  '/api/embed',
  '/api/embeddings',
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/embeddings',
  '/v1/responses',
  '/v1/messages',
]);
// Harmless endpoints clients use as a health check before they send a key.
const PUBLIC = new Set(['/', '/api/version']);

const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'authorization',
  'content-length',
  'x-corral-admin', // never forward the admin token upstream
]);

const MAX_BODY = 200 * 1024 * 1024;

export function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// Accepts the token as "Authorization: Bearer crl_…", "x-api-key", Basic auth password,
// or a /t/<token>/ path prefix for clients that cannot set headers.
function extractToken(req, url) {
  const m = url.pathname.match(/^\/t\/(crl_[a-f0-9]+)(\/.*)?$/);
  if (m) return { token: m[1], path: m[2] || '/' };
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return { token: auth.slice(7).trim(), path: url.pathname };
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    return { token: decoded.slice(decoded.indexOf(':') + 1), path: url.pathname };
  }
  if (req.headers['x-api-key']) return { token: String(req.headers['x-api-key']), path: url.pathname };
  return { token: null, path: url.pathname };
}

export function createProxy({ cfg, db, state }) {
  const upstream = new URL(cfg.ollama);
  const agent = upstream.protocol === 'https:' ? https : http;
  const insert = db.prepare(`
    INSERT INTO requests (ts, client, token_id, ip, endpoint, model, stream, status, prompt_tokens, output_tokens,
      approx, ttft_ms, total_ms, load_ms, tps, ctx_limit, overflow, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const touch = db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?');

  return async function proxy(req, res) {
    const started = Date.now();
    const url = new URL(req.url, 'http://x');
    const { token, path } = extractToken(req, url);

    let client = null;
    let tokenRow = null;
    if (token) {
      tokenRow = findToken(db, token);
      if (!tokenRow) return deny(res, 'invalid or revoked token');
      client = tokenRow.name;
      touch.run(started, tokenRow.id);
    } else if (isAdmin(req, cfg)) {
      // The dashboard's test chat (local, or relayed from a hub) authenticates with the admin token.
      client = 'corral-chat';
    } else if (cfg.localOpen && isLocal(req)) {
      client = 'local';
    } else if (req.method === 'OPTIONS' || (req.method !== 'POST' && PUBLIC.has(path))) {
      client = 'anonymous';
    } else {
      return deny(res, 'token required: create one with `corral token create <name>`');
    }

    // Buffer the (small) request body so we can read the model name, then forward it unchanged.
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      res.writeHead(413).end(JSON.stringify({ error: e.message }));
      return;
    }

    const endpoint = path;
    const metered = req.method === 'POST' && INFERENCE.has(endpoint);
    let reqJson = null;
    if (metered && body.length) {
      try {
        reqJson = JSON.parse(body.toString('utf8'));
      } catch {
        /* forward anyway */
      }
    }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
    if (upstream.username) {
      headers.authorization =
        'Basic ' + Buffer.from(`${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`).toString('base64');
    }
    if (body.length) headers['content-length'] = body.length;
    headers.host = upstream.host;

    const upReq = agent.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: endpoint + url.search,
        headers,
      },
      (upRes) => {
        const outHeaders = {};
        for (const [k, v] of Object.entries(upRes.headers)) if (!HOP.has(k.toLowerCase()) || k === 'content-length') outHeaders[k] = v;
        res.writeHead(upRes.statusCode, outHeaders);

        const meter = metered ? new Meter(String(upRes.headers['content-type'] || '')) : null;
        if (meter) upRes.on('data', (c) => meter.push(c));
        upRes.pipe(res);

        let logged = false;
        const finish = (status) => {
          if (!meter || logged) return;
          logged = true;
          record({ status, meter });
        };
        upRes.on('end', () => finish(upRes.statusCode));
        res.on('close', () => {
          if (!res.writableFinished) {
            upReq.destroy();
            finish(499);
          }
        });
      }
    );

    upReq.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `corral: cannot reach Ollama at ${cfg.ollama} (${err.code || err.message})` }));
      if (metered) record({ status: 502, meter: null, error: err.code || err.message });
    });
    upReq.end(body);

    function record({ status, meter, error }) {
      const r = meter ? meter.result() : {};
      const now = Date.now();
      const model = reqJson?.model || null;
      const ttft = meter?.firstByteAt
        ? r.load_ms != null && r.prompt_ms != null && reqJson?.stream === false
          ? Math.round(r.load_ms + r.prompt_ms)
          : meter.firstByteAt - started
        : null;
      const tps = r.eval_ms && r.output_tokens ? r.output_tokens / (r.eval_ms / 1000) : null;
      const ctx = state.contextFor(model) || reqJson?.options?.num_ctx || null;
      const overflow = ctx && r.prompt_tokens ? (r.prompt_tokens >= ctx * 0.95 ? 1 : 0) : 0;
      const stream = reqJson ? (reqJson.stream === false ? 0 : endpoint.startsWith('/v1') ? (reqJson.stream ? 1 : 0) : 1) : null;
      insert.run(
        started,
        client,
        tokenRow?.id ?? null,
        req.socket.remoteAddress || null,
        endpoint,
        model,
        stream,
        status,
        r.prompt_tokens ?? null,
        r.output_tokens ?? null,
        r.approx ?? 0,
        ttft,
        now - started,
        r.load_ms != null ? Math.round(r.load_ms) : null,
        tps != null ? Math.round(tps * 10) / 10 : null,
        ctx,
        overflow,
        error || r.error || null
      );
      state.onRequest?.();
    }
  };
}

function deny(res, msg) {
  res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="corral"' });
  res.end(JSON.stringify({ error: `corral: ${msg}` }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
