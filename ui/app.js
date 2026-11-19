// corral dashboard: plain JS, no build step.
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const S = {
  admin: null,
  machine: localStorage.getItem('corral.machine') || 'local',
  machines: [],
  tab: location.hash.match(/tab=(\w+)/)?.[1] || 'overview',
  days: 7,
  timer: null,
  confirm: null,
  catalog: { q: '', caps: new Set(), group: '', fit: false },
  reqFilter: { model: '', client: '', overflow: false },
};

// ---------- boot ----------
const fromHash = location.hash.match(/admin=(cra_[a-f0-9]+)/);
if (fromHash) {
  localStorage.setItem('corral.admin', fromHash[1]);
  history.replaceState(null, '', location.pathname);
}
S.admin = localStorage.getItem('corral.admin');

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  S.admin = $('#login-token').value.trim();
  localStorage.setItem('corral.admin', S.admin);
  boot();
});
$('#nav').addEventListener('click', (e) => {
  const tab = e.target.closest('a')?.dataset.tab;
  if (tab) go(tab);
});
$('#machine').addEventListener('change', (e) => {
  S.machine = e.target.value;
  localStorage.setItem('corral.machine', S.machine);
  render();
});

boot();

async function boot() {
  if (!S.admin) return showLogin();
  try {
    await api('/overview', { local: true });
  } catch (e) {
    return showLogin(e.status === 401 ? 'That admin token is not valid for this machine.' : e.message);
  }
  $('#login').hidden = true;
  $('#app').hidden = false;
  await loadMachines();
  go(S.tab);
}

function showLogin(msg = '') {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-err').textContent = msg;
}

function go(tab) {
  S.tab = tab;
  history.replaceState(null, '', `#tab=${tab}`);
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('active', a.dataset.tab === tab);
  render();
}

