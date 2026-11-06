import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../config/config.service.js';
import { MailService } from './mail.service.js';
import { MAIL_TRANSPORT, type MailTransport } from './mail.types.js';
import { ResendTransport } from './resend.transport.js';
import { SmtpTransport } from './smtp.transport.js';

@Global()
@Module({
  providers: [
    {
      provide: MAIL_TRANSPORT,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): MailTransport =>
        config.get('MAIL_DRIVER') === 'resend'
          ? // Presence is guaranteed by env validation.
            new ResendTransport(
              config.get('RESEND_API_KEY') as string,
              config.get('MAIL_TIMEOUT_MS'),
            )
          : new SmtpTransport(
              config.get('SMTP_URL'),
              config.get('MAIL_TIMEOUT_MS'),
            ),
    },
    MailService,
  ],
  exports: [MailService],
})
export class MailModule {}
