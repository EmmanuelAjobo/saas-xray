import { Controller, Get, Headers, Query, Sse } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { SkipTimeout } from '../../common/interceptors/skip-timeout.decorator.js';
import { RequirePermission } from '../tenancy/require-permission.decorator.js';
import { ListXrayEventsQueryDto, XrayEventsDto } from './dto/xray.dto.js';
import {
  type StreamMessage,
  XrayReaderService,
} from './xray-reader.service.js';

@ApiTags('X-ray')
@ApiBearerAuth()
@ApiParam({ name: 'orgId', format: 'uuid' })
@Controller('orgs/:orgId/xray')
export class XrayController {
  constructor(private readonly reader: XrayReaderService) {}

  @Get('events')
  @RequirePermission('xray:read')
  @ApiOperation({
    summary: 'What the backend just did for this organisation',
    description:
      'Recent X-ray events, oldest first. Every request you make appears as a few events ' +
      'sharing one `requestId`: the membership check, the permission check, the database ' +
      'work, and the answer. Poll with `after=<cursor>` for new ones. Events contain no ' +
      'request bodies, tokens or personal data. Demo sandboxes: any role. Real ' +
      'organisations: owners and admins.',
  })
  events(@Query() query: ListXrayEventsQueryDto): Promise<XrayEventsDto> {
    return this.reader.list(query);
  }

  @Sse('stream')
  @SkipTimeout()
  @RequirePermission('xray:read')
  @ApiOperation({
    summary: 'The same events, live (Server-Sent Events)',
    description:
      'Sends recent history, then each new event as it happens, plus a `heartbeat` every ' +
      'few seconds. Browsers cannot send an Authorization header from EventSource, so read ' +
      'it with `fetch` and a streaming reader. After the server closes the stream ' +
      '(it does so periodically) reconnect with the `Last-Event-ID` header to resume.',
  })
  @ApiQuery({ name: 'after', required: false })
  stream(
    @Headers('last-event-id') lastEventId?: string,
    @Query('after') after?: string,
  ): Observable<StreamMessage> {
    return this.reader.stream(lastEventId ?? after);
  }
}