// ---------- api ----------
async function api(path, { method = 'GET', body, local = false } = {}) {
  const prefix = local || S.machine === 'local' ? '' : `/r/${S.machine}`;
  const res = await fetch(`/corral/api${prefix}${path}`, {
    method,
    headers: { 'x-corral-admin': S.admin, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

async function loadMachines() {
  try {
    S.machines = await api('/machines', { local: true });
  } catch {
    S.machines = [{ id: 'local', name: 'this machine', reachable: true }];
  }
  if (!S.machines.some((m) => String(m.id) === String(S.machine))) S.machine = 'local';
  $('#machine').innerHTML = S.machines
    .map((m) => `<option value="${m.id}" ${String(m.id) === String(S.machine) ? 'selected' : ''}>${esc(m.name)}${m.id === 'local' ? ' (this)' : ''}${m.reachable === false ? ' (offline)' : ''}</option>`)
    .join('');
}

// ---------- render loop ----------
async function render(auto = false) {
  clearTimeout(S.timer);
  const view = VIEWS[S.tab] || VIEWS.overview;
  // Don't yank the page away while someone is typing or has a form open.
  if (!(auto && isEditing())) {
    const active = document.activeElement;
    const focusId = active && $('#main').contains(active) ? active.id : null;
    const caret = focusId ? active.selectionStart : null;
    try {
      const html = await view();
      if (html !== undefined) $('#main').innerHTML = html;
      view.after?.();
      await status();
    } catch (e) {
      $('#main').innerHTML = `<div class="warnbox"><b>Couldn't load this view.</b> ${esc(e.message)}</div>`;
    }
    if (focusId && document.getElementById(focusId)) {
      const el = document.getElementById(focusId);
      el.focus();
      if (caret != null && el.setSelectionRange) el.setSelectionRange(caret, caret);
    }
  }
  if (view.refresh) S.timer = setTimeout(() => render(true), view.refresh);
}

function isEditing() {
  const a = document.activeElement;
  if (a && $('#main').contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.value) return true;
  return Boolean($('#main details[open]') || $('#new-token')?.children.length);
}

async function status() {
  const ov = S.lastOverview;
  if (!ov) return;
  $('#status').innerHTML = ov.online
    ? `<span class="dot on"></span> Ollama ${esc(ov.ollamaVersion || '')} <span class="muted">· ${esc(ov.machine)}</span>`
    : `<span class="dot off"></span> Ollama unreachable <span class="muted">· ${esc(ov.ollamaUrl)}</span>`;
  $('#foot').innerHTML = `corral ${esc(ov.corral)}<br>gateway :${ov.gateway.port}<br>up ${dur(ov.uptimeSec)}`;
}

// ---------- views ----------
const VIEWS = {};

VIEWS.overview = async () => {
  const [ov, u, mem] = await Promise.all([api('/overview'), api(`/usage?days=${S.days}`), api('/memory?hours=6')]);
  S.lastOverview = ov;
  const t = u.totals;
  const maxModel = Math.max(1, ...u.byModel.map((m) => m.output + m.prompt));
  const maxClient = Math.max(1, ...u.byClient.map((m) => m.output + m.prompt));
  const vram = ov.hardware.vramGb ? ov.hardware.vramGb * 1024 ** 3 : null;

  return `
  <div class="head">
    <div><h1>${esc(ov.machine)}</h1><p class="sub">Every request that went through this gateway, from any app.</p></div>
    <div class="seg" id="days">${[1, 7, 30, 90].map((d) => `<button data-d="${d}" class="${d === S.days ? 'on' : ''}">${d === 1 ? 'Today' : d + ' days'}</button>`).join('')}</div>
  </div>

  ${!ov.online ? `<div class="warnbox"><b>Ollama is not reachable</b> at <code>${esc(ov.ollamaUrl)}</code>. ${esc(ov.ollamaError || '')}</div>` : ''}
  ${u.overflowing.length ? `<div class="warnbox"><b>Context overflow.</b> Some prompts filled ≥95% of the context window, so Ollama silently dropped the oldest content:
      ${u.overflowing.map((o) => `<div class="mono" style="margin-top:4px">${esc(o.client)} → ${esc(o.model)}: ${o.n}× (up to ${num(o.maxPrompt)} of ${num(o.ctx)} tokens)</div>`).join('')}
      <div class="note" style="margin-top:6px">Raise <code>num_ctx</code> for that app, or set <code>OLLAMA_CONTEXT_LENGTH</code> on the server.</div></div>` : ''}

  <div class="kpis">
    ${kpi(num(t.requests), 'requests')}
    ${kpi(num(t.prompt), 'tokens in')}
    ${kpi(num(t.output), 'tokens out')}
    ${kpi(t.tps ? t.tps : '–', 'avg tokens/s')}
    ${kpi(t.ttft ? ms(t.ttft) : '–', 'avg time to first token')}
    ${kpi(num(t.errors || 0), 'errors', t.errors > 0)}
  </div>

  <div class="panel">
    <div class="row" style="justify-content:space-between"><h2>Tokens per day</h2>
      <div class="legend"><span><i style="background:var(--hay)"></i>output</span><span><i style="background:var(--hay-soft)"></i>prompt</span></div></div>
    ${dayChart(u.byDay, S.days)}
  </div>

  <div class="grid g2">
    <div class="panel"><h2>By model</h2>${u.byModel.length ? `<div class="scroll"><table>
      <tr><th>Model</th><th class="n">Req</th><th class="n">In</th><th class="n">Out</th><th class="n">tok/s</th></tr>
      ${u.byModel.map((m) => `<tr><td class="bar-cell"><i class="b" style="width:${((m.output + m.prompt) / maxModel) * 100}%"></i><span class="mono">${esc(m.model || '(none)')}</span></td>
        <td class="n">${num(m.requests)}</td><td class="n">${num(m.prompt)}</td><td class="n">${num(m.output)}</td><td class="n">${m.tps ?? '–'}</td></tr>`).join('')}
      </table></div>` : empty('No requests yet. Point an app at the gateway.')}</div>

    <div class="panel"><h2>By app</h2>${u.byClient.length ? `<div class="scroll"><table>
      <tr><th>App / token</th><th class="n">Req</th><th class="n">In</th><th class="n">Out</th><th class="n">Errors</th></tr>
      ${u.byClient.map((m) => `<tr><td class="bar-cell"><i class="b" style="width:${((m.output + m.prompt) / maxClient) * 100}%"></i><span>${esc(m.client)}</span></td>
        <td class="n">${num(m.requests)}</td><td class="n">${num(m.prompt)}</td><td class="n">${num(m.output)}</td><td class="n">${m.errors || 0}</td></tr>`).join('')}
      </table></div>` : empty('No apps yet. Create an app token.')}</div>
  </div>

  <div class="grid g2">
    <div class="panel"><h2>Loaded right now</h2>
      ${ov.loaded.length ? `<table>${ov.loaded.map((m) => `<tr>
        <td><span class="mono">${esc(m.name)}</span><div class="note">ctx ${m.contextLength ? num(m.contextLength) : '?'} · unloads ${until(m.expiresAt)}</div></td>
        <td style="width:40%"><div class="mem"><div class="progress"><i style="width:${vram ? Math.min(100, (m.sizeVram / vram) * 100) : 100}%"></i></div><span class="mono">${gb(m.sizeVram)}</span></div>
          ${m.size > m.sizeVram ? `<div class="note">${gb(m.size - m.sizeVram)} on CPU</div>` : ''}</td>
        <td class="n"><button class="btn small" data-unload="${esc(m.name)}">Unload</button></td></tr>`).join('')}</table>` : empty('No models in memory.')}
    </div>
    <div class="panel"><h2>Memory, last 6 hours</h2>${memChart(mem, vram)}
      <div class="note" style="margin-top:8px">${esc(hwLine(ov.hardware))}</div></div>
  </div>`;
};
VIEWS.overview.refresh = 10000;
VIEWS.overview.after = () => {
  $('#days')?.addEventListener('click', (e) => {
    const d = Number(e.target.dataset.d);
    if (d) {
      S.days = d;
      render();
    }
  });
  bindUnload();
};

VIEWS.requests = async () => {
  const f = S.reqFilter;
  const qs = new URLSearchParams({ limit: 200, ...(f.model && { model: f.model }), ...(f.client && { client: f.client }), ...(f.overflow && { overflow: 1 }) });
  const [rows, ov] = await Promise.all([api(`/requests?${qs}`), api('/overview')]);
  S.lastOverview = ov;
  const prefix = S.machine === 'local' ? '' : `/r/${S.machine}`;
  return `
  <div class="head"><div><h1>Requests</h1><p class="sub">Latest 200, refreshed every 5 seconds. Prompts and replies are never stored.</p></div>
    <a class="btn" id="csv" data-href="/corral/api${prefix}/requests.csv?days=90">Export CSV (90 days)</a></div>
  <div class="panel">
    <div class="row" style="margin-bottom:12px">
      <input id="f-model" placeholder="model" value="${esc(f.model)}" />
      <input id="f-client" placeholder="app" value="${esc(f.client)}" />
      <label class="row note"><input type="checkbox" id="f-ov" ${f.overflow ? 'checked' : ''}/> overflow only</label>
    </div>
    ${rows.length ? `<div class="scroll"><table>
      <tr><th>Time</th><th>App</th><th>Model</th><th>Endpoint</th><th class="n">In</th><th class="n">Out</th><th class="n">tok/s</th><th class="n">TTFT</th><th class="n">Total</th><th>Status</th></tr>
      ${rows.map((r) => `<tr>
        <td class="mono muted">${time(r.ts)}</td><td>${esc(r.client)}</td><td class="mono">${esc(r.model || '')}</td><td class="mono muted">${esc(r.endpoint)}</td>
        <td class="n">${r.prompt_tokens ?? '–'}${r.overflow ? ` <span class="badge rust" title="context ${r.ctx_limit}">full</span>` : ''}</td>
        <td class="n">${r.output_tokens ?? '–'}${r.approx ? '<span class="muted" title="estimated">~</span>' : ''}</td>
        <td class="n">${r.tps ?? '–'}</td><td class="n">${r.ttft_ms != null ? ms(r.ttft_ms) : '–'}</td><td class="n">${ms(r.total_ms)}</td>
        <td>${r.status >= 400 ? `<span class="badge rust" title="${esc(r.error || '')}">${r.status}</span>` : `<span class="badge sage">${r.status}</span>`}</td></tr>`).join('')}
    </table></div>` : empty('Nothing yet.')}
  </div>`;
};
VIEWS.requests.refresh = 5000;
VIEWS.requests.after = () => {
  const deb = debounce(() => render(), 400);
  $('#f-model').addEventListener('input', (e) => ((S.reqFilter.model = e.target.value.trim()), deb()));
  $('#f-client').addEventListener('input', (e) => ((S.reqFilter.client = e.target.value.trim()), deb()));
  $('#f-ov').addEventListener('change', (e) => ((S.reqFilter.overflow = e.target.checked), render()));
  $('#csv').addEventListener('click', () => download($('#csv').dataset.href));
};

VIEWS.models = async () => {
  const [models, jobs, ov] = await Promise.all([api('/models'), api('/jobs'), api('/overview')]);
  S.lastOverview = ov;
  const updates = models.filter((m) => m.update).length;
  const running = jobs.filter((j) => j.state === 'running').length;
  VIEWS.models.refresh = running ? 1000 : 8000;
  return `
  <div class="head"><div><h1>Models</h1><p class="sub">${models.length} installed · ${gb(models.reduce((s, m) => s + (m.size || 0), 0))} on disk${updates ? ` · <b style="color:var(--hay)">${updates} update${updates > 1 ? 's' : ''} available</b>` : ''}</p></div>
    <button class="btn" id="check-upd">Check for updates</button></div>

  <div class="panel">
    <form class="row" id="pull-form">
      <input class="grow" id="pull-name" placeholder="model to install, e.g. qwen3.6:27b  or  hf.co/user/repo:Q4_K_M" autocomplete="off" spellcheck="false" />
      <button class="btn primary">Install</button>
    </form>
    ${jobs.length ? `<table style="margin-top:12px">${jobs.map((j) => `<tr>
      <td class="mono" style="width:30%">${esc(j.model)}</td>
      <td><div class="progress"><i style="width:${j.percent}%"></i></div>
        <div class="note">${j.state === 'running' ? `${esc(j.status)} · ${gb(j.completed)} / ${gb(j.total)} · ${gb(j.speed)}/s · ${j.eta != null ? dur(j.eta) + ' left' : ''}` : j.state === 'error' ? `<span style="color:var(--rust)">${esc(j.error)}</span>` : j.state}</div></td>
      <td class="n">${j.state === 'running' ? `<button class="btn small" data-cancel="${j.id}">Cancel</button>` : `<span class="badge ${j.state === 'done' ? 'sage' : 'rust'}">${j.state}</span>`}</td></tr>`).join('')}</table>` : ''}
  </div>

  <div class="panel">${models.length ? `<div class="scroll"><table>
    <tr><th>Name</th><th>Params</th><th>Quant</th><th class="n">Size</th><th class="n">Req (30d)</th><th>Last used</th><th></th></tr>
    ${models.map((m) => `<tr>
      <td><span class="mono">${esc(m.name)}</span> ${m.loaded ? '<span class="badge sage">loaded</span>' : ''} ${m.update ? `<span class="badge hay" title="The publisher pushed a newer version under this tag">update</span>` : ''} ${m.remote ? '<span class="badge sky">cloud</span>' : ''}</td>
      <td class="mono">${esc(m.params || '')}</td><td class="mono">${esc(m.quant || '')}</td><td class="n">${gb(m.size)}</td>
      <td class="n">${m.requests30d}</td><td class="muted">${m.lastUsed ? ago(m.lastUsed) : 'never'}</td>
      <td class="n"><div class="row end">
        ${m.update ? `<button class="btn small" data-pull="${esc(m.name)}">Update</button><button class="btn small" data-skip="${esc(m.name)}">Skip</button>` : ''}
        ${m.loaded ? `<button class="btn small" data-unload="${esc(m.name)}">Unload</button>` : ''}
        <button class="btn small danger" data-del="${esc(m.name)}">Delete</button></div></td></tr>`).join('')}
  </table></div>` : empty('No models installed. Install one above or browse the Catalog.')}</div>

  <div class="panel"><details><summary>Model Factory: make a custom copy with your own system prompt</summary>
    <form id="factory" class="grid" style="margin-top:12px">
      <div class="row"><label class="f grow">New name<input name="model" placeholder="php-reviewer" required /></label>
        <label class="f grow">Based on<select name="from">${models.map((m) => `<option>${esc(m.name)}</option>`).join('')}</select></label>
        <label class="f">Temperature<input name="temperature" type="number" step="0.1" min="0" max="2" placeholder="0.7" style="width:100px" /></label>
        <label class="f">Context (num_ctx)<input name="num_ctx" type="number" step="1024" placeholder="8192" style="width:120px" /></label></div>
      <label class="f">System prompt<textarea name="system" placeholder="You are a strict senior PHP reviewer…"></textarea></label>
      <div class="row end"><button class="btn primary">Create model</button></div>
    </form></details></div>`;
};
VIEWS.models.after = () => {
  $('#pull-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#pull-name').value.trim();
    if (!name) return;
    await act(() => api('/models/pull', { method: 'POST', body: { model: name } }), `Installing ${name}…`);
  });
  $('#check-upd').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Checking…';
    const res = await act(() => api('/updates/check', { method: 'POST' }));
    if (res) {
      const n = Object.values(res).filter((u) => u.status === 'update').length;
      toast(n ? `${n} model(s) have a newer version.` : 'All models are up to date.');
    }
  });
  $('#factory').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const parameters = {};
    if (f.get('temperature')) parameters.temperature = Number(f.get('temperature'));
    if (f.get('num_ctx')) parameters.num_ctx = Number(f.get('num_ctx'));
    await act(() => api('/models/create', { method: 'POST', body: { model: f.get('model'), from: f.get('from'), system: f.get('system'), parameters } }), `Created ${f.get('model')}`);
  });
  onClick('[data-pull]', (b) => act(() => api('/models/pull', { method: 'POST', body: { model: b.dataset.pull } }), 'Updating…'));
  onClick('[data-skip]', (b) => act(() => api('/updates/skip', { method: 'POST', body: { model: b.dataset.skip } }), 'Skipped this version'));
  onClick('[data-cancel]', (b) => act(() => api(`/jobs/${b.dataset.cancel}/cancel`, { method: 'POST' })));
  confirmClick('[data-del]', (b) => act(() => api('/models/delete', { method: 'POST', body: { model: b.dataset.del } }), `Deleted ${b.dataset.del}`));
  bindUnload();
};

