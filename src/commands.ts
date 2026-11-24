export const MAX_HINT_LENGTH = 200;

export type RefreshArgs = { force: boolean; hint?: string; };

/** Folds the user's extra requirement onto one line and caps it, so pasted text cannot break the prompt layout. */
function normalizeHint(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_HINT_LENGTH);
}

/**
 * Parses the arguments of `/sn refresh`. No text is a plain refresh; a leading `force` or
 * any other text forces a re-evaluation, and the remaining text becomes the hint.
 */
export function parseRefreshArgs(args: string): RefreshArgs {
  const trimmed = args.trim();
  if (!trimmed) return { force: false };
  const forced = trimmed.match(/^force(?![a-z0-9])[:\s]*([\s\S]*)$/i);
  const hint = normalizeHint(forced ? forced[1] : trimmed);
  return hint ? { force: true, hint } : { force: true };
}

export const SN_SUBCOMMANDS = [
  {
    name: 'refresh',
    description: 'Refresh the name; add `force` and/or an instruction to re-evaluate it',
  },
  { name: 'lock', description: 'Lock the current name' },
  { name: 'unlock', description: 'Unlock automatic naming' },
  { name: 'status', description: 'Show the name, lock state and next check' },
] as const;

export type SnSubcommand = (typeof SN_SUBCOMMANDS)[number]['name'];

/**
 * Splits `/sn <subcommand> [rest]` into the subcommand and its argument text.
 *
 * @returns `command` is `undefined` when the first word is not a subcommand.
 */
export function parseSnArgs(args: string): { command?: SnSubcommand; rest: string; } {
  const [word = '', ...rest] = args.trim().split(/\s+/);
  const command = SN_SUBCOMMANDS.find((c) => c.name === word.toLowerCase())?.name;
  return { command, rest: rest.join(' ') };
}
