import { ApiError, createApi } from './api.js';

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A fake fetch that answers from a script and records every call. */
function fake(...answers) {
  const calls = [];
  const fetchImpl = (path, init) => {
    calls.push({ path, ...init });
    const next = answers.shift();
    if (!next) throw new Error(`unexpected call: ${init.method} ${path}`);
    return Promise.resolve(
      typeof next === 'function' ? next(path, init) : next,
    );
  };
  return { fetchImpl, calls };
}

const session = (token) => ({
  accessToken: token,
  expiresIn: 900,
  user: { id: 'u', email: 'e', name: 'n' },
});

describe('createApi', () => {
  it('sends the session token as a Bearer header and the body as JSON', async () => {
    const { fetchImpl, calls } = fake(
      json(200, session('t1')),
      json(200, { ok: true }),
    );
    const api = createApi({ fetchImpl });
    await api.startDemo();
    await api.request('POST', '/v1/orgs', { body: { name: 'x' } });
    expect(calls[1]?.headers.Authorization).toBe('Bearer t1');
    expect(calls[1]?.headers['Content-Type']).toBe('application/json');
    expect(calls[1]?.body).toBe('{"name":"x"}');
  });

  it('sends no Authorization on the public demo call', async () => {
    const { fetchImpl, calls } = fake(json(200, session('t1')));
    await createApi({ fetchImpl }).startDemo();
    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });

  it('holds the token in memory and reports it', async () => {
    const tokens = [];
    const { fetchImpl } = fake(json(200, session('t1')));
    const api = createApi({ fetchImpl, onToken: (t) => tokens.push(t) });
    await api.startDemo();
    expect(api.token).toBe('t1');
    expect(tokens).toEqual(['t1']);
  });

  it('turns an error answer into an ApiError with the server’s own words', async () => {
    const { fetchImpl } = fake(
      json(409, {
        status: 409,
        code: 'INVALID_STATE_TRANSITION',
        detail: 'Only SENT invoices can be paid',
        requestId: 'r-1',
      }),
    );
    const error = await createApi({ fetchImpl })
      .request('POST', '/x')
      .catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'INVALID_STATE_TRANSITION',
      requestId: 'r-1',
    });
    expect(error.message).toBe('Only SENT invoices can be paid');
  });

  it('copes with an error answer that is not JSON', async () => {
    const { fetchImpl } = fake(
      new Response('<html>Bad gateway</html>', { status: 502 }),
    );
    const error = await createApi({ fetchImpl })
      .request('GET', '/x')
      .catch((e) => e);
    expect(error).toMatchObject({ status: 502 });
    expect(error.message).toBe('Request failed (502)');
  });

  describe('an expired token', () => {
    it('is renewed once from the cookie and the call is retried, invisibly', async () => {
      const { fetchImpl, calls } = fake(
        json(200, session('old')),
        json(401, { status: 401 }),
        json(200, session('new')),
        json(200, { data: [] }),
      );
      const api = createApi({ fetchImpl });
      await api.startDemo();
      const result = await api.request('GET', '/v1/orgs');
      expect(result).toEqual({ data: [] });
      expect(calls[2]?.path).toBe('/v1/auth/refresh');
      expect(calls[2]?.credentials).toBe('same-origin');
      expect(calls[3]?.headers.Authorization).toBe('Bearer new');
      expect(api.token).toBe('new');
    });

    it('fails with 401 when the cookie cannot renew it (and forgets the token)', async () => {
      const { fetchImpl } = fake(
        json(200, session('old')),
        json(401, { status: 401 }),
        json(401, { status: 401 }),
      );
      const api = createApi({ fetchImpl });
      await api.startDemo();
      const error = await api.request('GET', '/v1/orgs').catch((e) => e);
      expect(error.status).toBe(401);
      expect(api.token).toBeUndefined();
    });

    it('does not renew for a token the caller supplied', async () => {
      const { fetchImpl, calls } = fake(json(401, { status: 401 }));
      const error = await createApi({ fetchImpl })
        .request('GET', '/x', { bearer: 'someone-elses' })
        .catch((e) => e);
      expect(error.status).toBe(401);
      expect(calls).toHaveLength(1);
    });

    it('shares ONE refresh between simultaneous callers (a refresh token works once)', async () => {
      let refreshes = 0;
      const { fetchImpl } = fake(
        json(200, session('old')),
        json(401, { status: 401 }),
        json(401, { status: 401 }),
        () => {
          refreshes += 1;
          return json(200, session('new'));
        },
        json(200, { n: 1 }),
        json(200, { n: 2 }),
      );
      const api = createApi({ fetchImpl });
      await api.startDemo();
      const [a, b] = await Promise.all([
        api.request('GET', '/a'),
        api.request('GET', '/b'),
      ]);
      expect(refreshes).toBe(1);
      expect([a.n, b.n].sort((x, y) => x - y)).toEqual([1, 2]);
    });
  });

  it('plays a stranger in a second sandbox without touching this session or its cookie', async () => {
    const { fetchImpl, calls } = fake(
      json(200, session('mine')),
      json(200, session('theirs')),
    );
    const api = createApi({ fetchImpl });
    await api.startDemo();
    const stranger = await api.stranger();
    expect(stranger.accessToken).toBe('theirs');
    expect(api.token).toBe('mine');
    expect(calls[1]?.credentials).toBe('omit');
  });

  it('switches role and takes the new session’s token', async () => {
    const { fetchImpl, calls } = fake(
      json(200, session('t1')),
      json(200, session('t2')),
    );
    const api = createApi({ fetchImpl });
    await api.startDemo();
    await api.switchRole('MEMBER');
    expect(calls[1]?.path).toBe('/v1/demo/switch-role');
    expect(calls[1]?.body).toBe('{"role":"MEMBER"}');
    expect(api.token).toBe('t2');
  });
});
