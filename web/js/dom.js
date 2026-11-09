// @ts-check

/** Attributes that can carry markup or script, or load another page. Never set from here. */
const UNSAFE_ATTRIBUTES = new Set([
  'src',
  'srcdoc',
  'style',
  'formaction',
  'action',
]);

/** "/docs", "#top": a path or fragment on this site. Rejects "javascript:" and "//evil.example". */
const SAME_SITE_LINK = /^(\/(?!\/)|#)/;

/** The only other sites a link may point to: where a visitor can reach the author. */
const ALLOWED_EXTERNAL_HOSTS = new Set([
  'github.com',
  'linkedin.com',
  'www.linkedin.com',
]);

/** A plain address only: no "?subject=" or other tricks. */
const MAIL_LINK = /^mailto:[^\s@?#:/]+@[^\s@?#:/]+\.[^\s@?#:/]+$/;

/**
 * Whether a link may be put on the page: a path on this site, a mail address, or an https
 * link to one of the few allowed sites. Never "javascript:", "data:", other hosts, or a URL
 * with credentials in it ("https://github.com@evil.example").
 * @param {string} href
 * @returns {boolean}
 */
export function isAllowedLink(href) {
  if (SAME_SITE_LINK.test(href) || MAIL_LINK.test(href)) return true;
  try {
    const url = new URL(href);
    return (
      url.protocol === 'https:' &&
      ALLOWED_EXTERNAL_HOSTS.has(url.hostname) &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

/**
 * Builds a DOM element. This is the ONLY way the page puts text on screen, and it can only
 * make text nodes: there is deliberately no way to pass HTML. Text from the server (names,
 * summaries, error messages) therefore can never become markup, so it cannot inject script.
 * A test forbids `innerHTML` and friends anywhere in this folder.
 *
 * Props: `class`, `on<Event>` handlers (onClick, onToggle...), other values become
 * attributes (`true` = present, `false`/null/undefined = left out).
 *
 * @param {string} tag
 * @param {Record<string, any> | null} [props]
 * @param {...any} children strings, numbers, nodes, or arrays of them; null/false are skipped
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') {
      element.className = String(value);
    } else if (name.startsWith('on')) {
      // Handlers are functions, never strings (a string would become inline script).
      if (typeof value !== 'function') {
        throw new TypeError(`${name} must be a function`);
      }
      element.addEventListener(name.slice(2).toLowerCase(), value);
    } else if (UNSAFE_ATTRIBUTES.has(name)) {
      throw new TypeError(`The ${name} attribute is not allowed`);
    } else if (name === 'href' && !isAllowedLink(String(value))) {
      // Links go to this site, or to the few allowed contact sites, never to a URL built from data.
      throw new TypeError('href must be a path on this site');
    } else {
      if (name === 'href' && !SAME_SITE_LINK.test(String(value))) {
        // Leaving this site: the new page gets no handle back to this one.
        element.setAttribute('rel', 'noopener noreferrer');
        if (String(value).startsWith('https:')) {
          element.setAttribute('target', '_blank');
        }
      }
      element.setAttribute(name, value === true ? '' : String(value));
    }
  }
  append(element, children);
  return element;
}

/**
 * @param {HTMLElement} parent
 * @param {any[]} children
 */
function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(
      child instanceof Node ? child : document.createTextNode(String(child)),
    );
  }
}

/**
 * Replaces everything inside `parent`.
 * @param {HTMLElement} parent
 * @param {...any} children
 */
export function mount(parent, ...children) {
  parent.replaceChildren();
  append(parent, children);
}
