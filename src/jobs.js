// Background model downloads with combined progress across layers, speed and ETA.

export function createJobs(ollama) {
  const jobs = new Map();
  let seq = 0;

  function pull(model) {
    for (const j of jobs.values()) if (j.model === model && j.state === 'running') return j;
    const job = {
      id: ++seq,
      model,
      state: 'running',
      status: 'starting',
      total: 0,
      completed: 0,
      percent: 0,
      speed: 0,
      eta: null,
      error: null,
      startedAt: Date.now(),
      endedAt: null,
    };
    const ctrl = new AbortController();
    Object.defineProperty(job, 'ctrl', { value: ctrl, enumerable: false });
    jobs.set(job.id, job);
    run(job, ctrl).catch((e) => fail(job, e));
    return job;
  }

  async function run(job, ctrl) {
    const res = await ollama.call('/api/pull', { method: 'POST', body: { model: job.model, stream: true }, signal: ctrl.signal, timeout: 0 });
    if (!res.ok) throw new Error((await res.text()) || `Ollama ${res.status}`);

    const layers = new Map();
    const samples = [];
    const decoder = new TextDecoder();
    let partial = '';

    for await (const chunk of res.body) {
      const lines = (partial + decoder.decode(chunk, { stream: true })).split('\n');
      partial = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.error) throw new Error(ev.error);
        job.status = ev.status || job.status;
        if (ev.digest && ev.total) layers.set(ev.digest, { total: ev.total, completed: ev.completed || 0 });
        let total = 0;
        let completed = 0;
        for (const l of layers.values()) {
          total += l.total;
          completed += l.completed;
        }
        job.total = total;
        job.completed = completed;
        job.percent = total ? Math.min(100, Math.round((completed / total) * 1000) / 10) : 0;

        const now = Date.now();
        samples.push([now, completed]);
        while (samples.length > 2 && now - samples[0][0] > 5000) samples.shift();
        const [t0, c0] = samples[0];
        job.speed = now > t0 ? Math.max(0, ((completed - c0) / (now - t0)) * 1000) : 0;
        job.eta = job.speed > 0 ? Math.round((total - completed) / job.speed) : null;
        if (ev.status === 'success') {
          job.state = 'done';
          job.percent = 100;
          job.endedAt = Date.now();
        }
      }
    }
    if (job.state === 'running') {
      job.state = 'done';
      job.endedAt = Date.now();
    }
  }

  function fail(job, e) {
    job.state = e.name === 'AbortError' ? 'cancelled' : 'error';
    job.error = job.state === 'error' ? e.message : null;
    job.endedAt = Date.now();
  }

  return {
    pull,
    list: () =>
      [...jobs.values()].filter((j) => j.state === 'running' || Date.now() - j.endedAt < 10 * 60000).sort((a, b) => b.id - a.id),
    cancel(id) {
      const j = jobs.get(Number(id));
      if (j && j.state === 'running') j.ctrl.abort();
      return j || null;
    },
  };
}
