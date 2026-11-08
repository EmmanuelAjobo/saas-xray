import { testConfig } from '../../../test/support/test-config.js';
import { MemoryXrayStore } from './memory-xray.store.js';
import { tenantCheckEvent } from './xray.events.js';
import { XrayService } from './xray.service.js';
import type { XrayStore } from './xray.store.js';

const event = () => tenantCheckEvent({ ts: 1, role: 'OWNER' });

describe('XrayService', () => {
  it('writes events to the organisation it is given', async () => {
    const store = new MemoryXrayStore(testConfig());
    const xray = new XrayService(store, testConfig());
    xray.publish('org-a', [event(), event()]);
    await xray.flush();
    expect(await store.latest('org-a', 10)).toHaveLength(2);
    expect(await store.latest('org-b', 10)).toHaveLength(0);
  });

  it('does nothing at all when XRAY_ENABLED=false', async () => {
    const config = testConfig({ XRAY_ENABLED: 'false' });
    const store = new MemoryXrayStore(config);
    const append = vi.spyOn(store, 'append');
    const xray = new XrayService(store, config);
    expect(xray.enabled).toBe(false);
    xray.publish('org-a', [event()]);
    await xray.flush();
    expect(append).not.toHaveBeenCalled();
  });

  it('ignores an empty batch', async () => {
    const store = new MemoryXrayStore(testConfig());
    const append = vi.spyOn(store, 'append');
    new XrayService(store, testConfig()).publish('org-a', []);
    expect(append).not.toHaveBeenCalled();
  });

  it('never throws, and never rejects, when the store fails (X-ray must not break a request)', async () => {
    const broken: XrayStore = {
      append: () => Promise.reject(new Error('redis is down')),
      latest: () => Promise.resolve([]),
      after: () => Promise.resolve([]),
      subscribe: () => Promise.resolve(() => Promise.resolve()),
    };
    const xray = new XrayService(broken, testConfig());
    expect(() => xray.publish('org-a', [event()])).not.toThrow();
    await expect(xray.flush()).resolves.toBeUndefined();
  });

  it('does not make the caller wait for the store', () => {
    let finish: () => void = () => undefined;
    const slow: XrayStore = {
      append: () => new Promise((resolve) => (finish = () => resolve([]))),
      latest: () => Promise.resolve([]),
      after: () => Promise.resolve([]),
      subscribe: () => Promise.resolve(() => Promise.resolve()),
    };
    const xray = new XrayService(slow, testConfig());
    const started = Date.now();
    xray.publish('org-a', [event()]); // returns immediately even though the store has not answered
    expect(Date.now() - started).toBeLessThan(50);
    finish();
  });
});
