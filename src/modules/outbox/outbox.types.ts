/** An email a demo sandbox "sent": captured for display, never delivered. */
export interface OutboxMessage {
  id: string;
  /** Epoch milliseconds. */
  ts: number;
  to: string;
  subject: string;
  /** Plain text only. The page shows it as text and never as HTML. */
  text: string;
}

export type NewOutboxMessage = Omit<OutboxMessage, 'id' | 'ts'>;

/** Where captured emails are kept. Every method is scoped to one organisation. */
export interface OutboxStore {
  /** Keeps the message (newest first) and drops the oldest beyond the limit. */
  add(organizationId: string, message: OutboxMessage): Promise<void>;
  /** The most recent messages, newest first. */
  list(organizationId: string, limit: number): Promise<OutboxMessage[]>;
}

export const OUTBOX_STORE = Symbol('OUTBOX_STORE');
