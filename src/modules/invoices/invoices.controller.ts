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
import type { RequestTenant } from '../../core/context/request-context.service.js';
import { CurrentTenant } from '../tenancy/current-tenant.decorator.js';
import { uuidParam } from '../../common/pipes/uuid-param.pipe.js';
import { RequirePermission } from '../tenancy/require-permission.decorator.js';
import {
  CreateInvoiceDto,
  InvoiceDto,
  InvoicePageDto,
  ListInvoicesQueryDto,
  UpdateInvoiceDto,
} from './dto/invoice.dto.js';
import { InvoicesService } from './invoices.service.js';

const idPipe = uuidParam('Invoice');

@ApiTags('Invoices')
@ApiBearerAuth()
@ApiParam({ name: 'orgId', format: 'uuid' })
@Controller('orgs/:orgId/invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Post()
  @RequirePermission('invoice:create')
  @ApiOperation({
    summary: 'Create a DRAFT invoice (owner, admin)',
    description:
      'The number (INV-0001, INV-0002, ...) and the total are computed by the server. Money is whole cents.',
  })
  create(
    @CurrentTenant() tenant: RequestTenant,
    @Body() dto: CreateInvoiceDto,
  ): Promise<InvoiceDto> {
    return this.invoices.create(tenant, dto);
  }

  @Get()
  @RequirePermission('invoice:read')
  @ApiOperation({ summary: 'List invoices, newest first' })
  list(@Query() query: ListInvoicesQueryDto): Promise<InvoicePageDto> {
    return this.invoices.list(query);
  }

  @Get(':id')
  @RequirePermission('invoice:read')
  @ApiOperation({ summary: 'One invoice with its line items' })
  get(@Param('id', idPipe) id: string): Promise<InvoiceDto> {
    return this.invoices.get(id);
  }

  @Patch(':id')
  @RequirePermission('invoice:update')
  @ApiOperation({
    summary: 'Edit a DRAFT invoice (owner, admin)',
    description:
      'Sending `items` replaces all line items. Anything but a DRAFT answers 409.',
  })
  update(
    @Param('id', idPipe) id: string,
    @Body() dto: UpdateInvoiceDto,
  ): Promise<InvoiceDto> {
    return this.invoices.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('invoice:update')
  @ApiOperation({
    summary: 'Delete a DRAFT invoice (owner, admin)',
    description: 'Only drafts. Sent invoices are voided, never erased.',
  })
  remove(@Param('id', idPipe) id: string): Promise<void> {
    return this.invoices.remove(id);
  }

  @Post(':id/send')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('invoice:send')
  @ApiOperation({
    summary: 'Send a DRAFT invoice to the client (owner, admin)',
    description:
      'DRAFT → SENT. Needs at least one priced line item. Sets the due date if none was given, and emails the client.',
  })
  send(@Param('id', idPipe) id: string): Promise<InvoiceDto> {
    return this.invoices.send(id);
  }

  @Post(':id/pay')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('invoice:update')
  @ApiOperation({
    summary: 'Mark a SENT or OVERDUE invoice as paid (owner, admin)',
  })
  pay(@Param('id', idPipe) id: string): Promise<InvoiceDto> {
    return this.invoices.pay(id);
  }

  @Post(':id/void')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('invoice:void')
  @ApiOperation({
    summary: 'Void an unpaid invoice (owner, admin)',
    description:
      'DRAFT, SENT or OVERDUE → VOID. A PAID invoice cannot be voided.',
  })
  void(@Param('id', idPipe) id: string): Promise<InvoiceDto> {
    return this.invoices.void(id);
  }
}
