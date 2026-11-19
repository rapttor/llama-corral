# CLAUDE.md — corral (npm: llama-corral)

Open-source, Node-based control plane for Ollama: a usage-tracking gateway, a multi-machine hub,
a model catalog with hardware-fit checks, and community model ratings powered by **strasy**.
Chat exists only to test models. We do not compete with Open WebUI on chat, RAG, voice, etc.

Status: v0.1.0 built 2026-11-19. P1 (gateway + usage), most of P2, P3 hub basics and P4 static catalog are done.

## Implementation notes (how the code actually is)
- **Zero dependencies, no build step.** Plain ESM JavaScript, Node >= 22.13, `node:sqlite` for storage,
  native `fetch`/`http` for the proxy, vanilla JS dashboard in `ui/`. Keep it that way: `npx llama-corral` must stay instant.
  (This replaces the Fastify / better-sqlite3 / React+Vite stack in §2.)
- `src/proxy.js` is the gateway. `src/meter.js` reads usage out of NDJSON / SSE / JSON responses as they stream past.
- `src/api.js` is the admin API at `/corral/api/*` (header `x-corral-admin`). `/corral/api/r/<id>/...` runs the same call on a remote machine.
- Hub = any corral instance; "remotes" are other corral instances (URL + their admin token). There is no separate hub mode.
- `test/mock-ollama.js` is a fake Ollama; `npm test` runs `test/smoke.js` end-to-end (24 checks). Keep it green.
- Not done yet: agentless remotes (plain Ollama URL), routing/aliases, arena/benchmarks, strasy ratings, live catalog, Electron, HF update checks.

---

## 1. Positioning: what we do that others don't

| Need | OllaMan | Ollama app | LM Studio | Msty | Open WebUI | **Us** |
|---|---|---|---|---|---|---|
| Usage from *all* clients (Cursor, scripts…) | ✗ own chats | ✗ | partial | gateway (paid tiers) | own chats | **✓ gateway proxy** |
| Multi-machine hub, push model to N servers | list only | ✗ | LM Link (LM Studio only) | ✓ | multiple URLs | **✓ agents + hub** |
| "Will it fit on *my* machines" | ✗ | ✗ | partial | ✗ | ✗ | **✓ per-agent VRAM** |
| Ratings from verified usage | ✗ | ✗ | ✗ | ✗ | arena (local) | **✓ strasy** |
| Open source | ✗ | app closed | ✗ | ✗ | ✓ | **✓ MIT** |

Honest caveats: LM Studio has LM Link for remote use, and Msty has a local gateway with app tokens and usage.
Our edge is the combination of being Ollama-native, open source, multi-machine, and running on headless servers via npm.

---

## 2. Architecture

```
clients (Cursor, Continue, scripts, our UI)
        │  Bearer app-token
  ┌─────▼──────────────┐        ┌────────────────────┐
  │ AGENT (per machine)│◄──────►│ HUB (laptop / VPS) │──► strasy API (ratings, opt-in)
  │ proxy :11435       │  WS    │ web UI + aggregate │──► catalog updates (later)
  │ SQLite usage log   │        └────────────────────┘
  │ hw probe, /api/ps  │
  └─────┬──────────────┘
        │ localhost only
     Ollama 127.0.0.1:11434
```

- One npm package, two modes: `npx <name> agent` / `npx <name> hub` (or both on one machine).
- **Agent**: reverse proxy for the whole Ollama API, including OpenAI-compatible `/v1/*`. It:
  - checks app tokens, then streams responses through unchanged
  - parses the final chunk (`prompt_eval_count`, `eval_count`, `total_duration`, `load_duration`) and logs it
  - polls `/api/ps` every 10s for loaded models and VRAM
  - probes hardware at startup (GPU/VRAM, RAM, CPU, OS)
- **Hub**: talks to agents over HTTPS/WebSocket using an agent pairing key. It serves the UI and aggregates usage.
- Ollama must stay bound to localhost. The agent is the only thing exposed. Works over LAN, Tailscale, or a reverse proxy.
- Stack: Node 20+, TypeScript, Fastify, better-sqlite3, React + Vite, systeminformation (hardware), undici (proxy).
- Desktop later: Electron wraps the hub with a tray icon. There is no separate desktop codebase.

---

## 3. Feature list by phase

Sources of inspiration: OllaMan, LM Studio (headless daemon, LM Link, parallel requests), Msty (side-by-side
"multiverse" chats, gateway with app tokens), Open WebUI (folders, sharing, arena), OllaMan (perf cards).

### P1: Gateway + usage (the reason to exist)
- Transparent proxy, app tokens (one per client: "cursor", "n8n", "script-x"), revocable
- Usage log per request: ts, server, token, client IP, model, endpoint, prompt/output tokens, tokens/s, TTFT, duration, status
- Dashboards: tokens per day/model/app/machine, tokens/s trends, error rate, VRAM timeline
- Ollama version per server, update-available badge
- **Context-overflow detection**: compare `prompt_eval_count` with the model's effective `num_ctx` per request.
  Flag requests at ≥95% ("Cursor is silently truncating on qwen3.6, so raise the context or switch models"). Nobody else
  can see this across all clients.
- CSV export

### P2: Model management
- Installed models (size, quant, family, capabilities from `/api/show`), delete, copy
- Pull queue with progress, ETA, parallel downloads, resume
- Model Factory: system prompt + params → `/api/create`
- Keep-alive / unload controls, "loaded now" view with expiry countdown (`expires_at` from `/api/ps`)
- **Update detection**: compare local digest (`/api/tags`) with the registry manifest
  (`registry.ollama.ai/v2/<ns>/<model>/manifests/<tag>`, plus HF GGUF). Check every 24h, fail silently, "skip this version".
  Re-pulling fetches only changed layers. Hub view: "qwen3.6:27b is outdated on 2 of 3 machines".
