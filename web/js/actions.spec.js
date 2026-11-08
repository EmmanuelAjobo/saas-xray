import {
  createClient,
  createInvoice,
  payADraft,
  peekAsStranger,
  sampleInvoice,
  sendInvoice,
  attempt,
} from './actions.js';
import { ApiError } from './api.js';

/** A fake API that records calls and answers from a function. */
function fakeApi(
  answer = () => ({}),
  stranger = async () => ({ accessToken: 'stranger-token' }),
) {
  const calls = [];
  return {
    calls,
    request: async (method, path, options) => {
      calls.push({ method, path, options });
      const result = await Promise.resolve(answer(method, path, options));
      if (result instanceof Error) throw result;
      return result;
    },
    stranger,
  };
}

const refused = (status, detail) => new ApiError(status, { detail });

describe('attempt', () => {
  it('reports success with the action’s own message', async () => {
    expect(await attempt(async () => 'Done.')).toEqual({
      tone: 'ok',
      text: 'Done.',
    });
  });

  it('treats a 4xx as the backend doing its job ("refused"), quoting the server', async () => {
    const outcome = await attempt(async () => {
      throw refused(409, 'Only SENT invoices can be marked paid');
    });
    expect(outcome).toEqual({
      tone: 'refused',
      text: 'Refused (409): Only SENT invoices can be marked paid',
    });
  });

  it('treats a 5xx as a real error', async () => {
    const outcome = await attempt(async () => {
      throw refused(500, 'boom');
    });
    expect(outcome.tone).toBe('error');
  });

  it('does not call a 401 a refusal (the session is gone, not the action forbidden)', async () => {
    const outcome = await attempt(async () => {
      throw refused(401, 'Authentication required.');
    });
    expect(outcome.tone).toBe('error');
  });

  it('turns a network failure into a plain sentence', async () => {
    const outcome = await attempt(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(outcome.tone).toBe('error');
    expect(outcome.text).toContain('Could not reach the server');
  });
});

describe('sampleInvoice', () => {
  it('always has priced line items and the given client', () => {
    for (let n = 0; n < 12; n++) {
      const body = sampleInvoice('client-1', n);
      expect(body.clientId).toBe('client-1');
      expect(body.items.length).toBeGreaterThan(0);
      for (const item of body.items) {
        expect(item.quantity).toBeGreaterThan(0);
        expect(item.unitPriceCents).toBeGreaterThan(0);
        expect(Number.isInteger(item.unitPriceCents)).toBe(true);
      }
    }
  });
  it('varies from one invoice to the next', () => {
    expect(sampleInvoice('c', 0).items).not.toEqual(
      sampleInvoice('c', 1).items,
    );
  });
});

describe('creating and sending', () => {
  it('creates an invoice for the client, without ever sending a total or a number', async () => {
    const api = fakeApi(() => ({ number: 'INV-0011' }));
    const outcome = await createInvoice(api, 'org-1', 'client-1', 0);
    expect(api.calls[0]).toMatchObject({
      method: 'POST',
      path: '/v1/orgs/org-1/invoices',
    });
    expect(Object.keys(api.calls[0].options.body).sort()).toEqual([
      'clientId',
      'items',
    ]);
    expect(outcome.text).toContain('INV-0011');
  });

  it('sends an invoice and says no real email goes out in a demo', async () => {
    const api = fakeApi();
    const outcome = await sendInvoice(api, 'org-1', {
      id: 'inv-1',
      number: 'INV-0001',
    });
    expect(api.calls[0]).toMatchObject({
      method: 'POST',
      path: '/v1/orgs/org-1/invoices/inv-1/send',
    });
    expect(outcome.tone).toBe('ok');
    expect(outcome.text).toContain('no real email');
  });
});

describe('payADraft', () => {
  const REFUSAL =
    'Only SENT or OVERDUE invoices can be marked paid (this invoice is DRAFT)';

  /** Answers GET with the invoice's current status, creates drafts, and refuses payment. */
  const server = ({ currentStatus = 'DRAFT' } = {}) =>
    fakeApi((method, path) => {
      if (method === 'GET') return { id: 'draft-1', status: currentStatus };
      if (path.endsWith('/pay')) return refused(409, REFUSAL);
      return { id: 'new-draft' };
    });

  it('checks the draft is STILL a draft, then pays it and reports the server’s refusal', async () => {
    const api = server();
    const outcome = await payADraft(
      api,
      'org-1',
      [
        { id: 'a', number: 'INV-1', status: 'SENT' },
        { id: 'draft-1', number: 'INV-2', status: 'DRAFT' },
      ],
      'client-1',
    );
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/orgs/org-1/invoices/draft-1',
      'POST /v1/orgs/org-1/invoices/draft-1/pay',
    ]);
    expect(outcome).toMatchObject({ tone: 'refused' });
    expect(outcome.text).toContain('(this invoice is DRAFT)');
  });

  it('does not trust an out-of-date list: a "draft" that was sent a moment ago is replaced by a fresh one', async () => {
    // The screen still lists INV-2 as a draft, but it has since been sent.
    const api = server({ currentStatus: 'SENT' });
    const outcome = await payADraft(
      api,
      'org-1',
      [{ id: 'draft-1', number: 'INV-2', status: 'DRAFT' }],
      'client-1',
    );
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/orgs/org-1/invoices/draft-1',
      'POST /v1/orgs/org-1/invoices',
      'POST /v1/orgs/org-1/invoices/new-draft/pay',
    ]);
    // It never paid the invoice that really had been sent.
    expect(api.calls.some((c) => c.path.includes('/draft-1/pay'))).toBe(false);
    expect(outcome.tone).toBe('refused');
  });

  it('makes a draft first when the list has none', async () => {
    const api = server();
    await payADraft(
      api,
      'org-1',
      [{ id: 'a', number: 'INV-1', status: 'PAID' }],
      'client-1',
    );
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v1/orgs/org-1/invoices',
      'POST /v1/orgs/org-1/invoices/new-draft/pay',
    ]);
  });

  it('says so when there is no draft and no client to make one for', async () => {
    const api = fakeApi();
    const outcome = await payADraft(api, 'org-1', [], undefined);
    expect(api.calls).toHaveLength(0);
    expect(outcome.tone).toBe('refused');
  });

  it('flags it loudly if the server ever DID pay a verified draft', async () => {
    const api = fakeApi((method) =>
      method === 'GET' ? { id: 'd', status: 'DRAFT' } : {},
    );
    const outcome = await payADraft(
      api,
      'org-1',
      [{ id: 'd', number: 'INV-1', status: 'DRAFT' }],
      'c',
    );
    expect(outcome.text).toContain('should not be possible');
  });
});

