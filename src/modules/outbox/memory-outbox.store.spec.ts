import { testConfig } from '../../../test/support/test-config.js';
import { MemoryOutboxStore } from './memory-outbox.store.js';
import type { OutboxMessage } from './outbox.types.js';

const message = (n: number): OutboxMessage => ({
  id: `id-${n}`,
  ts: n,
  to: `client${n}@example.com`,
  subject: `Invoice ${n}`,
  text: `Hello ${n}`,
});

/** The in-memory store must follow the same rules as the Redis one (tests rely on that). */
describe('MemoryOutboxStore', () => {
  const store = () =>
    new MemoryOutboxStore(testConfig({ OUTBOX_MAX_MESSAGES: '3' }));

  it('lists newest first', async () => {
    const s = store();
    await s.add('org', message(1));
    await s.add('org', message(2));
    expect((await s.list('org', 10)).map((m) => m.id)).toEqual([
      'id-2',
      'id-1',
    ]);
  });

  it('keeps only the newest OUTBOX_MAX_MESSAGES, in the store itself (not just when reading)', async () => {
    const s = store();
    for (let n = 1; n <= 8; n++) await s.add('org', message(n));
    // Asking for far more than the cap still returns only what the store kept.
    expect((await s.list('org', 1_000)).map((m) => m.id)).toEqual([
      'id-8',
      'id-7',
      'id-6',
    ]);
  });

  it('honours the limit asked for', async () => {
    const s = store();
    for (let n = 1; n <= 3; n++) await s.add('org', message(n));
    expect(await s.list('org', 1)).toHaveLength(1);
  });

  it('keeps organisations apart', async () => {
    const s = store();
    await s.add('a', message(1));
    await s.add('b', message(2));
    expect((await s.list('a', 10)).map((m) => m.id)).toEqual(['id-1']);
    expect(await s.list('c', 10)).toEqual([]);
  });
});
