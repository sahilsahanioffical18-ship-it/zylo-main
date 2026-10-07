const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createLog } = require('../lib/log');

// Every console method the logger writes through, mocked silent for one test.
const watchConsole = (t) => ({
  log: t.mock.method(console, 'log', () => {}),
  warn: t.mock.method(console, 'warn', () => {}),
  error: t.mock.method(console, 'error', () => {}),
});
const argsOf = (mock) => mock.mock.calls.map((call) => call.arguments);

test('JSON mode writes one parseable line per call: time, level, msg, then base and fields', (t) => {
  const out = watchConsole(t);
  const log = createLog({ json: true, base: { serverId: 'server-1' } });
  log.info('meeting ended', { meetingId: 'abc-defg-hij', reason: 'host' });
  log.base.serverId = 'server-2'; // server.js adds its id once it has one: read on every line
  log.warn('Redis reconnected.');
  log.error('join failed', { meetingId: 'abc-defg-hij', userId: 'p1', event: undefined, extra: null, err: 'redis hiccup' });
  const lines = [out.log, out.warn, out.error].map((mock) => {
    assert.equal(mock.mock.callCount(), 1);
    const [raw, ...more] = mock.mock.calls[0].arguments;
    assert.deepEqual(more, [], 'one string per call');
    assert.ok(!raw.includes('\n'), 'one line');
    return JSON.parse(raw);
  });
  for (const line of lines) {
    assert.deepEqual(Object.keys(line).slice(0, 3), ['time', 'level', 'msg']);
    assert.equal(new Date(line.time).toISOString(), line.time, 'ISO 8601');
  }
  assert.deepEqual(
    lines.map(({ time, ...rest }) => rest),
    [
      { level: 'info', msg: 'meeting ended', serverId: 'server-1', meetingId: 'abc-defg-hij', reason: 'host' },
      { level: 'warn', msg: 'Redis reconnected.', serverId: 'server-2' },
      { level: 'error', msg: 'join failed', serverId: 'server-2', meetingId: 'abc-defg-hij', userId: 'p1', err: 'redis hiccup' },
    ],
  );
});

test('text mode prints what the server always printed: msg, an error as "msg: message", then fields as key=value', (t) => {
  const out = watchConsole(t);
  const log = createLog({ json: false, base: { serverId: 'server-1' } });
  log.info('meeting ended', { meetingId: 'abc-defg-hij', reason: 'host' });
  log.warn('WARNING: REDIS_URL is not set.');
  log.error('chat history failed', { meetingId: 'abc-defg-hij', userId: undefined, err: 'redis hiccup' });
  log.error('room sweep failed', { err: 'redis hiccup' });
  assert.deepEqual(argsOf(out.log), [['meeting ended', 'meetingId=abc-defg-hij', 'reason=host']]);
  assert.deepEqual(argsOf(out.warn), [['WARNING: REDIS_URL is not set.']]);
  assert.deepEqual(argsOf(out.error), [
    ['chat history failed:', 'redis hiccup', 'meetingId=abc-defg-hij'],
    ['room sweep failed:', 'redis hiccup'],
  ]);
});

// The default instance reads NODE_ENV when lib/log.js loads, so each case is its own process.
function logWithNodeEnv(nodeEnv) {
  const script = "const { log } = require('./lib/log'); log.info('hello', { port: 4000 }); log.warn('careful');";
  const run = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_ENV: nodeEnv },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return run;
}

test('the default instance follows NODE_ENV: JSON in production (info on stdout, warn on stderr), text otherwise', () => {
  const prod = logWithNodeEnv('production');
  const info = JSON.parse(prod.stdout);
  const warn = JSON.parse(prod.stderr);
  assert.deepEqual([info.level, info.msg, info.port], ['info', 'hello', 4000]);
  assert.deepEqual([warn.level, warn.msg], ['warn', 'careful']);
  const dev = logWithNodeEnv('development');
  assert.equal(dev.stdout, 'hello port=4000\n');
  assert.equal(dev.stderr, 'careful\n');
});
