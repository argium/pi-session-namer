import { DEFAULT_CONFIG } from './config.ts';

export type NameSegments = { type: string; topic: string; progress?: string; };

/**
 * Why the model produced no name: it declined (`SKIP`), returned nothing (`EMPTY`), there
 * was no conversation to analyse (`NO_CONTEXT`), or the provider failed (`ERROR`). They
 * are kept apart so each gets its own message and retry treatment.
 */
export type ModelFailure = 'SKIP' | 'EMPTY' | 'NO_CONTEXT' | 'ERROR';
export type ModelResult = ModelFailure | NameSegments;

const MAX_TYPE_LENGTH = 24;
export const MAX_TOPIC_LENGTH = 60;
export const MAX_PROGRESS_LENGTH = 16;

// Full-width and ASCII vertical bars both separate the model's segments.
const SEPARATOR = /[｜|]/;

export function resolveTimeZone(value: string): string {
  const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (value === 'auto') return systemZone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return value;
  } catch {
    return systemZone;
  }
}

/** Formats an ISO timestamp as `MMDD` in the configured time zone. */
export function formatDate(iso: string, configuredZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: resolveTimeZone(configuredZone),
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('month')}${part('day')}`;
}

/**
 * Parses the model's reply: `SKIP`, an empty reply, or `Type｜Topic[｜Progress]`.
 *
 * @returns The segments, a failure code, or `null` when the reply has no valid shape.
 */
export function parseModelSegments(
  raw: string,
  wantsProgress: boolean,
): ModelResult | null {
  const firstLine = raw
    .trim()
    .replace(/^```\w*\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? '';
  if (!firstLine) return 'EMPTY';
  if (/^SKIP$/i.test(firstLine)) return 'SKIP';

  const typeAndRest = firstLine.match(
    new RegExp(`^([^｜|]{1,${MAX_TYPE_LENGTH}})[｜|](.+)$`),
  );
  if (!typeAndRest?.[1].trim()) return null;
  const type = typeAndRest[1].trim();
  const rest = typeAndRest[2].trim();

  if (!wantsProgress) {
    const topic = rest.split(SEPARATOR)[0].trim().slice(0, MAX_TOPIC_LENGTH);
    return topic ? { type, topic } : null;
  }
  const topicAndProgress = rest.match(/^(.+?)[｜|]([^｜|]+)$/);
  const topic = (topicAndProgress ? topicAndProgress[1] : rest).trim().slice(
    0,
    MAX_TOPIC_LENGTH,
  );
  const progress = topicAndProgress?.[2].trim().slice(0, MAX_PROGRESS_LENGTH);
  return topic ? { type, topic, progress } : null;
}

// Drops separators left dangling by an empty segment (for example no progress).
function cleanupName(name: string): string {
  return name
    .replace(/(^\s+)|(\s*[｜|]\s*)+$/g, '')
    .replace(/\s*[｜|]\s*([｜|]\s*)+/g, '｜')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fills the `{date}`, `{type}`, `{topic}` and `{progress}` placeholders of a name format. */
export function renderName(
  nameFormat: string,
  parts: { date: string; } & NameSegments,
): string {
  return cleanupName(
    nameFormat
      .replaceAll('{date}', parts.date)
      .replaceAll('{type}', parts.type)
      .replaceAll('{topic}', parts.topic)
      .replaceAll('{progress}', parts.progress ?? ''),
  );
}

/** Parses a model reply and renders it as a full session name. */
export function parseModelResult(
  raw: string,
  date: string,
  nameFormat = DEFAULT_CONFIG.nameFormat,
): ModelFailure | string | null {
  const segments = parseModelSegments(raw, nameFormat.includes('{progress}'));
  if (segments === null || typeof segments === 'string') return segments;
  return renderName(nameFormat, { date, ...segments }) || null;
}