VIEWS.catalog = async () => {
  const cat = (S.catalogData = await api('/catalog'));
  S.lastOverview = S.lastOverview || (await api('/overview'));
  const groups = [...new Set(cat.models.map((m) => m.group))].sort();
  return `
  <div class="head"><div><h1>Catalog</h1><p class="sub">${cat.models.length} curated models from the Ollama library (snapshot ${esc(cat.snapshot)}). Size colors are for <b>${esc(machineName())}</b>.</p></div>
    <div class="legend"><span><i style="background:var(--sage)"></i>fits in GPU</span><span><i style="background:var(--hay)"></i>spills to RAM</span><span><i style="background:var(--sky)"></i>CPU only</span><span><i style="background:var(--muted)"></i>too big</span></div></div>
  <div class="panel" style="margin-bottom:16px"><div class="row">
    <input class="grow" id="c-q" placeholder="search models…" value="${esc(S.catalog.q)}" />
    <select id="c-group"><option value="">all kinds</option>${groups.map((g) => `<option ${g === S.catalog.group ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>
    ${Object.entries(cat.legend).filter(([k]) => k !== 'C').map(([k, v]) => `<button class="chip ${S.catalog.caps.has(k) ? 'on' : ''}" data-cap="${k}">${esc(v)}</button>`).join('')}
    <button class="chip ${S.catalog.fit ? 'on' : ''}" id="c-fit">fits this machine</button>
  </div></div>
  <div class="cat" id="cat-list"></div>`;
};
VIEWS.catalog.after = () => {
  const draw = () => {
    const c = S.catalog;
    const q = c.q.toLowerCase();
    const list = S.catalogData.models.filter(
      (m) =>
        (!q || m.id.includes(q) || m.desc.toLowerCase().includes(q)) &&
        (!c.group || m.group === c.group) &&
        [...c.caps].every((k) => m.caps.includes(k)) &&
        (!c.fit || m.sizes.some((s) => s.fit === 'fits'))
    );
    $('#cat-list').innerHTML = list.length
      ? list.map(card).join('')
      : empty('No models match.');
  };
  const card = (m) => `<div class="card">
    <div class="t"><span class="name">${esc(m.id)}</span>${m.installed ? '<span class="badge sage">installed</span>' : ''}</div>
    <div class="muted">${esc(m.desc)}</div>
    <div class="caps">${m.caps.map((k) => `<span class="badge ${k === 'C' ? 'sky' : ''}">${esc(S.catalogData.legend[k] || k)}</span>`).join('')}
      <span class="badge">${esc(m.group)}</span></div>
    <div class="note">${esc(m.pulls)} pulls · updated ${esc(m.updated)} ago</div>
    <div class="sizes">${
      m.cloudOnly
        ? `<button class="size cpu" data-install="${esc(m.id)}:cloud" title="Runs on Ollama's cloud, needs an Ollama account">cloud</button>`
        : m.sizes.length
          ? m.sizes.map((s) => `<button class="size ${s.fit} ${s.installed ? 'installed' : ''}" data-install="${esc(m.id)}:${esc(s.tag)}" title="${s.gb ? '≈' + s.gb + ' GB at Q4_K_M · ' : ''}${fitText(s.fit)}${s.installed ? ' · installed' : ''}">${esc(s.tag)}${s.gb ? ` <span class="muted">${s.gb}G</span>` : ''}</button>`).join('')
          : `<button class="size" data-install="${esc(m.id)}">latest</button>`
    }</div></div>`;

  draw();
  $('#c-q').addEventListener('input', debounce((e) => ((S.catalog.q = e.target.value.trim()), draw()), 150));
  $('#c-group').addEventListener('change', (e) => ((S.catalog.group = e.target.value), draw()));
  onClick('[data-cap]', (b) => {
    const k = b.dataset.cap;
    S.catalog.caps.has(k) ? S.catalog.caps.delete(k) : S.catalog.caps.add(k);
    b.classList.toggle('on');
    draw();
  });
  $('#c-fit').addEventListener('click', (e) => ((S.catalog.fit = !S.catalog.fit), e.target.classList.toggle('on'), draw()));
  $('#cat-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-install]');
    if (!b) return;
    const name = b.dataset.install;
    if (b.classList.contains('too-big') && !confirmTwice(b)) return toast('That size probably won’t fit. Click again to install anyway.');
    await api('/models/pull', { method: 'POST', body: { model: name } }).then(
      () => toast(`Installing ${name}. Follow it on the Models tab.`),
      (err) => toast(err.message, true)
    );
  });
};

VIEWS.tokens = async () => {
  const [tokens, ov] = await Promise.all([api('/tokens'), api('/overview')]);
  S.lastOverview = ov;
  const host = S.machine === 'local' ? location.hostname : new URL(S.machines.find((m) => String(m.id) === String(S.machine))?.url || location.origin).hostname;
  const base = `http://${host}:${ov.gateway.port}`;
  S.gatewayBase = base;
  return `
  <div class="head"><div><h1>App tokens</h1><p class="sub">One token per app, so usage is counted per app and you can revoke one without touching the others.</p></div></div>
  ${ov.gateway.host === '127.0.0.1' && S.machine === 'local' ? `<div class="warnbox"><b>Only this machine can reach the gateway.</b> Start with <code>corral --host 0.0.0.0</code> to let other machines connect.</div>` : ''}
  <div class="panel">
    <form class="row" id="tok-form"><input class="grow" name="name" placeholder="app name, e.g. open-webui, cursor, n8n" required maxlength="60" /><button class="btn primary">Create token</button></form>
    <div id="new-token"></div>
  </div>
  <div class="panel">${tokens.length ? `<table>
    <tr><th>App</th><th>Token</th><th>Created</th><th>Last used</th><th class="n">Requests</th><th></th></tr>
    ${tokens.map((t) => `<tr><td><b>${esc(t.name)}</b></td><td class="mono muted">${esc(t.prefix)}…</td><td class="muted">${ago(t.created_at)}</td>
      <td class="muted">${t.last_used_at ? ago(t.last_used_at) : 'never'}</td><td class="n">${num(t.requests)}</td>
      <td class="n"><button class="btn small danger" data-revoke="${t.id}">Revoke</button></td></tr>`).join('')}
  </table>` : empty('No tokens yet.')}</div>
  <div class="panel"><h2>Connecting apps</h2>
    <p class="note">Use the gateway instead of <code>:11434</code>. Requests from this machine work without a token${ov.gateway.localOpen ? '' : ' (disabled with --require-token)'}; everything else needs one.</p>
    ${snippets(base, 'crl_YOUR_TOKEN')}
  </div>`;
};
VIEWS.tokens.after = () => {
  $('#tok-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get('name');
    try {
      const t = await api('/tokens', { method: 'POST', body: { name } });
      await render();
      $('#new-token').innerHTML = `<div style="margin-top:14px"><div class="note">Token for <b>${esc(t.name)}</b>. Copy it now; it won't be shown again.</div>
        <div class="row" style="margin-top:6px"><div class="secret grow" id="tok-val">${esc(t.token)}</div><button class="btn" id="tok-copy">Copy</button></div>
        ${snippets(S.gatewayBase, t.token)}</div>`;
      $('#tok-copy').addEventListener('click', () => copy(t.token));
    } catch (err) {
      toast(err.message, true);
    }
  });
  confirmClick('[data-revoke]', (b) => act(() => api(`/tokens/${b.dataset.revoke}`, { method: 'DELETE' }), 'Token revoked'));
};

