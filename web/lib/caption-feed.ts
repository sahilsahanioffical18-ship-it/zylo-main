// The transcript reducer for Zylo Translator Convo, meant to be held as React state.
// Zero local imports, free of React and the DOM, so node --test can run it alone.
// Captions are keyed by (userId, utteranceId): an interim result is replaced in
// place by its final, and a translation attaches once it's ready.

export type CaptionEvent = {
  userId: string;
  id: string;
  text: string;
  lang: string;
  final: boolean;
  ts: number;
  translation?: { lang: string; text: string };
};

export type CaptionLine = {
  key: string;
  userId: string;
  id: string;
  text: string;
  lang: string;
  final: boolean;
  ts: number;
  translations: Record<string, string>;
};

export type CaptionFeed = { lines: readonly CaptionLine[] };

export const EMPTY_FEED: CaptionFeed = { lines: [] };

export function captionKey(userId: string, id: string): string {
  return `${userId}:${id}`;
}

function sameTranslations(a: Record<string, string>, b: Record<string, string>): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => a[k] === b[k]);
}

function trimLines(lines: CaptionLine[], max: number): readonly CaptionLine[] {
  return lines.length > max ? lines.slice(lines.length - max) : lines;
}

/**
 * Applies one caption event to the feed. A new key is appended; an existing key is
 * replaced in place (same position, new text). A final is never regressed: an
 * interim that arrives after the final for the same key (events can reorder on
 * reconnect) is dropped. A text change clears old translations, since they were
 * for the old text; an attached translation on the event is kept for the new text.
 * Trims the oldest lines beyond `max`, and returns the same `feed` reference when
 * nothing actually changed, so React can bail out of a re-render.
 */
export function applyCaption(feed: CaptionFeed, ev: CaptionEvent, max = 200): CaptionFeed {
  const key = captionKey(ev.userId, ev.id);
  const idx = feed.lines.findIndex((line) => line.key === key);

  if (idx === -1) {
    const line: CaptionLine = {
      key,
      userId: ev.userId,
      id: ev.id,
      text: ev.text,
      lang: ev.lang,
      final: ev.final,
      ts: ev.ts,
      translations: ev.translation ? { [ev.translation.lang]: ev.translation.text } : {},
    };
    return { lines: trimLines([...feed.lines, line], max) };
  }

  const existing = feed.lines[idx];
  if (existing.final && !ev.final) return feed;

  const textChanged = existing.text !== ev.text;
  const translations = textChanged
    ? ev.translation
      ? { [ev.translation.lang]: ev.translation.text }
      : {}
    : ev.translation
      ? { ...existing.translations, [ev.translation.lang]: ev.translation.text }
      : existing.translations;

  const next: CaptionLine = {
    ...existing,
    text: ev.text,
    lang: ev.lang,
    final: existing.final || ev.final,
    ts: ev.ts,
    translations,
  };

  if (
    next.text === existing.text &&
    next.lang === existing.lang &&
    next.final === existing.final &&
    next.ts === existing.ts &&
    sameTranslations(next.translations, existing.translations)
  ) {
    return feed;
  }

  const lines = feed.lines.slice();
  lines[idx] = next;
  return { lines: trimLines(lines, max) };
}

/**
 * Attaches a translation to the line keyed `key`, but only if it still has exactly
 * `forText` — a slow translation of an older interim must never overwrite a line
 * that has since moved on to newer text.
 */
export function attachTranslation(feed: CaptionFeed, key: string, forText: string, lang: string, text: string): CaptionFeed {
  const idx = feed.lines.findIndex((line) => line.key === key);
  if (idx === -1) return feed;
  const line = feed.lines[idx];
  if (line.text !== forText) return feed;
  if (line.translations[lang] === text) return feed;

  const lines = feed.lines.slice();
  lines[idx] = { ...line, translations: { ...line.translations, [lang]: text } };
  return { lines };
}

/** The most recently timestamped line from that user — the subtitle to show. */
export function latestFor(feed: CaptionFeed, userId: string): CaptionLine | undefined {
  let latest: CaptionLine | undefined;
  for (const line of feed.lines) {
    if (line.userId !== userId) continue;
    if (!latest || line.ts >= latest.ts) latest = line;
  }
  return latest;
}

/** SubtitleOverlay hides a line once it's this old — a partner who's gone quiet
 * shouldn't leave a stale caption glued to the bottom of the stage. */
export const SUBTITLE_STALE_MS = 8000;

/** Whether `ts` is old enough that the subtitle overlay should stop showing it. */
export function isSubtitleStale(ts: number, now: number): boolean {
  return now - ts > SUBTITLE_STALE_MS;
}
