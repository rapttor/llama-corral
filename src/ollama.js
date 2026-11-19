// Small client for the upstream Ollama API, used by the admin side (not by the proxy).

export function ollamaClient(baseUrl) {
  const base = new URL(baseUrl);
  const auth = base.username
    ? 'Basic ' + Buffer.from(`${decodeURIComponent(base.username)}:${decodeURIComponent(base.password)}`).toString('base64')
    : null;
  base.username = '';
  base.password = '';
  const root = base.toString().replace(/\/+$/, '');

  async function call(path, { method = 'GET', body, signal, timeout = 15000 } = {}) {
    const ctrl = new AbortController();
    const timer = timeout ? setTimeout(() => ctrl.abort(), timeout) : null;
    signal?.addEventListener('abort', () => ctrl.abort());
    try {
      const res = await fetch(root + path, {
        method,
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return res;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function json(path, opts) {
    const res = await call(path, opts);
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) throw new Error(data.error || `Ollama ${res.status}`);
    return data;
  }

  return {
    root,
    call,
    version: () => json('/api/version', { timeout: 4000 }),
    tags: () => json('/api/tags'),
    ps: () => json('/api/ps', { timeout: 4000 }),
    show: (model) => json('/api/show', { method: 'POST', body: { model } }),
    remove: (model) => json('/api/delete', { method: 'DELETE', body: { model } }),
    copy: (source, destination) => json('/api/copy', { method: 'POST', body: { source, destination } }),
    create: (body) => json('/api/create', { method: 'POST', body: { ...body, stream: false }, timeout: 0 }),
    unload: (model) => json('/api/generate', { method: 'POST', body: { model, keep_alive: 0 } }),
  };
}
