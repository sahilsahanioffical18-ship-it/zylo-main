// Whether a new ZyloChat message should surface as a toast, and how to shorten it for
// one. Free of React and sonner, zero local imports, so node --test can run it alone
// (see host-actions.ts).

export function shouldToast(message: { userId: string }, selfUserId: string, chatVisible: boolean): boolean {
  if (message.userId === selfUserId) return false;
  if (chatVisible) return false;
  return true;
}

// Collapses all whitespace (including newlines) to single spaces and trims. Text
// that already fits in `max` chars comes back unchanged; longer text is cut to
// `max`, then backed up to the last space — but only if that space is past the
// halfway point, or a single long word would hard-cut to nothing — and gets an
// ellipsis appended.
export function toastPreview(text: string, max = 80): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  let cut = collapsed.slice(0, max);
  // Don't leave half an emoji: a trailing high surrogate renders as U+FFFD.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const lastSpace = cut.lastIndexOf(' ');
  const boundary = lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut;
  return `${boundary.trimEnd()}…`;
}
