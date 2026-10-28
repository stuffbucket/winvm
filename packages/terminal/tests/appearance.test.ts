import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_TERMINAL_PALETTE_SETTINGS,
  liftTerminalContrast,
  resolveTerminalAppearance,
} from '../src/appearance.js';

describe('terminal palette resolution', () => {
  it('resolves the selected light or dark palette', () => {
    expect(resolveTerminalAppearance(
      DEFAULT_TERMINAL_PALETTE_SETTINGS,
      false,
      '#eef0f4',
    ).theme.background).toBe('#fafafa');
    expect(resolveTerminalAppearance(
      DEFAULT_TERMINAL_PALETTE_SETTINGS,
      true,
      '#1c1f26',
    ).theme.background).toBe('#111317');
  });

  it('keeps window effects separate unless they are stamped', () => {
    const layered = resolveTerminalAppearance({
      ...DEFAULT_TERMINAL_PALETTE_SETTINGS,
      effects: {
        ...DEFAULT_TERMINAL_PALETTE_SETTINGS.effects,
        tint: '#ff0000',
        tintAmount: 0.5,
        blendMode: 'multiply',
      },
    }, true, '#1c1f26');
    expect(layered.theme.background).toBe('#111317');
    expect(layered.window).toMatchObject({
      tint: '#ff0000',
      tintAmount: 0.5,
      blendMode: 'multiply',
    });

    const stamped = resolveTerminalAppearance({
      ...DEFAULT_TERMINAL_PALETTE_SETTINGS,
      effects: {
        ...DEFAULT_TERMINAL_PALETTE_SETTINGS.effects,
        tint: '#ff0000',
        tintAmount: 0.5,
        blendMode: 'multiply',
        stamp: true,
      },
    }, true, '#1c1f26');
    expect(stamped.theme.background).not.toBe('#111317');
    expect(stamped.window.tintAmount).toBe(0);
  });

  it('lifts low-contrast text while preserving sufficient colors', () => {
    expect(liftTerminalContrast('#777777', '#777777', 4.5)).not.toBe('#777777');
    expect(liftTerminalContrast('#ffffff', '#000000', 4.5)).toBe('#ffffff');
  });
});
