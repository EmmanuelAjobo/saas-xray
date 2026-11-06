import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, MaxLength } from 'class-validator';
import { EMAIL_MAX_LENGTH } from '../../../common/limits.js';

/** Roles an invitation may grant. OWNER is never invited: ownership is handed over explicitly. */
export const INVITABLE_ROLES = ['ADMIN', 'MEMBER'] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export class CreateInvitationDto {
  @ApiProperty({ example: 'newhire@example.com' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;

  @ApiProperty({ enum: INVITABLE_ROLES, example: 'MEMBER' })
  @IsIn(INVITABLE_ROLES)
  role!: InvitableRole;
}

// ---- responses (documentation only) ----

export class InvitationDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: INVITABLE_ROLES }) role!: string;
  @ApiProperty({
    enum: ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'],
    description: 'A PENDING invitation past its expiry is reported as EXPIRED.',
  })
  status!: string;
  @ApiProperty() expiresAt!: Date;
  @ApiProperty() createdAt!: Date;
}

export class InvitationPreviewDto {
  @ApiProperty() organizationName!: string;
  @ApiProperty({
    description: 'The address the invitation was sent to (pre-fill sign-up).',
  })
  email!: string;
  @ApiProperty({ enum: INVITABLE_ROLES }) role!: string;
  @ApiProperty() expiresAt!: Date;
}

export class AcceptedInvitationDto {
  @ApiProperty() organizationId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: INVITABLE_ROLES }) role!: string;
}
