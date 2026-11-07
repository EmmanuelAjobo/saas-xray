import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ForbiddenError } from '../../common/errors/domain-errors.js';
import type { RequestAuth } from '../../core/context/request-context.service.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.decorator.js';
import type { ClientMeta } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Public } from '../auth/public.decorator.js';
import { SessionCookies } from '../auth/session-cookies.service.js';
import { Inject } from '@nestjs/common';
import { CAPTCHA_VERIFIER, type CaptchaVerifier } from './captcha.js';
import { DemoSessionDto, StartDemoDto, SwitchRoleDto } from './dto/demo.dto.js';
import { DemoService, type DemoSession } from './demo.service.js';

const clientMeta = (req: Request): ClientMeta => ({
  ip: req.ip,
  userAgent: req.headers['user-agent'],
});

@ApiTags('Demo')
@Controller()
export class DemoController {
  constructor(
    private readonly demo: DemoService,
    private readonly cookies: SessionCookies,
    @Inject(CAPTCHA_VERIFIER) private readonly captcha: CaptchaVerifier,
  ) {}

  private respond(res: Response, result: DemoSession) {
    return {
      ...this.cookies.start(res, result.session),
      organization: result.organization,
      expiresAt: result.expiresAt,
      role: result.role,
    };
  }

  @Public()
  @Post('auth/demo')
  @RateLimit('demo')
  @ApiOperation({
    summary: 'Try the demo: your own sandbox, no sign-up',
    description:
      'Creates a private sandbox organisation (people, tasks, clients and invoices) and signs you in as its owner. It is deleted after DEMO_TTL_HOURS. Needs a Turnstile token when the server has Turnstile enabled.',
  })
  async start(
    @Body() dto: StartDemoDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DemoSessionDto> {
    this.demo.assertEnabled();
    if (!(await this.captcha.verify(dto.turnstileToken, req.ip))) {
      throw new ForbiddenError('Captcha verification failed.');
    }
    return this.respond(res, await this.demo.start(clientMeta(req)));
  }

  @ApiBearerAuth()
  @Post('demo/switch-role')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Demo only: become the sandbox’s owner, admin or member',
    description:
      'Lets a visitor feel role-based access. Moves between the three people of your own sandbox and replaces your session.',
  })
  async switchRole(
    @CurrentUser() user: RequestAuth,
    @Body() dto: SwitchRoleDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DemoSessionDto> {
    return this.respond(
      res,
      await this.demo.switchRole(user, dto.role, clientMeta(req)),
    );
  }
}
