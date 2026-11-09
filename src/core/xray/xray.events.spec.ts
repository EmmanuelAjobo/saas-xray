import {
  authCheckEvent,
  dbQueriesEvent,
  emailEvent,
  httpRequestEvent,
  plain,
  tenantCheckEvent,
} from './xray.events.js';

describe('X-ray event builders', () => {
  describe('httpRequestEvent', () => {
    const base = {
      ts: 1,
      requestId: 'req-12345678',
      method: 'POST',
      route: '/v1/orgs/:orgId/invoices/:id/send',
      durationMs: 83.6,
    };

    it('shows the route as a template, trimmed to what matters, and rounds the time', () => {
      const event = httpRequestEvent({ ...base, status: 200 });
      expect(event).toMatchObject({
        kind: 'http.request',
        severity: 'success',
        title: 'POST /invoices/:id/send',
        requestId: 'req-12345678',
        meta: {
          method: 'POST',
          route: '/v1/orgs/:orgId/invoices/:id/send',
          status: 200,
          durationMs: 84,
        },
      });
      expect(event.summary).toBe('Answered 200 in 84 ms: succeeded.');
    });

    it.each([
      [200, 'success'],
      [201, 'success'],
      [204, 'success'],
      [400, 'warn'],
      [403, 'warn'],
      [404, 'warn'],
      [409, 'warn'],
      [500, 'error'],
      [503, 'error'],
    ])('status %i has severity %s', (status, severity) => {
      expect(httpRequestEvent({ ...base, status }).severity).toBe(severity);
    });

    it('explains refusals in plain English', () => {
      expect(httpRequestEvent({ ...base, status: 403 }).summary).toContain(
        'role is not allowed',
      );
      expect(httpRequestEvent({ ...base, status: 409 }).summary).toContain(
        'conflicts with the current state',
      );
      expect(httpRequestEvent({ ...base, status: 429 }).summary).toContain(
        'rate limit',
      );
      expect(httpRequestEvent({ ...base, status: 502 }).summary).toContain(
        'failed on the server',
      );
    });

    it('omits requestId when there is none, and never invents one', () => {
      const { requestId: _omit, ...rest } = base;
      expect(httpRequestEvent({ ...rest, status: 200 })).not.toHaveProperty(
        'requestId',
      );
    });

    it('never goes negative on a clock hiccup', () => {
      expect(
        httpRequestEvent({ ...base, status: 200, durationMs: -5 }).meta
          .durationMs,
      ).toBe(0);
    });
  });

  it('authCheckEvent says whether the role was allowed, and why', () => {
    const allowed = authCheckEvent({
      ts: 1,
      role: 'ADMIN',
      permission: 'invoice:send',
      allowed: true,
    });
    expect(allowed).toMatchObject({
      kind: 'auth.check',
      severity: 'success',
      meta: { role: 'ADMIN', permission: 'invoice:send', allowed: true },
    });
    const denied = authCheckEvent({
      ts: 1,
      role: 'MEMBER',
      permission: 'client:write',
      allowed: false,
    });
    expect(denied.severity).toBe('warn');
    expect(denied.summary).toContain('does not hold "client:write"');
    expect(denied.summary).toContain('Refused before any data');
  });

  it('tenantCheckEvent states the role without naming a person', () => {
    expect(tenantCheckEvent({ ts: 1, role: 'OWNER' })).toMatchObject({
      kind: 'tenant.check',
      meta: { role: 'OWNER' },
    });
  });

  describe('dbQueriesEvent', () => {
    it('pluralises, rounds, and lists each model once, sorted', () => {
      const event = dbQueriesEvent({
        ts: 1,
        count: 3,
        totalMs: 12.4,
        models: ['Invoice', 'Client', 'Invoice'],
      });
      expect(event.summary).toBe(
        '3 database queries in 12 ms, each one confined to this organisation.',
      );
      expect(event.meta).toEqual({
        queries: 3,
        totalMs: 12,
        models: 'Client, Invoice',
      });
    });

    it('uses the singular for one query', () => {
      expect(
        dbQueriesEvent({ ts: 1, count: 1, totalMs: 1, models: ['Task'] })
          .summary,
      ).toContain('1 database query in');
    });

    it('bounds how many models it names', () => {
      const many = Array.from({ length: 40 }, (_, i) => `Model${i}`);
      const listed = String(
        dbQueriesEvent({ ts: 1, count: 40, totalMs: 1, models: many }).meta
          .models,
      ).split(', ');
      expect(listed.length).toBeLessThanOrEqual(10);
    });
  });

  describe('emailEvent', () => {
    it('describes a sent email without naming a recipient', () => {
      const event = emailEvent({
        ts: 1,
        template: 'invoice-sent',
        outcome: 'sent',
      });
      expect(event).toMatchObject({
        kind: 'email.sent',
        severity: 'success',
        meta: { template: 'invoice-sent' },
      });
      expect(JSON.stringify(event)).not.toMatch(/@/);
    });

    it('says a demo email was captured in the Outbox, not sent, and names no recipient', () => {
      const event = emailEvent({
        ts: 1,
        template: 'invoice-sent',
        outcome: 'captured',
      });
      expect(event.kind).toBe('email.captured');
      expect(event.summary).toContain('demo sandboxes never send');
      expect(event.summary).toContain('Outbox');
      expect(JSON.stringify(event)).not.toMatch(/@/);
    });
  });

  describe('plain', () => {
    it('removes control characters (no line breaks inside a summary)', () => {
      expect(plain('a\nb\r\tc\u0000d')).toBe('a b  c d');
    });
    it('cuts long text and marks the cut', () => {
      const cut = plain('x'.repeat(500), 20);
      expect(cut).toHaveLength(20);
      expect(cut.endsWith('…')).toBe(true);
    });
    it('leaves short text alone', () => {
      expect(plain('  hello  ')).toBe('hello');
    });
  });

  it('every builder returns only plain, flat meta values (nothing nested can leak)', () => {
    const events = [
      httpRequestEvent({
        ts: 1,
        method: 'GET',
        route: '/v1/orgs/:orgId/tasks',
        status: 200,
        durationMs: 1,
      }),
      tenantCheckEvent({ ts: 1, role: 'OWNER' }),
      authCheckEvent({
        ts: 1,
        role: 'OWNER',
        permission: 'task:read',
        allowed: true,
      }),
      dbQueriesEvent({ ts: 1, count: 1, totalMs: 1, models: ['Task'] }),
      emailEvent({ ts: 1, template: 'invoice-sent', outcome: 'sent' }),
    ];
    for (const event of events) {
      for (const value of Object.values(event.meta)) {
        expect(['string', 'number', 'boolean']).toContain(typeof value);
      }
    }
  });
});
