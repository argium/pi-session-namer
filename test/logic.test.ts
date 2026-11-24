import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRefreshArgs, parseSnArgs } from '../src/commands.ts';
import { buildConversationText } from '../src/conversation.ts';
import { MAX_ERROR_LENGTH, missMessage, responseError } from '../src/generate.ts';
import {
  formatDate,
  parseModelResult,
  parseModelSegments,
  resolveTimeZone,
} from '../src/name.ts';
import {
  buildContextLine,
  buildHintRule,
  buildOutputRule,
  buildReuseRule,
} from '../src/prompt.ts';

test('formats dates in the requested timezone', () => {
  assert.equal(formatDate('2026-03-11T00:30:00.000Z', 'America/Los_Angeles'), '0310');
  assert.equal(formatDate('2026-03-11T00:30:00.000Z', 'Asia/Shanghai'), '0311');
});

test('buildConversationText emphasizes the newest message', () => {
  const long = 'x'.repeat(1200);
  const entries = [
    { type: 'message', message: { role: 'user', content: 'old question' } },
    {
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: long }] },
    },
  ];
  const text = buildConversationText(entries as never);
  assert.ok(text.includes('old question'));
  // The newest (last) message keeps more than the old 700-char cap.
  assert.ok(text.length > 700 + 'old question'.length);
  assert.ok(text.split('x').length - 1 > 700);
});

test('buildConversationText keeps the newest message intact under budget pressure', () => {
  // 12 long messages: the first 11 fill the budget, so the oldest must be
  // dropped while the newest (with a completion report) stays intact.
  const filler = 'y'.repeat(700);
  const entries: { type: string; message: { role: string; content: unknown; }; }[] = [];
  for (let i = 0; i < 11; i++) {
    entries.push({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: filler }] },
    });
  }
  const report =
    'Restart verified: system status normal, zero crash events, task complete.';
  entries.push({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'text', text: report }] },
  });
  const text = buildConversationText(entries as never, 12, 5000);
  // The completion report survives untouched.
  assert.ok(text.includes(report));
  // Budget: 5000 - report(~75) = ~4925; each earlier message capped at 700 → about 7 kept.
  const yCount = text.split('y').length - 1;
  assert.ok(yCount <= 7 * 700);
  // And the oldest messages were dropped, not the newest.
  assert.ok(text.trimEnd().endsWith(report));
});

test('buildConversationText selects the newest message window', () => {
  const entries = [
    { type: 'message', message: { role: 'user', content: 'OLDEST_SENTINEL' } },
    ...Array.from({ length: 13 }, (_, index) => ({
      type: 'message',
      message: { role: 'assistant', content: `middle-${index}` },
    })),
    { type: 'message', message: { role: 'assistant', content: 'NEWEST_SENTINEL' } },
  ];

  const text = buildConversationText(entries as never, 12, 50_000);

  assert.ok(!text.includes('OLDEST_SENTINEL'));
  assert.ok(text.includes('NEWEST_SENTINEL'));
  assert.ok(text.trimEnd().endsWith('NEWEST_SENTINEL'));
});

test('falls back for an invalid timezone', () => {
  assert.doesNotThrow(() => resolveTimeZone('Not/AZone'));
});

test('parses model control responses', () => {
  assert.equal(parseModelResult('SKIP', '0310'), 'SKIP');
  // An empty reply means the model returned nothing, not that the context was thin.
  assert.equal(parseModelResult('', '0310'), 'EMPTY');
  assert.equal(parseModelResult('  \n\t ', '0310'), 'EMPTY');
  assert.equal(parseModelResult('KEEP', '0310'), null);
  assert.equal(
    parseModelResult('Fix｜OAuth callback errors', '0310'),
    '0310｜Fix｜OAuth callback errors',
  );
  assert.equal(
    parseModelResult('Research｜GitHub skills discovery｜published 0.1.1', '0310'),
    '0310｜Research｜GitHub skills discovery｜published 0.1.1',
  );
  assert.equal(
    parseModelResult('Research｜GitHub skills discovery', '0310'),
    '0310｜Research｜GitHub skills discovery',
  );
  assert.equal(
    parseModelResult(
      'Research｜GitHub skills discovery｜this progress text is way longer than sixteen chars',
      '0310',
    ),
    '0310｜Research｜GitHub skills discovery｜this progress te',
  );
  assert.equal(parseModelResult('just guessing', '0310'), null);
});

test('renders custom name formats', () => {
  assert.equal(
    parseModelResult(
      'Fix｜OAuth callback errors｜testing',
      '0310',
      '{type}: {topic} ({progress})',
    ),
    'Fix: OAuth callback errors (testing)',
  );
  assert.equal(
    parseModelResult(
      'Fix｜Callback errors｜awaiting review',
      '0310',
      '{date}｜{type}｜{topic}',
    ),
    '0310｜Fix｜Callback errors',
  );
  assert.equal(
    parseModelResult('Fix｜Login bug', '0310', '{date}｜{type}｜{topic}'),
    '0310｜Fix｜Login bug',
  );
});

