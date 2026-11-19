import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let cache = null;

export function loadCatalog() {
  if (!cache) cache = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'models.seed.json'), 'utf8'));
  return cache;
}

// Rough download/memory size for the default Q4_K_M quant, in GB.
export function estimateGb(sizeTag) {
  const t = String(sizeTag).toLowerCase();
  let m = t.match(/^(\d+(?:\.\d+)?)([mb])$/);
  if (m) {
    const billions = Number(m[1]) / (m[2] === 'm' ? 1000 : 1);
    return round(billions * 0.6 + (billions >= 1 ? 0.4 : 0.1));
  }
  m = t.match(/^e(\d+(?:\.\d+)?)b$/); // Gemma "effective" sizes ship more raw weights
  if (m) return round(Number(m[1]) * 1.6 + 1);
  return null; // MoE shapes like 8x7b vary too much to guess
}

// fits: in GPU memory · offload: spills to RAM (slower) · cpu: no GPU, runs on CPU · too-big · unknown
export function fitFor(gb, hw) {
  if (gb == null || !hw) return 'unknown';
  const need = gb * 1.15; // weights + KV cache headroom
  if (hw.vramGb > 0) {
    if (need <= hw.vramGb) return 'fits';
    const spare = hw.unified ? hw.ramGb * 0.9 : hw.vramGb + hw.ramGb * 0.6;
    return need <= spare ? 'offload' : 'too-big';
  }
  return need <= hw.ramGb * 0.7 ? 'cpu' : 'too-big';
}

export function catalogView(hw, installed = []) {
  const cat = loadCatalog();
  const names = new Set(installed.map((m) => m.name));
  return {
    snapshot: cat.snapshot,
    legend: cat.legend,
    models: cat.models.map((m) => {
      const cloudOnly = m.sizes.length === 0 && m.caps.includes('C');
      const sizes = m.sizes.map((s) => {
        const gb = estimateGb(s);
        return { tag: s, gb, fit: fitFor(gb, hw), installed: names.has(`${m.id}:${s}`) };
      });
      return {
        ...m,
        cloudOnly,
        sizes,
        installed: [...names].some((n) => n === m.id || n.startsWith(`${m.id}:`)),
        bestFit: sizes.filter((s) => s.fit === 'fits').map((s) => s.tag).pop() || null,
      };
    }),
  };
}

const round = (n) => Math.round(n * 10) / 10;
