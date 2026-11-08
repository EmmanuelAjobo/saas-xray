import { testConfig } from '../../../test/support/test-config.js';
import { tenantCheckEvent } from './xray.events.js';
import { MemoryXrayStore } from './memory-xray.store.js';
import { compareStreamIds, isStreamId, type XrayStore } from './xray.store.js';

const event = (role = 'OWNER') => tenantCheckEvent({ ts: 1, role });

describe('stream ids', () => {
  it.each(['1731000000000-0', '1-1', '0-0', '9999999999999-12'])(
    'accepts %s',
    (id) => expect(isStreamId(id)).toBe(true),
  );
  it.each([
    '',
    'abc',
    '1731000000000',
    '1-',
    '-1',
    '1-1-1',
    '( 1-0',
    '1-0\n',
    '+',
    '$',
    12,
    null,
    undefined,
  ])('rejects %j', (id) => expect(isStreamId(id)).toBe(false));
  it('orders numerically, not alphabetically', () => {
    expect(compareStreamIds('9-0', '10-0')).toBeLessThan(0);
    expect(compareStreamIds('10-0', '9-0')).toBeGreaterThan(0);
    expect(compareStreamIds('5-2', '5-10')).toBeLessThan(0);
    expect(compareStreamIds('5-3', '5-3')).toBe(0);
  });
});

describe('MemoryXrayStore (the behaviour the Redis store must also have)', () => {
  let store: MemoryXrayStore;
  beforeEach(() => {
    store = new MemoryXrayStore(
      testConfig({ XRAY_BUFFER_SIZE: '10', XRAY_REPLAY_DEFAULT: '5' }),
    );
  });

  it('gives events strictly increasing ids', async () => {
    const stored = await store.append(
      'org-a',
      Array.from({ length: 25 }, () => event()),
    );
    const ids = stored.map((e) => e.id);
    for (let i = 1; i < ids.length; i++) {
      expect(
        compareStreamIds(ids[i] as string, ids[i - 1] as string),
      ).toBeGreaterThan(0);
    }
  });

  it('keeps only the newest events up to the buffer size', async () => {
    await store.append(
      'org-a',
      Array.from({ length: 25 }, (_, i) => event(`R${i}`)),
    );
    const kept = await store.latest('org-a', 100);
    expect(kept).toHaveLength(10);
    expect(kept[0]?.meta.role).toBe('R15');
    expect(kept.at(-1)?.meta.role).toBe('R24');
  });

  it('returns the latest N oldest-first', async () => {
    await store.append('org-a', [event('A'), event('B'), event('C')]);
    expect((await store.latest('org-a', 2)).map((e) => e.meta.role)).toEqual([
      'B',
      'C',
    ]);
  });

  it('returns only events strictly after an id', async () => {
    const [first, second, third] = await store.append('org-a', [
      event('A'),
      event('B'),
      event('C'),
    ]);
    expect(
      (await store.after('org-a', (first as { id: string }).id, 10)).map(
        (e) => e.meta.role,
      ),
    ).toEqual(['B', 'C']);
    expect(
      await store.after('org-a', (third as { id: string }).id, 10),
    ).toEqual([]);
    expect(
      (await store.after('org-a', (second as { id: string }).id, 1)).map(
        (e) => e.meta.role,
      ),
    ).toEqual(['C']);
  });

  it('keeps organisations apart', async () => {
    await store.append('org-a', [event('A')]);
    await store.append('org-b', [event('B')]);
    expect((await store.latest('org-a', 10)).map((e) => e.meta.role)).toEqual([
      'A',
    ]);
    expect((await store.latest('org-b', 10)).map((e) => e.meta.role)).toEqual([
      'B',
    ]);
    expect(await store.latest('org-c', 10)).toEqual([]);
  });

  describe('live delivery', () => {
    const collect = async (s: XrayStore, org: string) => {
      const seen: string[] = [];
      const stop = await s.subscribe(org, (e) =>
        seen.push(String(e.meta.role)),
      );
      return { seen, stop };
    };

    it('tells listeners of the SAME organisation only', async () => {
      const a = await collect(store, 'org-a');
      const b = await collect(store, 'org-b');
      await store.append('org-a', [event('for-a')]);
      expect(a.seen).toEqual(['for-a']);
      expect(b.seen).toEqual([]);
    });

    it('stops telling a listener once it unsubscribes', async () => {
      const a = await collect(store, 'org-a');
      await store.append('org-a', [event('one')]);
      await a.stop();
      await store.append('org-a', [event('two')]);
      expect(a.seen).toEqual(['one']);
      expect(store.listenerCount('org-a')).toBe(0);
    });

    it('survives a listener that throws', async () => {
      await store.subscribe('org-a', () => {
        throw new Error('boom');
      });
      const ok = await collect(store, 'org-a');
      await expect(store.append('org-a', [event('x')])).resolves.toHaveLength(
        1,
      );
      expect(ok.seen).toEqual(['x']);
    });
  });
});