test('parses model segments for diff-based change detection', () => {
  const a = parseModelSegments('Fix｜OAuth callback errors｜published 0.1.1', true);
  const b = parseModelSegments('Fix｜OAuth callback errors｜published 0.2.0', true);
  const c = parseModelSegments('Research｜GitHub skills discovery', true);
  assert.deepEqual(a, {
    type: 'Fix',
    topic: 'OAuth callback errors',
    progress: 'published 0.1.1',
  });
  assert.deepEqual(b, {
    type: 'Fix',
    topic: 'OAuth callback errors',
    progress: 'published 0.2.0',
  });
  assert.deepEqual(c, {
    type: 'Research',
    topic: 'GitHub skills discovery',
    progress: undefined,
  });
  if (typeof a === 'object' && typeof b === 'object' && typeof c === 'object') {
    assert.equal(a.type !== c.type || a.topic !== c.topic, true);
    assert.equal(
      a.type === b.type && a.topic === b.topic && a.progress !== b.progress,
      true,
    );
  }
  assert.equal(parseModelSegments('SKIP', true), 'SKIP');
  assert.equal(parseModelSegments('', true), 'EMPTY');
  assert.equal(parseModelSegments('just guessing', true), null);
});

test('manual refresh tells the model to always produce a name', () => {
  const manual = buildOutputRule(true, true);
  assert.ok(manual.includes('Never output SKIP'));
  assert.ok(manual.includes('"Type｜Topic｜Progress"'));
  const automatic = buildOutputRule(false, false);
  assert.ok(automatic.includes('SKIP only if there is no clear task'));
  assert.ok(automatic.includes('"Type｜Topic"'));
});

test('explains each miss reason instead of blaming context', () => {
  assert.match(missMessage('NO_CONTEXT'), /no conversation content/i);
  assert.match(missMessage('EMPTY'), /returned no text/i);
  assert.match(missMessage('SKIP'), /add an instruction/i);
  assert.match(
    missMessage('ERROR', 'Provider finish_reason: content_filter'),
    /content_filter/,
  );
  assert.match(missMessage('ERROR'), /failed/i);
  assert.match(missMessage(null), /No valid session name/);
});

test('surfaces provider errors instead of calling them an empty response', () => {
  assert.equal(responseError({ stopReason: 'stop' }), undefined);
  assert.equal(
    responseError({ stopReason: 'error', errorMessage: ' 429 too many requests \n' }),
    '429 too many requests',
  );
  assert.match(responseError({ stopReason: 'error' }) ?? '', /error/);
  assert.match(responseError({ stopReason: 'aborted' }) ?? '', /aborted/);
  const long = 'x'.repeat(MAX_ERROR_LENGTH + 50);
  assert.equal(
    responseError({ stopReason: 'error', errorMessage: long })?.length,
    MAX_ERROR_LENGTH,
  );
});

test('parses refresh command arguments', () => {
  assert.deepEqual(parseRefreshArgs(''), { force: false });
  assert.deepEqual(parseRefreshArgs('   '), { force: false });
  assert.deepEqual(parseRefreshArgs('force'), { force: true });
  assert.deepEqual(parseRefreshArgs('FORCE'), { force: true });
  assert.deepEqual(parseRefreshArgs('force:'), { force: true });
  assert.deepEqual(parseRefreshArgs('force write the type in French'), {
    force: true,
    hint: 'write the type in French',
  });
  assert.deepEqual(parseRefreshArgs('force: use English'), {
    force: true,
    hint: 'use English',
  });
  // Any other text also forces a re-evaluation and becomes the hint.
  assert.deepEqual(parseRefreshArgs('do not use file names'), {
    force: true,
    hint: 'do not use file names',
  });
  // "forces" is not the keyword, so the whole text is the requirement.
  assert.deepEqual(parseRefreshArgs('forces x'), { force: true, hint: 'forces x' });
  assert.deepEqual(parseRefreshArgs('force\n  type  in\nFrench'), {
    force: true,
    hint: 'type in French',
  });
  assert.equal(parseRefreshArgs(`force ${'x'.repeat(300)}`).hint?.length, 200);
});

test('builds a force context line without feeding back the old segments', () => {
  const segments = { type: 'Fix', topic: 'OAuth callback errors', progress: 'testing' };
  const forced = buildContextLine(
    true,
    segments,
    '0310｜Fix｜OAuth callback errors｜testing',
  );
  assert.ok(forced.includes('forced re-evaluation'));
  assert.ok(!forced.includes('reuse them EXACTLY'));
  // A forced re-evaluation must not show the old wording at all: the model copies
  // what it sees, which is how a wrong first name used to survive a refresh.
  assert.ok(!forced.includes('OAuth callback errors'));
  assert.ok(!forced.includes('0310｜'));
  const reused = buildContextLine(false, segments, 'ignored');
  assert.ok(reused.includes('reuse them EXACTLY'));
  assert.ok(reused.includes('Fix｜OAuth callback errors'));
  assert.ok(
    buildContextLine(false, undefined, '0310｜Fix｜OAuth callback errors').startsWith(
      'Current name:',
    ),
  );
});

test('builds the reuse and hint rules', () => {
  assert.ok(buildReuseRule(true, true).includes('from scratch'));
  assert.ok(buildReuseRule(true, false).includes('from scratch'));
  assert.ok(buildReuseRule(false, true).includes('only the progress may change'));
  assert.ok(buildReuseRule(false, false).includes('output them EXACTLY as written'));
  assert.equal(buildHintRule(), '');
  assert.ok(buildHintRule('write the type in French').includes('highest priority'));
  assert.ok(
    buildHintRule('write the type in French').includes('write the type in French'),
  );
});

test('parseSnArgs picks the subcommand and keeps the rest as its argument', () => {
  assert.deepEqual(parseSnArgs('refresh force write in French'), {
    command: 'refresh',
    rest: 'force write in French',
  });
  assert.deepEqual(parseSnArgs('  LOCK '), { command: 'lock', rest: '' });
  assert.equal(parseSnArgs('').command, undefined);
  assert.equal(parseSnArgs('bogus x').command, undefined);
});
