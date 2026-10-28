import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';

import type {
  GhosttyWindowAdjustment,
  TerminalPaletteSettings,
} from './appearance.js';

export type { GhosttyWindowAdjustment } from './appearance.js';
export type TerminalTheme = ITheme;
export type TerminalEmulatorKind = 'xterm' | 'ghostty';

export interface TerminalTypography {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontVariations: Record<string, number>;
  cellHeight: number;
  tracking: number;
  baseline: number;
  thicken: boolean;
  thickenStrength: number;
  ligatures: boolean;
  fontFeatures?: Record<string, boolean>;
  palette?: TerminalPaletteSettings;
}

export function terminalFontVariationSettings(
  typography: Pick<TerminalTypography, 'fontVariations' | 'fontWeight'>,
): string {
  const variations = new Map(Object.entries(typography.fontVariations));
  variations.set('wght', typography.fontWeight);
  return [...variations]
    .filter(([tag, value]) =>
      /^[\x20-\x7e]{4}$/u.test(tag) && Number.isFinite(value))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([tag, value]) => `${JSON.stringify(tag)} ${String(value)}`)
    .join(', ');
}

export function terminalFontFeatureSettings(
  typography: Pick<TerminalTypography, 'fontFeatures' | 'ligatures'>,
): string {
  const features = {
    calt: typography.ligatures,
    liga: typography.ligatures,
    ...typography.fontFeatures,
  };
  return Object.entries(features)
    .filter(([tag]) => /^[\x20-\x7e]{4}$/u.test(tag))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tag, enabled]) => `${JSON.stringify(tag)} ${enabled ? '1' : '0'}`)
    .join(', ');
}

export function terminalThickenStrokeEm(strength: number): number {
  return 0.018 + (strength / 255) * 0.045;
}

interface TerminalDisposable {
  dispose(): void;
}

interface TerminalBufferLine {
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

interface TerminalBuffer {
  readonly length: number;
  getLine(index: number): TerminalBufferLine | undefined;
}

export interface TerminalEmulator {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: { readonly active: TerminalBuffer };
  open(element: HTMLElement): Promise<void>;
  fit(): void;
  /** Sets the grid directly, bypassing container measurement. See `fit()`. */
  resize(cols: number, rows: number): void;
  focus(): void;
  blur(): void;
  onData(listener: (data: string) => void): TerminalDisposable;
  onResize(listener: (size: { cols: number; rows: number }) => void): TerminalDisposable;
  onKeyEvent(listener: (event: KeyboardEvent) => boolean): void;
  onTitleChange(listener: (title: string) => void): TerminalDisposable;
  write(data: string, callback?: () => void): void;
  clear(): void;
  selectAll(): void;
  scrollToTop(): void;
  scrollToBottom(): void;
  setTypography(typography: TerminalTypography): void;
  setAppearance(theme?: TerminalTheme, adjustment?: GhosttyWindowAdjustment): void;
  dispose(): void;
}

const SYSTEM_MONOSPACE =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

/**
 * winvm: the family, point size and leading of `TerminalTypography`, as xterm
 * options. monimal's xterm adapter ignored typography (only its Ghostty
 * adapter applied it); the point-to-pixel and leading arithmetic is that
 * adapter's.
 */
function xtermTypography(typography: TerminalTypography | undefined) {
  if (!typography) return { fontFamily: SYSTEM_MONOSPACE, fontSize: 13 };
  return {
    fontFamily: typography.fontFamily === 'ui-monospace' ? SYSTEM_MONOSPACE : typography.fontFamily,
    fontSize: typography.fontSize * (96 / 72),
    fontWeight: typography.fontWeight,
    lineHeight: 1 + typography.cellHeight / 100,
  };
}

function createXtermEmulator(theme?: TerminalTheme, typography?: TerminalTypography): TerminalEmulator {
  let host: HTMLElement | undefined;
  const terminal = new Terminal({
    cursorBlink: true,
    ...xtermTypography(typography),
    minimumContrastRatio: 4.5,
    // Lets a shell-side diagnostic (`CSI 18 t`) confirm the emulator's own
    // rendered grid matches what the OS and the PTY report for it. The other
    // window-report queries stay off; they read or move the OS window itself.
    windowOptions: { getWinSizeChars: true },
    ...(theme ? { theme } : {}),
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  return {
    get cols() { return terminal.cols; },
    get rows() { return terminal.rows; },
    get buffer() { return terminal.buffer; },
    open: (element) => {
      host = element;
      if (theme?.foreground) element.style.color = theme.foreground;
      if (theme?.background) element.style.backgroundColor = theme.background;
      return Promise.resolve(terminal.open(element));
    },
    fit: () => {
      const proposed = fitAddon.proposeDimensions();
      if (!proposed) return;
      const { cols, rows } = clampTerminalGrid(proposed.cols, proposed.rows);
      if (cols !== terminal.cols || rows !== terminal.rows) terminal.resize(cols, rows);
    },
    resize: (cols, rows) => {
      const clamped = clampTerminalGrid(cols, rows);
      terminal.resize(clamped.cols, clamped.rows);
    },
    focus: () => terminal.focus(),
    blur: () => terminal.blur(),
    onData: (listener) => terminal.onData(listener),
    onResize: (listener) => terminal.onResize(listener),
    onKeyEvent: (listener) => {
      terminal.attachCustomKeyEventHandler((event) => !listener(event));
    },
    onTitleChange: (listener) => terminal.onTitleChange(listener),
    write: (data, callback) => terminal.write(data, callback),
    clear: () => terminal.clear(),
    selectAll: () => terminal.selectAll(),
    scrollToTop: () => terminal.scrollToTop(),
    scrollToBottom: () => terminal.scrollToBottom(),
    setTypography: (next) => {
      Object.assign(terminal.options, xtermTypography(next));
    },
    setAppearance: (nextTheme) => {
      if (!nextTheme) return;
      terminal.options.theme = nextTheme;
      if (host && nextTheme.foreground) host.style.color = nextTheme.foreground;
      if (host && nextTheme.background) host.style.backgroundColor = nextTheme.background;
    },
    dispose: () => terminal.dispose(),
  };
}

function clampTerminalGrid(cols: number, rows: number): { cols: number; rows: number } {
  const clamp = (value: number, maximum: number) =>
    Math.max(1, Math.min(maximum, Math.floor(value)));
  return { cols: clamp(cols, 256), rows: clamp(rows, 128) };
}

/**
 * winvm: only the xterm.js adapter is vendored. `ghostty` (monimal's
 * @wterm/ghostty WebAssembly adapter) is left out, so asking for it gets the
 * xterm adapter; `ghosttyWindow` is accepted and ignored for the same reason.
 */
export async function createTerminalEmulator(
  _kind: TerminalEmulatorKind = 'xterm',
  theme?: TerminalTheme,
  _ghosttyWindow?: GhosttyWindowAdjustment,
  typography?: TerminalTypography,
): Promise<TerminalEmulator> {
  return createXtermEmulator(theme, typography);
}
