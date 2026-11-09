import { Injectable } from '@nestjs/common';
import { HOUR_MS, SECOND_MS } from '../../common/time.js';
import { AppConfigService } from '../../core/config/config.service.js';
import { RedisService } from '../../core/redis/redis.service.js';
import type { OutboxMessage, OutboxStore } from './outbox.types.js';

const KEY_PREFIX = 'outbox:';

/**
 * Production store: one capped Redis list per organisation, newest first. The list expires
 * with the sandbox itself (DEMO_TTL_HOURS), so captured emails never outlive the demo.
 */
@Injectable()
export class RedisOutboxStore implements OutboxStore {
  constructor(
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
  ) {}

  async add(organizationId: string, message: OutboxMessage): Promise<void> {
    const key = KEY_PREFIX + organizationId;
    const ttlSeconds =
      (this.config.get('DEMO_TTL_HOURS') * HOUR_MS) / SECOND_MS;
    await this.redis.client
      .multi()
      .lpush(key, JSON.stringify(message))
      .ltrim(key, 0, this.config.get('OUTBOX_MAX_MESSAGES') - 1)
      .expire(key, ttlSeconds)
      .exec();
  }

  async list(organizationId: string, limit: number): Promise<OutboxMessage[]> {
    const rows = await this.redis.client.lrange(
      KEY_PREFIX + organizationId,
      0,
      limit - 1,
    );
    const messages: OutboxMessage[] = [];
    for (const row of rows) {
      try {
        const message = JSON.parse(row) as OutboxMessage;
        if (
          typeof message.id === 'string' &&
          typeof message.subject === 'string'
        ) {
          messages.push(message);
        }
      } catch {
        // A row that is not ours is skipped, never shown.
      }
    }
    return messages;
  }
}
