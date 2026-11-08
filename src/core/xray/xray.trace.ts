import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type NewXrayEvent,
  dbQueriesEvent,
  httpRequestEvent,
} from './xray.events.js';
import { MAX_STEPS_PER_REQUEST } from './xray.limits.js';

/**
 * What happened during ONE request, collected as it runs and published once, when the
 * response has been sent (one Redis round trip per request, not one per step).
 *
 * Lives in AsyncLocalStorage, so guards, the data layer and services record into the right
 * request without being handed anything. Outside a request there is no trace and recording
 * is a silent no-op, which is why callers never need to check.
 */
export class XrayTrace {
  readonly requestId: string | undefined;
  private readonly steps: NewXrayEvent[] = [];
  private queryCount = 0;
  private queryMs = 0;
  private readonly models = new Set<string>();
  /** Set once the request has finished: later events (a background email) go straight out. */
  private sink: ((events: NewXrayEvent[]) => void) | undefined;
  private closed = false;

  constructor(requestId?: string) {
    this.requestId = requestId;
  }

  step(event: NewXrayEvent): void {
    const tagged = this.requestId
      ? { ...event, requestId: this.requestId }
      : event;
    if (this.closed) {
      this.sink?.([tagged]);
      return;
    }
    if (this.steps.length < MAX_STEPS_PER_REQUEST) this.steps.push(tagged);
  }

  query(model: string, durationMs: number): void {
    if (this.closed) return; // the summary has already been published
    this.queryCount += 1;
    this.queryMs += durationMs;
    this.models.add(model);
  }

  /**
   * The events for the finished request, in the order they should read: the steps, the
   * database summary, then the request itself. After this, `close` decides where late
   * events go.
   */
  summarise(input: {
    method: string;
    route: string;
    status: number;
    durationMs: number;
  }): NewXrayEvent[] {
    const now = Date.now();
    const events = [...this.steps];
    if (this.queryCount > 0) {
      events.push(
        this.tag(
          dbQueriesEvent({
            ts: now,
            count: this.queryCount,
            totalMs: this.queryMs,
            models: this.models,
          }),
        ),
      );
    }
    events.push(
      this.tag(
        httpRequestEvent({
          ts: now,
          method: input.method,
          route: input.route,
          status: input.status,
          durationMs: input.durationMs,
          ...(this.requestId ? { requestId: this.requestId } : {}),
        }),
      ),
    );
    return events;
  }

  /** `sink` is where events recorded AFTER the response go; undefined drops them. */
  close(sink?: (events: NewXrayEvent[]) => void): void {
    this.closed = true;
    this.sink = sink;
    this.steps.length = 0;
  }

  private tag(event: NewXrayEvent): NewXrayEvent {
    return this.requestId ? { ...event, requestId: this.requestId } : event;
  }
}

const storage = new AsyncLocalStorage<XrayTrace>();

/** Runs `fn` (the rest of the request) with `trace` as the current trace. */
export function runInTrace<T>(trace: XrayTrace, fn: () => T): T {
  return storage.run(trace, fn);
}

/** Records a step in the current request's trace. No trace (a job, a test) = does nothing. */
export function recordXrayStep(event: NewXrayEvent): void {
  storage.getStore()?.step(event);
}

/** Notes one database query in the current request's trace (counted and timed, never logged). */
export function recordDatabaseQuery(model: string, durationMs: number): void {
  storage.getStore()?.query(model, durationMs);
}
