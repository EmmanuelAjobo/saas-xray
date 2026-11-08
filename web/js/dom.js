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
    } else if (name === 'href' && !SAME_SITE_LINK.test(String(value))) {
      // Links go to this site only (a path or "#"), never to a URL built from data.
      throw new TypeError('href must be a path on this site');
    } else {
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
