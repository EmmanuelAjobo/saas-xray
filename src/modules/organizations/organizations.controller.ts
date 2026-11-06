import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type {
  RequestAuth,
  RequestTenant,
} from '../../core/context/request-context.service.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { CurrentTenant } from '../tenancy/current-tenant.decorator.js';
import { RequirePermission } from '../tenancy/require-permission.decorator.js';
import {
  CreateOrganizationDto,
  OrganizationDetailDto,
  OrganizationSummaryDto,
  UpdateOrganizationDto,
} from './dto/organization.dto.js';
import { OrganizationsService } from './organizations.service.js';

@ApiTags('Organizations')
@ApiBearerAuth()
@Controller('orgs')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Post()
  @RateLimit('orgCreate')
  @ApiOperation({
    summary: 'Create an organisation',
    description:
      'The caller becomes its OWNER, on the FREE plan. Limited per user (MAX_ORGS_PER_USER).',
  })
  create(
    @CurrentUser() user: RequestAuth,
    @Body() dto: CreateOrganizationDto,
  ): Promise<OrganizationSummaryDto> {
    return this.organizations.create(user, dto.name);
  }

  @Get()
  @ApiOperation({ summary: 'Organisations I belong to' })
  list(@CurrentUser() user: RequestAuth): Promise<OrganizationSummaryDto[]> {
    return this.organizations.listMine(user.userId);
  }

  @Get(':orgId')
  @RequirePermission('org:read')
  @ApiParam({ name: 'orgId', format: 'uuid' })
  @ApiOperation({
    summary: 'One organisation',
    description: 'Not a member (or no such organisation): 404.',
  })
  get(@CurrentTenant() tenant: RequestTenant): Promise<OrganizationDetailDto> {
    return this.organizations.get(tenant);
  }

  @Patch(':orgId')
  @RequirePermission('org:update')
  @ApiParam({ name: 'orgId', format: 'uuid' })
  @ApiOperation({ summary: 'Rename the organisation (owner, admin)' })
  rename(
    @CurrentTenant() tenant: RequestTenant,
    @Body() dto: UpdateOrganizationDto,
  ): Promise<OrganizationDetailDto> {
    return this.organizations.rename(tenant, dto.name);
  }

  @Delete(':orgId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('org:delete')
  @ApiParam({ name: 'orgId', format: 'uuid' })
  @ApiOperation({
    summary: 'Delete the organisation and all its data (owner only)',
    description: 'Irreversible.',
  })
  remove(@CurrentTenant() tenant: RequestTenant): Promise<void> {
    return this.organizations.remove(tenant);
  }
}
