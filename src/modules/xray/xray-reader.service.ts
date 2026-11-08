import { Inject, Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  ForbiddenError,
  LimitReachedError,
} from '../../common/errors/domain-errors.js';
import { SECOND_MS } from '../../common/time.js';
import { AppConfigService } from '../../core/config/config.service.js';
import { RequestContextService } from '../../core/context/request-context.service.js';
import type { XrayEvent } from '../../core/xray/xray.events.js';
import {
  XRAY_STORE,
  type XrayStore,
  compareStreamIds,
  isStreamId,
} from '../../core/xray/xray.store.js';
import { can } from '../tenancy/permissions.js';

/** What Nest's @Sse() sends: `type` is the SSE event name, `id` enables Last-Event-ID resume. */
export interface StreamMessage {
  id?: string;
  type: 'xray' | 'heartbeat';
  data: XrayEvent | { ts: number };
}

export interface EventsPage {
  data: XrayEvent[];
  cursor: string | null;
}

/**
 * Reads the X-ray for the caller's own organisation: history (polling) and a live stream.
 *
 * Who may watch: in a demo sandbox, every persona (it is private to one visitor and the
 * panel is the point of the demo); in a real organisation, managers only, because events
 * show what teammates did and when.
 */
@Injectable()
export class XrayReaderService {
  private readonly streamsByUser = new Map<string, number>();

  constructor(
    @Inject(XRAY_STORE) private readonly store: XrayStore,
    private readonly config: AppConfigService,
    private readonly context: RequestContextService,
  ) {}

  /** Who is asking and for which organisation. Both come from the verified request. */
  private caller(): { userId: string; organizationId: string } {
    const auth = this.context.auth;
    const tenant = this.context.tenant;
    if (!auth || !tenant) throw new ForbiddenError('Not allowed.');
    if (!auth.isDemo && !can(tenant.role, 'audit:read')) {
      throw new ForbiddenError(
        'Only owners and admins can open the X-ray of a real organisation.',
      );
    }
    return { userId: auth.userId, organizationId: tenant.organizationId };
  }

  async list(query: { limit?: number; after?: string }): Promise<EventsPage> {
    const { organizationId } = this.caller();
    const limit = Math.min(
      query.limit ?? this.config.get('XRAY_REPLAY_DEFAULT'),
      this.config.get('XRAY_BUFFER_SIZE'),
    );
    const data = isStreamId(query.after)
      ? await this.store.after(organizationId, query.after, limit)
      : await this.store.latest(organizationId, limit);
    return {
      data,
      cursor: data.at(-1)?.id ?? query.after ?? null,
    };
  }

  /**
   * A live feed: recent history first (or everything after `resumeFrom`), then new events
   * as they happen, with a keep-alive. Ends by itself after XRAY_STREAM_MAX_SECONDS; the
   * client reconnects (sending Last-Event-ID) and permission is checked again.
   *
   * Refusals (not allowed, too many streams) are thrown HERE, before the response starts,
   * so the client gets a normal error and not a half-open stream.
   */
  stream(resumeFrom?: string): Observable<StreamMessage> {
    const { userId, organizationId } = this.caller();

    const open = this.streamsByUser.get(userId) ?? 0;
    if (open >= this.config.get('XRAY_MAX_STREAMS_PER_USER')) {
      throw new LimitReachedError(
        `You already have ${open} live X-ray streams open. Close one first.`,
      );
    }
    this.streamsByUser.set(userId, open + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (this.streamsByUser.get(userId) ?? 1) - 1;
      if (left <= 0) this.streamsByUser.delete(userId);
      else this.streamsByUser.set(userId, left);
    };

    const cursor = isStreamId(resumeFrom) ? resumeFrom : undefined;
    const bufferSize = this.config.get('XRAY_BUFFER_SIZE');
    const replayDefault = this.config.get('XRAY_REPLAY_DEFAULT');
    const heartbeatMs = this.config.get('XRAY_HEARTBEAT_SECONDS') * SECOND_MS;
    const maxMs = this.config.get('XRAY_STREAM_MAX_SECONDS') * SECOND_MS;

    return new Observable<StreamMessage>((subscriber) => {
      let closed = false;
      let replaying = true;
      let lastId = cursor ?? '0-0';
      const waiting: XrayEvent[] = [];
      let unsubscribe: (() => Promise<void>) | undefined;

      /** Sends an event unless the client already has it (history and live can overlap). */
      const send = (event: XrayEvent) => {
        if (closed || compareStreamIds(event.id, lastId) <= 0) return;
        lastId = event.id;
        subscriber.next({ id: event.id, type: 'xray', data: event });
      };

      void (async () => {
        // Subscribe BEFORE reading history, so nothing falls in the gap between the two.
        unsubscribe = await this.store.subscribe(organizationId, (event) => {
          if (replaying) waiting.push(event);
          else send(event);
        });
        if (closed) {
          await unsubscribe();
          return;
        }
        const history = cursor
          ? await this.store.after(organizationId, cursor, bufferSize)
          : await this.store.latest(organizationId, replayDefault);
        for (const event of history) send(event);
        waiting.sort((a, b) => compareStreamIds(a.id, b.id));
        for (const event of waiting) send(event);
        waiting.length = 0;
        replaying = false;
      })().catch(() => {
        // The store is unreachable: end the stream; the client will retry.
        subscriber.complete();
      });

      const heartbeat = setInterval(() => {
        if (!closed)
          subscriber.next({ type: 'heartbeat', data: { ts: Date.now() } });
      }, heartbeatMs);
      const limit = setTimeout(() => subscriber.complete(), maxMs);

      return () => {
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(limit);
        release();
        void unsubscribe?.().catch(() => undefined);
      };
    });
  }
}
