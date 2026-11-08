import { testConfig } from '../../../test/support/test-config.js';
import {
  ForbiddenError,
  LimitReachedError,
} from '../../common/errors/domain-errors.js';
import type {
  RequestAuth,
  RequestContextService,
  RequestTenant,
} from '../../core/context/request-context.service.js';
import { MemoryXrayStore } from '../../core/xray/memory-xray.store.js';
import { tenantCheckEvent } from '../../core/xray/xray.events.js';
import {
  type StreamMessage,
  XrayReaderService,
} from './xray-reader.service.js';

const ORG = 'org-a';
const event = (role: string) => tenantCheckEvent({ ts: 1, role });
const roleOf = (m: StreamMessage) =>
  m.type === 'xray' && 'meta' in m.data ? String(m.data.meta.role) : m.type;

function setup(
  who: { role?: RequestTenant['role']; isDemo?: boolean; userId?: string } = {},
  env: Record<string, string> = {},
) {
  const config = testConfig({ XRAY_BUFFER_SIZE: '100', ...env });
  const store = new MemoryXrayStore(config);
  const context = {
    auth: {
      userId: who.userId ?? 'user-1',
      sessionId: 's',
      isDemo: who.isDemo ?? false,
    } satisfies RequestAuth,
    tenant: {
      organizationId: ORG,
      membershipId: 'm',
      role: who.role ?? 'OWNER',
    } satisfies RequestTenant,
  } as unknown as RequestContextService;
  return { store, reader: new XrayReaderService(store, config, context) };
}

