import type { INestApplication } from '@nestjs/common';
import {
  ApiProperty,
  ApiPropertyOptional,
  DocumentBuilder,
  SwaggerModule,
} from '@nestjs/swagger';

/** Documents the RFC 7807 error body so API consumers (and the generated client) know its shape. */
export class FieldErrorDto {
  @ApiProperty({ example: 'email' }) field!: string;
  @ApiProperty({ example: 'email must be an email' }) message!: string;
}

export class ProblemDetailsDto {
  @ApiProperty({ example: 'https://docs.example.com/errors/validation-failed' })
  type!: string;
  @ApiProperty({ example: 'Validation failed' }) title!: string;
  @ApiProperty({ example: 400 }) status!: number;
  @ApiProperty({ example: 'One or more fields are invalid.' }) detail!: string;
  @ApiProperty({
    example: 'VALIDATION_FAILED',
    description: 'Stable, machine-readable error code.',
  })
  code!: string;
  @ApiPropertyOptional({
    description: 'Quote this when contacting support; it ties to server logs.',
  })
  requestId?: string;
  @ApiPropertyOptional({ type: [FieldErrorDto] }) errors?: FieldErrorDto[];
}

export const SWAGGER_PATH = 'docs';
export const SWAGGER_JSON_PATH = 'docs-json';

export function setupSwagger(app: INestApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('SaaS X-ray API')
      .setDescription(
        'Multi-tenant task & invoice backend. Errors use RFC 7807 problem+json.',
      )
      .setVersion('1.0')
      .addBearerAuth()
      .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, 'apiKey')
      .build(),
    { extraModels: [ProblemDetailsDto] },
  );
  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    jsonDocumentUrl: SWAGGER_JSON_PATH,
  });
}
