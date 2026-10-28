import { describe, expect, it } from 'bun:test';

import {
  SHELL_TERMINAL_PROPERTIES,
  createTerminalTransport,
  readTerminalTheme,
  type TerminalChannels,
  type TerminalEvent,
} from '../src/transport.js';

/**
 * The colours the emulator is handed.
 *
 * A property that resolves to nothing must be left out rather than passed
 * through empty, so the emulator retains its legible default. That is the
 * behaviour these tests exist for.
 */

const properties = SHELL_TERMINAL_PROPERTIES;

function reader(values: Record<string, string>) {
  return (property: string) => values[property] ?? '';
}

describe('readTerminalTheme', () => {
  it('passes every property through when all three resolve', () => {
    const theme = readTerminalTheme(
      reader({
        [properties.background]: '#101010',
        [properties.foreground]: '#f0f0f0',
        [properties.cursor]: '#ff8800',
      }),
      properties,
    );
    expect(theme).toEqual({
      background: '#101010',
      foreground: '#f0f0f0',
      cursor: '#ff8800',
    });
  });

  it('returns nothing when no property resolves', () => {
    expect(readTerminalTheme(reader({}), properties)).toEqual({});
  });

  it('omits a property that resolves to whitespace', () => {
    // getComputedStyle returns a leading space for a custom property.
    const theme = readTerminalTheme(
      reader({
        [properties.background]: '   ',
        [properties.foreground]: ' #f0f0f0',
        [properties.cursor]: '\t\n',
      }),
      properties,
    );
    expect(theme).toEqual({ foreground: '#f0f0f0' });
  });

  it('trims the value it keeps', () => {
    const theme = readTerminalTheme(
      reader({ [properties.background]: '  #101010  ' }),
      properties,
    );
    expect(theme.background).toBe('#101010');
  });

  it('omits the background alone', () => {
    const theme = readTerminalTheme(
      reader({
        [properties.foreground]: '#f0f0f0',
        [properties.cursor]: '#ff8800',
      }),
      properties,
    );
    expect(theme).toEqual({ foreground: '#f0f0f0', cursor: '#ff8800' });
  });

  it('omits the foreground alone', () => {
    const theme = readTerminalTheme(
      reader({
        [properties.background]: '#101010',
        [properties.cursor]: '#ff8800',
      }),
      properties,
    );
    expect(theme).toEqual({ background: '#101010', cursor: '#ff8800' });
  });

  it('omits the cursor alone', () => {
    const theme = readTerminalTheme(
      reader({
        [properties.background]: '#101010',
        [properties.foreground]: '#f0f0f0',
      }),
      properties,
    );
    expect(theme).toEqual({ background: '#101010', foreground: '#f0f0f0' });
  });

  it('reads each colour from its own property', () => {
    const asked: string[] = [];
    readTerminalTheme((property) => {
      asked.push(property);
      return property;
    }, properties);
    expect(asked).toEqual([
      properties.background,
      properties.foreground,
      properties.cursor,
    ]);
  });
});

describe('SHELL_TERMINAL_PROPERTIES', () => {
  it('names the three properties a consumer sets', () => {
    // `docs/shell-variables.md` documents these names, and a consumer's
    // stylesheet is the only place they are set.
    expect(SHELL_TERMINAL_PROPERTIES).toEqual({
      background: '--shell-terminal-background',
      foreground: '--shell-terminal-foreground',
      cursor: '--shell-terminal-cursor',
    });
  });
});

/**
 * The transport a consumer builds from their own channels.
 *
 * Nothing here names a channel of this repository's. The names arrive as an
 * argument, so the assertions use names no contract holds and a hard-coded one
 * would fail them.
 */

const CHANNELS: TerminalChannels = {
  spawn: 'consumer/open',
  write: 'consumer/write',
  resize: 'consumer/resize',
  terminate: 'consumer/close',
  list: 'consumer/list',
  data: 'consumer/output',
  exit: 'consumer/ended',
};

/** A transport over recorded calls, plus the recordings. */
function wired(answer: unknown = []) {
  const invoked: { channel: string; request: unknown }[] = [];
  const listeners = new Map<string, (payload: unknown) => void>();
  const unsubscribed: string[] = [];

  const transport = createTerminalTransport({
    invoke: (channel, request) => {
      invoked.push({ channel, request });
      return Promise.resolve(answer);
    },
    on: (event, listener) => {
      listeners.set(event, listener);
      return () => unsubscribed.push(event);
    },
    channels: CHANNELS,
  });

  const send = (event: string, payload: unknown) => {
    listeners.get(event)?.(payload);
  };

  return { transport, invoked, listeners, unsubscribed, send };
}