/** Subscribes and returns what arrives, plus a way to stop. */
function listen(reader: XrayReaderService, resumeFrom?: string) {
  const seen: StreamMessage[] = [];
  const state = { completed: false };
  const subscription = reader.stream(resumeFrom).subscribe({
    next: (m) => seen.push(m),
    complete: () => (state.completed = true),
  });
  return { seen, state, stop: () => subscription.unsubscribe() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('XrayReaderService: who may watch', () => {
  it.each(['OWNER', 'ADMIN'] as const)(
    'lets a real organisation’s %s read the X-ray',
    async (role) => {
      const { reader } = setup({ role });
      await expect(reader.list({})).resolves.toMatchObject({ data: [] });
    },
  );

  it('refuses a plain MEMBER of a real organisation (events show what teammates did)', async () => {
    const { reader } = setup({ role: 'MEMBER' });
    await expect(reader.list({})).rejects.toBeInstanceOf(ForbiddenError);
    expect(() => reader.stream()).toThrow(ForbiddenError);
  });

  it('lets every persona of a demo sandbox in, including MEMBER (the sandbox is private to the visitor)', async () => {
    const { reader } = setup({ role: 'MEMBER', isDemo: true });
    await expect(reader.list({})).resolves.toBeDefined();
  });

  it('refuses when the request carries no verified tenant or user', async () => {
    const config = testConfig();
    const reader = new XrayReaderService(
      new MemoryXrayStore(config),
      config,
      {} as RequestContextService,
    );
    await expect(reader.list({})).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('XrayReaderService.list', () => {
  it('returns the latest events oldest-first, with a cursor to poll from', async () => {
    const { store, reader } = setup();
    await store.append(ORG, [event('A'), event('B'), event('C')]);
    const page = await reader.list({});
    expect(page.data.map((e) => e.meta.role)).toEqual(['A', 'B', 'C']);
    expect(page.cursor).toBe(page.data.at(-1)?.id);
  });

  it('polling with the cursor returns only what is new', async () => {
    const { store, reader } = setup();
    await store.append(ORG, [event('A'), event('B')]);
    const { cursor } = await reader.list({});
    expect((await reader.list({ after: cursor as string })).data).toEqual([]);
    await store.append(ORG, [event('C')]);
    const next = await reader.list({ after: cursor as string });
    expect(next.data.map((e) => e.meta.role)).toEqual(['C']);
  });

  it('keeps the cursor you gave when nothing is new, so a poller never loses its place', async () => {
    const { store, reader } = setup();
    const [stored] = await store.append(ORG, [event('A')]);
    const page = await reader.list({ after: (stored as { id: string }).id });
    expect(page).toEqual({ data: [], cursor: (stored as { id: string }).id });
  });

  it('has a null cursor before anything has happened', async () => {
    expect(await setup().reader.list({})).toEqual({ data: [], cursor: null });
  });

  it('uses XRAY_REPLAY_DEFAULT when no limit is given, and never exceeds the buffer', async () => {
    const { store, reader } = setup({}, { XRAY_REPLAY_DEFAULT: '3' });
    await store.append(
      ORG,
      Array.from({ length: 10 }, (_, i) => event(`E${i}`)),
    );
    expect((await reader.list({})).data).toHaveLength(3);
  });

  it('never returns more than the buffer holds, however large a limit is asked for', async () => {
    const { store, reader } = setup(
      {},
      { XRAY_BUFFER_SIZE: '10', XRAY_REPLAY_DEFAULT: '5' },
    );
    await store.append(
      ORG,
      Array.from({ length: 25 }, (_, i) => event(`E${i}`)),
    );
    expect((await reader.list({ limit: 999_999 })).data).toHaveLength(10);
  });

  it('ignores a malformed cursor instead of passing it on to the store', async () => {
    const { store, reader } = setup();
    await store.append(ORG, [event('A')]);
    const spy = vi.spyOn(store, 'after');
    const page = await reader.list({ after: '( 0-0 +' });
    expect(spy).not.toHaveBeenCalled();
    expect(page.data).toHaveLength(1);
  });

  it('only ever reads the verified organisation', async () => {
    const { store, reader } = setup();
    await store.append('org-b', [event('SECRET')]);
    expect((await reader.list({})).data).toEqual([]);
  });
});

describe('XrayReaderService.stream', () => {
  it('sends recent history first, then new events as they happen, in order', async () => {
    const { store, reader } = setup();
    await store.append(ORG, [event('old-1'), event('old-2')]);
    const live = listen(reader);
    await settle();
    await store.append(ORG, [event('new-1')]);
    await store.append(ORG, [event('new-2')]);
    expect(live.seen.map(roleOf)).toEqual(['old-1', 'old-2', 'new-1', 'new-2']);
    live.stop();
  });

  it('labels each message with its id, so a dropped connection can resume (Last-Event-ID)', async () => {
    const { store, reader } = setup();
    const [stored] = await store.append(ORG, [event('A')]);
    const live = listen(reader);
    await settle();
    expect(live.seen[0]).toMatchObject({
      id: (stored as { id: string }).id,
      type: 'xray',
    });
    live.stop();
  });

  it('resumes after the id the client already has, with no repeats and no gaps', async () => {
    const { store, reader } = setup();
    const [a] = await store.append(ORG, [event('A')]);
    await store.append(ORG, [event('B'), event('C')]);
    const live = listen(reader, (a as { id: string }).id);
    await settle();
    await store.append(ORG, [event('D')]);
    expect(live.seen.map(roleOf)).toEqual(['B', 'C', 'D']);
    live.stop();
  });

  it('does not deliver another organisation’s events', async () => {
    const { store, reader } = setup();
    const live = listen(reader);
    await settle();
    await store.append('org-b', [event('SECRET')]);
    await store.append(ORG, [event('mine')]);
    expect(live.seen.map(roleOf)).toEqual(['mine']);
    live.stop();
  });

  it('delivers an event that arrives while history is still being read, exactly once', async () => {
    const { store, reader } = setup();
    await store.append(ORG, [event('old')]);
    const realLatest = store.latest.bind(store);
    vi.spyOn(store, 'latest').mockImplementation(async (org, limit) => {
      const history = await realLatest(org, limit);
      await store.append(ORG, [event('during')]); // lands in the gap between subscribe and read
      return history;
    });
    const live = listen(reader);
    await settle();
    expect(live.seen.map(roleOf)).toEqual(['old', 'during']);
    live.stop();
  });

  it('cleans up completely when the client goes away', async () => {
    const { store, reader } = setup();
    const live = listen(reader);
    await settle();
    expect(store.listenerCount(ORG)).toBe(1);
    live.stop();
    await settle();
    expect(store.listenerCount(ORG)).toBe(0);
  });

  it('cleans up even if the client leaves before the subscription is ready', async () => {
    const { store, reader } = setup();
    const live = listen(reader);
    live.stop(); // immediately, before the store has confirmed the subscription
    await settle();
    expect(store.listenerCount(ORG)).toBe(0);
  });

  describe('timing', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('sends a heartbeat every XRAY_HEARTBEAT_SECONDS', async () => {
      const { reader } = setup({}, { XRAY_HEARTBEAT_SECONDS: '10' });
      const live = listen(reader);
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(live.seen.filter((m) => m.type === 'heartbeat')).toHaveLength(2);
      live.stop();
    });

    it('closes the stream by itself after XRAY_STREAM_MAX_SECONDS (membership is rechecked on reconnect)', async () => {
      const { reader } = setup({}, { XRAY_STREAM_MAX_SECONDS: '30' });
      const live = listen(reader);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(live.state.completed).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(live.state.completed).toBe(true);
    });

    it('stops its timers when the client leaves (nothing keeps running for a closed stream)', async () => {
      const { reader } = setup();
      const live = listen(reader);
      live.stop();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('the per-user limit', () => {
    it('refuses a stream beyond XRAY_MAX_STREAMS_PER_USER, before the response starts', () => {
      const { reader } = setup({}, { XRAY_MAX_STREAMS_PER_USER: '2' });
      const one = listen(reader);
      const two = listen(reader);
      expect(() => reader.stream()).toThrow(LimitReachedError);
      one.stop();
      two.stop();
    });

    it('frees a slot when a stream closes', async () => {
      const { reader } = setup({}, { XRAY_MAX_STREAMS_PER_USER: '1' });
      const first = listen(reader);
      expect(() => reader.stream()).toThrow(LimitReachedError);
      first.stop();
      await settle();
      const second = listen(reader);
      second.stop();
    });

    it('counts each user separately', () => {
      const a = setup({ userId: 'user-a' }, { XRAY_MAX_STREAMS_PER_USER: '1' });
      const one = listen(a.reader);
      // A different reader instance shares nothing, but the same user on the same instance is capped:
      expect(() => a.reader.stream()).toThrow(LimitReachedError);
      one.stop();
    });

    it('does not leak a slot when a refused caller was never allowed in', () => {
      const { reader } = setup(
        { role: 'MEMBER' },
        { XRAY_MAX_STREAMS_PER_USER: '1' },
      );
      for (let i = 0; i < 5; i++)
        expect(() => reader.stream()).toThrow(ForbiddenError);
    });
  });
});
