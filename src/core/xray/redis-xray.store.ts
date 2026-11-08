import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppConfigService } from '../config/config.service.js';
import { RedisService } from '../redis/redis.service.js';
import type { NewXrayEvent, XrayEvent } from './xray.events.js';
import type { XrayStore } from './xray.store.js';

const STREAM_PREFIX = 'xray:stream:';
const CHANNEL_PREFIX = 'xray:live:';

interface Subscription {
  listeners: Set<(event: XrayEvent) => void>;
  /** Resolves when Redis has confirmed the subscription. */
  ready: Promise<void>;
}

/**
 * Production store. Each organisation has a capped Redis Stream (history, with ids that
 * order events and let a reconnecting client resume) plus a pub/sub channel (live delivery
 * to every API instance). One shared subscriber connection serves all streams of a process.
 *
 * The caller (XrayService) treats failures as non-events: X-ray must never break a request.
 */
@Injectable()
export class RedisXrayStore implements XrayStore, OnModuleDestroy {
  private readonly logger = new Logger(RedisXrayStore.name);
  private subscriber: Redis | undefined;
  private readonly subscriptions = new Map<string, Subscription>();

  constructor(
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
  ) {}

  async append(
    organizationId: string,
    events: NewXrayEvent[],
  ): Promise<XrayEvent[]> {
    const key = STREAM_PREFIX + organizationId;
    const write = this.redis.client.pipeline();
    for (const event of events) {
      // MAXLEN = exact: the history never exceeds the configured size.
      write.xadd(
        key,
        'MAXLEN',
        '=',
        this.config.get('XRAY_BUFFER_SIZE'),
        '*',
        'e',
        JSON.stringify(event),
      );
    }
    write.expire(key, this.config.get('XRAY_BUFFER_TTL_SECONDS'));
    const results = (await write.exec()) ?? [];

    const stored = events.map((event, index) => {
      const [error, id] = results[index] ?? [new Error('no reply'), null];
      if (error || typeof id !== 'string') {
        throw error ?? new Error('Redis returned no stream id');
      }
      return { ...event, id };
    });

    const publish = this.redis.client.pipeline();
    for (const event of stored) {
      publish.publish(CHANNEL_PREFIX + organizationId, JSON.stringify(event));
    }
    await publish.exec();
    return stored;
  }

  async latest(organizationId: string, limit: number): Promise<XrayEvent[]> {
    const rows = await this.redis.client.xrevrange(
      STREAM_PREFIX + organizationId,
      '+',
      '-',
      'COUNT',
      limit,
    );
    return rows.map(parseRow).filter(isEvent).reverse();
  }

  async after(
    organizationId: string,
    afterId: string,
    limit: number,
  ): Promise<XrayEvent[]> {
    // "(" makes the start exclusive: strictly after the id the client already has.
    const rows = await this.redis.client.xrange(
      STREAM_PREFIX + organizationId,
      `(${afterId}`,
      '+',
      'COUNT',
      limit,
    );
    return rows.map(parseRow).filter(isEvent);
  }

  async subscribe(
    organizationId: string,
    listener: (event: XrayEvent) => void,
  ): Promise<() => Promise<void>> {
    const subscriber = this.ensureSubscriber();
    let subscription = this.subscriptions.get(organizationId);
    if (!subscription) {
      subscription = {
        listeners: new Set(),
        ready: subscriber
          .subscribe(CHANNEL_PREFIX + organizationId)
          .then(() => undefined),
      };
      this.subscriptions.set(organizationId, subscription);
    }
    subscription.listeners.add(listener);
    try {
      await subscription.ready;
    } catch (error) {
      subscription.listeners.delete(listener);
      if (subscription.listeners.size === 0) {
        this.subscriptions.delete(organizationId);
      }
      throw error;
    }

    const current = subscription;
    return async () => {
      current.listeners.delete(listener);
      if (
        current.listeners.size === 0 &&
        this.subscriptions.get(organizationId) === current
      ) {
        this.subscriptions.delete(organizationId);
        try {
          await subscriber.unsubscribe(CHANNEL_PREFIX + organizationId);
        } catch (error) {
          this.logger.warn(
            `Could not unsubscribe an X-ray channel: ${errorText(error)}`,
          );
        }
      }
    };
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.subscriber) return;
    try {
      await this.subscriber.quit();
    } catch {
      this.subscriber.disconnect();
    }
  }

  /** Created on first use, so an API nobody streams from holds no extra connection. */
  private ensureSubscriber(): Redis {
    if (this.subscriber) return this.subscriber;
    const subscriber = this.redis.client.duplicate();
    subscriber.on('error', (error: Error) => {
      this.logger.error(`X-ray subscriber error: ${error.message}`);
    });
    subscriber.on('message', (channel: string, payload: string) => {
      if (!channel.startsWith(CHANNEL_PREFIX)) return;
      const listeners = this.subscriptions.get(
        channel.slice(CHANNEL_PREFIX.length),
      )?.listeners;
      if (!listeners?.size) return;
      let event: unknown;
      try {
        event = JSON.parse(payload);
      } catch {
        return;
      }
      if (!isEvent(event)) return;
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          this.logger.warn(`An X-ray listener threw: ${errorText(error)}`);
        }
      }
    });
    this.subscriber = subscriber;
    return subscriber;
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** [id, [field, value, ...]] from XRANGE → an event, or undefined if it is not one of ours. */
function parseRow(row: [string, string[]]): XrayEvent | undefined {
  const [id, fields] = row;
  const json = fields[fields.indexOf('e') + 1];
  if (json === undefined) return undefined;
  try {
    const event = JSON.parse(json) as Record<string, unknown>;
    return { ...event, id } as unknown as XrayEvent;
  } catch {
    return undefined;
  }
}

function isEvent(value: unknown): value is XrayEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === 'string' &&
    typeof event.kind === 'string' &&
    typeof event.ts === 'number' &&
    typeof event.title === 'string'
  );
}
