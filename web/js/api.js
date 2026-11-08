// @ts-check

/**
 * @typedef {{ id: string, email: string, name: string, isDemo?: boolean }} User
 * @typedef {{ accessToken: string, expiresIn: number, user: User }} SessionBody
 */

/** An error answer from the API (RFC 7807 problem details). */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {{ detail?: string, title?: string, code?: string, requestId?: string } | undefined} problem
   */
  constructor(status, problem) {
    super(problem?.detail ?? problem?.title ?? `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = problem?.code;
    this.requestId = problem?.requestId;
  }
}

/**
 * Talks to the API from the browser, same origin.
 *
 * The access token lives ONLY in memory (never localStorage: a script injected into the page
 * could read that). The refresh token is an HttpOnly cookie the browser sends by itself, so
 * this code never sees it. When a call answers 401 the token is renewed once through that
 * cookie and the call is retried, so a 15-minute token expiring is invisible to the user.
 *
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   onToken?: (token: string | undefined) => void,
 * }} [options]
 */
export function createApi({
  fetchImpl = (...args) => globalThis.fetch(...args),
  onToken = () => undefined,
} = {}) {
  /** @type {string | undefined} */
  let token;
  /** @type {Promise<boolean> | undefined} */
  let refreshing;

  /** @param {string | undefined} next */
  function setToken(next) {
    token = next;
    onToken(next);
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ body?: unknown, bearer?: string | null, credentials?: RequestCredentials }} options
   */
  function send(method, path, { body, bearer, credentials }) {
    // bearer: undefined = use the session token, null = send none, string = use that one.
    const authorization = bearer === null ? undefined : (bearer ?? token);
    return fetchImpl(path, {
      method,
      credentials: credentials ?? 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** @param {Response} response */
  async function parse(response) {
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  /**
   * Renews the access token from the refresh cookie. Simultaneous callers share one request
   * (the refresh token is single-use: two at once would look like theft and end the session).
   * @returns {Promise<boolean>} whether a fresh token is now held
   */
  function refresh() {
    refreshing ??= (async () => {
      try {
        const response = await send('POST', '/v1/auth/refresh', {
          bearer: null,
        });
        if (!response.ok) {
          setToken(undefined);
          return false;
        }
        /** @type {SessionBody} */
        const session = await parse(response);
        setToken(session.accessToken);
        return true;
      } catch {
        return false;
      } finally {
        refreshing = undefined;
      }
    })();
    return refreshing;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ body?: unknown, bearer?: string | null, credentials?: RequestCredentials }} [options]
   */
  async function request(method, path, options = {}) {
    let response = await send(method, path, options);
    // Only renew the SESSION token; a caller-supplied token that expired is the caller's business.
    if (response.status === 401 && options.bearer === undefined) {
      if (await refresh()) response = await send(method, path, options);
    }
    const body = await parse(response);
    if (!response.ok) throw new ApiError(response.status, body);
    return body;
  }

  return {
    request,
    refresh,
    get token() {
      return token;
    },
    /** @param {string | undefined} next */
    setToken,

    /** Starts a fresh private sandbox and signs the visitor in to it. @returns {Promise<SessionBody>} */
    async startDemo() {
      /** @type {SessionBody} */
      const session = await request('POST', '/v1/auth/demo', {
        body: {},
        bearer: null,
      });
      setToken(session.accessToken);
      return session;
    },

    /**
     * A SECOND, separate sandbox whose cookie is ignored, so it never replaces this visitor's
     * session. Used to play "a stranger from another company".
     * @returns {Promise<SessionBody>}
     */
    stranger() {
      return request('POST', '/v1/auth/demo', {
        body: {},
        bearer: null,
        credentials: 'omit',
      });
    },

    /** @param {'OWNER' | 'ADMIN' | 'MEMBER'} role @returns {Promise<SessionBody>} */
    async switchRole(role) {
      /** @type {SessionBody} */
      const session = await request('POST', '/v1/demo/switch-role', {
        body: { role },
      });
      setToken(session.accessToken);
      return session;
    },
  };
}