describe('createTerminalTransport', () => {
  it('delivers size changes for its session only when a size channel is given', () => {
    const sized = wired();
    const unsized = wired();
    const sizedTransport = createTerminalTransport({
      invoke: () => Promise.resolve(),
      on: (event, listener) => {
        sized.listeners.set(event, listener);
        return () => sized.unsubscribed.push(event);
      },
      channels: { ...CHANNELS, size: 'consumer/size' },
    });
    const events: unknown[] = [];
    const stop = sizedTransport.subscribe('one', (event) => events.push(event));
    unsized.transport.subscribe('one', (event) => events.push(event));

    sized.send('consumer/size', { id: 'two', cols: 1, rows: 1 });
    sized.send('consumer/size', { id: 'one', cols: 100, rows: 40 });
    expect(events).toEqual([{ type: 'size', cols: 100, rows: 40 }]);
    expect(unsized.listeners.has('consumer/size')).toBe(false);
    stop();
    expect(sized.unsubscribed).toContain('consumer/size');
  });

  it('does not expose acknowledgement when its channel is omitted', () => {
    expect(wired().transport.ack).toBeUndefined();
  });

  it('acknowledges the greatest consumed sequence on an optional channel', async () => {
    const { transport, invoked } = wired();
    const acknowledged = createTerminalTransport({
      invoke: (channel, request) => {
        invoked.push({ channel, request });
        return Promise.resolve();
      },
      on: () => () => undefined,
      channels: { ...CHANNELS, ack: 'consumer/ack' },
    });

    await acknowledged.ack?.('one', 4);
    expect(invoked).toEqual([{ channel: 'consumer/ack', request: { id: 'one', sequence: 4 } }]);
    expect(transport.ack).toBeUndefined();
  });
  it('opens a session on the channel it was given', async () => {
    const { transport, invoked } = wired();
    await transport.spawn({
      id: 'one',
      cwd: '/tmp/work',
      shell: '/bin/sh',
      cols: 80,
      rows: 24,
    });

    expect(invoked).toEqual([
      {
        channel: 'consumer/open',
        request: { id: 'one', cols: 80, rows: 24, shell: '/bin/sh', cwd: '/tmp/work' },
      },
    ]);
  });

  it('leaves the shell and the directory to the host when the caller names neither', async () => {
    const { transport, invoked } = wired();
    await transport.spawn({ id: 'one', cols: 80, rows: 24 });

    expect(invoked).toEqual([
      {
        channel: 'consumer/open',
        request: { id: 'one', cols: 80, rows: 24, shell: undefined, cwd: undefined },
      },
    ]);
  });

  it('writes, resizes and terminates by id', async () => {
    const { transport, invoked } = wired();
    await transport.write('one', 'ls\r');
    await transport.resize('one', 100, 40);
    await transport.terminate('one');

    expect(invoked).toEqual([
      { channel: 'consumer/write', request: { id: 'one', data: 'ls\r' } },
      { channel: 'consumer/resize', request: { id: 'one', cols: 100, rows: 40 } },
      { channel: 'consumer/close', request: { id: 'one' } },
    ]);
  });

  it('answers list with what the host reported', async () => {
    const sessions = [{ id: 'one', cwd: '/tmp', shell: '/bin/sh', startedAt: 17 }];
    const { transport, invoked } = wired(sessions);

    await expect(transport.list()).resolves.toEqual(sessions);
    expect(invoked).toEqual([{ channel: 'consumer/list', request: undefined }]);
  });

  it('uses each legacy name exactly once when acknowledgement is unavailable', () => {
    // The floor. A transport that called nothing would satisfy every
    // assertion above by never reaching a channel.
    const { transport, invoked, listeners } = wired();
    void transport.spawn({ id: 'one', cols: 1, rows: 1 });
    void transport.write('one', 'x');
    void transport.resize('one', 2, 2);
    void transport.terminate('one');
    void transport.list();
    transport.subscribe('one', () => undefined);

    const used = [...invoked.map((call) => call.channel), ...listeners.keys()];
    expect(used).toHaveLength(Object.keys(CHANNELS).length);
    expect(new Set(used)).toEqual(new Set(Object.values(CHANNELS)));
  });

  it('delivers this session output and no other', () => {
    const { transport, send } = wired();
    const received: TerminalEvent[] = [];
    transport.subscribe('one', (event) => received.push(event));

    send('consumer/output', { id: 'two', data: 'not mine' });
    send('consumer/output', { id: 'one', data: 'mine' });

    // The events are per host, not per session, so every subscription sees
    // every payload and the filter is the whole of the routing.
    expect(received).toEqual([{ type: 'data', data: 'mine' }]);
  });

  it('delivers this session exit and no other', () => {
    const { transport, send } = wired();
    const received: TerminalEvent[] = [];
    transport.subscribe('one', (event) => received.push(event));

    send('consumer/ended', { id: 'two', exitCode: 3 });
    send('consumer/ended', { id: 'one', exitCode: 0 });

    expect(received).toEqual([{ type: 'exit', exitCode: 0 }]);
  });

  it('unsubscribes from both events at once', () => {
    // A caller never has to pair two calls, so a stop that dropped one would
    // leave a dead view receiving output.
    const { transport, unsubscribed } = wired();
    const stop = transport.subscribe('one', () => undefined);

    expect(unsubscribed).toEqual([]);
    stop();
    expect(unsubscribed).toEqual(['consumer/output', 'consumer/ended']);
  });
});
