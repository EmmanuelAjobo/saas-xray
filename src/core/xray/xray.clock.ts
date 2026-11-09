/**
 * The time an X-ray event happened, in epoch milliseconds but with a fraction (microsecond
 * resolution).
 *
 * Why not `Date.now()`: events from one click (a permission check, the job queued, the worker
 * picking it up) can all happen inside the same millisecond, and the page orders a card's
 * steps by this time. With whole milliseconds those would tie, and the tie would be broken by
 * the order they were WRITTEN, which is not the order they HAPPENED. The fraction removes the
 * tie. (Clients treat it as an ordinary number of milliseconds.)
 */
export function eventTime(): number {
  return performance.timeOrigin + performance.now();
}
