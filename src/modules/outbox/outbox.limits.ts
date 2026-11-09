/**
 * Hard bounds on what one captured email may hold. They are safety limits (the text comes
 * from our own template filled with names a visitor typed), not tunables; the tunable
 * (how many messages are kept) is OUTBOX_MAX_MESSAGES.
 */

/** Longest subject kept; longer is cut. */
export const MAX_SUBJECT_LENGTH = 200;

/** Longest body kept; longer is cut. */
export const MAX_BODY_LENGTH = 5_000;
