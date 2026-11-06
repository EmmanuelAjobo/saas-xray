import { Injectable, Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { SECOND_MS } from '../../common/time.js';
import { RedisService } from '../redis/redis.service.js';

/**
 * Atomic fixed-window counter. One round trip; the INCR, the window start and the block
 * decision cannot interleave with another instance's request.
 *
 * KEYS[1] hits, KEYS[2] block marker; ARGV: window ms, limit, block ms.
 * Returns {hits, windowMsLeft, blocked(0|1), blockMsLeft}.
 */
const SCRIPT = `
if redis.call('EXISTS', KEYS[2]) == 1 then
  local current = tonumber(redis.call('GET', KEYS[1]) or '0')
  return {current, math.max(redis.call('PTTL', KEYS[1]), 0), 1, math.max(redis.call('PTTL', KEYS[2]), 0)}
end
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if hits == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
if hits > tonumber(ARGV[2]) then
  local block = tonumber(ARGV[3])
  if block > 0 then
    redis.call('SET', KEYS[2], '1', 'PX', block)
    return {hits, ttl, 1, block}
  end
  return {hits, ttl, 1, ttl}
end
return {hits, ttl, 0, 0}
`;

type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

const toSeconds = (ms: number): number => Math.ceil(ms / SECOND_MS);

/**
 * Rate-limit counters shared by every API instance (an in-memory counter would let an
 * attacker multiply their allowance by the number of instances).
 *
 * Fails open: if Redis is unreachable, requests are allowed and the error is logged.
 * Locking every user out of login because the cache is down would turn a Redis blip into a
 * full outage; password hashing cost still bounds brute force while it lasts.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitsKey = `rl:${throttlerName}:${key}`;
    try {
      const [hits, windowMs, blocked, blockMs] = (await this.redis.client.eval(
        SCRIPT,
        2,
        hitsKey,
        `${hitsKey}:block`,
        ttl,
        limit,
        blockDuration,
      )) as [number, number, number, number];
      return {
        totalHits: hits,
        timeToExpire: toSeconds(windowMs),
        isBlocked: blocked === 1,
        timeToBlockExpire: toSeconds(blockMs),
      };
    } catch (error) {
      this.logger.error(
        `Rate limiter unavailable, allowing request: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        totalHits: 0,
        timeToExpire: 0,
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }
}
