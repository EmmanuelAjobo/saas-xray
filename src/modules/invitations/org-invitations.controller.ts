import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { uuidParam } from '../../common/pipes/uuid-param.pipe.js';
import type {
  RequestAuth,
  RequestTenant,
} from '../../core/context/request-context.service.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { CurrentTenant } from '../tenancy/current-tenant.decorator.js';
import { RequirePermission } from '../tenancy/require-permission.decorator.js';
import { CreateInvitationDto, InvitationDto } from './dto/invitation.dto.js';
import { InvitationsService } from './invitations.service.js';

const invitationIdPipe = uuidParam('Invitation');

/** Managing an organisation's invitations (owner, admin). */
@ApiTags('Invitations')
@ApiBearerAuth()
@ApiParam({ name: 'orgId', format: 'uuid' })
@Controller('orgs/:orgId/invitations')
export class OrgInvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post()
  @RateLimit('invite')
  @RequirePermission('member:invite')
  @ApiOperation({
    summary: 'Invite someone by email',
    description:
      'Needs a verified email address. Grants ADMIN or MEMBER. Holds a seat until accepted, revoked or expired; over the plan limit answers 402.',
  })
  create(
    @CurrentUser() user: RequestAuth,
    @CurrentTenant() tenant: RequestTenant,
    @Body() dto: CreateInvitationDto,
  ): Promise<InvitationDto> {
    return this.invitations.create(user, tenant, dto);
  }

  @Get()
  @RequirePermission('member:invite')
  @ApiOperation({ summary: 'Invitations for this organisation, newest first' })
  list(@CurrentTenant() tenant: RequestTenant): Promise<InvitationDto[]> {
    return this.invitations.list(tenant);
  }

  @Post(':invitationId/resend')
  @HttpCode(HttpStatus.OK)
  @RateLimit('invite')
  @RequirePermission('member:invite')
  @ApiOperation({
    summary: 'Send the invitation again',
    description: 'Issues a new link and expiry; the old link stops working.',
  })
  resend(
    @CurrentUser() user: RequestAuth,
    @CurrentTenant() tenant: RequestTenant,
    @Param('invitationId', invitationIdPipe) invitationId: string,
  ): Promise<InvitationDto> {
    return this.invitations.resend(user, tenant, invitationId);
  }

  @Delete(':invitationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('member:invite')
  @ApiOperation({
    summary: 'Cancel an invitation',
    description: 'Its link stops working. Repeating it is harmless.',
  })
  revoke(
    @CurrentTenant() tenant: RequestTenant,
    @Param('invitationId', invitationIdPipe) invitationId: string,
  ): Promise<void> {
    return this.invitations.revoke(tenant, invitationId);
  }
}
