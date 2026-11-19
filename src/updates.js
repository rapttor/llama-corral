import crypto from 'node:crypto';
import { kvGet, kvSet } from './db.js';

// Ollama doesn't tell you when a publisher re-pushes a model under the same name:tag.
// We compare the local manifest digest (from /api/tags) with the registry's current manifest.

const REGISTRY = process.env.CORRAL_REGISTRY || 'https://registry.ollama.ai';
const ACCEPT = 'application/vnd.docker.distribution.manifest.v2+json';

export function registryRef(name) {
  if (/(^|:)cloud$|-cloud$/.test(name)) return null;
  let [repo, tag = 'latest'] = name.split(':');
  const first = repo.split('/')[0];
  if (first.includes('.')) return null; // other registries (hf.co, private) are skipped for now
  if (!repo.includes('/')) repo = `library/${repo}`;
  return { repo, tag };
}

export async function checkUpdates({ db, ollama, force = false }) {
  const store = kvGet(db, 'updates', {});
  const { models = [] } = await ollama.tags();
  const now = Date.now();
  const out = {};

  await Promise.all(
    models.map(async (m) => {
      const prev = store[m.name] || {};
      const ref = registryRef(m.name);
      if (!ref) return (out[m.name] = { status: 'unsupported' });
      if (!force && prev.checkedAt && now - prev.checkedAt < 6 * 3600000 && prev.localDigest === m.digest) {
        return (out[m.name] = prev);
      }
      try {
        const res = await fetch(`${REGISTRY}/v2/${ref.repo}/manifests/${ref.tag}`, {
          headers: { accept: ACCEPT },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`registry ${res.status}`);
        const body = await res.text();
        const remote = crypto.createHash('sha256').update(body).digest('hex');
        const local = String(m.digest || '').replace(/^sha256:/, '');
        out[m.name] = {
          status: remote === local ? 'current' : 'update',
          localDigest: m.digest,
          remoteDigest: remote,
          checkedAt: now,
          skipped: prev.skipped === remote ? remote : null,
        };
      } catch (e) {
        // Fail quietly (offline etc.), keep the previous answer.
        out[m.name] = { ...prev, status: prev.status || 'unknown', error: e.message };
      }
    })
  );

  kvSet(db, 'updates', out);
  return out;
}

export function skipUpdate(db, name) {
  const store = kvGet(db, 'updates', {});
  if (store[name]) store[name].skipped = store[name].remoteDigest;
  kvSet(db, 'updates', store);
  return store[name] || null;
}
