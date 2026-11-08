// @ts-check

/**
 * @typedef {{
 *   id: string,
 *   ts: number,
 *   requestId?: string,
 *   kind: string,
 *   severity: 'info' | 'success' | 'warn' | 'error',
 *   title: string,
 *   summary: string,
 *   meta: Record<string, string | number | boolean | null>,
 * }} XrayEvent
 *
 * @typedef {{
 *   key: string,
 *   events: XrayEvent[],
 *   request: XrayEvent | undefined,
 *   title: string,
 *   severity: XrayEvent['severity'],
 *   startedAt: number,
 * }} Group
 */

/** Groups shown at once. Older ones fall off so a long session never grows the page forever. */
export const MAX_GROUPS = 60;

const SEVERITY_RANK = { info: 0, success: 1, warn: 2, error: 3 };

/**
 * Orders two stream ids ("<ms>-<seq>") numerically. Comparing them as text would put
 * "9-0" after "10-0".
 * @param {string} a
 * @param {string} b
 */
export function compareIds(a, b) {
  const [aMs = 0, aSeq = 0] = a.split('-').map(Number);
  const [bMs = 0, bSeq = 0] = b.split('-').map(Number);
  return aMs !== bMs ? aMs - bMs : aSeq - bSeq;
}

/**
 * The record of what the backend did, grouped one card per click (all events that share a
 * request id). Events can arrive twice (the live stream resumes with some overlap) and the
 * last events of a click (an email sent afterwards) arrive after the card first appeared;
 * both are handled here, so the screen can simply render `groups()`.
 *
 * @param {{ maxGroups?: number }} [options]
 */
export function createTimeline({ maxGroups = MAX_GROUPS } = {}) {
  /** @type {Map<string, Group>} */
  const byKey = new Map();
  /** @type {Set<string>} */
  const seen = new Set();

  /** @param {Group} group */
  function refresh(group) {
    group.events.sort((a, b) => compareIds(a.id, b.id));
    group.request = group.events.find((e) => e.kind === 'http.request');
    group.title = group.request?.title ?? group.events[0]?.title ?? 'Activity';
    group.severity = group.events.reduce(
      (worst, e) =>
        SEVERITY_RANK[e.severity] > SEVERITY_RANK[worst] ? e.severity : worst,
      /** @type {XrayEvent['severity']} */ ('info'),
    );
    group.startedAt = group.events[0]?.ts ?? 0;
  }

  return {
    /**
     * @param {XrayEvent} event
     * @returns {boolean} true if it changed what is shown (false for a repeat)
     */
    add(event) {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      // An event with no request id is its own card.
      const key = event.requestId ?? `solo:${event.id}`;
      let group = byKey.get(key);
      if (!group) {
        group = {
          key,
          events: [],
          request: undefined,
          title: '',
          severity: 'info',
          startedAt: 0,
        };
        byKey.set(key, group);
      }
      group.events.push(event);
      refresh(group);

      if (byKey.size > maxGroups) {
        const oldest = [...byKey.values()].sort(
          (a, b) => a.startedAt - b.startedAt,
        )[0];
        if (oldest) {
          byKey.delete(oldest.key);
          for (const e of oldest.events) seen.delete(e.id);
        }
      }
      return true;
    },

    /** Newest click first. */
    groups() {
      return [...byKey.values()].sort((a, b) => {
        const aLast = a.events.at(-1)?.id ?? '0-0';
        const bLast = b.events.at(-1)?.id ?? '0-0';
        return compareIds(bLast, aLast);
      });
    },

    clear() {
      byKey.clear();
      seen.clear();
    },
  };
}
