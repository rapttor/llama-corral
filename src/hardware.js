import os from 'node:os';
import { execFile } from 'node:child_process';

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

// Best-effort hardware probe. "vramGb" is what a model can use for GPU offload.
export async function probeHardware() {
  const ramGb = round(os.totalmem() / 1024 ** 3);
  const hw = {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model?.trim() || 'unknown',
    cores: os.cpus().length,
    ramGb,
    gpus: [],
    vramGb: 0,
    unified: false,
  };

  const nv = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  if (nv) {
    for (const line of nv.split('\n')) {
      const [name, mem] = line.split(',').map((s) => s.trim());
      if (name) hw.gpus.push({ name, vramGb: round(Number(mem) / 1024) });
    }
  }

  if (!hw.gpus.length && hw.platform === 'darwin' && hw.arch === 'arm64') {
    // Apple Silicon: unified memory; macOS lets the GPU use roughly 75% of it by default.
    const chip = await run('sysctl', ['-n', 'machdep.cpu.brand_string']);
    hw.unified = true;
    hw.gpus.push({ name: chip || 'Apple Silicon', vramGb: round(ramGb * 0.75) });
  }

  if (!hw.gpus.length && hw.platform === 'linux') {
    const amd = await run('rocm-smi', ['--showmeminfo', 'vram', '--csv']);
    const m = amd && amd.match(/(\d{9,})/);
    if (m) hw.gpus.push({ name: 'AMD GPU', vramGb: round(Number(m[1]) / 1024 ** 3) });
  }

  hw.vramGb = round(hw.gpus.reduce((s, g) => s + g.vramGb, 0));
  return hw;
}

const round = (n) => Math.round(n * 10) / 10;
