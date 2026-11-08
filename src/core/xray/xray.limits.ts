/**
 * Hard bounds that protect the process from runaway work. They are not tunables (the
 * tunable X-ray settings live in the environment: XRAY_*), they are safety limits.
 */

/** Steps (permission checks and the like) one request may record before extras are dropped. */
export const MAX_STEPS_PER_REQUEST = 50;

/** Longest text kept in an event's title or summary. Anything longer is cut. */
export const MAX_TEXT_LENGTH = 200;

/** Distinct database models named in one request's query summary. */
export const MAX_MODELS_LISTED = 10;
