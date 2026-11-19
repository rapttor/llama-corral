# corral task list

Updated 2026-11-20. Status: `[x]` done, `[~]` in progress, `[ ]` to do.
Model tag: **H** = Haiku (mechanical, one file, clear done-check), **S** = Sonnet (ordinary feature work),
**O** = Opus (design, security, data model, privacy). Switch up early if a task goes wrong.

Rules for every task: zero dependencies, plain ESM, no build step, `npm test` stays green, no telemetry,
never log prompt or response text. Each task below is sized to touch one or two files and have a check you can run.

## Done

- [x] v0.1.0: gateway proxy, streaming meter (NDJSON / SSE / JSON), app tokens, usage dashboards, CSV export
- [x] Context-overflow detection (`ctx_limit`, `overflow`, "overflowing" list in `/usage`, Requests filter)
- [x] Models: list, pull jobs with progress, delete, copy, unload, Model Factory (`/models/create`)
- [x] Update detection against the registry, "skip this version"
- [x] Static catalog with per-machine hardware fit; hub with remotes and `/r/<id>/` routing
- [x] Agents backend: `agents` table, 6 starter agents, CRUD API (`/agents`), `src/agents.js`
- [x] Test chat backend: admin token accepted by the gateway (client `corral-chat`), admin header never forwarded upstream, streaming relay `/r/<id>/chat`

## A. Agents and chat (in progress)

An agent is a saved persona: system prompt + default model + temperature / top_p / top_k / num_ctx.
It never runs tools. Chat history stays in the browser (`localStorage`), so nothing is stored server-side.

