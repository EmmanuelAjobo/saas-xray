import { randomUUID } from 'node:crypto';
import { RedisService } from '../src/core/redis/redis.service.js';
import { RedisXrayStore } from '../src/core/xray/redis-xray.store.js';
import { tenantCheckEvent } from '../src/core/xray/xray.events.js';
import {
  compareStreamIds,
  type XrayStore,
} from '../src/core/xray/xray.store.js';
import { testConfig } from './support/test-config.js';

const event = (role = 'OWNER') => tenantCheckEvent({ ts: 1, role });
const settle = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
const redisUrl = () => process.env.REDIS_URL as string;

/**
 * The real Redis Streams store. Every test uses its own random organisation ids, and the
 * keys they create are deleted afterwards, so nothing else in Redis is touched.
 */
describe('RedisXrayStore (real Redis)', () => {
  const config = testConfig({
    REDIS_URL: redisUrl(),
    XRAY_BUFFER_SIZE: '10',
    XRAY_REPLAY_DEFAULT: '5',
    XRAY_BUFFER_TTL_SECONDS: '120',
  });
  let redis: RedisService;
  let store: RedisXrayStore;
  /** A second API instance: its own connections, same Redis. */
  let otherRedis: RedisService;
  let otherStore: RedisXrayStore;
  const used: string[] = [];
  const org = () => {
    const id = randomUUID();
    used.push(id);
    return id;
  };

  beforeAll(() => {
    redis = new RedisService(config);
    store = new RedisXrayStore(redis, config);
    otherRedis = new RedisService(config);
    otherStore = new RedisXrayStore(otherRedis, config);
  });
  afterAll(async () => {
    if (used.length > 0) {
      await redis.client.del(...used.map((id) => `xray:stream:${id}`));
    }
    await store.onModuleDestroy();
    await otherStore.onModuleDestroy();
    await redis.onModuleDestroy();
    await otherRedis.onModuleDestroy();
  });

  it('gives events strictly increasing ids and returns them with the ids Redis issued', async () => {
    const id = org();
    const stored = await store.append(
      id,
      Array.from({ length: 8 }, () => event()),
    );
    expect(stored).toHaveLength(8);
    for (let i = 1; i < stored.length; i++) {
      expect(
        compareStreamIds(stored[i]?.id as string, stored[i - 1]?.id as string),
      ).toBeGreaterThan(0);
    }
    expect(stored[0]?.id).toMatch(/^\d+-\d+$/);
  });

  it('reads the latest events oldest-first, and strictly-after an id', async () => {
    const id = org();
    const [a, b, c] = await store.append(id, [
      event('A'),
      event('B'),
      event('C'),
    ]);
    expect((await store.latest(id, 10)).map((e) => e.meta.role)).toEqual([
      'A',
      'B',
      'C',
    ]);
    expect((await store.latest(id, 2)).map((e) => e.meta.role)).toEqual([
      'B',
      'C',
    ]);
    expect(
      (await store.after(id, (a as { id: string }).id, 10)).map(
        (e) => e.meta.role,
      ),
    ).toEqual(['B', 'C']);
    expect(await store.after(id, (c as { id: string }).id, 10)).toEqual([]);
    expect(
      (await store.after(id, (b as { id: string }).id, 10)).map(
        (e) => e.meta.role,
      ),
    ).toEqual(['C']);
  });

  it('round-trips an event unchanged (apart from the id)', async () => {
    const id = org();
    const original = event('ADMIN');
    const [stored] = await store.append(id, [original]);
    const [read] = await store.latest(id, 1);
    expect(read).toEqual(stored);
    expect(read).toMatchObject(original);
  });

  it('never keeps more than XRAY_BUFFER_SIZE events', async () => {
    const id = org();
    await store.append(
      id,
      Array.from({ length: 25 }, (_, i) => event(`R${i}`)),
    );
    const kept = await store.latest(id, 100);
    expect(kept).toHaveLength(10);
    expect(kept[0]?.meta.role).toBe('R15');
    expect(kept.at(-1)?.meta.role).toBe('R24');
  });

  it('expires an idle organisation’s history (a TTL is set)', async () => {
    const id = org();
    await store.append(id, [event()]);
    const ttl = await redis.client.ttl(`xray:stream:${id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it('keeps organisations apart', async () => {
    const a = org();
    const b = org();
    await store.append(a, [event('A')]);
    await store.append(b, [event('B')]);
    expect((await store.latest(a, 10)).map((e) => e.meta.role)).toEqual(['A']);
    expect((await store.latest(b, 10)).map((e) => e.meta.role)).toEqual(['B']);
  });

  it('returns nothing, without error, for an organisation with no events', async () => {
    const id = org();
    expect(await store.latest(id, 10)).toEqual([]);
    expect(await store.after(id, '0-0', 10)).toEqual([]);
  });

  describe('live delivery across API instances', () => {
    const collect = async (s: XrayStore, id: string) => {
      const seen: string[] = [];
      const stop = await s.subscribe(id, (e) => seen.push(String(e.meta.role)));
      return { seen, stop };
    };

    it('reaches a subscriber on ANOTHER instance, in order, with the same ids as the history', async () => {
      const id = org();
      const remote = await collect(otherStore, id);
      const stored = await store.append(id, [event('one'), event('two')]);
      await settle();
      expect(remote.seen).toEqual(['one', 'two']);

      const seenIds: string[] = [];
      const stop = await otherStore.subscribe(id, (e) => seenIds.push(e.id));
      const [third] = await store.append(id, [event('three')]);
      await settle();
      expect(seenIds).toEqual([(third as { id: string }).id]);
      expect(stored[0]?.id).toBeDefined();
      await stop();
      await remote.stop();
    });

    it('tells only the subscribers of that organisation', async () => {
      const a = org();
      const b = org();
      const inA = await collect(otherStore, a);
      const inB = await collect(otherStore, b);
      await store.append(a, [event('for-a')]);
      await settle();
      expect(inA.seen).toEqual(['for-a']);
      expect(inB.seen).toEqual([]);
      await inA.stop();
      await inB.stop();
    });

    it('stops telling a listener after it unsubscribes, while the others keep receiving', async () => {
      const id = org();
      const first = await collect(otherStore, id);
      const second = await collect(otherStore, id);
      await store.append(id, [event('x')]);
      await settle();
      await first.stop();
      await store.append(id, [event('y')]);
      await settle();
      expect(first.seen).toEqual(['x']);
      expect(second.seen).toEqual(['x', 'y']);
      await second.stop();
      await store.append(id, [event('z')]);
      await settle();
      expect(second.seen).toEqual(['x', 'y']);
    });

    it('lets two listeners subscribe at the same moment without losing either', async () => {
      const id = org();
      const [one, two] = await Promise.all([
        collect(otherStore, id),
        collect(otherStore, id),
      ]);
      await store.append(id, [event('both')]);
      await settle();
      expect(one.seen).toEqual(['both']);
      expect(two.seen).toEqual(['both']);
      await one.stop();
      await two.stop();
    });

    it('ignores garbage published on a channel and keeps working', async () => {
      const id = org();
      const listener = await collect(otherStore, id);
      await redis.client.publish(`xray:live:${id}`, 'not json at all');
      await redis.client.publish(`xray:live:${id}`, '{"kind":42}');
      await store.append(id, [event('real')]);
      await settle();
      expect(listener.seen).toEqual(['real']);
      await listener.stop();
    });

    it('survives a listener that throws', async () => {
      const id = org();
      await otherStore.subscribe(id, () => {
        throw new Error('boom');
      });
      const ok = await collect(otherStore, id);
      await store.append(id, [event('still-delivered')]);
      await settle();
      expect(ok.seen).toEqual(['still-delivered']);
    });
  });
});
