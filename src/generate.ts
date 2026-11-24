import { uuidv7 } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Config, ThinkingLevel } from './config.ts';
import { buildConversationText } from './conversation.ts';
import { type ModelResult, parseModelSegments } from './name.ts';
import { buildContextLine, buildPrompt, type RunOptions } from './prompt.ts';
import type { State } from './state.ts';

type Model = NonNullable<ExtensionContext['model']>;

export const MAX_ERROR_LENGTH = 300;
const GIT_STATUS_TIMEOUT_MS = 5000;

/**
 * Picks the naming model: the configured one when it is available with auth, otherwise
 * the primary agent's model.
 *
 * @returns `fellBack` is true when a configured model was requested but unusable.
 */
export function selectModel(
  ctx: ExtensionContext,
  config: Config,
): { model: Model | undefined; fellBack: boolean; } {
  const primary = ctx.model && ctx.modelRegistry.hasConfiguredAuth(ctx.model)
    ? ctx.model
    : undefined;
  if (config.model === 'inherit') return { model: primary, fellBack: false };

  const slash = config.model.indexOf('/');
  if (slash > 0) {
    const configured = ctx.modelRegistry.find(
      config.model.slice(0, slash),
      config.model.slice(slash + 1),
    );
    if (configured && ctx.modelRegistry.hasConfiguredAuth(configured)) {
      return { model: configured, fellBack: false };
    }
  }
  return { model: primary, fellBack: true };
}

const REASONING_EFFORT_APIS = new Set([
  'openai-completions',
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
]);

/**
 * Maps a configured thinking level onto the provider-specific request option. A level the
 * model does not support is reduced to the nearest lower supported one; providers without
 * a known format get no option rather than a made-up one.
 */
function thinkingOptions(model: Model, level: ThinkingLevel): Record<string, unknown> {
  if (!model.reasoning || level === 'inherit' || level === 'off') return {};
  const levels: Exclude<ThinkingLevel, 'inherit' | 'off'>[] = [
    'max',
    'xhigh',
    'high',
    'medium',
    'low',
    'minimal',
  ];
  let mapped: string | undefined;
  for (const candidate of levels.slice(levels.indexOf(level))) {
    const value = model.thinkingLevelMap?.[candidate];
    if (value !== null) {
      mapped = value ?? candidate;
      break;
    }
  }
  if (!mapped) return {};
  if (model.api === 'anthropic-messages')
    return { thinkingEnabled: true, effort: mapped };
  if (REASONING_EFFORT_APIS.has(model.api)) return { reasoningEffort: mapped };
  return {};
}

/**
 * Describes a provider failure. `complete()` does not throw on provider errors (401, 429,
 * content filters); it returns an empty message whose stop reason is `error`.
 *
 * @returns A single-line, length-capped message, or `undefined` when the call succeeded.
 */
export function responseError(
  response: { stopReason?: string; errorMessage?: string; },
): string | undefined {
  if (response.stopReason !== 'error' && response.stopReason !== 'aborted')
    return undefined;
  const detail = (response.errorMessage ?? '').replace(/\s+/g, ' ').trim();
  return (detail || `the provider stopped with "${response.stopReason}"`).slice(
    0,
    MAX_ERROR_LENGTH,
  );
}

/** Explains a manual refresh that produced no name, by reason. */
export function missMessage(result: ModelResult | null, errorMessage?: string): string {
  if (result === 'NO_CONTEXT') return 'There is no conversation content to analyze yet.';
  if (result === 'ERROR') {
    return `The naming request failed: ${
      errorMessage || 'the provider returned an error without details'
    }.`;
  }
  if (result === 'EMPTY') {
    return 'The naming model returned no text. Try again, or add an instruction: /sn refresh <requirement>.';
  }
  if (result === 'SKIP') {
    return 'The naming model did not pick a main task. Add an instruction: /sn refresh <requirement>.';
  }
  return 'No valid session name was generated.';
}

export type GenerateOutcome = { result: ModelResult | null; errorMessage?: string; };

/**
 * Asks the model to describe the session. A missing `model` yields `{ result: null }`.
 * Provider errors are reported in the outcome rather than thrown.
 */
export async function generate(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: Config,
  model: Model | undefined,
  state: State,
  options: RunOptions,
): Promise<GenerateOutcome> {
  if (!model) return { result: null };
  const conversation = buildConversationText(ctx.sessionManager.getBranch());
  if (!conversation) return { result: 'NO_CONTEXT' };

  const level = config.thinkingLevel === 'inherit'
    ? (ctx.thinkingLevel ?? 'off')
    : config.thinkingLevel;
  const git = await pi
    .exec('git', ['status', '-sb'], { cwd: ctx.cwd, timeout: GIT_STATUS_TIMEOUT_MS })
    .then((result) => result.stdout.trim(), () => '');
  const contextLine = buildContextLine(
    Boolean(options.force),
    state.segments,
    pi.getSessionName() ?? state.autoName ?? '(unnamed)',
  );
  const prompt = buildPrompt(contextLine, conversation, config, options, git);

  const response = await ctx.modelRegistry.complete(
    model,
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    { sessionId: uuidv7(), cacheRetention: 'none', ...thinkingOptions(model, level) },
  );
  const failure = responseError(response);
  if (failure) return { result: 'ERROR', errorMessage: failure };
  const text = response.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  return { result: parseModelSegments(text, config.nameFormat.includes('{progress}')) };
}
