// A fake Ollama for development and tests: `node test/mock-ollama.js [port]`.
import http from 'node:http';
import crypto from 'node:crypto';

const port = Number(process.argv[2] || process.env.MOCK_PORT || 11434);
const digest = (s) => crypto.createHash('sha256').update(s).digest('hex');

const models = new Map(
  [
    ['qwen3.6:27b', '27.8B', 'Q4_K_M', 17.4e9, 'qwen3'],
    ['gemma4:12b', '12B', 'Q4_K_M', 8.1e9, 'gemma4'],
    ['qwen2.5-coder:7b', '7.6B', 'Q4_K_M', 4.7e9, 'qwen2'],
    ['nomic-embed-text:latest', '137M', 'F16', 0.27e9, 'nomic-bert'],
  ].map(([name, p, q, size, family]) => [name, { name, model: name, size, digest: digest(name), modified_at: new Date().toISOString(), details: { format: 'gguf', family, parameter_size: p, quantization_level: q } }])
);
const loaded = new Map();

function load(name, ctx = 8192) {
  const m = models.get(name) || models.get(`${name}:latest`);
  if (!m) return null;
  loaded.set(m.name, { ...m, size_vram: m.size, context_length: ctx, expires_at: new Date(Date.now() + 300000).toISOString() });
  return m;
}

const words = 'The quick brown llama jumps over the lazy alpaca in the green corral today'.split(' ');

http
  .createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const j = body ? JSON.parse(body) : {};
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    switch (url.pathname) {
      case '/':
        return res.end('Ollama is running');
      case '/api/version':
        return send(200, { version: '0.13.2-mock' });
      case '/api/tags':
        return send(200, { models: [...models.values()] });
      case '/api/ps':
        return send(200, { models: [...loaded.values()] });
      case '/api/show':
        return models.has(j.model) ? send(200, { modelfile: '# mock', details: models.get(j.model).details, capabilities: ['completion', 'tools'] }) : send(404, { error: 'model not found' });
      case '/api/delete':
        models.delete(j.model);
        loaded.delete(j.model);
        return send(200, {});
      case '/api/copy':
        models.set(j.destination, { ...models.get(j.source), name: j.destination, model: j.destination });
        return send(200, {});
      case '/api/create':
        models.set(j.model, { ...models.get(j.from), name: j.model, model: j.model, digest: digest(j.model) });
        return send(200, { status: 'success' });
      case '/api/pull': {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const total = 400e6;
        res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
        for (let done = 0; done <= total; done += 40e6) {
          res.write(JSON.stringify({ status: 'pulling abc123', digest: 'sha256:abc123', total, completed: done }) + '\n');
          await sleep(60);
        }
        const name = j.model.includes(':') ? j.model : `${j.model}:latest`;
        models.set(name, { name, model: name, size: total, digest: digest(name + 'v2'), modified_at: new Date().toISOString(), details: { format: 'gguf', family: 'mock', parameter_size: '1B', quantization_level: 'Q4_K_M' } });
        res.write(JSON.stringify({ status: 'success' }) + '\n');
        return res.end();
      }
      case '/api/embed': {
        if (!load(j.model)) return send(404, { error: `model "${j.model}" not found, try pulling it first` });
        return send(200, { model: j.model, embeddings: [[0.1, 0.2]], prompt_eval_count: 12, total_duration: 2e7, load_duration: 1e6 });
      }
      case '/api/generate':
      case '/api/chat': {
        if (j.keep_alive === 0 && !j.prompt && !j.messages) {
          loaded.delete(j.model);
          return send(200, { model: j.model, done: true, done_reason: 'unload' });
        }
        const ctx = j.options?.num_ctx || 8192;
        if (!load(j.model, ctx)) return send(404, { error: `model "${j.model}" not found, try pulling it first` });
        const text = JSON.stringify(j.messages || j.prompt || '');
        const promptTokens = Math.min(ctx, Math.ceil(text.length / 4));
        const n = 10;
        const final = { model: j.model, done: true, done_reason: 'stop', total_duration: 9e8, load_duration: 1e8, prompt_eval_count: promptTokens, prompt_eval_duration: 5e7, eval_count: n, eval_duration: 4e8 };
        const piece = (i) => (url.pathname === '/api/chat' ? { message: { role: 'assistant', content: words[i] + ' ' } } : { response: words[i] + ' ' });
        if (j.stream === false) return send(200, { ...piece(0), ...final, ...(url.pathname === '/api/chat' ? { message: { role: 'assistant', content: words.slice(0, n).join(' ') } } : { response: words.slice(0, n).join(' ') }) });
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        for (let i = 0; i < n; i++) {
          res.write(JSON.stringify({ model: j.model, done: false, ...piece(i) }) + '\n');
          await sleep(15);
        }
        res.write(JSON.stringify({ ...piece(0), ...final, message: undefined, response: undefined }) + '\n');
        return res.end();
      }
      case '/v1/chat/completions': {
        if (!load(j.model)) return send(404, { error: { message: 'model not found' } });
        const n = 8;
        if (!j.stream) return send(200, { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: words.slice(0, n).join(' ') } }], usage: { prompt_tokens: 42, completion_tokens: n, total_tokens: 42 + n } });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (let i = 0; i < n; i++) {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: words[i] + ' ' } }] })}\n\n`);
          await sleep(15);
        }
        if (j.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 42, completion_tokens: n } })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      default:
        return send(404, { error: 'not found' });
    }
  })
  .listen(port, '127.0.0.1', () => console.log(`mock ollama on :${port}`));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
