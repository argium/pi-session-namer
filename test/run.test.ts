import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sessionNamer from '../src/index.ts';

// The factory reads ~/.pi/agent/session-namer.json when it runs, so point HOME at
// a scratch directory: these tests exercise the retry budget, not the user's config.
const home = mkdtempSync(join(tmpdir(), 'session-namer-run-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
test.after(() => rmSync(home, { recursive: true, force: true }));

type Reply = 'OK' | 'SKIP' | 'EMPTY' | 'ERROR';
type Handler = (event: unknown, ctx: unknown) => unknown;

const MESSAGE_ENTRY = [
  {
    type: 'message',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'fix the OAuth callback bug' }],
    },
  },
];
const REPLIES: Record<Reply, unknown> = {
  OK: {
    content: [{ type: 'text', text: 'Fix｜OAuth callback bug' }],
    stopReason: 'stop',
  },
  SKIP: { content: [{ type: 'text', text: 'SKIP' }], stopReason: 'stop' },
  EMPTY: { content: [], stopReason: 'stop' },
  ERROR: { content: [], stopReason: 'error', errorMessage: '429 too many requests' },
};
const NAME = '0310｜Fix｜OAuth callback bug';

/** Drive the real handlers and `/sn` command against a stubbed extension context. */
function createHarness() {
  let sessionName: string | undefined;
  let branch: unknown[] = MESSAGE_ENTRY;
  let reply: Reply = 'OK';
  const prompts: string[] = [];
  const notices: string[] = [];
  const appended: unknown[] = [];
  const handled = new Map<string, Handler>();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => unknown; }
  >();
  const model = {
    provider: 'probe',
    id: 'probe',
    api: 'openai-completions',
    reasoning: false,
  };
  const ctx = {
    hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => [],
      getHeader: () => ({ timestamp: '2026-03-10T00:00:00.000Z' }),
      getSessionFile: () => join(home, 'session.jsonl'),
    },
    model,
    modelRegistry: {
      find: () => model,
      hasConfiguredAuth: () => true,
      complete: async (_model: unknown, request: unknown) => {
        prompts.push(JSON.stringify(request));
        return REPLIES[reply];
      },
    },
    thinkingLevel: 'off',
  };
  sessionNamer({
    on: (event: string, handler: Handler) => handled.set(event, handler),
    registerCommand: (name: string, command: never) => commands.set(name, command),
    appendEntry: (_type: string, data: unknown) => appended.push(data),
    exec: async () => ({ stdout: '## main...origin/main [ahead 1]' }),
    getSessionName: () => sessionName,
    // Pi emits session_info_changed from inside setSessionName, before it returns.
    setSessionName: (name: string) => {
      sessionName = name;
      handled.get('session_info_changed')!({ name }, ctx);
    },
  } as never);

  const emit = (event: string, payload: unknown = {}) =>
    handled.get(event)!(payload, ctx);
  return {
    async settle(withContext = true) {
      branch = withContext ? MESSAGE_ENTRY : [];
      await emit('agent_settled');
    },
    async gitPush() {
      await emit('tool_result', {
        toolName: 'bash',
        isError: false,
        input: { command: 'git push origin main' },
      });
    },
    async compact() {
      await emit('session_compact');
    },
    /** The user renames the session with `/name`. */
    userRenames(name: string) {
      sessionName = name;
      return emit('session_info_changed', { name });
    },
    async sn(args: string) {
      await commands.get('sn')!.handler(args, ctx);
    },
    setReply(next: Reply) {
      reply = next;
    },
    prompts,
    notices,
    appended,
    name: () => sessionName,
  };
}

test('keeps naming after empty-context checks instead of spending the retry budget', async () => {
  const harness = createHarness();
  for (let run = 0; run < 3; run++) await harness.settle(false);
  assert.equal(harness.name(), undefined);

  await harness.settle();

  assert.equal(harness.name(), NAME);
});

