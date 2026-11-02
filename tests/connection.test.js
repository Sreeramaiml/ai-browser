import { describe, it, expect } from 'vitest';
import { createConnection, BACKOFF_MS, MAX_FAILED_ATTEMPTS } from '../src/sidepanel/connection.js';

function fakePort() {
  const port = {
    sent: [],
    msgListeners: [],
    dcListeners: [],
    postMessage(m) { port.sent.push(m); },
    onMessage: { addListener: (fn) => port.msgListeners.push(fn) },
    onDisconnect: { addListener: (fn) => port.dcListeners.push(fn) },
    receive(m) { port.msgListeners.forEach((fn) => fn(m)); },
    drop() { port.dcListeners.forEach((fn) => fn()); }
  };
  return port;
}

function setup({ alive = true } = {}) {
  const env = {
    alive,
    ports: [],
    timers: [],
    statuses: [],
    messages: []
  };
  const conn = createConnection({
    connect: () => { const p = fakePort(); env.ports.push(p); return p; },
    isExtensionAlive: () => env.alive,
    hello: () => ({ type: 'PANEL_HELLO', payload: { windowId: 7 } }),
    onMessage: (m) => env.messages.push(m),
    onStatus: (s) => env.statuses.push(s),
    setTimeout: (fn, ms) => { env.timers.push({ fn, ms }); return env.timers.length; },
    clearTimeout: () => {}
  });
  env.runNextTimer = () => env.timers.shift().fn();
  env.lastPort = () => env.ports[env.ports.length - 1];
  return { conn, env };
}

describe('createConnection', () => {
  it('sends hello on connect and becomes connected on the first reply', () => {
    const { conn, env } = setup();
    conn.start();
    expect(env.lastPort().sent).toEqual([{ type: 'PANEL_HELLO', payload: { windowId: 7 } }]);
    expect(conn.getStatus()).toBe('connecting');
    env.lastPort().receive({ type: 'ACTIVE_TAB' });
    expect(conn.getStatus()).toBe('connected');
    expect(env.messages).toEqual([{ type: 'ACTIVE_TAB' }]);
  });

  it('reconnects quietly after a healthy port drops (worker sleep)', () => {
    const { conn, env } = setup();
    conn.start();
    env.lastPort().receive({ type: 'ACTIVE_TAB' });
    env.lastPort().drop();
    expect(conn.getStatus()).toBe('connected');
    expect(env.timers[0].ms).toBe(BACKOFF_MS[0]);
    env.runNextTimer();
    expect(env.ports).toHaveLength(2);
    expect(env.lastPort().sent[0].type).toBe('PANEL_HELLO');
  });

  it('backs off and gives up after repeated failures (EC-PNL-13)', () => {
    const { conn, env } = setup();
    conn.start();
    const delays = [];
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      env.lastPort().drop();
      if (env.timers.length) {
        delays.push(env.timers[0].ms);
        env.runNextTimer();
      }
    }
    expect(delays).toEqual(BACKOFF_MS);
    expect(conn.getStatus()).toBe('failed');
    expect(env.ports).toHaveLength(MAX_FAILED_ATTEMPTS);
  });

  it('resets the failure count once the worker answers', () => {
    const { conn, env } = setup();
    conn.start();
    env.lastPort().drop();
    env.runNextTimer();
    env.lastPort().receive({ type: 'ACTIVE_TAB' });
    env.lastPort().drop();
    expect(env.timers[0].ms).toBe(BACKOFF_MS[0]);
    expect(conn.getStatus()).toBe('connected');
  });

  it('retry() starts over after giving up', () => {
    const { conn, env } = setup();
    conn.start();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      env.lastPort().drop();
      if (env.timers.length) env.runNextTimer();
    }
    expect(conn.getStatus()).toBe('failed');
    conn.retry();
    expect(conn.getStatus()).toBe('connecting');
    env.lastPort().receive({ type: 'ACTIVE_TAB' });
    expect(conn.getStatus()).toBe('connected');
  });

  it('reports invalidated when the extension was reloaded (EC-INS-06)', () => {
    const { conn, env } = setup();
    conn.start();
    env.lastPort().receive({ type: 'ACTIVE_TAB' });
    env.alive = false;
    env.lastPort().drop();
    expect(conn.getStatus()).toBe('invalidated');
    expect(env.timers).toHaveLength(0);
  });

  it('ignores events from a stale port', () => {
    const { conn, env } = setup();
    conn.start();
    const first = env.lastPort();
    first.receive({ type: 'ACTIVE_TAB' });
    first.drop();
    env.runNextTimer();
    first.receive({ type: 'LATE' });
    expect(env.messages).toEqual([{ type: 'ACTIVE_TAB' }]);
  });

  it('send() returns false while disconnected', () => {
    const { conn, env } = setup();
    conn.start();
    expect(conn.send({ type: 'X' })).toBe(true);
    env.lastPort().drop();
    expect(conn.send({ type: 'Y' })).toBe(false);
  });
});
