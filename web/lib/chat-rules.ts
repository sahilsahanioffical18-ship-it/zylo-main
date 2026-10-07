// Twin of server/lib/chatRules.js — keep the limit and trim-then-measure order identical
// on both sides, or the composer's disabled state stops matching the server's silent drop.
// Duplicated rather than shared: the server is CommonJS, this is TS, and there is no
// workspace to share a four-line function through.

export const MAX_CHAT_LENGTH = 2000;

export function validateChatText(text: string): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  // ponytail: .length counts UTF-16 code units, so an emoji costs two. Switch to
  // [...trimmed].length if anyone complains.
  if (trimmed.length > MAX_CHAT_LENGTH) return null;
  return trimmed;
}
