import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { Role } from '../../../generated/prisma/client.js';
import { AuthResponseDto } from '../../auth/dto/auth.dto.js';

/** Cloudflare tokens are well under 2 KB; the cap only rejects abuse early. */
const CAPTCHA_TOKEN_MAX_LENGTH = 2_048;

export class StartDemoDto {
  @ApiPropertyOptional({
    description:
      'The Cloudflare Turnstile token. Required only when the server has Turnstile enabled.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(CAPTCHA_TOKEN_MAX_LENGTH)
  turnstileToken?: string;
}

export class SwitchRoleDto {
  @ApiProperty({ enum: Object.values(Role), example: 'MEMBER' })
  @IsEnum(Role)
  role!: Role;
}

export class DemoOrganizationDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
}

export class DemoSessionDto extends AuthResponseDto {
  @ApiProperty({ type: DemoOrganizationDto })
  organization!: DemoOrganizationDto;
  @ApiProperty({ description: 'When this sandbox is deleted.' })
  expiresAt!: Date;
  @ApiProperty({
    enum: Object.values(Role),
    description: 'The role this session has in the sandbox.',
  })
  role!: Role;
}
