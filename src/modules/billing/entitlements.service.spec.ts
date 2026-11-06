import { PlanLimitExceededError } from '../../common/errors/domain-errors.js';
import { testConfig } from '../../../test/support/test-config.js';
import { EntitlementsService } from './entitlements.service.js';

type Counter = { count: (args: unknown) => Promise<number> };

function fakeDb(opts: {
  plan?: 'FREE' | 'PRO' | null;
  members: number;
  pendingInvites: number;
}) {
  const invitationQueries: unknown[] = [];
  const db = {
    subscription: {
      findUnique: () =>
        Promise.resolve(
          opts.plan === null ? null : { plan: opts.plan ?? 'FREE' },
        ),
    },
    membership: { count: () => Promise.resolve(opts.members) } as Counter,
    invitation: {
      count: (args: unknown) => {
        invitationQueries.push(args);
        return Promise.resolve(opts.pendingInvites);
      },
    } as Counter,
  };
  return { db: db as never, invitationQueries };
}

describe('EntitlementsService', () => {
  const service = new EntitlementsService(testConfig());

  it('takes the seat limits from configuration (3 for FREE, 25 for PRO by default)', () => {
    expect(service.seatLimit('FREE')).toBe(3);
    expect(service.seatLimit('PRO')).toBe(25);
    const custom = new EntitlementsService(
      testConfig({ FREE_PLAN_MAX_SEATS: '2', PRO_PLAN_MAX_SEATS: '9' }),
    );
    expect(custom.seatLimit('FREE')).toBe(2);
    expect(custom.seatLimit('PRO')).toBe(9);
  });

  it.each([
    ['one under the limit', 1, 1, true],
    ['exactly at the limit', 2, 1, false],
    ['members alone fill it', 3, 0, false],
    ['pending invitations alone fill it', 0, 3, false],
    ['an empty organisation', 0, 0, true],
  ])(
    'FREE with %s (members %d, pending %d) → seat available: %s',
    async (_label, members, pendingInvites, available) => {
      const { db } = fakeDb({ members, pendingInvites });
      const attempt = service.assertSeatAvailable(db, 'org-1');
      if (available) await expect(attempt).resolves.toBeUndefined();
      else await expect(attempt).rejects.toBeInstanceOf(PlanLimitExceededError);
    },
  );

  it('gives PRO organisations the larger limit', async () => {
    const { db } = fakeDb({ plan: 'PRO', members: 10, pendingInvites: 10 });
    await expect(
      service.assertSeatAvailable(db, 'org-1'),
    ).resolves.toBeUndefined();
    const full = fakeDb({ plan: 'PRO', members: 20, pendingInvites: 5 });
    await expect(
      service.assertSeatAvailable(full.db, 'org-1'),
    ).rejects.toBeInstanceOf(PlanLimitExceededError);
  });

  it('treats an organisation with no subscription row as FREE', async () => {
    const { db } = fakeDb({ plan: null, members: 3, pendingInvites: 0 });
    await expect(service.assertSeatAvailable(db, 'org-1')).rejects.toThrow(
      /FREE plan allows 3 seats/,
    );
  });

  it('counts only UNEXPIRED pending invitations as seats', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const { db, invitationQueries } = fakeDb({ members: 1, pendingInvites: 0 });
    await service.assertSeatAvailable(db, 'org-1', now);
    expect(invitationQueries[0]).toEqual({
      where: {
        organizationId: 'org-1',
        status: 'PENDING',
        expiresAt: { gt: now },
      },
    });
  });

  it('points the error at the billing page of the web app', async () => {
    const { db } = fakeDb({ members: 3, pendingInvites: 0 });
    const error = await service
      .assertSeatAvailable(db, 'org-1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlanLimitExceededError);
    expect((error as PlanLimitExceededError).upgradeUrl).toBe(
      'http://localhost:3001/settings/billing',
    );
  });
});
