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
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { uuidParam } from '../../common/pipes/uuid-param.pipe.js';
import { RequirePermission } from '../tenancy/require-permission.decorator.js';
import {
  ClientDto,
  ClientPageDto,
  CreateClientDto,
  ListClientsQueryDto,
  UpdateClientDto,
} from './dto/client.dto.js';
import { ClientsService } from './clients.service.js';

const idPipe = uuidParam('Client');

@ApiTags('Clients')
@ApiBearerAuth()
@ApiParam({ name: 'orgId', format: 'uuid' })
@Controller('orgs/:orgId/clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Post()
  @RequirePermission('client:write')
  @ApiOperation({
    summary: 'Create a client (owner, admin)',
    description: 'Email is unique per organisation (409 if it already exists).',
  })
  create(@Body() dto: CreateClientDto): Promise<ClientDto> {
    return this.clients.create(dto);
  }

  @Get()
  @RequirePermission('client:read')
  @ApiOperation({ summary: 'List clients, A to Z, with search and paging' })
  list(@Query() query: ListClientsQueryDto): Promise<ClientPageDto> {
    return this.clients.list(query);
  }

  @Get(':id')
  @RequirePermission('client:read')
  @ApiOperation({ summary: 'One client' })
  get(@Param('id', idPipe) id: string): Promise<ClientDto> {
    return this.clients.get(id);
  }

  @Patch(':id')
  @RequirePermission('client:write')
  @ApiOperation({ summary: 'Change a client’s name or email (owner, admin)' })
  update(
    @Param('id', idPipe) id: string,
    @Body() dto: UpdateClientDto,
  ): Promise<ClientDto> {
    return this.clients.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('client:write')
  @ApiOperation({
    summary: 'Delete a client (owner, admin)',
    description: 'A client that has invoices cannot be deleted (409).',
  })
  remove(@Param('id', idPipe) id: string): Promise<void> {
    return this.clients.remove(id);
  }
}
