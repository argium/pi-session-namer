import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_CONFIG, loadConfig, parseConfig } from '../src/config.ts';

const scratch = mkdtempSync(join(tmpdir(), 'session-namer-config-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

test('parseConfig keeps valid values and trims type names', () => {
  const config = parseConfig({
    model: 'anthropic/claude',
    thinkingLevel: 'high',
    timeZone: 'Australia/Sydney',
    checkEveryTurns: 0,
    nameFormat: '{type}: {topic}',
    types: [' Fix ', 'Feature'],
    nameLanguage: 'en',
  });
  assert.deepEqual(config, {
    model: 'anthropic/claude',
    thinkingLevel: 'high',
    timeZone: 'Australia/Sydney',
    checkEveryTurns: 0,
    nameFormat: '{type}: {topic}',
    types: ['Fix', 'Feature'],
    nameLanguage: 'en',
  });
});

test('parseConfig replaces each invalid field with its default', () => {
  const config = parseConfig({
    model: '',
    thinkingLevel: 'extreme',
    checkEveryTurns: -1,
    nameFormat: 'no placeholders',
    types: ['Fix', ''],
    nameLanguage: 7,
  });
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.deepEqual(parseConfig({ checkEveryTurns: 2.5 }), DEFAULT_CONFIG);
  assert.deepEqual(parseConfig(null), DEFAULT_CONFIG);
});

test('loadConfig creates the default file once and never overwrites it', () => {
  const path = join(scratch, 'nested', 'session-namer.json');
  assert.deepEqual(loadConfig(path), { config: DEFAULT_CONFIG });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), DEFAULT_CONFIG);

  writeFileSync(path, JSON.stringify({ checkEveryTurns: 9 }));
  assert.equal(loadConfig(path).config.checkEveryTurns, 9);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { checkEveryTurns: 9 });
});

test('loadConfig falls back to the defaults and warns when the file is not valid JSON', () => {
  const path = join(scratch, 'broken.json');
  writeFileSync(path, '{ not json');
  const { config, warning } = loadConfig(path);
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.match(warning ?? '', /broken\.json/);
});
