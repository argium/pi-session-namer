import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { parseRefreshArgs, parseSnArgs, SN_SUBCOMMANDS } from './commands.ts';
import { loadConfig } from './config.ts';
import { generate, missMessage, selectModel } from './generate.ts';
import { type NameSegments, renderName } from './name.ts';
import type { RunOptions } from './prompt.ts';
import { defaultState, ENTRY_TYPE, latestState, type State } from './state.ts';

/** Consecutive failed automatic attempts before automatic naming stops for the session. */
const MAX_AUTOMATIC_FAILURES = 3;

type Notify = (message: string, level?: 'info' | 'warning' | 'error') => void;

export default function sessionNamer(pi: ExtensionAPI) {
  const { config, warning } = loadConfig();
  let pendingWarning = warning;
  let state: State | undefined;
  let running = false;
  let compactPending = false;
  let gitActivity = false;
  let failures = 0;
  // Settled agent runs since the last check. Kept in memory only: persisting it would add
  // a session entry on every prompt, and a reload simply restarts the interval.
  let turns = 0;

  const notifier = (ctx: ExtensionContext): Notify => (message, level = 'info') => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  };
  const ensureState = (ctx: ExtensionContext) => {
    state ??= latestState(ctx) ?? defaultState(ctx, config);
    return state;
  };
  const persist = (next: State) => {
    state = next;
    pi.appendEntry(ENTRY_TYPE, next);
  };

  const applyName = (
    ctx: ExtensionContext,
    current: State,
    segments: NameSegments,
    manual: boolean,
  ) => {
    const notify = notifier(ctx);
    const rendered = renderName(config.nameFormat, { date: current.date, ...segments });
    if (!rendered) {
      if (manual) notify('No valid session name was generated.', 'warning');
      return;
    }
    failures = 0;
    turns = 0;
    const next = { ...current, segments };
    if (rendered === pi.getSessionName()) {
      persist(next);
      if (manual) notify('The current session name is still accurate; no changes made.');
      return;
    }
    // Persist before renaming: session_info_changed can fire before setSessionName
    // returns, and the handler treats any name other than autoName as a manual rename.
    persist({ ...next, autoName: rendered });
    pi.setSessionName(rendered);
    if (manual || !current.autoName) notify(`Session name updated: ${rendered}`);
  };

  const run = async (ctx: ExtensionContext, options: RunOptions = {}) => {
    const manual = Boolean(options.manual);
    const notify = notifier(ctx);
    const current = ensureState(ctx);
    if (!manual && !ctx.sessionManager.getSessionFile()) return;
    if (
      running || current.manualLock || (!manual && failures >= MAX_AUTOMATIC_FAILURES)
    ) {
      if (manual && current.manualLock) {
        notify('The session name is locked. Run /sn unlock first.', 'warning');
      }
      return;
    }

    running = true;
    try {
      const { model, fellBack } = selectModel(ctx, config);
      if (fellBack && model) {
        notify(
          `Configured naming model is unavailable; falling back to the primary agent: ${model.provider}/${model.id}`,
          'warning',
        );
      }
      const { result, errorMessage } = await generate(
        pi,
        ctx,
        config,
        model,
        current,
        options,
      );
      if (result && typeof result !== 'string') {
        applyName(ctx, current, result, manual);
        return;
      }
      // Only a real failure spends the retry budget. SKIP is a valid answer and
      // NO_CONTEXT means there is nothing to analyze yet; counting either would stop
      // automatic naming for the rest of the session over a transient condition.
      if (result === 'SKIP') failures = 0;
      else if (result !== 'NO_CONTEXT' && !manual) failures++;
      turns = 0;
      if (manual) notify(missMessage(result, errorMessage), 'warning');
    } catch (error) {
      if (!manual) failures++;
      if (manual) {
        notify(
          `Session naming failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'error',
        );
      }
    } finally {
      running = false;
    }
  };

  const lockAsManual = (current: State) => persist({ ...current, manualLock: true });

  pi.on('session_start', (_event, ctx) => {
    state = latestState(ctx);
    turns = 0;
    if (pendingWarning) {
      notifier(ctx)(pendingWarning, 'warning');
      pendingWarning = undefined;
    }
    // A name that differs from the one we set means the user renamed the session while
    // the extension was not listening.
    const currentName = pi.getSessionName();
    if (
      state && currentName && state.autoName && currentName !== state.autoName &&
      !state.manualLock
    ) {
      lockAsManual(state);
    }
  });
  pi.on('session_compact', () => {
    compactPending = true;
  });
  // A commit or push changes what progress should say, so check as soon as the agent settles.
  pi.on('tool_result', (event) => {
    if (event.toolName !== 'bash' || event.isError) return;
    const { command } = event.input as { command?: string; };
    if (/\bgit\s+(commit|push)\b/.test(String(command))) gitActivity = true;
  });
  pi.on('session_info_changed', (event, ctx) => {
    const current = ensureState(ctx);
    if (event.name && event.name !== current.autoName) lockAsManual(current);
  });
  pi.on('agent_settled', async (_event, ctx) => {
    const current = ensureState(ctx);
    if (current.manualLock) return;
    turns++;
    const intervalElapsed = config.checkEveryTurns > 0 && turns >= config.checkEveryTurns;
    if (!(compactPending || gitActivity || !current.autoName || intervalElapsed)) return;
    compactPending = false;
    gitActivity = false;
    await run(ctx);
  });

  const lock = (ctx: ExtensionContext) => {
    const notify = notifier(ctx);
    if (!pi.getSessionName())
      return notify('There is no session name to lock.', 'warning');
    lockAsManual(ensureState(ctx));
    notify('Session name locked.');
  };
  const unlock = (ctx: ExtensionContext) => {
    const notify = notifier(ctx);
    const current = ensureState(ctx);
    if (!current.manualLock) return notify('The session name is not locked.');
    persist({ ...current, manualLock: false });
    notify('Session name unlocked. Run /sn refresh when you want to update it.');
  };
  const status = (ctx: ExtensionContext) => {
    const current = ensureState(ctx);
    const next = config.checkEveryTurns === 0
      ? 'disabled'
      : `in ${Math.max(0, config.checkEveryTurns - turns)} settled run(s)`;
    notifier(ctx)(
      [
        `Current name: ${pi.getSessionName() ?? '(unnamed)'}`,
        `Status: ${current.manualLock ? 'locked' : 'automatic'}`,
        `Next check: ${next}`,
      ].join('\n'),
    );
  };
  const refresh = async (args: string, ctx: ExtensionContext) => {
    const { force, hint } = parseRefreshArgs(args);
    notifier(ctx)(
      force
        ? 'Forcing a re-evaluation of the session name…'
        : 'Analyzing the current session to refresh its name…',
    );
    await run(ctx, { manual: true, force, hint });
  };

  const names = SN_SUBCOMMANDS.map((c) => c.name).join('|');
  pi.registerCommand('sn', {
    description: `Session naming (usage: /sn <${names}>)`,
    getArgumentCompletions: (prefix) => {
      const typed = prefix.trimStart();
      if (/\s/.test(typed)) return null;
      const matches = SN_SUBCOMMANDS.filter((c) =>
        c.name.startsWith(typed.toLowerCase())
      );
      return matches.length
        ? matches.map((c) => ({
          value: c.name,
          label: c.name,
          description: c.description,
        }))
        : null;
    },
    handler: async (args, ctx) => {
      const { command, rest } = parseSnArgs(args);
      if (command === 'refresh') return refresh(rest, ctx);
      if (command === 'lock') return lock(ctx);
      if (command === 'unlock') return unlock(ctx);
      if (command === 'status') return status(ctx);
      notifier(ctx)(
        [
          `Usage: /sn <${names}>`,
          ...SN_SUBCOMMANDS.map((c) => `  ${c.name} - ${c.description}`),
        ].join('\n'),
        'warning',
      );
    },
  });
}