- [ ] A1 **H** Add "Chat" and "Agents" links to the nav in `ui/index.html`
- [ ] A2 **H** `ui/app.js`: `VIEWS.agents` renders agent cards (emoji, name, description, model, params)
- [ ] A3 **H** Agents view: create/edit form (name, emoji, description, model datalist, system prompt, 4 params), calls `POST/PUT /agents`
- [ ] A4 **H** Agents view: delete with `confirmClick`
- [ ] A5 **H** Agents view: "Chat" button on a card opens a new chat with that agent
- [ ] A6 **H** Tiny safe markdown renderer `md()` (escape first, then fences, inline code, bold, line breaks)
- [ ] A7 **S** Chat core: POST `/api/chat` (local) or `/corral/api/r/<id>/chat` (remote) with the admin header, read the NDJSON stream, append `message.content`, Stop button via `AbortController`
- [ ] A8 **H** Chat: show `message.thinking` in a collapsible block (send `think: true` only when the toggle is on)
- [ ] A9 **H** Chat: save/load conversations in `localStorage` (cap 50, wrap every call in try/catch), list, new, delete
- [ ] A10 **H** Chat: settings panel (agent picker, model picker, system prompt, 4 params), edits persist per chat
- [ ] A11 **H** Chat: context meter from the final chunk (`prompt_eval_count + eval_count` vs `num_ctx` or the loaded model's context): gray, amber at 80%, red at 95%
- [ ] A12 **H** Chat: show tokens/s and TTFT under each answer
- [ ] A13 **H** Chat: export conversation as Markdown and JSON
- [ ] A14 **H** Chat: "Save as agent" button turns current settings into an agent
- [ ] A15 **H** Chat: attach images (base64 into `images`) for vision models
- [ ] A16 **H** Chat: Cmd/Ctrl+N new chat, Enter sends, Shift+Enter newline
- [ ] A17 **H** `ui/style.css`: layout for chat (list | messages | settings), bubbles, code blocks
- [ ] A18 **H** `test/smoke.js`: agents CRUD (starters present, create, update, delete, bad input returns 400)
- [ ] A19 **H** `test/smoke.js`: admin header authorizes `/api/chat` on a `--require-token` machine and the log shows client `corral-chat`; no header still returns 401
- [ ] A20 **H** `test/smoke.js`: `/r/<id>/chat` relay streams 11 lines
- [ ] A21 **S** "Make model from agent": button runs `/models/create` with the agent's prompt and params (links agents to the Factory)
- [ ] A22 **H** Export and import agents as a JSON file
- [ ] A23 **H** README section: agents, chat, and why chat history is browser-only
- [ ] A24 **H** CLAUDE.md: say "agent" means a saved persona and that tool-running agents are still out of scope

## B. Gateway and usage (P1 leftovers and ideas)

- [ ] B1 **H** Error-rate chart on Overview
- [ ] B2 **H** Request detail drawer (all columns, no content)
- [ ] B3 **S** Ollama version per machine plus "update available" badge (GitHub releases, cached 24h, fails silently)
- [ ] B4 **S** Per-token model allowlist (a token can only call named models)
- [ ] B5 **S** Per-token daily token quota with a clear 429 message
- [ ] B6 **S** Overflow alert: webhook URL setting, one POST per model/client per day
- [ ] B7 **O** Opt-in prompt logging per token: where it is stored, how it is purged, what the UI warns
- [ ] B8 **H** Retention setting: delete `requests` older than N days (default 365)
- [ ] B9 **H** `corral doctor` CLI: checks Ollama reachable, port free, data dir writable, prints fixes
- [ ] B11 **H** Overview empty state: show "your apps must use :11435, not :11434" with the exact port and a copy button
- [ ] B12 **H** Docs: "transparent mode" (move Ollama to another port, run corral on 11434 so existing apps are counted with no changes), macOS `launchctl setenv OLLAMA_HOST` and Linux systemd override steps
- [ ] B13 **S** `corral setup` command that prints (or applies, after asking) the port-swap steps for this OS
- [ ] B14 **S** Detect direct-to-Ollama traffic: compare Ollama `/api/ps` activity with the gateway log and warn "something is bypassing the gateway"
- [ ] B10 **H** `corral token create` flag `--model-allow`, once B4 lands

## C. Model management (P2)

- [ ] C1 **H** Installed list: capability badges (vision, tools, thinking) from `/api/show`
- [ ] C2 **H** Installed list: multi-select and bulk delete (with the two-click confirm)
- [ ] C3 **H** Model details drawer: template, parameters, license, capabilities from `/api/show`
- [ ] C4 **H** Copy-model button in the row menu (API exists)
- [ ] C5 **S** Pull queue UI: several parallel pulls, cancel, retry, show resume
- [ ] C6 **S** Import GGUF from a path on the machine itself (`/api/blobs` + `/api/create`)
- [ ] C7 **H** Quant picker on pull (Q4_K_M default, Q8_0 when memory allows, uses fit data)
- [ ] C8 **H** "Pull by name" box that accepts `name:tag`, `hf.co/user/repo`, and a huggingface.co URL
- [ ] C9 **H** Hub view: "qwen3.6:27b is outdated on 2 of 3 machines"

## D. Hub and routing (P3)

- [ ] D1 **S** Agentless remote: plain Ollama URL with Basic / Bearer / custom-header auth, management only
- [ ] D2 **S** "Install model X on machines A, C" with a machine-by-model matrix
- [ ] D3 **O** Aliases and routing design: `coder` maps to the machine that has it loaded or free, fallback order, failure behaviour
- [ ] D4 **S** Implement aliases per D3 (alias table, resolve in proxy before forwarding)
- [ ] D5 **H** Machine health and latency history (store last 24h samples, small sparkline)
- [ ] D6 **H** Pairing helper: dashboard shows the exact `--host 0.0.0.0` command and a copyable pairing link

- [ ] D7 **H** Startup auto-detect: if the default upstream is down, probe `127.0.0.1` ports 11434 and 11436 and `OLLAMA_HOST`, then print what was found
- [ ] D8 **S** "Find Ollama on my network" button (opt-in, never automatic): scan the local /24 for port 11434 with `GET /api/version`, short timeout, small concurrency, list hits to add as agentless remotes (needs D1)
- [ ] D9 **O** Decide on discovery safety: scan only private ranges, only on a user click, never send anything but `GET /api/version`, document that most Ollama installs listen on localhost only and will not appear

## E. Catalog and recommendations (P4)

- [ ] E1 **H** Fill empty descriptions in `data/models.seed.json` (OllaMan's list shows "No description available"; ours must not)
- [ ] E2 **H** Starter packs data (student, developer, writer, researcher) as JSON
- [ ] E3 **S** Hugging Face GGUF browser: variants table with a per-machine fit verdict (OllaMan shows size/RAM but no verdict)
- [ ] E4 **S** Live catalog source: HF Hub API (newest, trending GGUF)
- [ ] E5 **S** ollama.com library scraper isolated in `src/catalog/sources/ollama-web.js` (it will break, keep it contained)
- [ ] E6 **S** Watchlist: notify when a new version of a family you use appears
- [ ] E7 **O** Recommendation rules by use case x hardware tier (8 GB / 16-32 GB / 48 GB+ / cloud), later driven by strasy ratings
- [ ] E8 **H** Hugging Face endpoint setting with mirror fallback (OllaMan has this; helps users behind blocked networks)

## F. Arena and benchmarks (P5)

- [ ] F1 **S** Side-by-side chat: same prompt to 2-4 models, optionally on different machines
- [ ] F2 **S** Blind A/B arena with pairwise preference stored locally
- [ ] F3 **S** Benchmark runner: fixed prompt set, TTFT, tokens/s, peak VRAM per model x machine
- [ ] F4 **H** Shareable benchmark card (SVG, no external fonts)
- [ ] F5 **H** Local star rating per model (private until strasy is on)

## G. strasy ratings (separate repo for the service)

- [ ] G1 **O** Rating schema v1, ed25519 install identity, what leaves the machine (exactly the fields in CLAUDE.md §4)
- [ ] G2 **O** Verified-usage gate (>= 20 requests or >= 10k output tokens) computed from the local log
- [ ] G3 **H** Opt-in toggle, off by default, with a "preview exactly what will be sent" panel
- [ ] G4 **S** Ratings outbox and signed submit with retry
- [ ] G5 **O** strasy API design: namespaces, rate limits per key + IP, Bayesian ranking, abuse handling
- [ ] G6 **S** strasy service on Yii2 (advanced template) for cPanel: REST + public pages per subject
- [ ] G7 **H** Embeddable vanilla-JS star widget
- [ ] G8 **S** In-app suggestions: "On 24 GB GPUs users who use X also rate Y highly"
- [ ] G9 **user** Renew strasy.com before 2026-12

## H. Packaging and operations

- [ ] H1 **H** `Dockerfile` (node:22-alpine) and `.dockerignore`, documented as hub/VPS use only (the hardware probe is wrong inside a container)
- [ ] H2 **H** `docker-compose.yml` for a hub with a data volume
- [~] H3 **H** launchd examples done in `docs/launchd/` (Ollama on :11436, corral on :11434); still to do: systemd unit, and a README page that explains editing the paths
- [ ] H11 **H** Docs note: clients like OllaMan can relaunch the Ollama app when :11434 looks empty, which steals the port from corral. Start corral first, keep the app closed, and use `launchctl kickstart gui/$(id -u)/com.corral.gateway` after stopping a rogue Ollama
- [ ] B15 **H** Overflow check misses the first request after a model loads (`ctx_limit` null until the next poll); refresh `/api/ps` once on a miss
- [ ] H4 **H** Reverse-proxy and TLS notes (Caddy, nginx) for exposing the gateway
- [ ] H5 **H** GitHub Actions: `npm test` on Node 22 and 24
- [ ] H6 **H** npm publish checklist and `files` check (`npm pack --dry-run`)
- [ ] H7 **S** Electron wrapper with tray (wraps the hub, no separate codebase)
- [ ] H8 **H** i18n scaffold plus EN strings extraction, then BS / SR / HR translations
- [ ] H9 **O** Security review: admin token handling, `/t/<token>/` path tokens in logs, SSRF through remotes and pull URLs
- [ ] H10 **H** Replace stale stack text in CLAUDE.md section 2 (TypeScript/Fastify/React) with what the code really is

## I. Docs and positioning

- [ ] I1 **H** README comparison table (what is free here that others lock: update, import, multi-server, agents)
- [ ] I2 **H** Fresh screenshots in `docs/` after agents and chat land
- [ ] I3 **H** Short demo script for a GIF (gateway, token, overflow flag, fit check)
- [ ] I4 **H** Landing-page copy draft

## Out of scope (do not build)

RAG, voice, image generation, web search, MCP host, cloud providers, and any agent mode that runs commands or
reads and writes files (OllaMan ships one with skills paths and a command blacklist; it is a security liability).
Point users to Open WebUI, Msty, or Claude Code for those.

## Suggested order

1. Finish A (agents + chat UI and tests), because the backend is already in.
2. B3, B8, B9 and C1-C4, C8 (cheap, visible polish, all Haiku).
3. E1, E3 (fixes OllaMan's weakest spots).
4. D1, D2, C5, C6.
5. H1-H6 (packaging) before the first public push.
6. G and F only after the free features are solid.
