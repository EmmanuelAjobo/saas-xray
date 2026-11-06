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
  CreateTaskDto,
  ListTasksQueryDto,
  TaskDto,
  TaskPageDto,
  UpdateTaskDto,
} from './dto/task.dto.js';
import { TasksService } from './tasks.service.js';

const idPipe = uuidParam('Task');

@ApiTags('Tasks')
@ApiBearerAuth()
@ApiParam({ name: 'orgId', format: 'uuid' })
@Controller('orgs/:orgId/tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post()
  @RequirePermission('task:create')
  @ApiOperation({ summary: 'Create a task' })
  create(
    @CurrentTenant() tenant: RequestTenant,
    @Body() dto: CreateTaskDto,
  ): Promise<TaskDto> {
    return this.tasks.create(tenant, dto);
  }

  @Get()
  @RequirePermission('task:read')
  @ApiOperation({
    summary: 'List tasks, newest first',
    description:
      'Filter by status, priority, assigneeId (or "me") and search text; page with cursor.',
  })
  list(
    @CurrentTenant() tenant: RequestTenant,
    @Query() query: ListTasksQueryDto,
  ): Promise<TaskPageDto> {
    return this.tasks.list(tenant, query);
  }

  @Get(':id')
  @RequirePermission('task:read')
  @ApiOperation({ summary: 'One task' })
  get(@Param('id', idPipe) id: string): Promise<TaskDto> {
    return this.tasks.get(id);
  }

  @Patch(':id')
  @RequirePermission('task:update')
  @ApiOperation({
    summary: 'Change a task',
    description:
      'Members can edit tasks they created or are assigned to; only the creator can reassign. Owners and admins can edit any task.',
  })
  update(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id', idPipe) id: string,
    @Body() dto: UpdateTaskDto,
  ): Promise<TaskDto> {
    return this.tasks.update(tenant, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('task:delete')
  @ApiOperation({
    summary: 'Delete a task',
    description:
      'Members can delete only tasks they created. The task is hidden, not erased.',
  })
  remove(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id', idPipe) id: string,
  ): Promise<void> {
    return this.tasks.remove(tenant, id);
  }
}
