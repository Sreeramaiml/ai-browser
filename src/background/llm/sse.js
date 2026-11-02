// @ts-check
// Server-Sent Events parser. Feed it decoded text in arbitrary chunks; it emits whole events.
// Handles events split across chunks (EC-LLM-01); UTF-8 splitting is handled by the caller's
// TextDecoder in stream mode (EC-LLM-02).

/**
 * @param {(event: { event: string, data: string }) => void} onEvent
 */
export function createSseParser(onEvent) {
  let buffer = '';
  let eventName = '';
  /** @type {string[]} */
  let dataLines = [];

  function dispatch() {
    if (dataLines.length) onEvent({ event: eventName || 'message', data: dataLines.join('\n') });
    eventName = '';
    dataLines = [];
  }

  /** @param {string} line */
  function processLine(line) {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }

  return {
    /** @param {string} chunk */
    push(chunk) {
      buffer += chunk;
      let newline;
      while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
        const line = buffer.slice(0, newline);
        const sep = buffer[newline] === '\r' && buffer[newline + 1] === '\n' ? 2 : 1;
        // A lone trailing \r might be the first half of \r\n: wait for more input.
        if (buffer[newline] === '\r' && newline === buffer.length - 1) break;
        buffer = buffer.slice(newline + sep);
        processLine(line);
      }
    },

    /** Flush anything left when the stream ends. */
    end() {
      if (buffer) processLine(buffer.replace(/\r$/, ''));
      buffer = '';
      dispatch();
    }
  };
}
