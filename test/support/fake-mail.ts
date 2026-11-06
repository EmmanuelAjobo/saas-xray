import type {
  MailMessage,
  MailTransport,
} from '../../src/core/mail/mail.types.js';

/** Captures outgoing mail instead of sending it, so tests can read the links users would get. */
export class FakeMailTransport implements MailTransport {
  readonly sent: MailMessage[] = [];
  /** Set to make delivery fail, to prove a mail outage never breaks a request. */
  failWith?: Error;

  send(message: MailMessage): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.sent.push(message);
    return Promise.resolve();
  }

  to(address: string): MailMessage[] {
    return this.sent.filter((m) => m.to === address);
  }

  /** The `token` query parameter from the most recent link sent to this address. */
  lastToken(address: string): string {
    const message = this.to(address).at(-1);
    const match = message && /[?&]token=([^\s"&<]+)/.exec(message.text);
    if (!match) throw new Error(`No email with a token was sent to ${address}`);
    return decodeURIComponent(match[1] as string);
  }

  clear(): void {
    this.sent.length = 0;
  }
}
