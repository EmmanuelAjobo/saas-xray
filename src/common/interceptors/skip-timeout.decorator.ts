import { SetMetadata } from '@nestjs/common';

export const SKIP_TIMEOUT_KEY = 'skipTimeout';

/**
 * Exempts a route from the global request timeout. Only for routes that are SUPPOSED to stay
 * open (the live X-ray stream). Such a route must bound its own lifetime instead.
 */
export const SkipTimeout = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_TIMEOUT_KEY, true);
