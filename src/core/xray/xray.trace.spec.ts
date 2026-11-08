import { authCheckEvent, tenantCheckEvent } from './xray.events.js';
import { MAX_STEPS_PER_REQUEST } from './xray.limits.js';
import {
  XrayTrace,
  recordDatabaseQuery,
  recordXrayStep,
  runInTrace,
} from './xray.trace.js';

const step = (role = 'OWNER') => tenantCheckEvent({ ts: 1, role });
const summary = {
  method: 'GET',
  route: '/v1/orgs/:orgId/tasks',
  status: 200,
  durationMs: 5,
};

describe('XrayTrace', () => {
  it('orders a request: its steps, then the database summary, then the request itself', () => {
    const trace = new XrayTrace('req-12345678');
    trace.step(step());
    trace.step(
      authCheckEvent({
        ts: 2,
        role: 'OWNER',
        permission: 'task:read',
        allowed: true,
      }),
    );
    trace.query('Task', 4);
    trace.query('Client', 6);

    const events = trace.summarise(summary);
    expect(events.map((e) => e.kind)).toEqual([
      'tenant.check',
      'auth.check',
      'db.queries',
      'http.request',
    ]);
    expect(events.every((e) => e.requestId === 'req-12345678')).toBe(true);
    expect(events[2]?.meta).toMatchObject({
      queries: 2,
      totalMs: 10,
      models: 'Client, Task',
    });
  });

  it('leaves out the database summary when nothing touched the database', () => {
    const trace = new XrayTrace();
    expect(trace.summarise(summary).map((e) => e.kind)).toEqual([
      'http.request',
    ]);
  });

  it('keeps no more than the safety limit of steps', () => {
    const trace = new XrayTrace();
    for (let i = 0; i < MAX_STEPS_PER_REQUEST + 25; i++) trace.step(step());
    const events = trace.summarise(summary);
    expect(events.filter((e) => e.kind === 'tenant.check')).toHaveLength(
      MAX_STEPS_PER_REQUEST,
    );
  });

  describe('after the request has finished', () => {
    it('sends late steps (a background email) straight to the sink, tagged with the request id', () => {
      const trace = new XrayTrace('req-12345678');
      const sink = vi.fn();
      trace.summarise(summary);
      trace.close(sink);

      trace.step(step());
      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink.mock.calls[0]?.[0]).toMatchObject([
        { kind: 'tenant.check', requestId: 'req-12345678' },
      ]);
    });

    it('drops late steps when there is nowhere safe to send them', () => {
      const trace = new XrayTrace();
      trace.close(); // e.g. not a tenant route
      expect(() => trace.step(step())).not.toThrow();
    });

    it('ignores late database queries (the summary is already out)', () => {
      const trace = new XrayTrace();
      const sink = vi.fn();
      trace.close(sink);
      trace.query('Task', 1);
      expect(sink).not.toHaveBeenCalled();
    });
  });
});

describe('recording into the current request', () => {
  it('records into the trace the code is running inside, across awaits', async () => {
    const trace = new XrayTrace();
    await runInTrace(trace, async () => {
      await Promise.resolve();
      recordXrayStep(step());
      await new Promise((resolve) => setTimeout(resolve, 1));
      recordDatabaseQuery('Invoice', 3);
    });
    expect(trace.summarise(summary).map((e) => e.kind)).toEqual([
      'tenant.check',
      'db.queries',
      'http.request',
    ]);
  });

  it('keeps concurrent requests apart', async () => {
    const a = new XrayTrace('aaaaaaaa');
    const b = new XrayTrace('bbbbbbbb');
    await Promise.all([
      runInTrace(a, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        recordXrayStep(step('OWNER'));
      }),
      runInTrace(b, async () => {
        recordXrayStep(step('MEMBER'));
        recordXrayStep(step('MEMBER'));
      }),
    ]);
    expect(
      a.summarise(summary).filter((e) => e.kind === 'tenant.check'),
    ).toHaveLength(1);
    expect(
      b.summarise(summary).filter((e) => e.kind === 'tenant.check'),
    ).toHaveLength(2);
  });

  it('does nothing outside a request (jobs, startup, tests of other code)', () => {
    expect(() => recordXrayStep(step())).not.toThrow();
    expect(() => recordDatabaseQuery('Task', 1)).not.toThrow();
  });
});
