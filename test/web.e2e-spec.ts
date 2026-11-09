import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './support/create-test-app.js';

describe('the demo page (HTTP, real app configuration)', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });
  afterAll(async () => {
    await app.close();
  });

  it('serves the page at /', async () => {
    const res = await http().get('/').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<div id="app"></div>');
  });

  it('serves its scripts as JavaScript modules and its styles as CSS', async () => {
    const script = await http().get('/js/main.js').expect(200);
    expect(script.headers['content-type']).toMatch(/javascript/);
    const style = await http().get('/styles.css').expect(200);
    expect(style.headers['content-type']).toMatch(/text\/css/);
  });

  it('serves the contact file the footer reads, as JSON with a name and links', async () => {
    const res = await http().get('/contact.json').expect(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const contact = res.body as { name: string; links: unknown[] };
    expect(contact.name.length).toBeGreaterThan(0);
    expect(contact.links.length).toBeGreaterThan(0);
  });

  it('lets the browser revalidate (a deploy shows up straight away)', async () => {
    const res = await http().get('/js/main.js').expect(200);
    expect(res.headers['cache-control']).toBe('public, max-age=0');
    expect(res.headers.etag).toBeDefined();
    await http()
      .get('/js/main.js')
      .set('If-None-Match', res.headers.etag as string)
      .expect(304);
  });

  it('does not publish the test files that sit next to the scripts', async () => {
    await http().get('/js/timeline.spec.js').expect(404);
    await http().get('/js/api.spec.js').expect(404);
  });

  it('cannot be used to read files outside the page', async () => {
    for (const path of [
      '/%2e%2e/package.json',
      '/js/%2e%2e/%2e%2e/package.json',
      '/..%2fpackage.json',
      '/.env',
    ]) {
      const res = await http().get(path);
      expect(res.status, path).toBeGreaterThanOrEqual(400);
      expect(res.text, path).not.toContain('"saas-xray"');
    }
  });

  it('keeps the strict security policy on the page: scripts only from itself, no inline script', async () => {
    const res = await http().get('/').expect(200);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not upgrade requests to https outside production (Safari refuses plain-http localhost otherwise)', async () => {
    const res = await http().get('/').expect(200);
    expect(String(res.headers['content-security-policy'])).not.toContain(
      'upgrade-insecure-requests',
    );
  });

  it('leaves the API alone: unknown API paths are still problem+json, and routes still work', async () => {
    const missing = await http().get('/v1/nothing-here').expect(404);
    expect(missing.headers['content-type']).toMatch(/problem\+json/);
    await http().get('/health/live').expect(200);
    await http().get('/docs').redirects(1).expect(200);
  });
});

describe('the demo page in production', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp({ env: { NODE_ENV: 'production' } }));
  });
  afterAll(async () => {
    await app.close();
  });

  it('does upgrade insecure requests there', async () => {
    const res = await request(app.getHttpServer()).get('/').expect(200);
    expect(String(res.headers['content-security-policy'])).toContain(
      'upgrade-insecure-requests',
    );
  });
});
