import { testConfig } from '../../../test/support/test-config.js';
import { NotFoundError } from '../../common/errors/domain-errors.js';
import type {
  RequestAuth,
  RequestContextService,
  RequestTenant,
} from '../../core/context/request-context.service.js';
import { MemoryOutboxStore } from './memory-outbox.store.js';
import { MAX_BODY_LENGTH, MAX_SUBJECT_LENGTH } from './outbox.limits.js';
import { OutboxService } from './outbox.service.js';
import type { OutboxStore } from './outbox.types.js';

const ORG = 'org-a';
const mail = (n: number) => ({
  to: `client${n}@example.com`,
  subject: `Invoice INV-${n}`,
  text: `Hello ${n}`,
});

function setup(
  who: { isDemo?: boolean; role?: RequestTenant['role'] } = {},
  env: Record<string, string> = {},
  storeOverride?: OutboxStore,
) {
  const config = testConfig({ OUTBOX_MAX_MESSAGES: '5', ...env });
  const store = storeOverride ?? new MemoryOutboxStore(config);
  const context = {
    auth: {
      userId: 'u',
      sessionId: 's',
      isDemo: who.isDemo ?? true,
    } satisfies RequestAuth,
    tenant: {
      organizationId: ORG,
      membershipId: 'm',
      role: who.role ?? 'OWNER',
    } satisfies RequestTenant,
  } as unknown as RequestContextService;
  return { store, service: new OutboxService(store, config, context) };
}

describe('OutboxService.capture', () => {
  it('keeps a message with an id and a time, newest first', async () => {
    const { service } = setup();
    await service.capture(ORG, mail(1));
    await service.capture(ORG, mail(2));
    const { data } = await service.list();
    expect(data.map((m) => m.subject)).toEqual([
      'Invoice INV-2',
      'Invoice INV-1',
    ]);
    expect(data[0]).toMatchObject({
      to: 'client2@example.com',
      text: 'Hello 2',
    });
    expect(typeof data[0]?.id).toBe('string');
    expect(data[0]?.ts).toBeGreaterThan(0);
    expect(data[0]?.id).not.toBe(data[1]?.id);
  });

  it('keeps only the newest OUTBOX_MAX_MESSAGES', async () => {
    const { service } = setup();
    for (let n = 1; n <= 9; n++) await service.capture(ORG, mail(n));
    const { data } = await service.list();
    expect(data).toHaveLength(5);
    expect(data[0]?.subject).toBe('Invoice INV-9');
    expect(data.at(-1)?.subject).toBe('Invoice INV-5');
  });

  it('cuts an over-long subject and body instead of storing them whole', async () => {
    const { service } = setup();
    await service.capture(ORG, {
      to: 'a@example.com',
      subject: 's'.repeat(MAX_SUBJECT_LENGTH * 3),
      text: 'b'.repeat(MAX_BODY_LENGTH * 3),
    });
    const [message] = (await service.list()).data;
    expect(message?.subject).toHaveLength(MAX_SUBJECT_LENGTH);
    expect(message?.text).toHaveLength(MAX_BODY_LENGTH);
  });

  it('never throws when the store fails (a sent invoice must not fail over a display feature)', async () => {
    const broken: OutboxStore = {
      add: () => Promise.reject(new Error('redis is down')),
      list: () => Promise.resolve([]),
    };
    const { service } = setup({}, {}, broken);
    await expect(service.capture(ORG, mail(1))).resolves.toBeUndefined();
  });

  it('keeps organisations apart', async () => {
    const { service, store } = setup();
    await service.capture('org-b', mail(1));
    expect((await service.list()).data).toEqual([]);
    expect(await store.list('org-b', 10)).toHaveLength(1);
  });
});

describe('OutboxService.list: demo sandboxes only', () => {
  it('shows a demo sandbox its own messages, whatever its role (a visitor may switch persona)', async () => {
    for (const role of ['OWNER', 'ADMIN', 'MEMBER'] as const) {
      const { service } = setup({ isDemo: true, role });
      await service.capture(ORG, mail(1));
      expect((await service.list()).data).toHaveLength(1);
    }
  });

  it('answers 404 for a real organisation (its email is really sent; there is no outbox)', async () => {
    const { service } = setup({ isDemo: false });
    await expect(service.list()).rejects.toBeInstanceOf(NotFoundError);
  });

  it('answers 404 with no verified caller or tenant', async () => {
    const config = testConfig();
    const service = new OutboxService(
      new MemoryOutboxStore(config),
      config,
      {} as RequestContextService,
    );
    await expect(service.list()).rejects.toBeInstanceOf(NotFoundError);
  });
});
