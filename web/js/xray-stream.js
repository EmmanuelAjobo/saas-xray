// @ts-check
import { createSseParser } from './sse-parser.js';

/** First pause before reconnecting, doubled after each failure up to the maximum. */
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 15_000;

/**
 * @typedef {'connecting' | 'live' | 'reconnecting' | 'unavailable' | 'stopped'} StreamState
 *
 * @param {number} ms
 * @param {AbortSignal} signal
 * @returns {Promise<void>} resolves after `ms`, or immediately if stopped
 */
function pause(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

/**
 * Keeps a live X-ray stream open for as long as it is wanted.
 *
 * - Reads Server-Sent Events with `fetch`, because EventSource cannot send the
 *   `Authorization` header.
 * - If the connection drops, or the server ends it (it does, on purpose, every few minutes
 *   so permissions are re-checked), it reconnects with `Last-Event-ID`, so no event is
 *   missed or repeated. Waits grow from 1 s to 15 s while the server is unreachable.
 * - A 401 renews the token first. A 404 or a "not allowed" 403 means this viewer can never
 *   watch, so it stops instead of hammering the server; "too many streams" is retried.
 *
 * @param {{
 *   url: string,
 *   getToken: () => string | undefined,
 *   refreshToken: () => Promise<boolean>,
 *   onEvent: (event: any) => void,
 *   onState: (state: StreamState, detail?: string) => void,
 *   fetchImpl?: typeof fetch,
 *   wait?: (ms: number, signal: AbortSignal) => Promise<void>,
 * }} options
 * @returns {{ stop: () => void }}
 */
export function startXrayStream({
  url,
  getToken,
  refreshToken,
  onEvent,
  onState,
  fetchImpl = (...args) => globalThis.fetch(...args),
  wait = pause,
}) {
  const controller = new AbortController();
  const { signal } = controller;
  /** @type {string | undefined} */
  let lastId;
  let delay = RECONNECT_MIN_MS;
  let first = true;

  /** @param {Response} response */
  async function read(response) {
    const decoder = new TextDecoder();
    const parser = createSseParser((message) => {
      if (message.type !== 'xray') return; // heartbeats only prove the line is alive
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      if (message.id) lastId = message.id;
      onEvent(event);
    });
    const reader = /** @type {ReadableStream<Uint8Array>} */ (
      response.body
    ).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      parser.feed(decoder.decode(value, { stream: true }));
    }
  }

  async function run() {
    while (!signal.aborted) {
      onState(first ? 'connecting' : 'reconnecting');
      first = false;
      try {
        const response = await fetchImpl(url, {
          signal,
          headers: {
            Accept: 'text/event-stream',
            ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
            ...(lastId ? { 'Last-Event-ID': lastId } : {}),
          },
        });

        if (response.status === 401) {
          await refreshToken();
        } else if (response.status === 404) {
          onState('unavailable', 'This organisation has no X-ray for you.');
          return;
        } else if (response.status === 403) {
          const problem = await response.json().catch(() => ({}));
          if (problem?.code !== 'LIMIT_REACHED') {
            onState(
              'unavailable',
              problem?.detail ?? 'The X-ray is not available to your role.',
            );
            return;
          }
          // Too many streams open (another tab): keep trying, it frees up when one closes.
          delay = RECONNECT_MAX_MS;
        } else if (response.ok && response.body) {
          onState('live');
          delay = RECONNECT_MIN_MS;
          await read(response);
          // Ended normally (the server's own time limit): reconnect straight away.
          if (signal.aborted) return;
          await wait(RECONNECT_MIN_MS, signal);
          continue;
        }
      } catch {
        if (signal.aborted) return;
      }
      if (signal.aborted) return;
      await wait(delay, signal);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    }
  }

  void run().finally(() => onState('stopped'));
  return { stop: () => controller.abort() };
}
