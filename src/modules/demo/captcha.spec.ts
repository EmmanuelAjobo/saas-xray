import { Logger } from '@nestjs/common';
import { NoCaptcha, TurnstileCaptcha } from './captcha.js';

describe('captcha', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('NoCaptcha lets everything through (development only)', async () => {
    expect(await new NoCaptcha().verify()).toBe(true);
  });

  describe('TurnstileCaptcha', () => {
    const captcha = new TurnstileCaptcha('the-secret', 4_000);
    const stub = (answer: () => Promise<unknown>) => {
      const calls: Array<{
        url: string;
        init: RequestInit & { body: URLSearchParams };
      }> = [];
      vi.stubGlobal(
        'fetch',
        (url: string, init: RequestInit & { body: URLSearchParams }) => {
          calls.push({ url, init });
          return answer();
        },
      );
      return calls;
    };
    const reply =
      (json: unknown, ok = true) =>
      () =>
        Promise.resolve({ ok, json: () => Promise.resolve(json) });

    it('refuses a missing or empty token without calling Cloudflare', async () => {
      const calls = stub(reply({ success: true }));
      expect(await captcha.verify(undefined, '1.2.3.4')).toBe(false);
      expect(await captcha.verify('', '1.2.3.4')).toBe(false);
      expect(calls).toHaveLength(0);
    });

    it('accepts only `success: true`, sending the secret, token and client IP', async () => {
      const calls = stub(reply({ success: true }));
      expect(await captcha.verify('tok', '1.2.3.4')).toBe(true);
      expect(calls[0]?.url).toBe(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      );
      expect(calls[0]?.init.method).toBe('POST');
      expect(Object.fromEntries(calls[0]!.init.body)).toEqual({
        secret: 'the-secret',
        response: 'tok',
        remoteip: '1.2.3.4',
      });
      expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    });

    it('leaves out the IP when it is unknown', async () => {
      const calls = stub(reply({ success: true }));
      await captcha.verify('tok', undefined);
      expect(calls[0]?.init.body.has('remoteip')).toBe(false);
    });

    it.each([
      ['success false', reply({ success: false })],
      ['success as text', reply({ success: 'true' })],
      ['success as 1', reply({ success: 1 })],
      ['no success field', reply({})],
      ['an HTTP error', reply({ success: true }, false)],
      [
        'an unparseable body',
        () =>
          Promise.resolve({
            ok: true,
            json: () => Promise.reject(new Error('bad json')),
          }),
      ],
      ['a network error', () => Promise.reject(new Error('ECONNRESET'))],
      [
        'a timeout',
        () =>
          Promise.reject(
            Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
          ),
      ],
    ])('FAILS CLOSED on %s', async (_label, answer) => {
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      stub(answer);
      expect(await captcha.verify('tok', '1.2.3.4')).toBe(false);
    });

    it('never writes the secret or the token to the log when it fails', async () => {
      const logged: string[] = [];
      vi.spyOn(Logger.prototype, 'error').mockImplementation(
        (m) => void logged.push(String(m)),
      );
      stub(() => Promise.reject(new Error('network down')));
      await captcha.verify('sensitive-token', '1.2.3.4');
      expect(logged.join(' ')).not.toContain('the-secret');
      expect(logged.join(' ')).not.toContain('sensitive-token');
    });
  });
});
