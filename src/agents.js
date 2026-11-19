// Agents = saved personas: a system prompt plus default model and sampling parameters.
// They only shape the test chat (and can be baked into a model with the Factory). They never run tools.
import { kvGet, kvSet } from './db.js';

const PARAM_KEYS = ['temperature', 'top_p', 'top_k', 'num_ctx'];

const STARTERS = [
  { emoji: '💻', name: 'Coder', description: 'Direct, careful programming help.', params: { temperature: 0.2 },
    system: 'You are an experienced software engineer. Give working code first, then a short explanation. Prefer simple, readable solutions, name edge cases, and say so when you are unsure instead of guessing.' },
  { emoji: '🔍', name: 'Code reviewer', description: 'Finds bugs, risks and unclear code.', params: { temperature: 0.2 },
    system: 'You review code. List real problems first (bugs, security, data loss), then maintainability issues. For each, quote the line, explain the failure, and suggest a fix. Skip praise and nitpicks.' },
  { emoji: '🧒', name: 'Explain simply', description: 'Plain-language explanations with examples.', params: { temperature: 0.6 },
    system: 'Explain things the way a patient teacher would to a smart beginner. Use plain words, one concrete example, and an analogy when it helps. Define any jargon you cannot avoid.' },
  { emoji: '✍️', name: 'Editor', description: 'Tightens and corrects your writing.', params: { temperature: 0.4 },
    system: 'You are a copy editor. Fix spelling, grammar and clarity while keeping the author\'s voice. Return the edited text first, then a short list of the most important changes.' },
  { emoji: '🌐', name: 'Translator', description: 'Natural translation, keeps tone and formatting.', params: { temperature: 0.3 },
    system: 'You translate between languages. Keep meaning, tone and formatting. If the target language is not stated, translate to English (or to the language the user writes in if the text is already English). Output only the translation unless asked.' },
  { emoji: '📊', name: 'Analyst', description: 'Structured, evidence-based answers.', params: { temperature: 0.3 },
    system: 'You are an objective analyst. Structure answers as: summary, key points, assumptions, risks. Separate facts from opinion, show your reasoning, and say what data would change your conclusion.' },
];

export function cleanAgent(b = {}) {
  const fail = (m) => Object.assign(new Error(m), { status: 400 });
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) throw fail('name is required');
  const system = String(b.system || '').slice(0, 20000);
  const params = {};
  for (const k of PARAM_KEYS) {
    const v = b.params?.[k];
    if (v === '' || v == null) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) throw fail(`${k} must be a number`);
    params[k] = n;
  }
  return {
    name,
    emoji: String(b.emoji || '🤖').trim().slice(0, 8) || '🤖',
    description: String(b.description || '').trim().slice(0, 200),
    system,
    model: String(b.model || '').trim().slice(0, 200) || null,
    params,
  };
}

const parse = (r) => ({ ...r, params: JSON.parse(r.params || '{}') });

export function createAgents(db) {
  const insert = db.prepare(
    'INSERT INTO agents (name, emoji, description, system, model, params, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const list = () => db.prepare('SELECT * FROM agents ORDER BY id').all().map(parse);

  // Starters are added once; deleting them later keeps them deleted.
  if (!kvGet(db, 'agents_seeded')) {
    for (const a of STARTERS) {
      const c = cleanAgent(a);
      insert.run(c.name, c.emoji, c.description, c.system, c.model, JSON.stringify(c.params), Date.now());
    }
    kvSet(db, 'agents_seeded', true);
  }

  return {
    list,
    create(body) {
      const c = cleanAgent(body);
      const info = insert.run(c.name, c.emoji, c.description, c.system, c.model, JSON.stringify(c.params), Date.now());
      return parse(db.prepare('SELECT * FROM agents WHERE id = ?').get(Number(info.lastInsertRowid)));
    },
    update(id, body) {
      const c = cleanAgent(body);
      const info = db
        .prepare('UPDATE agents SET name=?, emoji=?, description=?, system=?, model=?, params=? WHERE id=?')
        .run(c.name, c.emoji, c.description, c.system, c.model, JSON.stringify(c.params), id);
      if (!info.changes) throw Object.assign(new Error('no such agent'), { status: 404 });
      return parse(db.prepare('SELECT * FROM agents WHERE id = ?').get(id));
    },
    remove(id) {
      db.prepare('DELETE FROM agents WHERE id = ?').run(id);
      return { ok: true };
    },
  };
}
