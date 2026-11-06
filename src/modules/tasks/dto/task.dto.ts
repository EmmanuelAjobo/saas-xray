import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  SEARCH_TERM_MAX_LENGTH,
  TASK_DESCRIPTION_MAX_LENGTH,
  TASK_TITLE_MAX_LENGTH,
} from '../../../common/limits.js';
import { PageQueryDto } from '../../../common/pagination.js';
import { TaskPriority, TaskStatus } from '../../../generated/prisma/client.js';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateTaskDto {
  @ApiProperty({ example: 'Draft the launch announcement' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(TASK_TITLE_MAX_LENGTH)
  title!: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(TASK_DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  @ApiPropertyOptional({ enum: Object.values(TaskStatus), default: 'TODO' })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @ApiPropertyOptional({ enum: Object.values(TaskPriority), default: 'MEDIUM' })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Membership id of a member of this organisation (see GET /members). null = unassigned.',
  })
  @IsOptional()
  @IsUUID()
  assigneeId?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-12-31T17:00:00Z' })
  @IsOptional()
  @IsISO8601({ strict: true })
  dueDate?: string | null;
}

export class UpdateTaskDto extends PartialType(CreateTaskDto) {}

export class ListTasksQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: Object.values(TaskStatus) })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @ApiPropertyOptional({ enum: Object.values(TaskPriority) })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @ApiPropertyOptional({
    description: 'A membership id, or "me" for my own tasks.',
  })
  @IsOptional()
  @ValidateIf((_query, value) => value !== 'me')
  @IsUUID()
  assigneeId?: string;

  @ApiPropertyOptional({
    description: 'Matches title or description, case-insensitive.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(SEARCH_TERM_MAX_LENGTH)
  q?: string;
}

// ---- responses (documentation only) ----

export class TaskAssigneeDto {
  @ApiProperty({ description: 'Membership id.' }) id!: string;
  @ApiProperty() name!: string;
}

export class TaskDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({ enum: Object.values(TaskStatus) }) status!: TaskStatus;
  @ApiProperty({ enum: Object.values(TaskPriority) }) priority!: TaskPriority;
  @ApiProperty({ nullable: true, type: TaskAssigneeDto })
  assignee!: TaskAssigneeDto | null;
  @ApiProperty({ nullable: true, type: String }) createdById!: string | null;
  @ApiProperty({ nullable: true, type: Date }) dueDate!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class TaskPageDto {
  @ApiProperty({ type: [TaskDto] }) data!: TaskDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}