describe('createClient', () => {
  it('reports a role refusal in the server’s words', async () => {
    const api = fakeApi(() =>
      refused(403, 'You do not have permission to do this.'),
    );
    const outcome = await createClient(api, 'org-1', 1);
    expect(outcome).toEqual({
      tone: 'refused',
      text: 'Refused (403): You do not have permission to do this.',
    });
  });
});

describe('peekAsStranger', () => {
  it('asks for the data with the STRANGER’s token, never the visitor’s, and celebrates the 404', async () => {
    const api = fakeApi(() => refused(404, 'Organization not found.'));
    const outcome = await peekAsStranger(api, 'org-1');
    expect(api.calls[0].options.bearer).toBe('stranger-token');
    expect(api.calls[0].path).toBe('/v1/orgs/org-1/invoices');
    expect(outcome.tone).toBe('refused');
    expect(outcome.text).toContain('404');
    expect(outcome.text).toContain('strangers leave no trace');
  });

  it('raises the alarm if a stranger ever CAN read it', async () => {
    const api = fakeApi(() => ({ data: [] }));
    const outcome = await peekAsStranger(api, 'org-1');
    expect(outcome.tone).toBe('error');
    expect(outcome.text).toContain('should never happen');
  });

  it('explains a rate limit while starting the stranger’s sandbox', async () => {
    const api = fakeApi(
      () => ({}),
      async () => {
        throw refused(429, 'slow down');
      },
    );
    const outcome = await peekAsStranger(api, 'org-1');
    expect(outcome.tone).toBe('error');
    expect(outcome.text).toContain('Wait a little');
  });

  it('copes with any other failure', async () => {
    const api = fakeApi(
      () => ({}),
      async () => {
        throw new TypeError('offline');
      },
    );
    expect((await peekAsStranger(api, 'org-1')).tone).toBe('error');
  });
});
