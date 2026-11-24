import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Config } from './config.ts';
import { formatDate, type NameSegments, resolveTimeZone } from './name.ts';

export const ENTRY_TYPE = 'pi-session-namer';

/** Naming state persisted in the session as a custom entry. */
export type State = {
  version: 1;
  autoName?: string;
  segments?: NameSegments;
  /** Set when the user renames the session or runs `/sn lock`; automatic naming stops. */
  manualLock: boolean;
  /** Creation date (`MMDD`) kept stable across renames. */
  date: string;
  timeZone: string;
};

/** Returns the most recently persisted state of this session, if any. */
export function latestState(ctx: ExtensionContext): State | undefined {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== 'custom' || entry.customType !== ENTRY_TYPE) continue;
    if (!entry.data || typeof entry.data !== 'object') continue;
    // Pick the known fields so entries written by older versions do not carry stale ones forward.
    const { autoName, segments, manualLock, date, timeZone } = entry.data as State;
    return { version: 1, autoName, segments, manualLock, date, timeZone };
  }
  return undefined;
}

export function defaultState(ctx: ExtensionContext, config: Config): State {
  const timeZone = resolveTimeZone(config.timeZone);
  const timestamp = ctx.sessionManager.getHeader()?.timestamp ?? new Date().toISOString();
  return {
    version: 1,
    manualLock: false,
    date: formatDate(timestamp, timeZone),
    timeZone,
  };
}
