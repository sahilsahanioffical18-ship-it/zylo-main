'use client';

import { useEffect, useState } from 'react';
import { isSubtitleStale, type CaptionLine } from '@/lib/caption-feed';

// Re-checks staleness once a second — the line itself doesn't change while the
// partner stays quiet, so nothing else would ever re-render this to hide it.
const STALE_CHECK_MS = 1000;

/**
 * The partner's latest caption, floating over the bottom of the video stage.
 * Shows their translation (in `myLang`) large, with the original small and muted
 * underneath; falls back to the original alone (with a "translating…" hint) until
 * a translation arrives. Renders nothing once there's no line, or it's gone stale
 * (caption-feed.ts's isSubtitleStale — the partner went quiet).
 */
export function SubtitleOverlay({ line, myLang }: { line: CaptionLine | undefined; myLang: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!line) return;
    const id = setInterval(() => setNow(Date.now()), STALE_CHECK_MS);
    return () => clearInterval(id);
  }, [line]);

  const visible = line && !isSubtitleStale(line.ts, now) ? line : undefined;
  const translation = visible?.translations[myLang];

  // The live region is always mounted (one mounted along with its first text isn't
  // announced by most screen readers); aria-busy holds an interim back until its
  // final, so a reader hears each sentence once instead of every 250ms revision.
  return (
    <div
      aria-live="polite"
      aria-busy={visible ? !visible.final : false}
      className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-3"
    >
      {visible && (
        <div className="flex min-h-[4.5rem] w-full max-w-3xl flex-col items-center justify-center gap-1 rounded-xl bg-background/85 px-4 py-3 text-center shadow-lg">
          <p lang={translation ? myLang : visible.lang} dir="auto" className="text-lg font-semibold text-balance sm:text-xl">
            {translation ?? visible.text}
            {!translation && !visible.final && <span className="ml-1 text-sm font-normal text-muted-foreground">translating…</span>}
          </p>
          {translation && (
            <p lang={visible.lang} dir="auto" className="text-sm text-balance text-muted-foreground">
              {visible.text}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