VIEWS.machines = async () => {
  await loadMachines();
  const remotes = await api('/remotes', { local: true });
  S.lastOverview = S.lastOverview || (await api('/overview', { local: true }));
  return `
  <div class="head"><div><h1>Machines</h1><p class="sub">Every Ollama machine running corral, in one place. Click one to manage it.</p></div></div>
  <div class="grid g3">${S.machines.map((m) => `<div class="mcard ${String(m.id) === String(S.machine) ? 'sel' : ''}" data-pick="${m.id}">
    <div class="t"><b>${esc(m.name)}</b>${m.reachable === false ? '<span class="badge rust">unreachable</span>' : m.online ? `<span class="badge sage">Ollama ${esc(m.ollamaVersion || '')}</span>` : '<span class="badge rust">Ollama down</span>'}</div>
    ${m.reachable === false ? `<div class="note">${esc(m.error || '')}</div>` : `<dl class="kv">
      <dt>GPU</dt><dd>${esc(m.hardware?.gpus?.map((g) => g.name).join(', ') || 'none')}</dd>
      <dt>Memory</dt><dd>${m.hardware?.vramGb ? m.hardware.vramGb + ' GB GPU · ' : ''}${m.hardware?.ramGb} GB RAM</dd>
      <dt>Loaded</dt><dd>${m.loaded?.length ? m.loaded.map((l) => esc(l.name)).join(', ') : '–'}</dd>
      <dt>Today</dt><dd>${num(m.today?.requests || 0)} req · ${num(m.today?.output || 0)} tokens out</dd>
      ${m.latencyMs != null ? `<dt>Latency</dt><dd>${m.latencyMs} ms</dd>` : ''}</dl>`}
    ${m.id !== 'local' ? `<div class="row end" style="margin-top:10px"><button class="btn small danger" data-rm="${m.id}">Remove</button></div>` : ''}
  </div>`).join('')}</div>

  <div class="panel"><h2>Add a machine</h2>
    <p class="note">On the other machine run <code>npx llama-corral --host 0.0.0.0</code>, then <code>npx llama-corral admin</code> to get its admin token.</p>
    <form class="row" id="add-m">
      <input class="grow" name="url" placeholder="http://192.168.1.20:11435" required />
      <input class="grow" name="adminToken" placeholder="cra_… admin token of that machine" required />
      <input name="name" placeholder="name (optional)" />
      <button class="btn primary">Add machine</button>
    </form>
    ${remotes.length ? '' : '<p class="note">Tip: Tailscale or a VPN is the easiest way to reach machines outside your network.</p>'}
  </div>`;
};
VIEWS.machines.after = () => {
  onClick('[data-pick]', (el, e) => {
    if (e.target.closest('[data-rm]')) return;
    S.machine = el.dataset.pick;
    localStorage.setItem('corral.machine', S.machine);
    $('#machine').value = S.machine;
    go('overview');
  });
  confirmClick('[data-rm]', (b) => act(() => api(`/remotes/${b.dataset.rm}`, { method: 'DELETE', local: true }), 'Machine removed'));
  $('#add-m').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    await act(() => api('/remotes', { method: 'POST', body: f, local: true }), 'Machine added');
  });
};

