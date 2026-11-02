import { describe, it, expect } from 'vitest';
import { createSseParser } from '../src/background/llm/sse.js';

function collect() {
  const events = [];
  const parser = createSseParser((e) => events.push(e));
  return { events, parser };
}

describe('createSseParser', () => {
  it('parses complete events', () => {
    const { events, parser } = collect();
    parser.push('event: ping\ndata: {"type":"ping"}\n\n');
    expect(events).toEqual([{ event: 'ping', data: '{"type":"ping"}' }]);
  });

  it('handles an event split across chunks, even mid-line (EC-LLM-01)', () => {
    const { events, parser } = collect();
    const raw = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"Hi"}}\n\n';
    for (const piece of [raw.slice(0, 7), raw.slice(7, 40), raw.slice(40, 41), raw.slice(41)]) parser.push(piece);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].data).delta.text).toBe('Hi');
  });

  it('supports CRLF line endings, including a CR/LF split across chunks', () => {
    const { events, parser } = collect();
    parser.push('event: a\r');
    parser.push('\ndata: 1\r\n\r\n');
    expect(events).toEqual([{ event: 'a', data: '1' }]);
  });

  it('ignores comments and joins multi-line data', () => {
    const { events, parser } = collect();
    parser.push(': keep-alive\ndata: line1\ndata: line2\n\n');
    expect(events).toEqual([{ event: 'message', data: 'line1\nline2' }]);
  });

  it('flushes a final event without a trailing blank line on end()', () => {
    const { events, parser } = collect();
    parser.push('event: message_stop\ndata: {"type":"message_stop"}');
    expect(events).toHaveLength(0);
    parser.end();
    expect(events).toEqual([{ event: 'message_stop', data: '{"type":"message_stop"}' }]);
  });
});
