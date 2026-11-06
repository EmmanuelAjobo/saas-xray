import type { MailMessage, MailTransport } from './mail.types.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** Resend over its HTTPS API (no SDK needed; one POST). */
export class ResendTransport implements MailTransport {
  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs: number,
  ) {}

  async send(message: MailMessage, from: string): Promise<void> {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, ...message }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      // Status only: the response body can echo the recipient address.
      throw new Error(`Resend rejected the email (HTTP ${response.status})`);
    }
  }
}
