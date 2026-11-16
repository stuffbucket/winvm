export type TerminalSplitDirection = 'right' | 'down';

export type TerminalPane =
  | { sessionId: string }
  | {
      direction: TerminalSplitDirection;
      first: TerminalPane;
      second: TerminalPane;
    };

export function isTerminalPane(value: unknown): value is TerminalPane {
  if (typeof value !== 'object' || value === null) return false;
  if ('sessionId' in value) {
    return typeof value.sessionId === 'string' && value.sessionId !== '';
  }
  if (!('direction' in value) || !('first' in value) || !('second' in value)) return false;
  return (value.direction === 'right' || value.direction === 'down')
    && isTerminalPane(value.first)
    && isTerminalPane(value.second);
}

export function splitTerminalPane(
  pane: TerminalPane,
  targetId: string,
  direction: TerminalSplitDirection,
  sessionId: string,
): TerminalPane {
  if ('sessionId' in pane) {
    return pane.sessionId === targetId
      ? { direction, first: pane, second: { sessionId } }
      : pane;
  }
  return {
    ...pane,
    first: splitTerminalPane(pane.first, targetId, direction, sessionId),
    second: splitTerminalPane(pane.second, targetId, direction, sessionId),
  };
}

export function terminalPaneSessionIds(pane: TerminalPane): string[] {
  return 'sessionId' in pane
    ? [pane.sessionId]
    : [...terminalPaneSessionIds(pane.first), ...terminalPaneSessionIds(pane.second)];
}

export function removeTerminalPane(
  pane: TerminalPane,
  sessionId: string,
): TerminalPane | undefined {
  if ('sessionId' in pane) return pane.sessionId === sessionId ? undefined : pane;
  const first = removeTerminalPane(pane.first, sessionId);
  const second = removeTerminalPane(pane.second, sessionId);
  if (!first) return second;
  if (!second) return first;
  return { ...pane, first, second };
}