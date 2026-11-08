import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Rules for the demo page that keep it safe, enforced by tests so they cannot erode.
 *
 * The page shows text from the server (names, summaries, error messages). If any of it could
 * become HTML or script, one crafted client name would run code in a visitor's browser. So:
 * text only goes in through `textContent`/text nodes (see web/js/dom.js), never as markup.
 */

const WEB = join(process.cwd(), 'web');
const JS = join(WEB, 'js');

const files = readdirSync(JS).filter((name) => name.endsWith('.js'));
const sources = files.filter((name) => !name.endsWith('.spec.js'));
/**
 * The CODE of a script: comments removed, so a comment that explains a rule ("never use
 * innerHTML") cannot trip it. Only whole-line `//` comments and block comments are removed;
 * a `//` inside a string (a URL) is left alone, so it cannot hide a real violation.
 */
const read = (name: string) =>
  readFileSync(join(JS, name), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('web page: safety rules', () => {
  it('finds the scripts (sanity check)', () => {
    expect(sources).toEqual(
      expect.arrayContaining(['main.js', 'dom.js', 'api.js', 'xray-stream.js']),
    );
  });

  it.each([
    ['innerHTML', /\binnerHTML\b/],
    ['outerHTML', /\bouterHTML\b/],
    ['insertAdjacentHTML', /\binsertAdjacentHTML\b/],
    ['document.write', /\bdocument\.write(ln)?\s*\(/],
    ['eval', /\beval\s*\(/],
    ['new Function', /\bnew\s+Function\b/],
    ['setTimeout with a string', /\bsetTimeout\s*\(\s*['"`]/],
    ['DOMParser', /\bDOMParser\b/],
    ['createContextualFragment', /\bcreateContextualFragment\b/],
  ])(
    'no script uses %s (server text must never become markup)',
    (_name, pattern) => {
      for (const file of sources) {
        expect(read(file), file).not.toMatch(pattern);
      }
    },
  );

  it('never stores a token where page scripts (or an injected one) could read it later', () => {
    for (const file of sources) {
      expect(read(file), file).not.toMatch(
        /\b(localStorage|sessionStorage|indexedDB)\b/,
      );
      expect(read(file), file).not.toMatch(/document\.cookie/);
    }
  });

  it('only loads code from its own origin', () => {
    for (const file of sources) {
      expect(read(file), file).not.toMatch(/https?:\/\//);
      expect(read(file), file).not.toMatch(/\bimport\s*\(/); // no dynamic imports
    }
    const html = readFileSync(join(WEB, 'index.html'), 'utf8');
    expect(html).not.toMatch(/https?:\/\/(?!localhost)/);
  });

  it('the page has no inline script and no inline event handlers (the CSP forbids them)', () => {
    const html = readFileSync(join(WEB, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  it('the stylesheet pulls nothing from elsewhere', () => {
    const css = readFileSync(join(WEB, 'styles.css'), 'utf8');
    expect(css).not.toMatch(/@import/);
    expect(css).not.toMatch(/url\(\s*['"]?https?:/);
  });

  it('builds elements only through h(), whose single job is to make text nodes', () => {
    const dom = read('dom.js');
    expect(dom).toContain('createTextNode');
    expect(dom).toContain('setAttribute');
    // Handlers are attached as functions only; a string handler is refused, not set.
    expect(dom).toMatch(/typeof value !== 'function'/);
    // Attributes that can carry markup or script are refused, and links stay on this site.
    expect(dom).toContain('UNSAFE_ATTRIBUTES');
    for (const attribute of ['src', 'srcdoc', 'style', 'formaction']) {
      expect(dom).toContain(`'${attribute}'`);
    }
    expect(dom).toContain('SAME_SITE_LINK');
  });
});
