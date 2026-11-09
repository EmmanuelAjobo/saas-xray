import { compareIds, createTimeline, outboxChanged } from './timeline.js';

let counter = 0;
/** An event as the server would send it. */
function event(overrides = {}) {
  counter += 1;
  return {
    id: `${1_000 + counter}-0`,
    ts: 1_000 + counter,
    kind: 'http.request',
    severity: 'success',
    title: 'GET /clients',
    summary: 'ok',
    meta: {},
    ...overrides,
  };
}

describe('compareIds', () => {
  it('orders numerically, not as text', () => {
    expect(compareIds('9-0', '10-0')).toBeLessThan(0);
    expect(compareIds('10-0', '9-0')).toBeGreaterThan(0);
    expect(compareIds('5-2', '5-10')).toBeLessThan(0);
    expect(compareIds('5-3', '5-3')).toBe(0);
  });
});

describe('createTimeline', () => {
  it('puts the events of one click on one card, in stream order, whatever order they arrive in', () => {
    const t = createTimeline();
    const a = event({
      id: '10-0',
      requestId: 'r1',
      kind: 'tenant.check',
      title: 'Organisation membership',
    });
    const b = event({
      id: '11-0',
      requestId: 'r1',
      kind: 'auth.check',
      title: 'Permission check',
    });
    const c = event({
      id: '12-0',
      requestId: 'r1',
      kind: 'http.request',
      title: 'POST /clients',
    });
    t.add(c);
    t.add(a);
    t.add(b);
    const [group] = t.groups();
    expect(t.groups()).toHaveLength(1);
    expect(group?.events.map((e) => e.kind)).toEqual([
      'tenant.check',
      'auth.check',
      'http.request',
    ]);
    expect(group?.title).toBe('POST /clients');
    expect(group?.request?.id).toBe('12-0');
  });

  it('orders a card’s steps by when they HAPPENED, not by when they were written (a fast job can report before its request does)', () => {
    const t = createTimeline();
    // The worker's events were written to the stream first (low ids) but happened AFTER the
    // click's own steps (higher ts).
    t.add(
      event({
        id: '10-0',
        ts: 3000,
        requestId: 'r',
        kind: 'job.active',
        title: 'Background job: invoice email',
      }),
    );
    t.add(
      event({
        id: '11-0',
        ts: 3100,
        requestId: 'r',
        kind: 'job.completed',
        title: 'Background job: invoice email',
      }),
    );
    t.add(
      event({
        id: '12-0',
        ts: 1000,
        requestId: 'r',
        kind: 'tenant.check',
        title: 'Organisation membership',
      }),
    );
    t.add(
      event({
        id: '13-0',
        ts: 2000,
        requestId: 'r',
        kind: 'job.queued',
        title: 'Background job: invoice email',
      }),
    );
    t.add(
      event({
        id: '14-0',
        ts: 2500,
        requestId: 'r',
        kind: 'http.request',
        title: 'POST /invoices/:id/send',
      }),
    );
    const [group] = t.groups();
    expect(group?.events.map((e) => e.kind)).toEqual([
      'tenant.check',
      'job.queued',
      'http.request',
      'job.active',
      'job.completed',
    ]);
    expect(group?.startedAt).toBe(1000);
  });

  it('breaks a tie in time by stream id, so the order is always the same', () => {
    const t = createTimeline();
    t.add(event({ id: '12-0', ts: 5, requestId: 'r', kind: 'b' }));
    t.add(event({ id: '11-0', ts: 5, requestId: 'r', kind: 'a' }));
    expect(t.groups()[0]?.events.map((e) => e.kind)).toEqual(['a', 'b']);
  });

  it('ranks cards by their newest activity, even when a card’s last step by time is not its newest write', () => {
    const t = createTimeline();
    t.add(event({ id: '10-0', ts: 100, requestId: 'old' }));
    // This card's NEWEST write (id 30) has an early timestamp; it must still rank first.
    t.add(
      event({ id: '20-0', ts: 9000, requestId: 'busy', kind: 'http.request' }),
    );
    t.add(
      event({ id: '30-0', ts: 50, requestId: 'busy', kind: 'job.completed' }),
    );
    expect(t.groups().map((g) => g.key)).toEqual(['busy', 'old']);
  });

  it('keeps separate clicks on separate cards, newest first', () => {
    const t = createTimeline();
    t.add(event({ id: '10-0', requestId: 'old' }));
    t.add(event({ id: '20-0', requestId: 'new' }));
    expect(t.groups().map((g) => g.key)).toEqual(['new', 'old']);
  });

  it('ignores an event it has already seen (the live stream can resume with overlap)', () => {
    const t = createTimeline();
    const e = event({ id: '10-0', requestId: 'r1' });
    expect(t.add(e)).toBe(true);
    expect(t.add({ ...e })).toBe(false);
    expect(t.groups()[0]?.events).toHaveLength(1);
  });

  it('adds a late event (an email sent after the response) to the SAME card and moves it to the top', () => {
    const t = createTimeline();
    t.add(
      event({
        id: '10-0',
        requestId: 'send',
        title: 'POST /invoices/:id/send',
      }),
    );
    t.add(event({ id: '20-0', requestId: 'other' }));
    expect(t.groups()[0]?.key).toBe('other');
    t.add(
      event({
        id: '30-0',
        requestId: 'send',
        kind: 'email.sent',
        title: 'Email sent',
      }),
    );
    const [top] = t.groups();
    expect(top?.key).toBe('send');
    expect(top?.events.map((e) => e.kind)).toEqual([
      'http.request',
      'email.sent',
    ]);
  });

  it('gives an event with no request id its own card', () => {
    const t = createTimeline();
    t.add(event({ id: '10-0', kind: 'email.sent', title: 'Email sent' }));
    t.add(event({ id: '11-0', kind: 'email.sent', title: 'Email sent' }));
    expect(t.groups()).toHaveLength(2);
  });

  it('uses the worst severity in the group, so a refusal stands out', () => {
    const t = createTimeline();
    t.add(
      event({
        id: '10-0',
        requestId: 'r',
        kind: 'tenant.check',
        severity: 'success',
      }),
    );
    t.add(
      event({
        id: '11-0',
        requestId: 'r',
        kind: 'auth.check',
        severity: 'warn',
      }),
    );
    t.add(
      event({
        id: '12-0',
        requestId: 'r',
        kind: 'http.request',
        severity: 'warn',
      }),
    );
    expect(t.groups()[0]?.severity).toBe('warn');
    t.add(
      event({
        id: '13-0',
        requestId: 'r',
        kind: 'db.queries',
        severity: 'error',
      }),
    );
    expect(t.groups()[0]?.severity).toBe('error');
  });

  it('falls back to the first event title when the request itself has not arrived yet', () => {
    const t = createTimeline();
    t.add(
      event({
        id: '10-0',
        requestId: 'r',
        kind: 'tenant.check',
        title: 'Organisation membership',
      }),
    );
    expect(t.groups()[0]?.title).toBe('Organisation membership');
    expect(t.groups()[0]?.request).toBeUndefined();
  });

  it('drops the oldest cards beyond the limit, and forgets their events', () => {
    const t = createTimeline({ maxGroups: 3 });
    for (let i = 1; i <= 5; i++)
      t.add(event({ id: `${i}0-0`, ts: i, requestId: `r${i}` }));
    expect(t.groups().map((g) => g.key)).toEqual(['r5', 'r4', 'r3']);
    // The dropped card's event can be accepted again (it is gone, not remembered forever).
    expect(t.add(event({ id: '10-0', ts: 1, requestId: 'r1' }))).toBe(true);
  });

  it('clears everything', () => {
    const t = createTimeline();
    t.add(event({ id: '10-0', requestId: 'r' }));
    t.clear();
    expect(t.groups()).toEqual([]);
    expect(t.add(event({ id: '10-0', requestId: 'r' }))).toBe(true);
  });
});

describe('outboxChanged', () => {
  it('is true for the event that says an email was captured', () => {
    expect(outboxChanged({ kind: 'email.captured' })).toBe(true);
  });
  it.each([
    'email.sent',
    'job.queued',
    'job.completed',
    'http.request',
    'auth.check',
  ])('is false for %s', (kind) => {
    expect(outboxChanged({ kind })).toBe(false);
  });
});
