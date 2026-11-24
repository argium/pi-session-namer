import type { SessionEntry } from '@earendil-works/pi-coding-agent';

const MAX_MESSAGES = 12;
const MAX_CHARS = 5000;
const NEWEST_LIMIT = 2000;
const OLDER_LIMIT = 700;
const SUMMARY_LIMIT = 700;
const SEPARATOR = '\n\n';

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function toolNamesOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part?.type === 'toolCall' && part.name)
    .map((part) => part.name);
}

/** Renders one entry as a transcript line, or `undefined` when it carries no evidence. */
function lineFor(entry: SessionEntry): string | undefined {
  if (entry.type === 'compaction' && entry.summary) {
    return `Summary: ${entry.summary.slice(0, SUMMARY_LIMIT)}`;
  }
  if (entry.type !== 'message') return undefined;
  const { message } = entry;
  if (message.role !== 'user' && message.role !== 'assistant') return undefined;
  const text = textOf(message.content).trim();
  if (!text) return undefined;
  const toolNames = toolNamesOf(message.content);
  const toolSuffix = toolNames.length ? `\nTools: ${toolNames.join(', ')}` : '';
  return `${message.role === 'user' ? 'User' : 'Assistant'}: ${text}${toolSuffix}`;
}

/**
 * Builds the transcript sent to the naming model from the newest messages and compaction
 * summaries.
 *
 * Budgets favour the latest evidence (for example a completion report): the newest line
 * keeps up to {@link NEWEST_LIMIT} characters and each earlier line up to
 * {@link OLDER_LIMIT}. When the budget runs out the oldest lines are dropped, and
 * separators count against the budget so the newest line is never trimmed at its tail.
 */
export function buildConversationText(
  entries: readonly SessionEntry[],
  maxMessages = MAX_MESSAGES,
  maxChars = MAX_CHARS,
): string {
  const lines: string[] = [];
  for (let i = entries.length - 1; i >= 0 && lines.length < maxMessages; i--) {
    const line = lineFor(entries[i]);
    if (line) lines.unshift(line);
  }
  if (lines.length === 0) return '';

  const newest = lines[lines.length - 1].slice(0, NEWEST_LIMIT);
  let budget = maxChars - newest.length;
  if (budget <= 0) return newest.slice(0, maxChars);

  const kept = [newest];
  for (let i = lines.length - 2; i >= 0 && budget > SEPARATOR.length; i--) {
    const line = lines[i].slice(0, Math.min(OLDER_LIMIT, budget - SEPARATOR.length));
    kept.unshift(line);
    budget -= line.length + SEPARATOR.length;
  }
  return kept.join(SEPARATOR);
}
