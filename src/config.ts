import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const THINKING_LEVELS = [
  'inherit',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const DEFAULT_TYPES = [
  'Feature',
  'Design',
  'Fix',
  'Optimization',
  'Release',
  'Exploration',
  'Documentation',
  'Research',
];

export type Config = {
  model: string;
  thinkingLevel: ThinkingLevel;
  timeZone: string;
  checkEveryTurns: number;
  nameFormat: string;
  types: string[];
  nameLanguage: string;
};

export const DEFAULT_CONFIG: Config = {
  model: 'inherit',
  thinkingLevel: 'inherit',
  timeZone: 'auto',
  checkEveryTurns: 4,
  nameFormat: '{date}｜{type}｜{topic}｜{progress}',
  types: DEFAULT_TYPES,
  nameLanguage: 'auto',
};

const nonEmptyString = (value: unknown) =>
  typeof value === 'string' && value ? value : undefined;

/**
 * Validates untrusted configuration JSON field by field.
 *
 * @returns A complete config; any missing or invalid field takes its default.
 */
export function parseConfig(raw: unknown): Config {
  const input: Partial<Record<keyof Config, unknown>> =
    typeof raw === 'object' && raw !== null
      ? raw
      : {};
  const { thinkingLevel, checkEveryTurns, nameFormat, types } = input;
  return {
    model: nonEmptyString(input.model) ?? DEFAULT_CONFIG.model,
    thinkingLevel: THINKING_LEVELS.find((level) => level === thinkingLevel) ??
      DEFAULT_CONFIG.thinkingLevel,
    timeZone: nonEmptyString(input.timeZone) ?? DEFAULT_CONFIG.timeZone,
    checkEveryTurns:
      typeof checkEveryTurns === 'number' && Number.isInteger(checkEveryTurns) &&
        checkEveryTurns >= 0
        ? checkEveryTurns
        : DEFAULT_CONFIG.checkEveryTurns,
    nameFormat: typeof nameFormat === 'string' && nameFormat.includes('{type}') &&
        nameFormat.includes('{topic}')
      ? nameFormat
      : DEFAULT_CONFIG.nameFormat,
    types: Array.isArray(types) && types.length > 0 &&
        types.every((type) => typeof type === 'string' && type.trim())
      ? types.map((type: string) => type.trim())
      : DEFAULT_CONFIG.types,
    nameLanguage: nonEmptyString(input.nameLanguage) ?? DEFAULT_CONFIG.nameLanguage,
  };
}

export function configPath(): string {
  return join(homedir(), '.pi', 'agent', 'session-namer.json');
}

/**
 * Reads the configuration file, writing the defaults first when it does not exist. An
 * existing file is never overwritten.
 *
 * @returns The validated config, plus a warning when the file could not be read or parsed
 * (the defaults are used in that case).
 */
export function loadConfig(path = configPath()): { config: Config; warning?: string; } {
  try {
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { flag: 'wx' });
    }
    return { config: parseConfig(JSON.parse(readFileSync(path, 'utf8'))) };
  } catch {
    return {
      config: DEFAULT_CONFIG,
      warning: `Failed to read configuration; using defaults: ${path}`,
    };
  }
}
