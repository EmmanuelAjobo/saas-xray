import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { Role } from '../../../generated/prisma/client.js';

export class ChangeRoleDto {
  @ApiProperty({ enum: Object.values(Role), example: 'ADMIN' })
  @IsEnum(Role)
  role!: Role;
}

// ---- responses (documentation only) ----

export class MemberDto {
  @ApiProperty({ description: 'Membership id (use this in /members/{id}).' })
  id!: string;
  @ApiProperty() userId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: Object.values(Role) }) role!: Role;
  @ApiProperty() joinedAt!: Date;
}
