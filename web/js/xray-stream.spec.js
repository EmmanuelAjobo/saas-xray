import {
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  startXrayStream,
} from './xray-stream.js';

const encoder = new TextEncoder();

/** A streaming Response from chunks of text; `end: false` keeps it open until aborted. */
function stream(chunks, { status = 200, end = true, signal } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (end) controller.close();
      else
        signal?.addEventListener('abort', () =>
          controller.error(new DOMException('aborted', 'AbortError')),
        );
    },
  });
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const xrayMessage = (id, extra = {}) =>
  `id: ${id}\nevent: xray\ndata: ${JSON.stringify({ id, kind: 'http.request', ...extra })}\n\n`;

/** Runs the stream against scripted answers; resolves when `done()` says so. */
async function run({
  answers,
  getToken = () => 'tok',
  refreshToken = async () => true,
  until,
}) {
  const calls = [];
  const events = [];
  const states = [];
  const waits = [];
  const queue = [...answers];
  let controllerStop;
  const finished = new Promise((resolve) => {
    const handle = startXrayStream({
      url: '/v1/orgs/o/xray/stream',
      getToken,
      refreshToken,
      onEvent: (e) => events.push(e),
      onState: (s, detail) => {
        states.push(detail ? `${s}:${detail}` : s);
        if (s === 'stopped') resolve();
      },
      fetchImpl: (url, init) => {
        calls.push({ url, ...init });
        const next = queue.shift();
        if (!next) {
          // Out of script: stop the stream so the test ends.
          handle.stop();
          // A real fetch rejects when its request is aborted.
          return Promise.reject(new DOMException('aborted', 'AbortError'));
        }
        return Promise.resolve(typeof next === 'function' ? next(init) : next);
      },
      wait: async (ms) => {
        waits.push(ms);
        await Promise.resolve();
      },
    });
    controllerStop = handle.stop;
  });
  if (until) await until(() => events.length);
  await finished;
  return { calls, events, states, waits, stop: controllerStop };
}

describe('startXrayStream', () => {
  it('delivers each X-ray event and ignores heartbeats', async () => {
    const { events, states } = await run({
      answers: [
        stream([
          xrayMessage('1-0'),
          'event: heartbeat\ndata: {"ts":1}\n\n',
          xrayMessage('2-0'),
        ]),
      ],
    });
    expect(events.map((e) => e.id)).toEqual(['1-0', '2-0']);
    expect(states.slice(0, 2)).toEqual(['connecting', 'live']);
  });

  it('sends the token and asks for an event stream', async () => {
    const { calls } = await run({ answers: [stream([])] });
    expect(calls[0]).toMatchObject({
      url: '/v1/orgs/o/xray/stream',
      headers: { Authorization: 'Bearer tok', Accept: 'text/event-stream' },
    });
    expect(calls[0].headers['Last-Event-ID']).toBeUndefined();
  });

  it('reconnects when the server ends the stream, resuming from the last id it saw', async () => {
    const { calls, events, states, waits } = await run({
      answers: [
        stream([xrayMessage('1-0'), xrayMessage('2-0')]),
        stream([xrayMessage('3-0')]),
      ],
    });
    expect(calls[1].headers['Last-Event-ID']).toBe('2-0');
    expect(events.map((e) => e.id)).toEqual(['1-0', '2-0', '3-0']);
    expect(states).toContain('reconnecting');
    expect(waits[0]).toBe(RECONNECT_MIN_MS);
  });

  it('copes with a message split across network chunks', async () => {
    const whole = xrayMessage('1-0');
    const { events } = await run({
      answers: [
        stream([whole.slice(0, 15), whole.slice(15, 40), whole.slice(40)]),
      ],
    });
    expect(events.map((e) => e.id)).toEqual(['1-0']);
  });

  it('skips a message it cannot read instead of crashing', async () => {
    const { events } = await run({
      answers: [
        stream(['event: xray\ndata: {not json\n\n', xrayMessage('2-0')]),
      ],
    });
    expect(events.map((e) => e.id)).toEqual(['2-0']);
  });

  it('on 401 renews the token, then reconnects with the NEW one', async () => {
    let token = 'old';
    const { calls } = await run({
      getToken: () => token,
      refreshToken: async () => {
        token = 'new';
        return true;
      },
      answers: [
        new Response('', { status: 401 }),
        stream([xrayMessage('1-0')]),
      ],
    });
    expect(calls[0].headers.Authorization).toBe('Bearer old');
    expect(calls[1].headers.Authorization).toBe('Bearer new');
  });

  it('gives up for good on 404 (not your organisation): no retries', async () => {
    const { calls, states } = await run({
      answers: [new Response('', { status: 404 })],
    });
    expect(calls).toHaveLength(1);
    expect(states.at(-2)).toMatch(/^unavailable:/);
  });

  it('gives up for good when the role may not watch, and shows the server’s reason', async () => {
    const { calls, states } = await run({
      answers: [
        new Response(
          JSON.stringify({
            code: 'FORBIDDEN',
            detail: 'Only owners and admins can open the X-ray.',
          }),
          { status: 403 },
        ),
      ],
    });
    expect(calls).toHaveLength(1);
    expect(states.find((s) => s.startsWith('unavailable'))).toContain(
      'Only owners and admins',
    );
  });

  it('keeps trying when it is only "too many streams open" (another tab may close)', async () => {
    const limit = () =>
      new Response(
        JSON.stringify({ code: 'LIMIT_REACHED', detail: 'too many' }),
        { status: 403 },
      );
    const { calls, events, waits } = await run({
      answers: [limit(), limit(), stream([xrayMessage('1-0')])],
    });
    // Two refusals, the stream that finally opened, and the reconnect after it ended.
    expect(calls).toHaveLength(4);
    expect(events).toHaveLength(1);
    expect(waits[0]).toBe(RECONNECT_MAX_MS);
  });

  it('backs off while the server is unreachable, up to a ceiling, and starts over after a success', async () => {
    const down = () => Promise.reject(new TypeError('network down'));
    const { waits } = await run({
      answers: [
        down,
        down,
        down,
        down,
        down,
        down,
        down,
        stream([xrayMessage('1-0')]),
        down,
      ],
    });
    expect(waits.slice(0, 7)).toEqual([
      1000, 2000, 4000, 8000, 15000, 15000, 15000,
    ]);
    // After the successful connection the next pause is the short one again.
    expect(waits[7]).toBe(RECONNECT_MIN_MS);
  });

  it('stops on request, even while connected and waiting for more', async () => {
    const calls = [];
    let handle;
    const states = [];
    const finished = new Promise((resolve) => {
      handle = startXrayStream({
        url: '/x',
        getToken: () => 'tok',
        refreshToken: async () => true,
        onEvent: () => undefined,
        onState: (s) => {
          states.push(s);
          if (s === 'live') setTimeout(() => handle.stop(), 5);
          if (s === 'stopped') resolve();
        },
        fetchImpl: (url, init) => {
          calls.push(url);
          return Promise.resolve(
            stream([xrayMessage('1-0')], { end: false, signal: init.signal }),
          );
        },
      });
    });
    await finished;
    expect(calls).toHaveLength(1);
    expect(states.at(-1)).toBe('stopped');
  });
});
