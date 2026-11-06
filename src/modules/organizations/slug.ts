import { randomBytes } from 'node:crypto';
import { SLUG_BASE_MAX_LENGTH } from '../../common/limits.js';

/** Random bytes in the unique suffix: 3 bytes = 6 hex characters, ~16 million variants. */
const SUFFIX_BYTES = 3;
const FALLBACK_BASE = 'org';

/** "Acme Studio, Inc." → "acme-studio-inc". Accents are folded; anything else becomes a dash. */
export function slugBase(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_BASE_MAX_LENGTH)
    .replace(/-+$/g, '');
  return base || FALLBACK_BASE;
}

/**
 * URL-safe slug that is unique without a lookup: readable part + random suffix. Two orgs
 * called "Acme" get different slugs, and the database's unique index is the final arbiter
 * (the caller retries on the rare collision).
 */
export function makeSlug(name: string): string {
  return `${slugBase(name)}-${randomBytes(SUFFIX_BYTES).toString('hex')}`;
}
