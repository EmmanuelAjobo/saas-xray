import {
  Body,
  Controller,
  Get,
  HttpException,
  Post,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  ConflictError,
  InvalidStateTransitionError,
  NotFoundError,
} from '../../src/common/errors/domain-errors.js';
import { Public } from '../../src/modules/auth/public.decorator.js';
import { RequestContextService } from '../../src/core/context/request-context.service.js';

class AddressDto {
  @IsString() @MinLength(3) postcode!: string;
}

class CreateProbeDto {
  @IsEmail() email!: string;
  @ValidateNested() @Type(() => AddressDto) address!: AddressDto;
}

class PageQueryDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit!: number;
}

/**
 * Test-only controller (never part of the app). Gives the e2e suite endpoints that throw
 * every kind of error, so the real filter / pipe / interceptor chain is exercised over HTTP.
 */
@Public()
@Controller('probe')
export class ProbeController {
  constructor(private readonly context: RequestContextService) {}

  @Get('ok') ok() {
    return { ok: true };
  }

  @Get('request-id') requestId() {
    return { requestId: this.context.requestId };
  }

  @Get('not-found') notFound() {
    throw new NotFoundError('Invoice not found');
  }

  @Get('conflict') conflict() {
    throw new ConflictError('Email already in use');
  }

  @Get('state') state() {
    throw new InvalidStateTransitionError('Only DRAFT invoices can be edited');
  }

  @Get('teapot') teapot() {
    throw new HttpException('short and stout', 418);
  }

  @Get('boom') boom() {
    throw new Error('connect ECONNREFUSED 10.1.2.3:5432 password=hunter2');
  }

  @Get('prisma-unique') prismaUnique() {
    throw Object.assign(
      new Error('Unique constraint failed on the fields: (`email`)'),
      {
        name: 'PrismaClientKnownRequestError',
        code: 'P2002',
        meta: { target: ['email'] },
      },
    );
  }

  @Get('slow') async slow() {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { slow: true };
  }

  @Get('page') page(@Query() query: PageQueryDto) {
    return { limit: query.limit, type: typeof query.limit };
  }

  @Post('create') create(@Body() body: CreateProbeDto) {
    return body;
  }
}
