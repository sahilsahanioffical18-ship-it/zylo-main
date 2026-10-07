export function mediaErrorMessage(err: unknown, productName: string, context: 'prejoin' | 'room' = 'prejoin'): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError') return 'Camera and microphone are blocked. Allow them in your browser’s site settings, then reload.';
  if (name === 'NotFoundError') {
    // In-room, the user is already past "join" — telling them they can still do
    // it again is nonsense, so drop that clause for context: 'room'.
    return context === 'room'
      ? 'No camera or microphone found.'
      : 'No camera or microphone found. You can still join with them off.';
  }
  if (name === 'NotReadableError') return 'Your camera or microphone is in use by another app.';
  // In-room, we're already on the page that's making this call — the HTTPS/localhost
  // hint (written for the pre-join screen, where the browser hasn't granted camera
  // access at all yet) would tell someone on a working secure connection to go open
  // the page they're already looking at.
  if (context === 'room') return 'Your camera or microphone couldn’t be started.';
  return `This browser can’t use a camera on this page. Open ${productName} over HTTPS or on localhost.`;
}
