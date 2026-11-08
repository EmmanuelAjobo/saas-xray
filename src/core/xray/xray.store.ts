import type { NewXrayEvent, XrayEvent } from './xray.events.js';

/**
 * Where X-ray events are kept and how they travel. Two implementations: Redis Streams in
 * production (shared by every API instance) and an in-memory one for tests.
 *
 * Every method is scoped to ONE organisation. Nothing here can read across organisations,
 * and the organisation id always comes from a verified membership, never from the caller.
 */
export interface XrayStore {
  /** Stores events (oldest first) and tells live listeners. Returns them with their ids. */
  append(organizationId: string, events: NewXrayEvent[]): Promise<XrayEvent[]>;

  /** The most recent `limit` events, oldest first. */
  latest(organizationId: string, limit: number): Promise<XrayEvent[]>;

  /** Up to `limit` events strictly after `afterId`, oldest first. */
  after(
    organizationId: string,
    afterId: string,
    limit: number,
  ): Promise<XrayEvent[]>;

  /**
   * Calls `listener` for every event appended from now on (by any API instance). Resolves
   * once the subscription is active, with a function that cancels it.
   */
  subscribe(
    organizationId: string,
    listener: (event: XrayEvent) => void,
  ): Promise<() => Promise<void>>;
}

export const XRAY_STORE = Symbol('XRAY_STORE');

/** A stream position: "<milliseconds>-<sequence>", exactly what Redis Streams issues. */
const STREAM_ID = /^\d{1,16}-\d{1,16}$/;

export function isStreamId(value: unknown): value is string {
  return typeof value === 'string' && STREAM_ID.test(value);
}

/** Orders two stream ids numerically (string comparison would put "9-0" after "10-0"). */
export function compareStreamIds(a: string, b: string): number {
  const [aMs, aSeq] = a.split('-').map(Number) as [number, number];
  const [bMs, bSeq] = b.split('-').map(Number) as [number, number];
  return aMs !== bMs ? aMs - bMs : aSeq - bSeq;
}
