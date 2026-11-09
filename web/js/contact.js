// @ts-check
import { isAllowedLink } from './dom.js';

/**
 * @typedef {{ label: string, href: string }} ContactLink
 * @typedef {{ name: string, headline: string, links: ContactLink[] }} Contact
 */

/** Bounds, so a bad or huge file cannot fill the page. */
const MAX_TEXT = 140;
const MAX_LABEL = 30;
const MAX_LINKS = 8;

/**
 * Turns the contents of contact.json into what the page shows, or undefined if there is
 * nothing usable. Every link is checked with the same rule the DOM helper enforces, and one
 * that fails is quietly dropped: a typo in the file shows fewer links, never a broken page,
 * and no value in it can ever become a "javascript:" link.
 * @param {unknown} raw
 * @returns {Contact | undefined}
 */
export function parseContact(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { name, headline, links } = /** @type {Record<string, unknown>} */ (
    raw
  );
  if (typeof name !== 'string' || name.trim() === '') return undefined;

  /** @type {ContactLink[]} */
  const kept = [];
  for (const link of Array.isArray(links) ? links : []) {
    if (kept.length >= MAX_LINKS) break;
    if (typeof link !== 'object' || link === null) continue;
    const { label, href } = /** @type {Record<string, unknown>} */ (link);
    if (typeof label !== 'string' || typeof href !== 'string') continue;
    if (label.trim() === '' || label.length > MAX_LABEL) continue;
    if (!isAllowedLink(href)) continue;
    kept.push({ label: label.trim(), href });
  }
  return {
    name: name.trim().slice(0, MAX_TEXT),
    headline:
      typeof headline === 'string' ? headline.trim().slice(0, MAX_TEXT) : '',
    links: kept,
  };
}

/**
 * Reads /contact.json from this site. Never throws: no contact file just means no footer.
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Contact | undefined>}
 */
export async function loadContact(
  fetchImpl = (...args) => globalThis.fetch(...args),
) {
  try {
    const response = await fetchImpl('/contact.json', {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return undefined;
    return parseContact(await response.json());
  } catch {
    return undefined;
  }
}
