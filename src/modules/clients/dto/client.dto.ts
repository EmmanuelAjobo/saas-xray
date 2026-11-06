import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  EMAIL_MAX_LENGTH,
  NAME_MAX_LENGTH,
  SEARCH_TERM_MAX_LENGTH,
} from '../../../common/limits.js';
import { PageQueryDto } from '../../../common/pagination.js';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const normaliseEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CreateClientDto {
  @ApiProperty({ example: 'Northwind Traders' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  name!: string;

  @ApiProperty({ example: 'billing@northwind.example' })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;
}

export class UpdateClientDto extends PartialType(CreateClientDto) {}

export class ListClientsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    description: 'Matches name or email, case-insensitive.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(SEARCH_TERM_MAX_LENGTH)
  q?: string;
}

// ---- responses (documentation only) ----

export class ClientDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class ClientPageDto {
  @ApiProperty({ type: [ClientDto] }) data!: ClientDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}