// ---------- pieces ----------
function snippets(base, token) {
  return `
  <details open><summary>Open WebUI</summary><pre class="snip">Settings → Connections → Ollama API
URL:  ${esc(base)}
Key:  ${esc(token)}</pre></details>
  <details><summary>Cursor, Continue, n8n, any OpenAI-compatible tool</summary><pre class="snip">Base URL:  ${esc(base)}/v1
API key:   ${esc(token)}</pre></details>
  <details><summary>curl</summary><pre class="snip">curl ${esc(base)}/api/chat \\
  -H "Authorization: Bearer ${esc(token)}" \\
  -d '{"model":"qwen3.6:27b","messages":[{"role":"user","content":"hi"}]}'</pre></details>
  <details><summary>Apps that can't send headers</summary><pre class="snip">${esc(base)}/t/${esc(token)}</pre></details>`;
}

function dayChart(rows, days) {
  const map = Object.fromEntries(rows.map((r) => [r.day, r]));
  const list = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    list.push({ key, ...(map[key] || { prompt: 0, output: 0, requests: 0 }) });
  }
  const W = 1000, H = 180, pad = 26;
  const max = Math.max(1, ...list.map((d) => d.prompt + d.output));
  const bw = (W - pad) / list.length;
  const y = (v) => H - 20 - (v / max) * (H - 36);
  const every = Math.ceil(list.length / 10);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${[0.5, 1].map((f) => `<line class="grid-l" x1="${pad}" x2="${W}" y1="${y(max * f)}" y2="${y(max * f)}"/><text x="0" y="${y(max * f) + 4}">${num(max * f)}</text>`).join('')}
    ${list.map((d, i) => {
      const x = pad + i * bw + bw * 0.15, w = bw * 0.7;
      return `<g><title>${d.key}: ${num(d.requests)} req · ${num(d.prompt)} in · ${num(d.output)} out</title>
        <rect class="bar-in" x="${x}" width="${w}" y="${y(d.prompt + d.output)}" height="${Math.max(0, y(d.output) - y(d.prompt + d.output))}" rx="2"/>
        <rect class="bar-out" x="${x}" width="${w}" y="${y(d.output)}" height="${H - 20 - y(d.output)}" rx="2"/>
        ${i % every === 0 ? `<text x="${x}" y="${H - 4}">${d.key.slice(5)}</text>` : ''}</g>`;
    }).join('')}
  </svg>`;
}

function memChart(samples, vram) {
  if (!samples.length) return empty('No samples yet. A sample is taken every 10s while a model is loaded.');
  const W = 1000, H = 140;
  const t0 = Date.now() - 6 * 3600000;
  const max = Math.max(vram || 0, ...samples.map((s) => s.total || 0), 1);
  const x = (ts) => ((ts - t0) / (6 * 3600000)) * W;
  const y = (v) => H - 16 - (v / max) * (H - 28);
  const pts = samples.map((s) => `${x(s.ts).toFixed(1)},${y(s.vram || 0).toFixed(1)}`);
  const path = `M${x(samples[0].ts)},${H - 16} L${pts.join(' L')} L${x(samples.at(-1).ts)},${H - 16} Z`;
  return `<svg class="chart" style="height:140px" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${vram ? `<line class="grid-l" x1="0" x2="${W}" y1="${y(vram)}" y2="${y(vram)}"/><text x="4" y="${y(vram) - 4}">GPU ${gb(vram)}</text>` : ''}
    <path class="area" d="${path}"/>
    <text x="0" y="${H - 2}">-6h</text><text x="${W - 30}" y="${H - 2}">now</text>
  </svg>`;
}

const kpi = (v, l, warn) => `<div class="kpi ${warn ? 'warn' : ''}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
const empty = (t) => `<div class="empty">${t}</div>`;
const fitText = (f) => ({ fits: 'fits in GPU memory', offload: 'partly offloaded to RAM (slower)', cpu: 'runs on CPU', 'too-big': 'probably too big', unknown: 'size unknown' })[f] || f;
const machineName = () => S.machines.find((m) => String(m.id) === String(S.machine))?.name || 'this machine';
const hwLine = (h) => `${h.gpus?.length ? h.gpus.map((g) => `${g.name} ${g.vramGb} GB`).join(' + ') : 'No GPU detected'} · ${h.ramGb} GB RAM · ${h.cpu} (${h.cores} cores) · ${h.platform}/${h.arch}`;

