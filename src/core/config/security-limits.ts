/**
 * Hard bounds for password-hashing cost. Used in two places that must agree: the env schema
 * (what an operator may configure) and the hash parser (what a stored hash may claim, so a
 * corrupted or hostile row cannot make the server allocate gigabytes).
 */
export const ARGON2_LIMITS = {
  memoryKiB: { min: 8192, max: 262_144 },
  passes: { min: 1, max: 10 },
  parallelism: { min: 1, max: 8 },
} as const;
