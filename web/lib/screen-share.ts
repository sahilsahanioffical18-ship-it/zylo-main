// ZyloLive decisions that can be wrong, free of React and LiveKit so node --test can
// run them. Zero local imports (tsconfig: bundler resolution, tests import ./x.ts):
// the brand name arrives as `live`.

export type ScreenDenial = { reason: 'busy'; sharerName: string } | { reason: 'host_only' } | { reason: 'unavailable' };
export type StageView =
  | { mode: 'grid' }
  | { mode: 'presenting'; sharerUserId: string; sharerName: string; isSelf: boolean };

export function stageView(sharerUserId: string | null, selfUserId: string, people: { userId: string; name: string }[]): StageView {
  if (!sharerUserId) return { mode: 'grid' };
  const sharer = people.find((p) => p.userId === sharerUserId);
  // screen:state and room:presence are separate broadcasts, so the lock can briefly
  // name someone the roster no longer has. A banner naming nobody is worse than one
  // frame of grid.
  if (!sharer) return { mode: 'grid' };
  return { mode: 'presenting', sharerUserId, sharerName: sharer.name, isSelf: sharerUserId === selfUserId };
}

export function presentingBanner(view: Extract<StageView, { mode: 'presenting' }>, live: string): string {
  return view.isSelf ? `${live} · You are presenting` : `${live} · ${view.sharerName} is presenting`;
}

export function screenDeniedMessage(denial: ScreenDenial, live: string): string {
  if (denial.reason === 'busy') return `${live} is in use by ${denial.sharerName}`;
  if (denial.reason === 'host_only') return `Only the host can use ${live}`;
  return `${live} couldn’t start. Try again in a moment.`;
}

// Phones have no getDisplayMedia, so a button that can only fail is worse than no button.
export function canShareScreen(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

export function screenStartErrorMessage(err: unknown, live: string): string {
  const name = typeof err === 'object' && err !== null && 'name' in err ? err.name : undefined;
  // Chrome raises NotAllowedError both for "closed the picker" and for the OS
  // refusing screen recording (macOS), so one line serves both.
  if (name === 'NotAllowedError') {
    return `${live} didn’t start. If you picked a screen, allow screen recording for your browser in your system settings.`;
  }
  // livekit-client throws DeviceUnsupportedError where getDisplayMedia is missing (phones).
  if (name === 'DeviceUnsupportedError' || name === 'NotSupportedError') return `${live} isn’t available in this browser.`;
  return `${live} couldn’t share your screen. Try again.`;
}
