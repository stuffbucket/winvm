import { describe, expect, it, vi } from 'bun:test';

import {
  animationFrameScheduler,
  TerminalAcknowledgements,
  TerminalResizes,
} from '../src/ack.js';

describe('TerminalAcknowledgements', () => {
  it('acknowledges the greatest completed sequence once per scheduled frame', () => {
    const frames: Array<() => void> = [];
    const acknowledged: number[] = [];
    const acks = new TerminalAcknowledgements(
      (sequence) => acknowledged.push(sequence),
      { schedule: (callback) => frames.push(callback) },
    );

    acks.consume(3);
    acks.consume(5);
    acks.consume(5);
    acks.consume(4);
    expect(frames).toHaveLength(1);
    frames[0]!();

    expect(acknowledged).toEqual([5]);
  });

  it('does not acknowledge a completion delivered after cleanup', () => {
    const frames: Array<() => void> = [];
    const acknowledged: number[] = [];
    const acks = new TerminalAcknowledgements(
      (sequence) => acknowledged.push(sequence),
      { schedule: (callback) => frames.push(callback) },
    );

    acks.consume(1);
    acks.dispose();
    frames[0]!();
    acks.consume(2);

    expect(acknowledged).toEqual([]);
    expect(frames).toHaveLength(1);
  });

  it('starts a new frame after acknowledgement and ignores stale completions', () => {
    const frames: Array<() => void> = [];
    const acknowledged: number[] = [];
    const acks = new TerminalAcknowledgements(
      (sequence) => acknowledged.push(sequence),
      { schedule: (callback) => frames.push(callback) },
    );

    acks.consume(3);
    frames[0]!();
    acks.consume(3);
    acks.consume(2);
    expect(frames).toHaveLength(1);
    acks.consume(4);
    expect(frames).toHaveLength(2);
    frames[1]!();

    expect(acknowledged).toEqual([3, 4]);
  });

  it('uses browser frames when they are available', () => {
    const frame = vi.fn();
    const callback = vi.fn();
    const g = globalThis as { requestAnimationFrame?: unknown };
    const saved = g.requestAnimationFrame;
    g.requestAnimationFrame = frame;

    animationFrameScheduler.schedule(callback);

    expect(frame).toHaveBeenCalledWith(callback);
    g.requestAnimationFrame = saved;
  });

  it('falls back to a microtask outside a browser', async () => {
    const g = globalThis as { requestAnimationFrame?: unknown };
    const saved = g.requestAnimationFrame;
    g.requestAnimationFrame = undefined;
    const callback = vi.fn();

    animationFrameScheduler.schedule(callback);
    expect(callback).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(callback).toHaveBeenCalledTimes(1);
    g.requestAnimationFrame = saved;
  });
});

describe('TerminalResizes', () => {
  it('sends only the latest dimensions once per scheduled frame', () => {
    const frames: Array<() => void> = [];
    const resize = vi.fn();
    const resizes = new TerminalResizes(resize, {
      schedule: (callback) => frames.push(callback),
    });

    resizes.update(80, 24);
    resizes.update(100, 30);
    resizes.update(120, 40);

    expect(frames).toHaveLength(1);
    expect(resize).not.toHaveBeenCalled();
    frames[0]!();
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(120, 40);
  });

  it('schedules a later resize in a new frame', () => {
    const frames: Array<() => void> = [];
    const resize = vi.fn();
    const resizes = new TerminalResizes(resize, {
      schedule: (callback) => frames.push(callback),
    });

    resizes.update(80, 24);
    frames[0]!();
    resizes.update(100, 30);
    frames[1]!();

    expect(resize.mock.calls).toEqual([[80, 24], [100, 30]]);
  });

  it('drops a pending resize after disposal', () => {
    const frames: Array<() => void> = [];
    const resize = vi.fn();
    const resizes = new TerminalResizes(resize, {
      schedule: (callback) => frames.push(callback),
    });

    resizes.update(80, 24);
    resizes.dispose();
    frames[0]!();
    resizes.update(100, 30);

    expect(resize).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
  });
});