- **Import GGUF**: upload via `/api/blobs/:digest` + `/api/create`. Better: the agent imports from a path on its own
  machine, so a multi-GB upload never crosses the network
- Install by exact name:tag (manual install), with a quant picker (Q4_K_M default, Q8_0 if memory allows)

### P3: Hub / multi-machine
- Pair agents, health + latency, one dashboard for every machine
- "Install model X on machines A, C", plus a matrix of which model is on which machine
- **Agentless mode**: the hub can also add a plain Ollama URL (Basic / Bearer / custom-header auth) for management only,
  with no usage stats. This lowers the barrier, and installing the agent is the upgrade path.
- Aliases + routing: `coder` → whichever machine has it loaded or free, with fallback order (simple load balancing)

### P4: Catalog + hardware fit
- Static seed catalog (`data/models.seed.json`, snapshot 2026-11-19), filter by capability (tools/vision/thinking/embedding/audio), size, family
- Fit check per agent: estimated size of the quant vs VRAM/RAM → fits / tight / won't fit / cloud-only
- Later: live updates (HF Hub API GGUF newest/trending, ollama.com library scraper isolated in one module, Ollama GitHub releases)
- Watchlist: notify when a new version of a family you use appears
- **Recommendations by use case × hardware tier** (8 GB / 16–32 GB / 48 GB+ / cloud) plus starter packs
  (student, developer, writer, researcher). Driven by strasy ratings from verified usage, not editorial stars.

### P5: Arena, benchmarks, ratings (feeds strasy)
- Side-by-side chat: same prompt → 2–4 models (optionally on different machines)
- **Blind A/B arena**: pick the better answer → pairwise preference
- Benchmark runner: fixed prompt set → TTFT, tokens/s, peak VRAM per model × machine; shareable card
- Star ratings (see §4)

### P6: Polish
- Minimal test chat (streaming, thinking blocks, images, code highlight, temperature/top_p/top_k, per-chat context
  length with a usage ring: gray / amber ≥80% / red ≥95%), chat export (Markdown/JSON)
- Electron wrapper + tray
- i18n (EN, BS/SR/HR first)

### Explicitly out of scope
RAG/knowledge bases, voice, image generation, web search, multi-agent workflows, MCP host, cloud providers,
and an "agent mode" with file read/write/bash tools (OllaMan has one; it's a security liability and Claude Code /
OpenCode / Open WebUI Terminal already do it better).
Open WebUI / Msty / AnythingLLM do these. Point users there.

---

## 4. Ratings → strasy

strasy.com (owned; **renew: expires 2026-12**) becomes a small, general-purpose rating service.
This app is its first client. Other portfolio products can reuse it later (Ulaznica events, Dolazis, games).

### Rating shape (from this app)
```json
{
  "subject": "ollama:qwen3.6:27b-q4_K_M",
  "stars": 4,
  "dimensions": { "coding": 5, "chat": 4, "reasoning": 4, "speed": 3 },
  "context": { "gpu": "RTX 4090", "vram_gb": 24, "os": "linux", "tps": 38.2, "ctx": 8192 },
  "evidence": { "requests": 212, "tokens_out": 184000, "days_used": 9 },
  "install_id": "anon-ed25519-pubkey",
  "sig": "..."
}
```

### Rules
- **Opt-in only.** Off by default. No prompts or responses ever leave the machine, only the fields above.
- **Verified usage.** You can only rate a model the gateway has seen you use (for example ≥20 requests or ≥10k output tokens).
  This is the anti-spam moat, because nobody else can prove usage.
- Anonymous install identity is an ed25519 keypair. Rate limit per key + IP. One active rating per subject per key (editable).
- Ranking: Bayesian average + weight by evidence. Show "rated by N users on similar hardware".
- Arena preferences are stored as pairwise results and computed into an Elo-style score on strasy.
- Suggestions in the app: "On 24 GB GPUs, users who use qwen2.5-coder also rate X highly for coding."

### strasy service (separate repo)
- Yii2 on cPanel (fits the existing stack): REST API + public pages per subject (SEO: "best local coding model for 16 GB")
- Generic: `namespace` (ollama, ulaznica, …) + `subject` + stars + dimensions + context JSON
- Embeddable star widget (vanilla JS) for other products. This is the later SaaS angle.

---

## 5. Data model (agent SQLite)
- `requests(id, ts, token_id, client_ip, model, endpoint, prompt_tokens, output_tokens, ttft_ms, total_ms, load_ms, status)`
- `ps_samples(ts, model, size_vram, size_total, expires_at)`
- `tokens(id, name, hash, created_at, revoked_at)`
- `hardware(json, probed_at)`
- Hub: `agents(id, name, url, pair_key, last_seen, version)`, `ratings_outbox`, `catalog_cache`

## 6. Ollama API surface used
`/api/tags` `/api/ps` `/api/show` `/api/pull` `/api/create` `/api/copy` `/api/delete` `/api/chat`
`/api/generate` `/api/embed` `/api/version` `/v1/*` (passthrough). HF GGUF: `ollama pull hf.co/<user>/<repo>:<quant>`.

## 7. Rules for agents working on this repo
- The proxy must never buffer whole streams. Pipe the bytes and only tee the final JSON chunk for metrics.
- Never expose Ollama directly. Never log prompt/response content unless the user enables it explicitly per token.
- Keep the ollama.com scraper isolated in `src/catalog/sources/ollama-web.ts`. It will break.
- No telemetry of any kind besides opt-in strasy ratings.
- License MIT. Don't use OllaMan's name, branding, screenshots or copy.
