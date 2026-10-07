export type HostAction = 'mute' | 'stop-share' | 'kick';

/** The host's ⋯ menu for one People row. What to OFFER only: the server re-checks every host:* event. */
export function hostActionsFor(
  person: { userId: string; micMuted: boolean },
  viewer: { isHost: boolean; selfUserId: string; sharerUserId: string | null },
): HostAction[] {
  if (!viewer.isHost || person.userId === viewer.selfUserId) return [];
  const actions: HostAction[] = [];
  if (!person.micMuted) actions.push('mute');
  if (viewer.sharerUserId === person.userId) actions.push('stop-share');
  actions.push('kick');
  return actions;
}
