import type { Config } from './config.ts';
import { MAX_PROGRESS_LENGTH, type NameSegments } from './name.ts';

export type RunOptions = {
  /** Re-assess the type and topic from scratch instead of reusing the current ones. */
  force?: boolean;
  /** Extra requirement from the user, injected with the highest priority. */
  hint?: string;
  /** The user asked for this run, so the model must not answer `SKIP`. */
  manual?: boolean;
};

/**
 * Describes the current name to the model. A forced re-evaluation must not see the old
 * wording: the model copies what it is shown, and the point of forcing is to escape a
 * first name that turned out wrong.
 */
export function buildContextLine(
  force: boolean,
  segments: NameSegments | undefined,
  currentName: string,
): string {
  if (force) {
    return 'The user requested a forced re-evaluation: describe the current main task from the conversation alone, ignoring any earlier name.';
  }
  if (segments) {
    return `Current type and topic (reuse them EXACTLY as written if they still describe the main task): ${segments.type}｜${segments.topic}`;
  }
  return `Current name: ${currentName}`;
}

export function buildReuseRule(force: boolean, wantsProgress: boolean): string {
  if (force) {
    return '- Re-assess the type and topic from scratch, using the conversation alone; do not carry over any earlier name.';
  }
  return wantsProgress
    ? '- If the current name\'s type and topic still describe the main task, reuse them EXACTLY as written; only the progress may change.'
    : '- If the current name\'s type and topic still describe the main task, output them EXACTLY as written.';
}

export function buildHintRule(hint?: string): string {
  return hint
    ? `\n- Additional user requirement (highest priority, as long as the output format is respected): ${hint}`
    : '';
}

/**
 * A manual refresh is an explicit instruction, so the model never answers `SKIP`: it names
 * the most likely main task even when the evidence is thin.
 */
export function buildOutputRule(manual: boolean, wantsProgress: boolean): string {
  const shape = wantsProgress ? '"Type｜Topic｜Progress"' : '"Type｜Topic"';
  return manual
    ? `- Output ${shape}. The user explicitly requested a refresh: always name the most likely main task, even if the evidence is thin. Never output SKIP.`
    : `- Output ${shape}; output SKIP only if there is no clear task.`;
}

const PROGRESS_RULE =
  `- Progress states the latest status of the main task (e.g. "published 0.1.1", "fix verified", "awaiting review"), at most ${MAX_PROGRESS_LENGTH} characters. Anchor it to the latest evidence near the END of the conversation; never report an earlier phase when a later milestone has already been reached. When <git-status> is present, progress should say whether the work is uncommitted, committed or pushed.`;

/** Builds the full naming prompt. `git` is the `git status -sb` output, when available. */
export function buildPrompt(
  contextLine: string,
  conversation: string,
  config: Config,
  options: RunOptions,
  git?: string,
): string {
  const wantsProgress = config.nameFormat.includes('{progress}');
  const languageRule = config.nameLanguage === 'auto'
    ? 'Use the primary language of the conversation for the type, topic, and progress.'
    : `Write the type, topic, and progress in this language: ${config.nameLanguage}.`;
  const rules = [
    buildOutputRule(Boolean(options.manual), wantsProgress),
    buildReuseRule(Boolean(options.force), wantsProgress),
    `- Type must be one of: ${
      config.types.join(', ')
    }, or an equivalent label in the naming language.`,
    '- Topic is concise and specific, suitable for a sidebar.',
    languageRule,
    '- No project name, file paths, dates, explanations, quotes, or Markdown.',
    ...(wantsProgress ? [PROGRESS_RULE] : []),
    `- The program will apply the date and the name format: ${config.nameFormat}.${
      buildHintRule(options.hint)
    }`,
  ];
  const sections = [
    'You are Pi\'s session naming assistant. Describe what this session is working on and its latest state.',
    `Output rules:\n${rules.join('\n')}`,
    contextLine,
    `<conversation>\n${conversation}\n</conversation>`,
  ];
  if (git) sections.push(`<git-status>\n${git}\n</git-status>`);
  return sections.join('\n\n');
}
