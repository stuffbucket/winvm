import type { ITheme } from '@xterm/xterm';

export interface GhosttyWindowAdjustment {
  /** Horizontal content padding in CSS pixels. */
  paddingX?: number;
  /** Vertical content padding in CSS pixels. */
  paddingY?: number;
  /** Keep the configured padding equal on opposing edges. */
  balance?: boolean;
  /** Terminal background opacity from 0 through 1. Text remains opaque. */
  opacity?: number;
  /** Backdrop blur radius in CSS pixels. Zero disables blur. */
  blur?: number;
  /** Optional composited colour layer when effects are not stamped into the palette. */
  tint?: string;
  /** Tint layer opacity from 0 through 1. */
  tintAmount?: number;
  /** Tone adjustment from -1 (black) through 1 (white). */
  tone?: number;
  /** CSS blend mode used by the tint layer. */
  blendMode?: 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten';
}

export type TerminalColorMode = 'auto' | 'light' | 'dark';
export type TerminalBlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten';

export const TERMINAL_PALETTE_COLOURS = [
  'background', 'foreground', 'cursor', 'selectionBackground',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

export type TerminalPaletteColour = (typeof TERMINAL_PALETTE_COLOURS)[number];
export type TerminalPalette = Record<TerminalPaletteColour, string>;

export interface TerminalWindowEffects {
  opacity: number;
  blur: number;
  tint: string;
  tintAmount: number;
  tone: number;
  blendMode: TerminalBlendMode;
  stamp: boolean;
  compensate: boolean;
}

export interface TerminalPaletteSettings {
  mode: TerminalColorMode;
  light: TerminalPalette;
  dark: TerminalPalette;
  minimumContrast: number;
  effects: TerminalWindowEffects;
}

export const DEFAULT_TERMINAL_PALETTE_SETTINGS: TerminalPaletteSettings = {
  mode: 'auto',
  dark: {
    background: '#111317',
    foreground: '#f5f5f5',
    cursor: '#5198a6',
    selectionBackground: '#264f78',
    black: '#1e1e1e',
    red: '#f44747',
    green: '#6a9955',
    yellow: '#d7ba7d',
    blue: '#569cd6',
    magenta: '#c586c0',
    cyan: '#4ec9b0',
    white: '#d4d4d4',
    brightBlack: '#808080',
    brightRed: '#f44747',
    brightGreen: '#6a9955',
    brightYellow: '#d7ba7d',
    brightBlue: '#569cd6',
    brightMagenta: '#c586c0',
    brightCyan: '#4ec9b0',
    brightWhite: '#ffffff',
  },
  light: {
    background: '#fafafa',
    foreground: '#383a42',
    cursor: '#2563eb',
    selectionBackground: '#bfceff',
    black: '#383a42',
    red: '#e45649',
    green: '#50a14f',
    yellow: '#986801',
    blue: '#4078f2',
    magenta: '#a626a4',
    cyan: '#0184bc',
    white: '#d7d7d7',
    brightBlack: '#696c77',
    brightRed: '#c93b2f',
    brightGreen: '#3f8f3e',
    brightYellow: '#8a5d00',
    brightBlue: '#2f67db',
    brightMagenta: '#8f218d',
    brightCyan: '#00749f',
    brightWhite: '#ffffff',
  },
  minimumContrast: 4.5,
  effects: {
    opacity: 1,
    blur: 0,
    tint: '#5198a6',
    tintAmount: 0,
    tone: 0,
    blendMode: 'normal',
    stamp: false,
    compensate: true,
  },
};

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const TEXT_COLOURS = TERMINAL_PALETTE_COLOURS.filter((key) =>
  key !== 'background' && key !== 'selectionBackground');

function parseHex(value: string): Rgb {
  const normalized = value.slice(1);
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function hex({ r, g, b }: Rgb): string {
  return `#${[r, g, b]
    .map((value) => Math.round(Math.min(255, Math.max(0, value)))
      .toString(16).padStart(2, '0'))
    .join('')}`;
}

function blendChannel(base: number, tint: number, mode: TerminalBlendMode): number {
  switch (mode) {
    case 'multiply': return base * tint / 255;
    case 'screen': return 255 - ((255 - base) * (255 - tint) / 255);
    case 'overlay':
      return base < 128
        ? 2 * base * tint / 255
        : 255 - (2 * (255 - base) * (255 - tint) / 255);
    case 'darken': return Math.min(base, tint);
    case 'lighten': return Math.max(base, tint);
    case 'normal': return tint;
  }
}

function mix(base: string, tint: string, amount: number, mode: TerminalBlendMode): string {
  const left = parseHex(base);
  const right = parseHex(tint);
  const channel = (key: keyof Rgb): number => {
    const blended = blendChannel(left[key], right[key], mode);
    return left[key] + ((blended - left[key]) * amount);
  };
  return hex({ r: channel('r'), g: channel('g'), b: channel('b') });
}

function applyEffects(
  colour: string,
  effects: Pick<TerminalWindowEffects, 'blendMode' | 'tint' | 'tintAmount' | 'tone'>,
): string {
  const tinted = mix(colour, effects.tint, effects.tintAmount, effects.blendMode);
  const toneTarget = effects.tone < 0 ? '#000000' : '#ffffff';
  return mix(tinted, toneTarget, Math.abs(effects.tone), 'normal');
}

function luminance(colour: string): number {
  const rgb = parseHex(colour);
  const linear = (value: number): number => {
    const channel = value / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return (0.2126 * linear(rgb.r)) + (0.7152 * linear(rgb.g)) + (0.0722 * linear(rgb.b));
}

function contrast(left: string, right: string): number {
  const leftLuminance = luminance(left);
  const rightLuminance = luminance(right);
  const lighter = Math.max(leftLuminance, rightLuminance);
  const darker = Math.min(leftLuminance, rightLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export function liftTerminalContrast(
  foreground: string,
  background: string,
  minimum: number,
): string {
  if (minimum <= 1 || contrast(foreground, background) >= minimum) return foreground;
  const target = contrast('#000000', background) > contrast('#ffffff', background)
    ? '#000000'
    : '#ffffff';
  let low = 0;
  let high = 1;
  for (let index = 0; index < 12; index += 1) {
    const middle = (low + high) / 2;
    if (contrast(mix(foreground, target, middle, 'normal'), background) >= minimum) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return mix(foreground, target, high, 'normal');
}

export function resolveTerminalAppearance(
  settings: TerminalPaletteSettings,
  dark: boolean,
  windowBackground: string,
): { theme: TerminalPalette & ITheme; window: GhosttyWindowAdjustment } {
  const source = dark ? settings.dark : settings.light;
  const palette = { ...source };
  if (settings.effects.stamp) {
    for (const key of TERMINAL_PALETTE_COLOURS) {
      palette[key] = applyEffects(palette[key], settings.effects);
    }
  }
  const compositeBackground = mix(
    windowBackground,
    palette.background,
    settings.effects.opacity,
    'normal',
  );
  const effectiveBackground = settings.effects.stamp
    ? compositeBackground
    : applyEffects(compositeBackground, settings.effects);
  if (settings.effects.compensate) {
    for (const key of TEXT_COLOURS) {
      palette[key] = liftTerminalContrast(
        palette[key],
        effectiveBackground,
        settings.minimumContrast,
      );
    }
  }
  return {
    theme: palette,
    window: {
      paddingX: 8,
      paddingY: 6,
      balance: true,
      opacity: settings.effects.opacity,
      blur: settings.effects.blur,
      tint: settings.effects.stamp ? undefined : settings.effects.tint,
      tintAmount: settings.effects.stamp ? 0 : settings.effects.tintAmount,
      tone: settings.effects.stamp ? 0 : settings.effects.tone,
      blendMode: settings.effects.blendMode,
    },
  };
}
