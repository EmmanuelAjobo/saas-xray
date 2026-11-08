// @ts-check

/**
 * Money from whole cents. Never throws: an unknown currency code falls back to plain text.
 * @param {number} cents
 * @param {string} currency ISO 4217, e.g. "USD"
 */
export function formatMoney(cents, currency) {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/**
 * Clock time for an event, in the viewer's own time zone.
 * @param {number} epochMs
 */
export function formatClock(epochMs) {
  return new Date(epochMs).toLocaleTimeString('en-GB', { hour12: false });
}

/**
 * "SENT" -> "Sent", "OVERDUE" -> "Overdue".
 * @param {string} word
 */
export function sentenceCase(word) {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Whole days from `now` until `date`: positive in the future, negative if it has passed.
 * @param {string | null} date ISO timestamp
 * @param {number} now epoch ms
 */
export function daysUntil(date, now) {
  if (!date) return null;
  return Math.ceil((Date.parse(date) - now) / 86_400_000);
}
