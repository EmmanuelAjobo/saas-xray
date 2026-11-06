import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../core/config/config.service.js';
import { REQUEST_ID_HEADER } from '../../core/context/request-id.js';
import { RequestContextService } from '../../core/context/request-context.service.js';
import { buildProblem } from './problem-details.js';

/**
 * The single exit point for every error. Responds with RFC 7807 `application/problem+json`
 * and logs 5xx with the full error (the client only ever sees a generic message).
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly config: AppConfigService,
    private readonly context: RequestContextService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GlobalExceptionFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    // WebSocket / RPC contexts have their own error channels.
    if (host.getType() !== 'http') throw exception;

    const http = host.switchToHttp();
    const request = http.getRequest<{ headers: Record<string, unknown> }>();
    const response: unknown = http.getResponse();
    const adapter = this.adapterHost.httpAdapter;

    const header = request.headers[REQUEST_ID_HEADER];
    const problem = buildProblem(exception, {
      requestId:
        this.context.requestId ??
        (typeof header === 'string' ? header : undefined),
      docsBaseUrl: this.config.get('ERROR_DOCS_BASE_URL'),
    });

    if (problem.status >= 500) {
      this.logger.error(
        { err: exception, code: problem.code },
        'Unhandled exception',
      );
    }

    // Too late to send a clean error (e.g. mid-stream); the connection is closed instead.
    if (adapter.isHeadersSent(response)) {
      adapter.end(response);
      return;
    }

    adapter.setHeader(
      response,
      'Content-Type',
      'application/problem+json; charset=utf-8',
    );
    adapter.reply(response, problem, problem.status);
  }
}
