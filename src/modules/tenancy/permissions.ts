import type { Role } from '../../generated/prisma/client.js';

/**
 * Who may do what (ARCHITECTURE §8.3). One table, used by the guard on every request.
 *
 * Guards answer "may this ROLE ever do this?". Questions about a specific record ("may a
 * MEMBER edit THIS task?") are answered by the service that owns the record: MEMBERs hold
 * `task:update` and `task:delete`, and the tasks service narrows them to their own work.
 */
const OWNER_ONLY = ['OWNER'] as const;
const MANAGERS = ['OWNER', 'ADMIN'] as const;
const EVERYONE = ['OWNER', 'ADMIN', 'MEMBER'] as const;

export const PERMISSION_ROLES = {
  // Organisation
  'org:read': EVERYONE,
  'org:update': MANAGERS,
  'org:delete': OWNER_ONLY,
  'billing:manage': OWNER_ONLY,

  // People
  'member:read': EVERYONE,
  'member:invite': MANAGERS,
  'member:remove': MANAGERS,
  'member:change-role': MANAGERS,
  'apikey:manage': MANAGERS,

  // Tasks (MEMBERs are narrowed to their own work by the service)
  'task:read': EVERYONE,
  'task:create': EVERYONE,
  'task:update': EVERYONE,
  'task:delete': EVERYONE,

  // Money: members are read-only
  'client:read': EVERYONE,
  'client:write': MANAGERS,
  'invoice:read': EVERYONE,
  'invoice:create': MANAGERS,
  'invoice:update': MANAGERS,
  'invoice:send': MANAGERS,
  'invoice:void': MANAGERS,

  // The Backend X-ray. Every role may OPEN it; the reader service then lets only managers
  // see a real organisation's events (a demo sandbox is private to its visitor, so all
  // personas may).
  'xray:read': EVERYONE,

  // Oversight and reporting
  'audit:read': MANAGERS,
  'report:generate': EVERYONE,
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSION_ROLES;

export const ALL_PERMISSIONS = Object.keys(PERMISSION_ROLES) as Permission[];

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSION_ROLES[permission] as readonly Role[]).includes(role);
}
