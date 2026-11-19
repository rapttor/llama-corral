// Watches a response stream as it passes through, without buffering it for the client,
// and extracts usage numbers from whichever format Ollama answered in:
//   - NDJSON (native /api/chat, /api/generate streaming): last line carries the totals
//   - SSE    (OpenAI-compatible /v1/* streaming): usage chunk if present, else count content chunks
//   - JSON   (non-streaming): totals are in the body

const MAX_JSON = 8 * 1024 * 1024;
const TAIL = 64 * 1024;

export class Meter {
  constructor(contentType = '') {
    this.kind = contentType.includes('ndjson')
      ? 'ndjson'
      : contentType.includes('event-stream')
        ? 'sse'
        : 'json';
    this.firstByteAt = null;
    this.buf = '';
    this.tooBig = false;
    this.partial = '';
    this.sseChunks = 0;
    this.sseUsage = null;
    this.decoder = new TextDecoder();
  }

  push(chunk) {
    if (this.firstByteAt === null) this.firstByteAt = Date.now();
    const text = this.decoder.decode(chunk, { stream: true });

    if (this.kind === 'sse') return this.#sse(text);

    if (this.kind === 'ndjson') {
      this.buf = (this.buf + text).slice(-TAIL);
      return;
    }
    if (this.buf.length + text.length > MAX_JSON) {
      this.tooBig = true;
      this.buf = '';
    } else if (!this.tooBig) this.buf += text;
  }

  #sse(text) {
    const lines = (this.partial + text).split('\n');
    this.partial = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const obj = JSON.parse(data);
        if (obj.usage) this.sseUsage = obj.usage;
        const delta = obj.choices?.[0]?.delta;
        const piece = obj.choices?.[0]?.text;
        if ((delta && (delta.content || delta.reasoning || delta.reasoning_content)) || piece) this.sseChunks++;
      } catch {
        /* not JSON, ignore */
      }
    }
  }

  // Returns { prompt_tokens, output_tokens, approx, load_ms, eval_ms, prompt_ms, total_ms_upstream, error }
  result() {
    if (this.kind === 'sse') {
      if (this.sseUsage)
        return { prompt_tokens: this.sseUsage.prompt_tokens ?? null, output_tokens: this.sseUsage.completion_tokens ?? null, approx: 0 };
      // Ollama emits roughly one token per SSE chunk, so this is a good estimate.
      return { prompt_tokens: null, output_tokens: this.sseChunks, approx: 1 };
    }

    let obj = null;
    if (this.kind === 'ndjson') {
      const lines = this.buf.trim().split('\n').reverse();
      for (const l of lines) {
        try {
          const o = JSON.parse(l);
          if (o.done || o.error) {
            obj = o;
            break;
          }
        } catch {
          /* partial line at the cut, skip */
        }
      }
    } else if (!this.tooBig && this.buf) {
      try {
        obj = JSON.parse(this.buf);
      } catch {
        obj = null;
      }
    }
    if (!obj) return {};
    if (obj.error) return { error: String(obj.error?.message || obj.error).slice(0, 300) };

    if (obj.usage) {
      // OpenAI-compatible non-streaming response
      return { prompt_tokens: obj.usage.prompt_tokens ?? null, output_tokens: obj.usage.completion_tokens ?? 0, approx: 0 };
    }
    const ns = (v) => (typeof v === 'number' ? v / 1e6 : null);
    return {
      prompt_tokens: obj.prompt_eval_count ?? null,
      output_tokens: obj.eval_count ?? (obj.embeddings || obj.embedding ? 0 : null),
      approx: 0,
      load_ms: ns(obj.load_duration),
      prompt_ms: ns(obj.prompt_eval_duration),
      eval_ms: ns(obj.eval_duration),
      total_ms_upstream: ns(obj.total_duration),
    };
  }
}
