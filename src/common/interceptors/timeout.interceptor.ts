import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  RequestTimeoutException,
} from '@nestjs/common';
import {
  Observable,
  TimeoutError,
  catchError,
  throwError,
  timeout,
} from 'rxjs';
import { AppConfigService } from '../../core/config/config.service.js';

/**
 * Fails requests that run longer than REQUEST_TIMEOUT_MS with a clean 408, so a hung
 * dependency can't pin connections forever. Note: this stops *waiting*; it does not cancel
 * the underlying work. Long jobs belong on a queue, not in a request.
 */
@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  constructor(private readonly config: AppConfigService) {}

  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(
      timeout(this.config.get('REQUEST_TIMEOUT_MS')),
      catchError((error: unknown) =>
        error instanceof TimeoutError
          ? throwError(
              () =>
                new RequestTimeoutException(
                  'The request took too long to complete.',
                ),
            )
          : throwError(() => error),
      ),
    );
  }
}
