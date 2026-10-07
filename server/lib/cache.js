// Spoken-translation clips (MP3 bytes) keyed by language + text, so a phrase
// Google has already voiced ("hello", "thank you", "yes") is served from memory
// instead of fetched again.
//
// createCache is in memory, one process, lost on restart: the fallback when no
// Redis is configured. createRedisCache has the same async get/set, kept in Redis.

const { createHash } = require('node:crypto');

const DAY_MS = 24 * 60 * 60 * 1000;

function createCache({ max = 500, ttlMs = DAY_MS, now = Date.now } = {}) {
  const entries = new Map(); // insertion order = least recently used first

  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      if (entry.expiresAt <= now()) return null;
      entries.set(key, entry); // most recently used again
      return entry.audio;
    },
    async set(key, audio) {
      entries.delete(key);
      entries.set(key, { audio, expiresAt: now() + ttlMs });
      if (entries.size > max) entries.delete(entries.keys().next().value);
    },
  };
}

// The same async get/set, kept in Redis: every API server shares one cache, and it
// survives restarts. Keys are zylo:cache:<kind>:<sha1 of the key>, since a key holds
// up to 500 characters of text. Values come back as bytes (a Buffer); callers that
// stored text call toString(). A Redis error is a miss on get and a no-op on set:
// the cache only ever makes things faster, never breaks them.
const DAY_SECONDS = 24 * 60 * 60;

function createRedisCache(redis, { ttlSeconds = DAY_SECONDS } = {}) {
  const redisKey = (key) => `zylo:cache:${key.split('\n', 1)[0]}:${createHash('sha1').update(key).digest('hex')}`;
  return {
    async get(key) {
      try {
        return await redis.getBuffer(redisKey(key));
      } catch {
        return null;
      }
    },
    async set(key, value) {
      try {
        await redis.set(redisKey(key), value, 'EX', ttlSeconds);
      } catch {
        // The next get is a miss; nothing else to do.
      }
    },
  };
}

module.exports = { createCache, createRedisCache };
