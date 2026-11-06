import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  INT4_MAX,
  LINE_ITEM_DESCRIPTION_MAX_LENGTH,
  LINE_ITEM_QUANTITY_MAX,
  SEARCH_TERM_MAX_LENGTH,
} from '../../../common/limits.js';
import { PageQueryDto } from '../../../common/pagination.js';
import { InvoiceStatus } from '../../../generated/prisma/client.js';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class LineItemDto {
  @ApiProperty({ example: 'Website design (hours)' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(LINE_ITEM_DESCRIPTION_MAX_LENGTH)
  description!: string;

  @ApiProperty({ example: 12, minimum: 1, maximum: LINE_ITEM_QUANTITY_MAX })
  @IsInt()
  @Min(1)
  @Max(LINE_ITEM_QUANTITY_MAX)
  quantity!: number;

  @ApiProperty({
    example: 9500,
    description: 'Price of ONE unit in cents (no decimals, no floats).',
  })
  @IsInt()
  @Min(0)
  @Max(INT4_MAX)
  unitPriceCents!: number;
}

export class CreateInvoiceDto {
  @ApiProperty({ description: 'A client of this organisation.' })
  @IsUUID()
  clientId!: string;

  @ApiPropertyOptional({
    example: 'USD',
    description: 'ISO 4217 code. Defaults to INVOICE_DEFAULT_CURRENCY.',
  })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, {
    message: 'currency must be a 3-letter uppercase ISO 4217 code',
  })
  currency?: string;

  @ApiPropertyOptional({ nullable: true, example: '2026-12-31T00:00:00Z' })
  @IsOptional()
  @IsISO8601({ strict: true })
  dueDate?: string | null;

  @ApiPropertyOptional({ type: [LineItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LineItemDto)
  items?: LineItemDto[];
}

/** Only DRAFT invoices can be edited. Sending `items` replaces all of them. */
export class UpdateInvoiceDto extends PartialType(CreateInvoiceDto) {}

export class ListInvoicesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: Object.values(InvoiceStatus) })
  @IsOptional()
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiPropertyOptional({
    description: 'Matches the invoice number, e.g. "0042".',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(SEARCH_TERM_MAX_LENGTH)
  q?: string;
}

// ---- responses (documentation only) ----

export class InvoiceClientDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
}

export class LineItemViewDto extends LineItemDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'quantity × unit price, in cents.' })
  amountCents!: number;
}

export class InvoiceSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'INV-0042' }) number!: string;
  @ApiProperty({ enum: Object.values(InvoiceStatus) }) status!: InvoiceStatus;
  @ApiProperty({ description: 'Sum of the line items, in cents.' })
  totalCents!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ nullable: true, type: Date }) dueDate!: Date | null;
  @ApiProperty({ type: InvoiceClientDto }) client!: InvoiceClientDto;
  @ApiProperty() lineItemCount!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class InvoiceDto extends InvoiceSummaryDto {
  @ApiProperty({ type: [LineItemViewDto] }) lineItems!: LineItemViewDto[];
}

export class InvoicePageDto {
  @ApiProperty({ type: [InvoiceSummaryDto] }) data!: InvoiceSummaryDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}
