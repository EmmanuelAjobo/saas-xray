export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** A way of delivering mail. Swappable: SMTP locally, Resend in production, a fake in tests. */
export interface MailTransport {
  send(message: MailMessage, from: string): Promise<void>;
}

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');
