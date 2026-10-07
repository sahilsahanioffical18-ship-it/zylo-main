// Twin of web/lib/chat-rules.ts — keep the limit and trim-then-measure order identical
// on both sides, or the composer's disabled state stops matching the server's silent drop.
//
// This is the only size guard on the socket chat path: express.json({ limit: '32kb' })
// does not apply to Socket.IO, whose maxHttpBufferSize defaults to 1 MB.

const MAX_CHAT_LENGTH = 2000;

function validateChatText(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  // ponytail: .length counts UTF-16 code units, so an emoji costs two. Switch to
  // [...trimmed].length if anyone complains.
  if (trimmed.length > MAX_CHAT_LENGTH) return null;
  return trimmed;
}

module.exports = { MAX_CHAT_LENGTH, validateChatText };
