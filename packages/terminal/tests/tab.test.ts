import { describe, expect, it } from 'bun:test';

import {
  newTerminalTab,
  terminalDirectoryTitle,
  terminalProcessTitle,
} from '../src/tab.js';

describe('terminal tab identity', () => {
  it('uses the final cwd segment for an idle shell title', () => {
    expect(terminalDirectoryTitle('/Users/alex/projects/maximal///')).toBe('maximal');
    expect(terminalDirectoryTitle('C:\\Users\\alex\\src')).toBe('src');
    expect(terminalDirectoryTitle('/')).toBe('/');
  });

  it('handles long repetitive path separators', () => {
    expect(terminalDirectoryTitle(`/root/${'/'.repeat(100_000)}leaf`)).toBe('leaf');
    expect(terminalDirectoryTitle(`C:\\root\\${'\\/'.repeat(50_000)}leaf\\\\`)).toBe('leaf');
  });

  it('removes controls and bounds a process-supplied title', () => {
    expect(terminalProcessTitle('  vim\u0000 README.md\u0080\u009f  ')).toBe('vim README.md');
    expect(terminalProcessTitle('café')).toBe('café');
    expect([...terminalProcessTitle('x'.repeat(200))]).toHaveLength(160);
    expect(terminalProcessTitle('\u0000\u001f\u007f\u009f')).toBe('');
  });

  it('numbers repeated profile labels', () => {
    const first = newTerminalTab([], 'session-a', 'Local');
    const second = newTerminalTab([first], 'session-b', 'Local');

    expect(first).toEqual({ id: 'term-1', title: 'Local', kind: 'terminal', sessionId: 'session-a' });
    expect(second).toEqual({ id: 'term-2', title: 'Local 2', kind: 'terminal', sessionId: 'session-b' });
  });

  it('does not reuse tab identity or a label suffix after a close', () => {
    const existing = [
      { id: 'tab-1', title: 'Library', kind: 'library' },
      { id: 'term-12', title: 'Local 2', kind: 'terminal' },
      { id: 'term-20-copy', title: 'Other 8', kind: 'terminal' },
      { id: 'xterm-30', title: 'Local 9', kind: 'library' },
      { id: 'other', title: 'Other 8', kind: 'terminal' },
      { id: 'other-2', title: 'Local x2', kind: 'terminal' },
      { id: 'other-3', title: 'Local 2x', kind: 'terminal' },
    ];

    expect(newTerminalTab(existing, 'session-c', 'Local')).toEqual({
      id: 'term-13',
      title: 'Local 3',
      kind: 'terminal',
      sessionId: 'session-c',
    });
  });

  it('keeps detached-session fallback labels aligned with the tab ordinal', () => {
    expect(newTerminalTab([{ id: 'term-3', title: 'SSH', kind: 'terminal' }])).toEqual({
      id: 'term-4',
      title: 'Terminal 4',
      kind: 'terminal',
      sessionId: 'session-4',
    });
  });
});