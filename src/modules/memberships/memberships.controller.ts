import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { uuidParam } from '../../common/pipes/uuid-param.pipe.js';
import type { RequestTenant } from '../../core/context/request-context.service.js';
import { CurrentTenant } from '../tenancy/current-tenant.decorator.js';
import { RequirePermission } from '../tenancy/require-permission.decorator.js';
import { ChangeRoleDto, MemberDto } from './dto/membership.dto.js';
import { MembershipsService } from './memberships.service.js';

const membershipIdPipe = uuidParam('Member');

@ApiTags('Members')
@ApiBearerAuth()
@ApiParam({ name: 'orgId', format: 'uuid' })
@Controller('orgs/:orgId/members')
export class MembershipsController {
  constructor(private readonly memberships: MembershipsService) {}

  @Get()
  @RequirePermission('member:read')
  @ApiOperation({ summary: 'Everyone in the organisation' })
  list(@CurrentTenant() tenant: RequestTenant): Promise<MemberDto[]> {
    return this.memberships.list(tenant);
  }

  // Declared before ':membershipId' routes so "leave" is never read as an id.
  @Post('leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('org:read')
  @ApiOperation({
    summary: 'Leave the organisation',
    description:
      'The only owner cannot leave; make someone else an owner first.',
  })
  leave(@CurrentTenant() tenant: RequestTenant): Promise<void> {
    return this.memberships.leave(tenant);
  }

  @Patch(':membershipId')
  @RequirePermission('member:change-role')
  @ApiOperation({
    summary: 'Change a member’s role',
    description:
      'You cannot change your own role. Only an owner can change an owner or grant ownership. The organisation always keeps at least one owner.',
  })
  changeRole(
    @CurrentTenant() tenant: RequestTenant,
    @Param('membershipId', membershipIdPipe) membershipId: string,
    @Body() dto: ChangeRoleDto,
  ): Promise<MemberDto> {
    return this.memberships.changeRole(tenant, membershipId, dto.role);
  }

  @Delete(':membershipId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('member:remove')
  @ApiOperation({
    summary: 'Remove a member',
    description:
      'Their tasks are kept and become unassigned. Only an owner can remove an owner.',
  })
  remove(
    @CurrentTenant() tenant: RequestTenant,
    @Param('membershipId', membershipIdPipe) membershipId: string,
  ): Promise<void> {
    return this.memberships.remove(tenant, membershipId);
  }
}
