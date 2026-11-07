import { Module } from '@nestjs/common';
import { AppConfigService } from '../../core/config/config.service.js';
import { AuthModule } from '../auth/auth.module.js';
import {
  CAPTCHA_VERIFIER,
  NoCaptcha,
  TurnstileCaptcha,
  type CaptchaVerifier,
} from './captcha.js';
import { DemoCleanupService } from './demo-cleanup.service.js';
import { DemoController } from './demo.controller.js';
import { DemoService } from './demo.service.js';

@Module({
  imports: [AuthModule],
  controllers: [DemoController],
  providers: [
    DemoService,
    DemoCleanupService,
    {
      provide: CAPTCHA_VERIFIER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): CaptchaVerifier => {
        const secret = config.get('TURNSTILE_SECRET_KEY');
        return secret
          ? new TurnstileCaptcha(secret, config.get('CAPTCHA_TIMEOUT_MS'))
          : new NoCaptcha();
      },
    },
  ],
})
export class DemoModule {}
