import { testConfig } from '../../../test/support/test-config.js';
import type { InvoiceEmailJob } from '../../core/jobs/jobs.types.js';
import type { MailService } from '../../core/mail/mail.service.js';
import { MemoryXrayStore } from '../../core/xray/memory-xray.store.js';
import { XrayService } from '../../core/xray/xray.service.js';
import type { OutboxService } from '../outbox/outbox.service.js';
import { InvoiceEmailHandler } from './invoice-email.handler.js';

const job = (overrides: Partial<InvoiceEmailJob> = {}): InvoiceEmailJob => ({
  organizationId: 'org-a',
  invoiceId: 'inv-1',
  delivery: 'send',
  to: 'client@example.com',
  organizationName: 'Acme Studio',
  clientName: 'Northwind',
  number: 'INV-0042',
  amount: '$986.00',
  dueDate: '2026-12-01',
  requestId: 'req-12345678',
  ...overrides,
});

function setup() {
  const config = testConfig();
  const store = new MemoryXrayStore(config);
  const xray = new XrayService(store, config);
  const mail = { send: vi.fn().mockResolvedValue(undefined) };
  const outbox = { capture: vi.fn().mockResolvedValue(undefined) };
  const handler = new InvoiceEmailHandler(
    mail as unknown as MailService,
    outbox as unknown as OutboxService,
    xray,
  );
  const events = async () => {
    await xray.flush();
    return store.latest('org-a', 20);
  };
  return { handler, mail, outbox, events };
}

describe('InvoiceEmailHandler', () => {
  it('delivers a real organisation’s email through the mail provider, with the right content', async () => {
    const { handler, mail, outbox } = setup();
    await handler.handle(job());
    expect(mail.send).toHaveBeenCalledTimes(1);
    const message = mail.send.mock.calls[0]?.[0];
    expect(message).toMatchObject({
      to: 'client@example.com',
      subject: 'Invoice INV-0042 from Acme Studio',
    });
    expect(message.text).toContain('Hi Northwind');
    expect(message.text).toContain('$986.00');
    expect(message.html).toContain('INV-0042');
    expect(outbox.capture).not.toHaveBeenCalled();
  });

  it('keeps a demo sandbox’s email in its Outbox and sends NOTHING', async () => {
    const { handler, mail, outbox } = setup();
    await handler.handle(job({ delivery: 'outbox' }));
    expect(mail.send).not.toHaveBeenCalled();
    expect(outbox.capture).toHaveBeenCalledWith('org-a', {
      to: 'client@example.com',
      subject: 'Invoice INV-0042 from Acme Studio',
      text: expect.stringContaining('$986.00'),
    });
  });

  it('tells the organisation’s X-ray what happened, joined to the click', async () => {
    const real = setup();
    await real.handler.handle(job());
    expect((await real.events()).map((e) => e.kind)).toEqual(['email.sent']);
    expect((await real.events())[0]?.requestId).toBe('req-12345678');

    const demo = setup();
    await demo.handler.handle(job({ delivery: 'outbox' }));
    expect((await demo.events()).map((e) => e.kind)).toEqual([
      'email.captured',
    ]);
  });

  it('THROWS when delivery fails, so the queue retries, and claims no success', async () => {
    const { handler, mail, events } = setup();
    mail.send.mockRejectedValue(new Error('smtp down'));
    await expect(handler.handle(job())).rejects.toThrow('smtp down');
    expect(await events()).toEqual([]);
  });

  it('never puts the recipient or the amount into the X-ray', async () => {
    const { handler, events } = setup();
    await handler.handle(job());
    const text = JSON.stringify(await events());
    expect(text).not.toContain('client@example.com');
    expect(text).not.toContain('$986.00');
    expect(text).not.toContain('Northwind');
  });
});
