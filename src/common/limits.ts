/**
 * Fixed limits that come from a standard or from the API contract (not deployment settings;
 * changing one changes what clients may send, so it is a code change with a review).
 */

/** Longest valid email address (RFC 5321). */
export const EMAIL_MAX_LENGTH = 254;
export const NAME_MAX_LENGTH = 100;
export const ORG_NAME_MAX_LENGTH = 100;

/** Longest readable part of an organisation slug (a short random suffix is added). */
export const SLUG_BASE_MAX_LENGTH = 40;

/** Opaque tokens are 43 chars; the bounds only reject obvious garbage early. */
export const TOKEN_MIN_LENGTH = 20;
export const TOKEN_MAX_LENGTH = 200;

/** Stops a 10 MB "password" from burning hashing time. Login enforces only this ceiling. */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/** Device info stored with a session is truncated to this, so it cannot bloat the table. */
export const MAX_USER_AGENT_LENGTH = 256;
export const MAX_IP_LENGTH = 64;

/** Most invitations returned by one list call (newest first). Pending ones are already bounded by seats. */
export const INVITATION_LIST_MAX = 200;

/** Tasks, clients and invoices (the API contract; changing one changes what clients may send). */
export const TASK_TITLE_MAX_LENGTH = 200;
export const TASK_DESCRIPTION_MAX_LENGTH = 5_000;
export const SEARCH_TERM_MAX_LENGTH = 100;
export const LINE_ITEM_DESCRIPTION_MAX_LENGTH = 200;
export const LINE_ITEM_QUANTITY_MAX = 1_000_000;
/** Money is stored as a 32-bit integer of cents; a total above this cannot be stored. */
export const INT4_MAX = 2_147_483_647;
/** Invoice numbers look like INV-0001: the sequence is zero-padded to this width. */
export const INVOICE_NUMBER_PAD = 4;
/** Longest cursor string accepted from a client. */
export const CURSOR_MAX_LENGTH = 300;