test('a SKIP answer does not consume the retry budget', async () => {
  const harness = createHarness();
  harness.setReply('SKIP');
  for (let run = 0; run < 3; run++) await harness.settle();
  harness.setReply('OK');

  await harness.settle();

  assert.equal(harness.name(), NAME);
});

test('three real model failures stop automatic naming until a manual refresh', async () => {
  const harness = createHarness();
  harness.setReply('EMPTY');
  for (let run = 0; run < 3; run++) await harness.settle();
  harness.setReply('OK');

  await harness.settle();

  assert.equal(harness.name(), undefined, 'a broken model must not be retried forever');
});

test('a git push triggers a check before the interval and sends the git status', async () => {
  const harness = createHarness();
  await harness.settle();
  await harness.settle();
  assert.equal(
    harness.prompts.length,
    1,
    'no check between intervals without git activity',
  );

  await harness.gitPush();
  await harness.settle();

  assert.equal(harness.prompts.length, 2);
  assert.match(harness.prompts[1], /ahead 1/);
});

test('names after the first prompt, then checks every checkEveryTurns prompts', async () => {
  const harness = createHarness();
  await harness.settle();
  assert.equal(harness.prompts.length, 1, 'initial name after the first prompt');

  for (let run = 0; run < 3; run++) await harness.settle();
  assert.equal(harness.prompts.length, 1, 'no check during the next three prompts');

  await harness.settle();
  assert.equal(
    harness.prompts.length,
    2,
    'next check on the fourth prompt after the initial name',
  );
});

test('compaction triggers a check before the interval', async () => {
  const harness = createHarness();
  await harness.settle();
  await harness.compact();

  await harness.settle();

  assert.equal(harness.prompts.length, 2);
});

test('settling without a check does not add session entries', async () => {
  const harness = createHarness();
  await harness.settle();
  const afterNaming = harness.appended.length;

  for (let run = 0; run < 3; run++) await harness.settle();

  assert.equal(harness.appended.length, afterNaming);
});

test('the extension renaming the session does not lock it', async () => {
  const harness = createHarness();
  await harness.settle();
  await harness.sn('status');

  assert.match(harness.notices.at(-1)!, /Status: automatic/);
});

test('a manual rename locks the name and stops automatic checks', async () => {
  const harness = createHarness();
  await harness.settle();

  await harness.userRenames('my own name');
  for (let run = 0; run < 4; run++) await harness.settle();

  assert.equal(harness.prompts.length, 1);
  assert.equal(harness.name(), 'my own name');
});

test('/sn lock and unlock control automatic naming', async () => {
  const harness = createHarness();
  await harness.sn('lock');
  assert.match(harness.notices.at(-1)!, /no session name to lock/);

  await harness.settle();
  await harness.sn('lock');
  assert.match(harness.notices.at(-1)!, /locked/);
  for (let run = 0; run < 4; run++) await harness.settle();
  assert.equal(harness.prompts.length, 1);

  await harness.sn('refresh');
  assert.match(harness.notices.at(-1)!, /Run \/sn unlock first/);

  await harness.sn('unlock');
  await harness.settle();
  await harness.sn('status');
  assert.match(harness.notices.at(-1)!, /Status: automatic/);
});

test('/sn refresh force sends the instruction to the model', async () => {
  const harness = createHarness();
  await harness.settle();

  await harness.sn('refresh force write the type in French');

  assert.equal(harness.prompts.length, 2);
  assert.match(harness.prompts[1], /write the type in French/);
  assert.match(harness.prompts[1], /forced re-evaluation/);
});

test('/sn with an unknown subcommand lists the subcommands', async () => {
  const harness = createHarness();

  await harness.sn('bogus');

  assert.match(harness.notices.at(-1)!, /Usage: \/sn <refresh\|lock\|unlock\|status>/);
  assert.equal(harness.prompts.length, 0);
});
