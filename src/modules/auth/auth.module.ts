import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { PasswordService } from './password.service.js';
import { SameOriginGuard } from './same-origin.guard.js';
import { SessionCookies } from './session-cookies.service.js';
import { TokenService } from './token.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    SameOriginGuard,
    SessionCookies,
    // Secure by default: every route needs a token unless it says @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [AuthService, SessionCookies, TokenService, PasswordService],
})
export class AuthModule {}
