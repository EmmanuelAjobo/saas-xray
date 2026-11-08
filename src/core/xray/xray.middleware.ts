import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { getRequestIdFromRequest } from '../context/request-id.js';
import type { RequestTenant } from '../context/request-context.service.js';
import { XrayService } from './xray.service.js';
import { XrayTrace, runInTrace } from './xray.trace.js';

/** The X-ray's own endpoints are never recorded (a panel watching itself would never be quiet). */
const XRAY_OWN_ROUTES = /\/orgs\/:orgId\/xray(\/|$)/;

/**
 * Opens a trace for every request and, once the response is sent, publishes what happened
 * to the stream of the organisation the request was VERIFIED to belong to.
 *
 * "Verified" is the point: the organisation comes from `request.tenant`, which only the
 * tenant guard sets, after confirming membership. A request that is not a tenant route, or
 * whose caller is not a member (a 404), has no tenant and publishes nothing. So nobody can
 * write into another organisation's stream by guessing its id.
 *
 * Runs on `finish`, so it sees the FINAL status, including refusals by guards (403) and
 * the error filter.
 */
@Injectable()
export class XrayMiddleware implements NestMiddleware {
  private readonly logger = new Logger(XrayMiddleware.name);

  constructor(private readonly xray: XrayService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    if (!this.xray.enabled) {
      next();
      return;
    }
    const trace = new XrayTrace(getRequestIdFromRequest(req));
    const started = performance.now();
    res.on('finish', () => {
      try {
        this.finish(req, res, trace, performance.now() - started);
      } catch (error) {
        // Never let the X-ray disturb the response that has already gone out.
        this.logger.warn(
          `X-ray trace failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        trace.close();
      }
    });
    runInTrace(trace, () => next());
  }

  private finish(
    req: Request,
    res: Response,
    trace: XrayTrace,
    durationMs: number,
  ): void {
    const tenant = (req as Request & { tenant?: RequestTenant }).tenant;
    const route: unknown = req.route?.path;
    if (!tenant || typeof route !== 'string' || XRAY_OWN_ROUTES.test(route)) {
      trace.close(); // nothing to show, and nowhere safe to send late events
      return;
    }
    const organizationId = tenant.organizationId;
    const events = trace.summarise({
      method: req.method,
      route,
      status: res.statusCode,
      durationMs,
    });
    trace.close((late) => this.xray.publish(organizationId, late));
    this.xray.publish(organizationId, events);
  }
}
