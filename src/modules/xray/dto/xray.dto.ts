import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

export class ListXrayEventsQueryDto {
  @ApiPropertyOptional({
    description:
      'Events to return (newest N, oldest first). Capped by the server (XRAY_BUFFER_SIZE).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({
    example: '1731000000000-0',
    description:
      'Only events after this id: pass the last id you received to poll for new ones.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,16}-\d{1,16}$/, {
    message: 'after must be an event id such as 1731000000000-0',
  })
  after?: string;
}

// ---- responses (documentation only) ----

export class XrayEventDto {
  @ApiProperty({ example: '1731000000000-0', description: 'Orders events.' })
  id!: string;
  @ApiProperty({ description: 'Epoch milliseconds.' }) ts!: number;
  @ApiPropertyOptional({
    description: 'Events with the same id are one click.',
  })
  requestId?: string;
  @ApiProperty({
    enum: [
      'http.request',
      'tenant.check',
      'auth.check',
      'db.queries',
      'email.sent',
      'email.skipped',
    ],
  })
  kind!: string;
  @ApiProperty({ enum: ['info', 'success', 'warn', 'error'] })
  severity!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ description: 'One plain-English sentence.' }) summary!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Technical details (plain values only).',
  })
  meta!: Record<string, string | number | boolean | null>;
}

export class XrayEventsDto {
  @ApiProperty({ type: [XrayEventDto], description: 'Oldest first.' })
  data!: XrayEventDto[];
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Pass as `after` to get only newer events; null if there are none yet.',
  })
  cursor!: string | null;
}
