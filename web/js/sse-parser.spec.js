import { createSseParser } from './sse-parser.js';

function collect() {
  const messages = [];
  const parser = createSseParser((m) => messages.push(m));
  return { messages, parser };
}

describe('createSseParser', () => {
  it('parses a message with its event name, id and JSON data', () => {
    const { messages, parser } = collect();
    parser.feed('id: 17-0\nevent: xray\ndata: {"a":1}\n\n');
    expect(messages).toEqual([{ type: 'xray', id: '17-0', data: '{"a":1}' }]);
  });

  it('defaults the type to "message" and the id to undefined', () => {
    const { messages, parser } = collect();
    parser.feed('data: hello\n\n');
    expect(messages).toEqual([
      { type: 'message', id: undefined, data: 'hello' },
    ]);
  });

  it('parses several messages in one chunk', () => {
    const { messages, parser } = collect();
    parser.feed('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n');
    expect(messages.map((m) => [m.type, m.data])).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
  });

  it('joins several data lines with a newline', () => {
    const { messages, parser } = collect();
    parser.feed('data: one\ndata: two\n\n');
    expect(messages[0]?.data).toBe('one\ntwo');
  });

  it('copes with text split at ANY position, even between the two newlines', () => {
    const wire =
      'id: 1-0\nevent: xray\ndata: {"x":"héllo"}\n\nevent: heartbeat\ndata: {}\n\n';
    for (let cut = 0; cut <= wire.length; cut++) {
      const { messages, parser } = collect();
      parser.feed(wire.slice(0, cut));
      parser.feed(wire.slice(cut));
      expect(
        messages.map((m) => m.type),
        `cut at ${cut}`,
      ).toEqual(['xray', 'heartbeat']);
      expect(messages[0]?.data).toBe('{"x":"héllo"}');
    }
  });

  it('copes with the text arriving one character at a time', () => {
    const { messages, parser } = collect();
    for (const ch of 'event: xray\ndata: ok\n\n') parser.feed(ch);
    expect(messages).toEqual([{ type: 'xray', id: undefined, data: 'ok' }]);
  });

  it('ignores comments and keep-alives that carry no data', () => {
    const { messages, parser } = collect();
    parser.feed(': keep-alive\n\n');
    parser.feed(':comment\ndata: real\n\n');
    expect(messages.map((m) => m.data)).toEqual(['real']);
  });

  it('accepts Windows line endings', () => {
    const { messages, parser } = collect();
    parser.feed('event: xray\r\ndata: ok\r\n\r\n');
    expect(messages).toEqual([{ type: 'xray', id: undefined, data: 'ok' }]);
  });

  it('keeps an unfinished message until it is completed', () => {
    const { messages, parser } = collect();
    parser.feed('event: xray\ndata: part');
    expect(messages).toEqual([]);
    parser.feed('ial\n\n');
    expect(messages[0]?.data).toBe('partial');
  });

  it('removes only ONE space after the colon, and accepts none', () => {
    const { messages, parser } = collect();
    parser.feed('data:  two spaces\n\ndata:none\n\n');
    expect(messages.map((m) => m.data)).toEqual([' two spaces', 'none']);
  });

  it('ignores unknown fields', () => {
    const { messages, parser } = collect();
    parser.feed('retry: 5000\nfoo: bar\ndata: x\n\n');
    expect(messages).toEqual([{ type: 'message', id: undefined, data: 'x' }]);
  });
});
