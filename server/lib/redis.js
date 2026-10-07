const Redis = require('ioredis');
const { log: defaultLog } = require('./log');

// The one Redis connection. While Redis is down, commands fail at once (no offline
// queue, one try, a 500 ms timeout; socketTimeout cuts a hung connection after 1 s)
// so every caller falls back immediately instead of hanging; the client keeps
// reconnecting in the background, backing off to 5 s.
// ponytail: one log line per outage and one per recovery, never per command. Add a
// metric if you ever need to know how often it happens.
function createRedis(url = process.env.REDIS_URL, { log = defaultLog } = {}) {
  if (!url) return null;
  const redis = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 500,
    socketTimeout: 1000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  });
  let down = false;
  redis.on('error', (err) => {
    if (down) return;
    down = true;
    log.warn(`Redis unavailable (${err.message || err.code}). Falling back until it returns.`);
  });
  redis.on('ready', () => {
    if (!down) return;
    down = false;
    log.warn('Redis reconnected.');
  });
  return redis;
}

// Resolves once the connection is usable, rejects if it ends or is still not ready
// after timeoutMs. The client retries forever and never ends on its own, so without
// the timeout a down Redis would leave callers (tests, a must-not-start-degraded
// boot) waiting for good. With no offline queue a command sent before ready rejects.
function whenReady(redis, { timeoutMs = 3000 } = {}) {
  if (redis.status === 'ready') return Promise.resolve();
  if (redis.status === 'end') return Promise.reject(new Error('Redis connection has ended'));
  return new Promise((resolve, reject) => {
    const done = (settle, arg) => {
      clearTimeout(timer);
      redis.off('ready', onReady);
      redis.off('end', onEnd);
      settle(arg);
    };
    const onReady = () => done(resolve);
    const onEnd = () => done(reject, new Error('Redis connection ended before it was ready'));
    const timer = setTimeout(
      () => done(reject, new Error(`Redis is not reachable after ${timeoutMs} ms. Is it running? Try: npm run db:up`)),
      timeoutMs,
    );
    redis.on('ready', onReady);
    redis.on('end', onEnd);
  });
}

module.exports = { createRedis, whenReady };
