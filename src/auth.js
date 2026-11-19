import crypto from 'node:crypto';

// True when the request carries this machine's admin token (header "x-corral-admin").
export function isAdmin(req, cfg) {
  const given = String(req.headers['x-corral-admin'] || '');
  const a = Buffer.from(given);
  const b = Buffer.from(cfg.adminToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