function num(n) {
  n = Number(n || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  return Math.round(n).toLocaleString();
}
function gb(bytes) {
  bytes = Number(bytes || 0);
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB';
  if (bytes >= 1024 ** 2) return Math.round(bytes / 1024 ** 2) + ' MB';
  return Math.round(bytes / 1024) + ' KB';
}
const ms = (v) => (v == null ? '–' : v >= 1000 ? (v / 1000).toFixed(1) + 's' : Math.round(v) + 'ms');
function dur(s) {
  s = Math.max(0, Math.round(s));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
}
const ago = (ts) => dur((Date.now() - ts) / 1000) + ' ago';
function until(iso) {
  const t = Date.parse(iso);
  if (!t) return '?';
  const s = (t - Date.now()) / 1000;
  return s > 1e8 ? 'never' : s <= 0 ? 'now' : 'in ' + dur(s);
}
const time = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

function onClick(sel, fn) {
  for (const el of document.querySelectorAll(sel)) el.addEventListener('click', (e) => fn(el, e));
}
// Destructive buttons need a second click instead of a blocking browser dialog.
function confirmClick(sel, fn) {
  onClick(sel, (b, e) => {
    e.stopPropagation();
    if (confirmTwice(b)) fn(b);
  });
}
function confirmTwice(b) {
  if (b.classList.contains('confirm')) return true;
  b.dataset.label = b.textContent;
  b.classList.add('confirm');
  b.textContent = 'Sure?';
  setTimeout(() => {
    b.classList.remove('confirm');
    if (b.dataset.label) b.textContent = b.dataset.label;
  }, 3000);
  return false;
}
function bindUnload() {
  onClick('[data-unload]', (b) => act(() => api('/models/unload', { method: 'POST', body: { model: b.dataset.unload } }), `Unloaded ${b.dataset.unload}`));
}
async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    await render();
    return r;
  } catch (e) {
    toast(e.message, true);
    await render();
    return null;
  }
}
let toastT;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 3500);
}
function copy(text) {
  navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Select the text and copy it manually', true));
}
async function download(href) {
  const res = await fetch(href, { headers: { 'x-corral-admin': S.admin } });
  if (!res.ok) return toast('Export failed', true);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: 'corral-requests.csv' });
  a.click();
  URL.revokeObjectURL(url);
}
function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
