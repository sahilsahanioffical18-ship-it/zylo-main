// Each meeting's last 20 ZyloChat lines, the context Zylo AI answers from. A plain
// Redis list beside the room keys and deliberately outside the room scripts: they all
// take exactly the 7 room keys, and this list needs none of their atomicity. Unlike the
// room keys it has a TTL, because it is disposable context: if volatile-lru evicts it
// under memory pressure, the AI just sees less. The {code} braces put it in the same
// Redis Cluster slot as the room's keys.

const MAX_ENTRIES = 20;
const TTL_SECONDS = 6 * 60 * 60;

const keyOf = (code) => `zylo:chat:{${code}}`;

function createChatHistory(redis) {
  return {
    // One MULTI: append, keep the last 20, restart the 6 h clock.
    async add(code, { name, text, ai = false }) {
      const key = keyOf(code);
      await redis.multi().rpush(key, JSON.stringify({ name, text, ai })).ltrim(key, -MAX_ENTRIES, -1).expire(key, TTL_SECONDS).exec();
    },
    // Oldest first.
    async recent(code) {
      return (await redis.lrange(keyOf(code), 0, -1)).map((raw) => JSON.parse(raw));
    },
    async clear(code) {
      await redis.del(keyOf(code));
    },
  };
}

module.exports = { createChatHistory };
