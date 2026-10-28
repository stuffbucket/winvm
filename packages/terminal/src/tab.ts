interface ExistingTab {
  id: string;
  title: string;
  kind: string;
}

export interface TerminalShellTab {
  id: string;
  title: string;
  kind: 'terminal';
  sessionId: string;
  customTitle?: boolean;
}

function nextOrdinal(existing: readonly ExistingTab[]): number {
  let highest = 0;
  for (const tab of existing) {
    const match = /^term-(\d+)$/.exec(tab.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

function nextTitle(existing: readonly ExistingTab[], label: string): string {
  let highest = 0;
  const prefix = `${label} `;
  for (const tab of existing) {
    if (tab.kind !== 'terminal') continue;
    if (tab.title === label) {
      highest = Math.max(highest, 1);
      continue;
    }
    if (!tab.title.startsWith(prefix)) continue;
    const suffix = tab.title.slice(prefix.length);
    if (/^[1-9]\d*$/.test(suffix)) highest = Math.max(highest, Number(suffix));
  }
  return highest === 0 ? label : `${label} ${String(highest + 1)}`;
}

/** Returns the final directory segment for an idle terminal title. */
export function terminalDirectoryTitle(cwd: string): string {
  let end = cwd.length;
  while (end > 0 && (cwd[end - 1] === '/' || cwd[end - 1] === '\\')) end -= 1;
  const withoutTrailingSeparators = cwd.slice(0, end);
  const segments = withoutTrailingSeparators.split(/[\\/]/);
  return segments.at(-1) || cwd;
}

/** Removes controls and bounds a process-supplied terminal title. */
export function terminalProcessTitle(title: string): string {
  const printable = [...title]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127 && !(codePoint >= 128 && codePoint <= 159);
    })
    .join('')
    .trim();
  return [...printable].slice(0, 160).join('');
}

/** Creates the next numbered reference tab without reusing closed identities. */
export function newTerminalTab(
  existing: readonly ExistingTab[],
  sessionId?: string,
  label?: string,
): TerminalShellTab {
  const ordinal = nextOrdinal(existing);
  return {
    id: `term-${String(ordinal)}`,
    title: label ? nextTitle(existing, label) : `Terminal ${String(ordinal)}`,
    kind: 'terminal',
    sessionId: sessionId ?? `session-${String(ordinal)}`,
  };
}