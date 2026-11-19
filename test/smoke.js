// End-to-end smoke test: mock Ollama + two corral instances (hub + remote machine).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'corral-test-'));
const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnNode(args, label) {
  const p = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.label = label;
  p.out = () => out;
  procs.push(p);
  return p;
}
async function waitFor(url, headers = {}) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(url, { headers });
      if (r.status < 500) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${url}`);
}
const cfgOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));

let pass = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ✗ ${name}\n    ${e.stack}`);
    process.exitCode = 1;
  }
}

try {
  spawnNode(['test/mock-ollama.js', '21434'], 'mock');
  await waitFor('http://127.0.0.1:21434/');

  const hubDir = path.join(tmp, 'hub');
  const remDir = path.join(tmp, 'remote');
  spawnNode(['bin/corral.js', 'start', '--port', '21435', '--ollama', 'http://127.0.0.1:21434', '--data', hubDir, '--name', 'hub-mac'], 'hub');
  spawnNode(['bin/corral.js', 'start', '--port', '21436', '--ollama', 'http://127.0.0.1:21434', '--data', remDir, '--name', 'office-linux', '--require-token'], 'remote');
  await waitFor('http://127.0.0.1:21435/');
  await waitFor('http://127.0.0.1:21436/');

  const HUB = 'http://127.0.0.1:21435';
  const REM = 'http://127.0.0.1:21436';
  const hubAdmin = { 'x-corral-admin': cfgOf(hubDir).adminToken, 'content-type': 'application/json' };
  const remAdmin = { 'x-corral-admin': cfgOf(remDir).adminToken, 'content-type': 'application/json' };
  const api = async (base, hdr, p, method = 'GET', body) => {
    const r = await fetch(`${base}/corral/api${p}`, { method, headers: hdr, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    return { status: r.status, data: r.headers.get('content-type')?.includes('json') ? JSON.parse(t) : t };
  };
  const post = (base, p, body, headers = {}) =>
    fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  console.log('\ngateway');
  await test('health check passes through without a token', async () => {
    const r = await fetch(`${REM}/`);
    assert.equal(await r.text(), 'Ollama is running');
  });
  await test('local streaming chat works without token and is metered', async () => {
    const r = await post(HUB, '/api/chat', { model: 'qwen3.6:27b', messages: [{ role: 'user', content: 'hi' }] });
    const text = await r.text();
    assert.equal(text.trim().split('\n').length, 11);
  });
  await test('non-streaming generate', async () => {
    const r = await post(HUB, '/api/generate', { model: 'gemma4:12b', prompt: 'hello', stream: false });
    assert.equal((await r.json()).eval_count, 10);
  });
  await test('embeddings', async () => {
    const r = await post(HUB, '/api/embed', { model: 'nomic-embed-text:latest', input: 'x' });
    assert.ok((await r.json()).embeddings);
  });
  await test('OpenAI SSE without usage → approximate tokens', async () => {
    const r = await post(HUB, '/v1/chat/completions', { model: 'qwen2.5-coder:7b', stream: true, messages: [{ role: 'user', content: 'x' }] });
    assert.match(await r.text(), /\[DONE\]/);
  });
  await test('OpenAI non-stream usage', async () => {
    const r = await post(HUB, '/v1/chat/completions', { model: 'qwen2.5-coder:7b', messages: [{ role: 'user', content: 'x' }] });
    assert.equal((await r.json()).usage.completion_tokens, 8);
  });
  await test('context overflow is flagged', async () => {
    const r = await post(HUB, '/api/chat', { model: 'qwen3.6:27b', stream: false, options: { num_ctx: 256 }, messages: [{ role: 'user', content: 'x'.repeat(5000) }] });
    await r.json();
  });
  await test('unknown model error is logged', async () => {
    const r = await post(HUB, '/api/chat', { model: 'nope:1b', messages: [] });
    assert.equal(r.status, 404);
  });

  let token;
  await test('remote with --require-token rejects missing and bad tokens', async () => {
    assert.equal((await post(REM, '/api/chat', { model: 'x' })).status, 401);
    assert.equal((await post(REM, '/api/chat', { model: 'x' }, { authorization: 'Bearer crl_bad' })).status, 401);
  });
  await test('create token via API, then Bearer / x-api-key / /t/ prefix all work', async () => {
    const { data } = await api(REM, remAdmin, '/tokens', 'POST', { name: 'cursor' });
    token = data.token;
    assert.match(token, /^crl_/);
    for (const [p, h] of [
      ['/api/chat', { authorization: `Bearer ${token}` }],
      ['/api/chat', { 'x-api-key': token }],
      [`/t/${token}/api/chat`, {}],
    ]) {
      const r = await post(REM, p, { model: 'qwen3.6:27b', stream: false, messages: [{ role: 'user', content: 'hi' }] }, h);
      assert.equal(r.status, 200, p);
      await r.json();
    }
  });
  await test('revoked token stops working', async () => {
    const { data } = await api(REM, remAdmin, '/tokens', 'POST', { name: 'temp' });
    await api(REM, remAdmin, `/tokens/${data.id}`, 'DELETE');
    assert.equal((await post(REM, '/api/chat', { model: 'x' }, { authorization: `Bearer ${data.token}` })).status, 401);
  });

  await sleep(400);
  console.log('\nadmin api');
  await test('admin api requires admin token', async () => {
    assert.equal((await api(HUB, {}, '/overview')).status, 401);
  });
  await test('overview shows today totals + loaded models', async () => {
    const { data } = await api(HUB, hubAdmin, '/overview');
    assert.equal(data.machine, 'hub-mac');
    assert.ok(data.online);
    assert.ok(data.today.requests >= 7, JSON.stringify(data.today));
    assert.ok(data.loaded.length >= 1);
  });
  await test('requests log has correct numbers', async () => {
    const { data } = await api(HUB, hubAdmin, '/requests?limit=50');
    const chat = data.find((r) => r.endpoint === '/api/chat' && r.model === 'qwen3.6:27b' && !r.overflow);
    assert.equal(chat.output_tokens, 10);
    assert.equal(chat.tps, 25);
    assert.equal(chat.client, 'local');
    const sse = data.find((r) => r.endpoint === '/v1/chat/completions' && r.approx === 1);
    assert.equal(sse.output_tokens, 8);
    const ov = data.find((r) => r.overflow === 1);
    assert.ok(ov, 'overflow row');
    assert.equal(ov.ctx_limit, 256);
    const err = data.find((r) => r.model === 'nope:1b');
    assert.equal(err.status, 404);
    assert.match(err.error, /not found/);
  });
  await test('usage aggregates by model and client', async () => {
    const { data } = await api(HUB, hubAdmin, '/usage?days=7');
    assert.ok(data.byModel.length >= 3);
    assert.equal(data.byClient[0].client, 'local');
    assert.equal(data.overflowing.length, 1);
  });
  await test('remote usage attributed to the token name', async () => {
    const { data } = await api(REM, remAdmin, '/usage');
    assert.equal(data.byClient.find((c) => c.client === 'cursor').requests, 3);
  });
  await test('csv export', async () => {
    const { data } = await api(HUB, hubAdmin, '/requests.csv');
    assert.match(data, /^id,ts,client/);
  });

  console.log('\nmodels');
  await test('list models with usage counts', async () => {
    const { data } = await api(HUB, hubAdmin, '/models');
    assert.ok(data.find((m) => m.name === 'qwen3.6:27b').requests30d >= 2);
  });
  await test('pull job reports progress and completes', async () => {
    const { data: job } = await api(HUB, hubAdmin, '/models/pull', 'POST', { model: 'smollm2:135m' });
    let j;
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      j = (await api(HUB, hubAdmin, '/jobs')).data.find((x) => x.id === job.id);
      if (j.state !== 'running') break;
    }
    assert.equal(j.state, 'done');
    assert.equal(j.percent, 100);
    assert.ok((await api(HUB, hubAdmin, '/models')).data.find((m) => m.name === 'smollm2:135m'));
  });
  await test('model factory create + delete + unload', async () => {
    assert.equal((await api(HUB, hubAdmin, '/models/create', 'POST', { model: 'reviewer', from: 'qwen2.5-coder:7b', system: 'You review PHP.' })).status, 200);
    assert.equal((await api(HUB, hubAdmin, '/models/delete', 'POST', { model: 'reviewer' })).status, 200);
    assert.equal((await api(HUB, hubAdmin, '/models/unload', 'POST', { model: 'gemma4:12b' })).status, 200);
  });
  await test('catalog with hardware fit', async () => {
    const { data } = await api(HUB, hubAdmin, '/catalog');
    assert.ok(data.models.length > 80);
    const q = data.models.find((m) => m.id === 'qwen3.6');
    assert.ok(q.installed);
    assert.ok(['fits', 'offload', 'cpu', 'too-big'].includes(q.sizes[0].fit));
  });

  console.log('\nhub');
  let remoteId;
  await test('add remote machine (validates admin token)', async () => {
    assert.equal((await api(HUB, hubAdmin, '/remotes', 'POST', { url: REM, adminToken: 'cra_wrong' })).status, 400);
    const { data } = await api(HUB, hubAdmin, '/remotes', 'POST', { url: REM, adminToken: cfgOf(remDir).adminToken });
    remoteId = data.id;
    assert.equal(data.name, 'office-linux');
  });
  await test('machines view aggregates local + remote', async () => {
    const { data } = await api(HUB, hubAdmin, '/machines');
    assert.equal(data.length, 2);
    assert.ok(data[1].reachable && data[1].latencyMs >= 0);
  });
  await test('calls route to the remote machine via /r/<id>/', async () => {
    const { data } = await api(HUB, hubAdmin, `/r/${remoteId}/usage?days=1`);
    assert.ok(data.byClient.find((c) => c.client === 'cursor'));
  });

  console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  if (process.exitCode) for (const p of procs) console.log(`--- ${p.label} output ---\n${p.out()}`);
  for (const p of procs) p.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
