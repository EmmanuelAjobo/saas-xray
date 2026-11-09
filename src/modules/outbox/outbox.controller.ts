import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../tenancy/require-permission.decorator.js';
import { OutboxDto } from './dto/outbox.dto.js';
import { OutboxService } from './outbox.service.js';

@ApiTags('Outbox')
@ApiBearerAuth()
@ApiParam({ name: 'orgId', format: 'uuid' })
@Controller('orgs/:orgId/outbox')
export class OutboxController {
  constructor(private readonly outbox: OutboxService) {}

  @Get()
  @RequirePermission('outbox:read')
  @ApiOperation({
    summary: 'The emails this demo sandbox would have sent',
    description:
      'Demo sandboxes never send real email; what they would have sent is captured here, ' +
      'newest first, so you can see what the client would have received. Real ' +
      'organisations have no outbox (404): their email is delivered for real.',
  })
  list(): Promise<OutboxDto> {
    return this.outbox.list();
  }
}
