import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import {
  EMAIL_MAX_LENGTH,
  NAME_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  TOKEN_MAX_LENGTH,
  TOKEN_MIN_LENGTH,
} from '../../../common/limits.js';

/** Emails are compared case-insensitively; the database enforces lower-case. */
const normaliseEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class RegisterDto {
  @ApiProperty({ example: 'ada@example.com' })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;

  @ApiProperty({
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
  })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @ApiProperty({ example: 'Ada Lovelace' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  name!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'ada@example.com' })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;

  /** No length floor here: login must not reveal the password policy. */
  @ApiProperty()
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}

export class TokenDto {
  @ApiProperty({ description: 'The token from the email link.' })
  @IsString()
  @MinLength(TOKEN_MIN_LENGTH)
  @MaxLength(TOKEN_MAX_LENGTH)
  token!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'ada@example.com' })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;
}

export class ResetPasswordDto extends TokenDto {
  @ApiProperty({
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
  })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword!: string;
}

// ---- responses (documentation only) ----

export class UserDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
  @ApiProperty() emailVerified!: boolean;
  @ApiProperty() isDemo!: boolean;
}

export class AuthResponseDto {
  @ApiProperty({
    description:
      'Short-lived JWT. Keep it in memory and send as `Authorization: Bearer`.',
  })
  accessToken!: string;
  @ApiProperty({ example: 900, description: 'Seconds until it expires.' })
  expiresIn!: number;
  @ApiProperty({ type: UserDto }) user!: UserDto;
}

export class MembershipDto {
  @ApiProperty() organizationId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: ['OWNER', 'ADMIN', 'MEMBER'] }) role!: string;
}

export class MeResponseDto extends UserDto {
  @ApiProperty({ type: [MembershipDto] }) memberships!: MembershipDto[];
}
