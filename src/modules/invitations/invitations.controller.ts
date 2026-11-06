import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RequestAuth } from '../../core/context/request-context.service.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { TokenDto } from '../auth/dto/auth.dto.js';
import { Public } from '../auth/public.decorator.js';
import {
  AcceptedInvitationDto,
  InvitationPreviewDto,
} from './dto/invitation.dto.js';
import { InvitationsService } from './invitations.service.js';

/** The receiving side: what a link is for, and accepting it. */
@ApiTags('Invitations')
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Public()
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RateLimit('tokenAction')
  @ApiOperation({
    summary: 'What is this invitation for? (no login needed)',
    description:
      'Returns the organisation name, the invited email and the role, so the sign-up page can pre-fill the email.',
  })
  preview(@Body() dto: TokenDto): Promise<InvitationPreviewDto> {
    return this.invitations.preview(dto.token);
  }

  @ApiBearerAuth()
  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @RateLimit('tokenAction')
  @ApiOperation({
    summary: 'Join the organisation',
    description:
      'The signed-in account must use the invited email address. Single use.',
  })
  accept(
    @CurrentUser() user: RequestAuth,
    @Body() dto: TokenDto,
  ): Promise<AcceptedInvitationDto> {
    return this.invitations.accept(user, dto.token);
  }
}
