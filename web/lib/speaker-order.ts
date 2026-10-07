export const LIVE_VIDEO_LIMIT = 5;

/** Moves `identities` to the front, keeping everyone else in their relative order. */
export function promote(order: string[], identities: string[]): string[] {
  const promoted = new Set(identities);
  const rest = order.filter((id) => !promoted.has(id));
  return [...promoted, ...rest];
}

// ponytail: no `forget` — order only ever grows, ceiling is the number of distinct
// people ever in the room (<=20 in practice). Add pruning if that stops being true.

/** Appends an identity we have not seen at the back. Idempotent. */
export function seen(order: string[], identity: string): string[] {
  if (order.includes(identity)) return order;
  return [...order, identity];
}

/**
 * The identities that get live video: the first `limit` of `order` that are actually
 * present. Filtering against `present` before slicing (not after) matters twice over:
 * a departed identity never consumes a slot, and the local participant — who is never
 * in `present` (room.remoteParticipants.keys()) — can't eat a remote slot by speaking.
 */
export function videoIdentities(order: string[], present: Iterable<string>, limit: number = LIVE_VIDEO_LIMIT): Set<string> {
  const presentSet = present instanceof Set ? present : new Set(present);
  const result = new Set<string>();
  for (const id of order) {
    if (result.size >= limit) break;
    if (presentSet.has(id)) result.add(id);
  }
  return result;
}
