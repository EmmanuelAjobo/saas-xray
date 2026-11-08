import type { Role } from '../../generated/prisma/client.js';
import {
  ALL_PERMISSIONS,
  PERMISSION_ROLES,
  type Permission,
  can,
} from './permissions.js';

const ROLES: Role[] = ['OWNER', 'ADMIN', 'MEMBER'];

/**
 * The table from ARCHITECTURE.md §8.3, written out one row per permission. If someone
 * loosens or tightens a permission by accident, this test names the exact cell.
 */
const EXPECTED: Record<Permission, Role[]> = {
  'org:read': ['OWNER', 'ADMIN', 'MEMBER'],
  'org:update': ['OWNER', 'ADMIN'],
  'org:delete': ['OWNER'],
  'billing:manage': ['OWNER'],
  'member:read': ['OWNER', 'ADMIN', 'MEMBER'],
  'member:invite': ['OWNER', 'ADMIN'],
  'member:remove': ['OWNER', 'ADMIN'],
  'member:change-role': ['OWNER', 'ADMIN'],
  'apikey:manage': ['OWNER', 'ADMIN'],
  'task:read': ['OWNER', 'ADMIN', 'MEMBER'],
  'task:create': ['OWNER', 'ADMIN', 'MEMBER'],
  'task:update': ['OWNER', 'ADMIN', 'MEMBER'],
  'task:delete': ['OWNER', 'ADMIN', 'MEMBER'],
  'client:read': ['OWNER', 'ADMIN', 'MEMBER'],
  'client:write': ['OWNER', 'ADMIN'],
  'invoice:read': ['OWNER', 'ADMIN', 'MEMBER'],
  'invoice:create': ['OWNER', 'ADMIN'],
  'invoice:update': ['OWNER', 'ADMIN'],
  'invoice:send': ['OWNER', 'ADMIN'],
  'invoice:void': ['OWNER', 'ADMIN'],
  'xray:read': ['OWNER', 'ADMIN', 'MEMBER'],
  'audit:read': ['OWNER', 'ADMIN'],
  'report:generate': ['OWNER', 'ADMIN', 'MEMBER'],
};

describe('permission map', () => {
  it('covers exactly the permissions in the expected table (none missing, none extra)', () => {
    expect([...ALL_PERMISSIONS].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED) as [Permission, Role[]][])(
    '%s is held by %j and nobody else',
    (permission, allowed) => {
      for (const role of ROLES) {
        expect(can(role, permission), `${role} ${permission}`).toBe(
          allowed.includes(role),
        );
      }
    },
  );

  it('is a strict hierarchy: every ADMIN permission is also an OWNER permission, every MEMBER one an ADMIN one', () => {
    for (const permission of ALL_PERMISSIONS) {
      if (can('MEMBER', permission))
        expect(can('ADMIN', permission)).toBe(true);
      if (can('ADMIN', permission)) expect(can('OWNER', permission)).toBe(true);
    }
  });

  it('gives the OWNER every permission', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(can('OWNER', permission)).toBe(true);
    }
  });

  it('keeps billing and deleting the organisation to the owner alone', () => {
    expect(PERMISSION_ROLES['billing:manage']).toEqual(['OWNER']);
    expect(PERMISSION_ROLES['org:delete']).toEqual(['OWNER']);
  });

  it('denies an unknown role rather than allowing it', () => {
    expect(can('GUEST' as Role, 'org:read')).toBe(false);
  });
});
