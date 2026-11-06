import { EMAIL_MAX_LENGTH } from '../../common/limits.js';

/**
 * Rate-limit key for credential endpoints: the client IP AND the targeted email.
 *
 * IP alone would let one attacker hammer a single account from many addresses unnoticed;
 * email alone would let anyone lock a victim out by guessing their address. Combining them
 * limits guessing per (source, target) pair. Runs before body validation, so the body may
 * be anything: only a string is used.
 */
export function ipAndEmailTracker(req: Record<string, unknown>): string {
  const body = req.body as { email?: unknown } | undefined;
  const email =
    typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  return `${String(req.ip)}|${email.slice(0, EMAIL_MAX_LENGTH)}`;
}
