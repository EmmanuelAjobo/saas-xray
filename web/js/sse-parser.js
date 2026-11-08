// @ts-check

/**
 * @typedef {{ type: string, id: string | undefined, data: string }} SseMessage
 */

/**
 * Turns the text of a Server-Sent Events stream into messages. Text can arrive split at any
 * point (in the middle of a line, or between the two newlines that end a message), so this
 * keeps what it has not finished and continues on the next `feed`.
 *
 * Follows the SSE format: a message is lines ended by a blank line; `event:`, `id:` and
 * `data:` fields (several `data:` lines are joined with a newline); lines starting with ":"
 * are comments and ignored.
 *
 * @param {(message: SseMessage) => void} onMessage
 */
export function createSseParser(onMessage) {
  let buffer = '';

  /** @param {string} block */
  function dispatch(block) {
    let type = 'message';
    /** @type {string | undefined} */
    let id;
    /** @type {string[]} */
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') type = value;
      else if (field === 'id') id = value;
      else if (field === 'data') data.push(value);
    }
    // A block with no data (a comment-only keep-alive) is not a message.
    if (data.length > 0) onMessage({ type, id, data: data.join('\n') });
  }

  return {
    /** @param {string} text */
    feed(text) {
      buffer += text;
      for (;;) {
        const end = /\r?\n\r?\n/.exec(buffer);
        if (!end) return;
        const block = buffer.slice(0, end.index);
        buffer = buffer.slice(end.index + end[0].length);
        dispatch(block);
      }
    },
  };
}
