import { randomUUID } from 'node:crypto';
import { RedisService } from '../src/core/redis/redis.service.js';
import { RedisOutboxStore } from '../src/modules/outbox/redis-outbox.store.js';
import type { OutboxMessage } from '../src/modules/outbox/outbox.types.js';
import { testConfig } from './support/test-config.js';

const message = (n: number): OutboxMessage => ({
  id: `id-${n}`,
  ts: 1_000 + n,
  to: `client${n}@example.com`,
  subject: `Invoice INV-${n}`,
  text: `Hello ${n}`,
});

/**
 * The real Redis-backed outbox. Every test uses its own random organisation id and the keys
 * are deleted afterwards, so nothing else in Redis is touched.
 */
describe('RedisOutboxStore (real Redis)', () => {
  const config = testConfig({
    REDIS_URL: process.env.REDIS_URL as string,
    OUTBOX_MAX_MESSAGES: '4',
    DEMO_TTL_HOURS: '2',
  });
  let redis: RedisService;
  let store: RedisOutboxStore;
  const used: string[] = [];
  const org = () => {
    const id = randomUUID();
    used.push(id);
    return id;
  };

  beforeAll(() => {
    redis = new RedisService(config);
    store = new RedisOutboxStore(redis, config);
  });
  afterAll(async () => {
    if (used.length > 0) {
      await redis.client.del(...used.map((id) => `outbox:${id}`));
    }
    await redis.onModuleDestroy();
  });

  it('lists messages newest first and round-trips them unchanged', async () => {
    const id = org();
    await store.add(id, message(1));
    await store.add(id, message(2));
    await store.add(id, message(3));
    const listed = await store.list(id, 10);
    expect(listed.map((m) => m.id)).toEqual(['id-3', 'id-2', 'id-1']);
    expect(listed[0]).toEqual(message(3));
  });

  it('never keeps more than OUTBOX_MAX_MESSAGES', async () => {
    const id = org();
    for (let n = 1; n <= 9; n++) await store.add(id, message(n));
    const listed = await store.list(id, 100);
    expect(listed.map((m) => m.id)).toEqual(['id-9', 'id-8', 'id-7', 'id-6']);
  });

  it('respects the limit asked for when listing', async () => {
    const id = org();
    for (let n = 1; n <= 4; n++) await store.add(id, message(n));
    expect(await store.list(id, 2)).toHaveLength(2);
  });

  it('expires with the sandbox (a TTL of DEMO_TTL_HOURS is set)', async () => {
    const id = org();
    await store.add(id, message(1));
    const ttl = await redis.client.ttl(`outbox:${id}`);
    expect(ttl).toBeGreaterThan(2 * 3600 - 60);
    expect(ttl).toBeLessThanOrEqual(2 * 3600);
  });

  it('keeps organisations apart', async () => {
    const a = org();
    const b = org();
    await store.add(a, message(1));
    await store.add(b, message(2));
    expect((await store.list(a, 10)).map((m) => m.id)).toEqual(['id-1']);
    expect((await store.list(b, 10)).map((m) => m.id)).toEqual(['id-2']);
  });

  it('returns nothing, without error, for an organisation that has none', async () => {
    expect(await store.list(org(), 10)).toEqual([]);
  });

  it('skips a row that is not one of ours instead of showing it or crashing', async () => {
    const id = org();
    await store.add(id, message(1));
    await redis.client.lpush(`outbox:${id}`, 'not json at all');
    await redis.client.lpush(`outbox:${id}`, '{"id":5}');
    expect((await store.list(id, 10)).map((m) => m.id)).toEqual(['id-1']);
  });
});
