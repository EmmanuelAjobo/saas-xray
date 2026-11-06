import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { ORG_NAME_MAX_LENGTH } from '../../../common/limits.js';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateOrganizationDto {
  @ApiProperty({ example: 'Acme Studio', maxLength: ORG_NAME_MAX_LENGTH })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(ORG_NAME_MAX_LENGTH)
  name!: string;
}

export class UpdateOrganizationDto extends CreateOrganizationDto {}

// ---- responses (documentation only) ----

export class OrganizationSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'Stable, URL-safe identifier.' }) slug!: string;
  @ApiProperty({ enum: ['OWNER', 'ADMIN', 'MEMBER'] }) role!: string;
  @ApiProperty() createdAt!: Date;
}

export class OrganizationDetailDto extends OrganizationSummaryDto {
  @ApiProperty() memberCount!: number;
  @ApiProperty({ enum: ['FREE', 'PRO'] }) plan!: string;
}
