import { createTransport, type Transporter } from 'nodemailer';
import type { MailMessage, MailTransport } from './mail.types.js';

/** Plain SMTP. In development this is Mailpit (inbox at http://localhost:8025). */
export class SmtpTransport implements MailTransport {
  private readonly transporter: Transporter;

  constructor(url: string, timeoutMs: number) {
    this.transporter = createTransport({
      url,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
    });
  }

  async send(message: MailMessage, from: string): Promise<void> {
    await this.transporter.sendMail({ from, ...message });
  }
}
