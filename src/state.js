// Live state of the local Ollama: loaded models (from /api/ps), version, reachability.
// Samples are stored so the dashboard can draw a memory timeline.

export function createState({ cfg, db, ollama }) {
  const insert = db.prepare('INSERT INTO ps_samples (ts, model, size, size_vram, context_length) VALUES (?, ?, ?, ?, ?)');
  const state = {
    online: false,
    version: null,
    loaded: [],
    lastPoll: null,
    lastError: null,
    contextFor(model) {
      if (!model) return null;
      const m = state.loaded.find((x) => x.name === model || x.model === model || x.name === `${model}:latest`);
      return m?.context_length || null;
    },
    async refresh() {
      try {
        const [ps, ver] = await Promise.all([ollama.ps(), state.version ? null : ollama.version()]);
        if (ver) state.version = ver.version;
        state.loaded = ps.models || [];
        state.online = true;
        state.lastError = null;
      } catch (e) {
        state.online = false;
        state.version = null;
        state.lastError = e.message;
        state.loaded = [];
      }
      state.lastPoll = Date.now();
      return state;
    },
  };

  async function tick() {
    await state.refresh();
    const ts = Date.now();
    for (const m of state.loaded) insert.run(ts, m.name, m.size ?? null, m.size_vram ?? null, m.context_length ?? null);
  }

  // A request just finished; refresh soon so its model shows up as loaded.
  let soon = null;
  state.onRequest = () => {
    if (soon) return;
    soon = setTimeout(() => {
      soon = null;
      state.refresh();
    }, 300);
  };

  tick();
  const timer = setInterval(tick, cfg.pollMs);
  timer.unref();

  // Daily cleanup of old rows.
  const cleanup = () => {
    const cutoff = Date.now() - cfg.retentionDays * 86400000;
    db.prepare('DELETE FROM requests WHERE ts < ?').run(cutoff);
    db.prepare('DELETE FROM ps_samples WHERE ts < ?').run(Date.now() - 14 * 86400000);
  };
  cleanup();
  setInterval(cleanup, 86400000).unref();

  return state;
}
