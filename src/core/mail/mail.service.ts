import { Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/config.service.js';
import {
  MAIL_TRANSPORT,
  type MailMessage,
  type MailTransport,
} from './mail.types.js';

@Injectable()
export class MailService {
  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    private readonly config: AppConfigService,
  ) {}

  /** Throws if delivery fails. Callers send through BackgroundTasks so that never reaches a user. */
  async send(message: MailMessage): Promise<void> {
    await this.transport.send(message, this.config.get('MAIL_FROM'));
  }
}
