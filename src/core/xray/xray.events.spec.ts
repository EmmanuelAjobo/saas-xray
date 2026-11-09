import {
  authCheckEvent,
  dbQueriesEvent,
  emailEvent,
  httpRequestEvent,
  jobEvent,
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

  describe('jobEvent', () => {
    const base = { ts: 1, label: 'invoice email', requestId: 'req-12345678' };

    it.each([
      ['queued', 'info', 'job.queued'],
      ['active', 'info', 'job.active'],
      ['completed', 'success', 'job.completed'],
      ['retry', 'warn', 'job.retry'],
      ['failed', 'error', 'job.failed'],
    ] as const)('%s is a %s event of kind %s', (phase, severity, kind) => {
      const event = jobEvent({ ...base, phase });
      expect(event).toMatchObject({
        kind,
        severity,
        requestId: 'req-12345678',
      });
      expect(event.title).toBe('Background job: invoice email');
    });

    it('says what happened in plain English, with the attempt', () => {
      expect(jobEvent({ ...base, phase: 'queued' }).summary).toContain(
        'so your click is not kept waiting',
      );
      expect(
        jobEvent({ ...base, phase: 'active', attempt: 2, attempts: 3 }).summary,
      ).toBe('A worker picked up the invoice email (attempt 2 of 3).');
      expect(
        jobEvent({ ...base, phase: 'completed', durationMs: 84.4 }).summary,
      ).toBe('The invoice email finished in 84 ms.');
    });

    it('says when it will try again, in seconds or minutes', () => {
      const retry = (ms: number) =>
        jobEvent({
          ...base,
          phase: 'retry',
          attempt: 1,
          attempts: 3,
          nextDelayMs: ms,
        }).summary;
      expect(retry(5_000)).toBe(
        'The invoice email failed (attempt 1 of 3); trying again in 5 s.',
      );
      expect(retry(300)).toContain('in 1 s');
      expect(retry(120_000)).toContain('in 2 min');
    });

    it('says a failed job was given up on and stays inspectable', () => {
      expect(
        jobEvent({ ...base, phase: 'failed', attempt: 3, attempts: 3 }).summary,
      ).toContain('given up on');
    });

    it('can carry a short detail from our own code (the sweep: how many invoices)', () => {
      expect(
        jobEvent({
          ts: 1,
          label: 'overdue invoice sweep',
          phase: 'completed',
          durationMs: 5,
          detail: '3 invoices marked overdue',
        }).summary,
      ).toBe(
        'The overdue invoice sweep finished in 5 ms: 3 invoices marked overdue.',
      );
    });

    it('keeps only flat facts in meta, and leaves out what it was not given', () => {
      const event = jobEvent({ ...base, phase: 'queued' });
      expect(event.meta).toEqual({ job: 'invoice email' });
      const retry = jobEvent({
        ...base,
        phase: 'retry',
        attempt: 1,
        attempts: 3,
        durationMs: 9.6,
        nextDelayMs: 5_000,
      });
      expect(retry.meta).toEqual({
        job: 'invoice email',
        attempt: 1,
        attempts: 3,
        durationMs: 10,
        nextDelayMs: 5_000,
      });
    });

    it('has no way to carry a payload or an error message', () => {
      const text = JSON.stringify(
        jobEvent({ ...base, phase: 'failed', attempt: 3, attempts: 3 }),
      );
      expect(text).not.toMatch(/@|password|token|smtp/i);
    });

    it('omits the request id when there is none', () => {
      expect(
        jobEvent({ ts: 1, label: 'x', phase: 'queued' }),
      ).not.toHaveProperty('requestId');
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
