import { h, mount } from './dom.js';

/** Just enough of a DOM to see what h() does with its arguments. */
class FakeNode {}
class FakeText extends FakeNode {
  constructor(text) {
    super();
    this.text = text;
  }
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tag = tag;
    this.attributes = {};
    this.listeners = {};
    this.children = [];
    this.className = '';
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  addEventListener(name, handler) {
    this.listeners[name] = handler;
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren() {
    this.children = [];
  }
}

beforeAll(() => {
  globalThis.Node = FakeNode;
  globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => new FakeText(text),
  };
});
afterAll(() => {
  delete globalThis.Node;
  delete globalThis.document;
});

describe('h()', () => {
  it('turns every string child into a TEXT node, even one that looks like markup', () => {
    const el = h('p', null, '<img src=x onerror=alert(1)>');
    expect(el.children).toHaveLength(1);
    expect(el.children[0]).toBeInstanceOf(FakeText);
    expect(el.children[0].text).toBe('<img src=x onerror=alert(1)>');
  });

  it('flattens arrays, skips null/false/undefined, and stringifies numbers', () => {
    const inner = h('b', null, 'x');
    const el = h('p', null, ['a', [null, false, undefined, 7]], inner);
    expect(el.children.map((c) => c.text ?? c.tag)).toEqual(['a', '7', 'b']);
  });

  it('sets class, plain attributes and boolean attributes, and leaves out empty ones', () => {
    const el = h('button', {
      class: 'primary',
      type: 'button',
      disabled: true,
      hidden: false,
      title: undefined,
    });
    expect(el.className).toBe('primary');
    expect(el.attributes).toEqual({ type: 'button', disabled: '' });
  });

  it('attaches handlers as functions', () => {
    const handler = () => undefined;
    const el = h('button', { onClick: handler });
    expect(el.listeners.click).toBe(handler);
  });

  it('REFUSES a handler given as a string (that would be inline script)', () => {
    expect(() => h('button', { onclick: 'alert(1)' })).toThrow(
      /must be a function/,
    );
    expect(() => h('button', { onClick: 'alert(1)' })).toThrow(
      /must be a function/,
    );
  });

  it.each(['src', 'srcdoc', 'style', 'formaction', 'action'])(
    'REFUSES the %s attribute',
    (name) => {
      expect(() => h('div', { [name]: 'x' })).toThrow(/not allowed/);
    },
  );

  it.each([
    'https://github.com/EmmanuelAjobo',
    'https://www.linkedin.com/in/someone',
    'https://linkedin.com/in/someone',
    'mailto:hello@example.com',
  ])(
    'allows a link to the contact address %s, and makes it safe to follow',
    (href) => {
      const el = h('a', { href });
      expect(el.attributes.href).toBe(href);
      // The page you leave gets no handle back to this one.
      expect(el.attributes.rel).toBe('noopener noreferrer');
      expect(el.attributes.target).toBe(
        href.startsWith('https:') ? '_blank' : undefined,
      );
    },
  );

  it('does not add rel or target to a link inside this site', () => {
    const el = h('a', { href: '/docs' });
    expect(el.attributes.rel).toBeUndefined();
    expect(el.attributes.target).toBeUndefined();
  });

  it.each(['/docs', '#top', '/'])(
    'allows a link to %s on this site',
    (href) => {
      expect(h('a', { href }).attributes.href).toBe(href);
    },
  );

  it.each([
    'javascript:alert(1)',
    'https://evil.example',
    '//evil.example',
    'data:text/html,x',
    'docs',
    ' /docs',
    'http://github.com/x',
    'https://github.com@evil.example/x',
    'https://github.com.evil.example/x',
    'https://user:secret@github.com/EmmanuelAjobo',
    'https://anyone@www.linkedin.com/in/x',
    'https://evil.example',
    'mailto:a@b.com?subject=x',
    'mailto:nope',
  ])('REFUSES a link to %s', (href) => {
    expect(() => h('a', { href })).toThrow(/href must be a path/);
  });

  it('mount() replaces what was there', () => {
    const parent = h('div', null, 'old');
    mount(parent, 'new', h('i'));
    expect(parent.children.map((c) => c.text ?? c.tag)).toEqual(['new', 'i']);
  });
});
