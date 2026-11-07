import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { UnauthenticatedError } from '../../common/errors/domain-errors.js';
import type { RequestAuth } from '../../core/context/request-context.service.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.decorator.js';
import { AuthService, type ClientMeta } from './auth.service.js';
import { CurrentUser } from './current-user.decorator.js';
import {
  AuthResponseDto,
  ForgotPasswordDto,
  LoginDto,
  MeResponseDto,
  RegisterDto,
  ResetPasswordDto,
  TokenDto,
} from './dto/auth.dto.js';
import { Public } from './public.decorator.js';
import { SameOriginGuard } from './same-origin.guard.js';
import { REFRESH_COOKIE, SessionCookies } from './session-cookies.service.js';

function clientMeta(req: Request): ClientMeta {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cookies: SessionCookies,
  ) {}

  @Public()
  @Post('register')
  @RateLimit('register')
  @ApiOperation({
    summary: 'Create an account',
    description:
      'Signs the user in immediately (email verification is required only for inviting people and billing). A verification email is sent.',
  })
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    return this.cookies.start(
      res,
      await this.auth.register(dto, clientMeta(req)),
    );
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @RateLimit('credentials')
  @ApiOperation({ summary: 'Log in with email and password' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    return this.cookies.start(res, await this.auth.login(dto, clientMeta(req)));
  }

  @Public()
  @UseGuards(SameOriginGuard)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @RateLimit('refresh')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Get a new access token using the refresh cookie',
    description:
      'Rotates the refresh token. Presenting an already-used refresh token revokes the whole session.',
  })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const token = (req.cookies as Record<string, string> | undefined)?.[
      REFRESH_COOKIE
    ];
    try {
      if (!token) throw new UnauthenticatedError('Session is no longer valid.');
      return this.cookies.start(
        res,
        await this.auth.refresh(token, clientMeta(req)),
      );
    } catch (error) {
      if (error instanceof UnauthenticatedError) this.cookies.clear(res);
      throw error;
    }
  }

  @Public()
  @UseGuards(SameOriginGuard)
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'End this session' })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token = (req.cookies as Record<string, string> | undefined)?.[
      REFRESH_COOKIE
    ];
    await this.auth.logout(token);
    this.cookies.clear(res);
  }

  @ApiBearerAuth()
  @UseGuards(SameOriginGuard)
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'End every session on every device' })
  async logoutAll(
    @CurrentUser() user: RequestAuth,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logoutAll(user.userId);
    this.cookies.clear(res);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit('tokenAction')
  @ApiOperation({ summary: 'Confirm an email address (single-use link)' })
  async verifyEmail(@Body() dto: TokenDto): Promise<void> {
    await this.auth.verifyEmail(dto.token);
  }

  @ApiBearerAuth()
  @Post('resend-verification')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit('resend')
  @ApiOperation({ summary: 'Send the verification email again' })
  async resendVerification(@CurrentUser() user: RequestAuth): Promise<void> {
    await this.auth.resendVerification(user.userId);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit('credentials')
  @ApiOperation({
    summary: 'Email a password-reset link',
    description:
      'Always answers 202, whether or not the address is registered, so it cannot be used to discover accounts.',
  })
  forgotPassword(@Body() dto: ForgotPasswordDto): { message: string } {
    this.auth.requestPasswordReset(dto.email);
    return {
      message:
        'If an account exists for that address, a reset link is on its way.',
    };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit('tokenAction')
  @ApiOperation({
    summary: 'Choose a new password using a reset link',
    description:
      'Single use, short-lived (PASSWORD_RESET_TTL_MINUTES), and signs out every session.',
  })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.auth.resetPassword(dto.token, dto.newPassword);
  }

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'The signed-in user and their organisations' })
  me(@CurrentUser() user: RequestAuth): Promise<MeResponseDto> {
    return this.auth.me(user.userId);
  }
}
