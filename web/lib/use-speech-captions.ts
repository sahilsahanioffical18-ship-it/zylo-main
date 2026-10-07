'use client';

// SpeechRecognition for Zylo Translator Convo: turns *my* speech into interim/final
// text. Verified live, not unit-tested (see the plan) — the logic that can be wrong
// (end/restart policy, echo detection) lives in speech-policy.ts, which is tested.

import { useEffect, useRef, useState } from 'react';
import { canRecognizeTrack, recognitionCtor, speechSupport } from '@/lib/convo-support';
import { joinTranscripts, onRecognitionEnd } from '@/lib/speech-policy';

export type CaptionListenState = {
  status: 'off' | 'starting' | 'listening' | 'unsupported' | 'blocked';
  mode: 'on-device' | 'cloud' | null;
  notice: string | null;
};

const OFF: CaptionListenState = { status: 'off', mode: null, notice: null };
const UNSUPPORTED: CaptionListenState = { status: 'unsupported', mode: null, notice: null };

// Interim results are throttled to at most one onInterim call per id every 250ms,
// with a trailing call so the very last (most complete) interim is never dropped.
const INTERIM_THROTTLE_MS = 250;

// The echo guard stops and restarts recognition around every spoken translation;
// re-probing each time cost up to PROBE_TIMEOUT_MS of dead captions where the probe
// hangs. ponytail: per page load, so installing a language pack mid-convo is only
// picked up after a reload.
const supportByTag = new Map<string, ReturnType<typeof speechSupport>>();

type Throttle = { lastCall: number; timer: ReturnType<typeof setTimeout> | null };

export function useSpeechCaptions(opts: {
  enabled: boolean;
  sttTag: string;
  track: MediaStreamTrack | null;
  onInterim: (id: string, text: string) => void;
  onFinal: (id: string, text: string) => void;
}): CaptionListenState {
  const { enabled, sttTag, track } = opts;
  const [state, setState] = useState<CaptionListenState>(OFF);

  // Read inside recognition event listeners and restart timers, so those closures
  // (registered once per effect run, below) never see a stale onInterim/onFinal —
  // same no-dependency-array idiom as use-livekit-room.ts's prefsRef.
  const onInterimRef = useRef(opts.onInterim);
  const onFinalRef = useRef(opts.onFinal);
  const enabledRef = useRef(enabled);
  const trackRef = useRef(track);
  useEffect(() => {
    onInterimRef.current = opts.onInterim;
    onFinalRef.current = opts.onFinal;
    enabledRef.current = enabled;
    trackRef.current = track;
  });

  useEffect(() => {
    let cancelled = false;

    // No constructor: nothing else happens, on any browser or OS. Checked before
    // `enabled` on purpose — a Firefox user should see "unsupported" (type instead)
    // even before turning their mic on, not a plain "off".
    const ctor = recognitionCtor(window) as SpeechRecognitionStatic | null;
    if (!ctor) {
      Promise.resolve().then(() => {
        if (!cancelled) setState(UNSUPPORTED);
      });
      return () => {
        cancelled = true;
      };
    }
    if (!enabled) {
      Promise.resolve().then(() => {
        if (!cancelled) setState(OFF);
      });
      return () => {
        cancelled = true;
      };
    }

    // Deferred (matches the codebase's other effect-body resets): shows 'starting'
    // right away instead of leaving a stale status from a previous tag/track.
    Promise.resolve().then(() => {
      if (!cancelled) setState({ status: 'starting', mode: null, notice: null });
    });

    let recognition: SpeechRecognition | null = null;
    let restartTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let resultIds = new Map<number, string>();
    // Ids already sent as final this session: Android Chrome can re-deliver old
    // finals, which would caption (and speak) the same sentence twice.
    let finalIds = new Set<string>();
    // The interim still waiting for its final. Chrome only finalizes after a pause,
    // and a stop (mic muted, the partner's translation starting to play, a restart)
    // drops it — so whatever was said is promoted to a final instead of vanishing.
    let pending: { id: string; text: string } | null = null;
    const throttles = new Map<string, Throttle>();

    function emitFinal(id: string, text: string) {
      if (pending?.id === id) pending = null;
      if (finalIds.has(id)) return;
      finalIds.add(id);
      clearThrottle(id);
      onFinalRef.current(id, text);
    }

    function promotePending() {
      if (pending) emitFinal(pending.id, pending.text);
    }

    function clearThrottle(id: string) {
      const entry = throttles.get(id);
      if (entry?.timer) clearTimeout(entry.timer);
      throttles.delete(id);
    }

    function clearAllThrottles() {
      for (const entry of throttles.values()) if (entry.timer) clearTimeout(entry.timer);
      throttles.clear();
    }

    // Leading call if idle for 250ms, otherwise reschedules a trailing call that
    // always closes over the latest text passed in — every call cancels the
    // previous timer, so whichever call is last before it fires wins.
    function emitInterim(id: string, text: string) {
      const now = Date.now();
      const entry = throttles.get(id);
      if (entry?.timer) clearTimeout(entry.timer);
      if (!entry || now - entry.lastCall >= INTERIM_THROTTLE_MS) {
        throttles.set(id, { lastCall: now, timer: null });
        onInterimRef.current(id, text);
        return;
      }
      const delay = INTERIM_THROTTLE_MS - (now - entry.lastCall);
      const timer = setTimeout(() => {
        throttles.set(id, { lastCall: Date.now(), timer: null });
        onInterimRef.current(id, text);
      }, delay);
      throttles.set(id, { lastCall: entry.lastCall, timer });
    }

    // Each result INDEX gets one id for its whole life (interim updates, then its
    // final) — reset per start() so ids never leak across a restarted session.
    function idFor(index: number): string {
      let id = resultIds.get(index);
      if (!id) {
        id = `${Date.now().toString(36)}-${index}`;
        resultIds.set(index, id);
      }
      return id;
    }

    function beginStart() {
      if (cancelled || !recognition) return;
      resultIds = new Map();
      finalIds = new Set();
      if (trackRef.current && canRecognizeTrack(window)) {
        try {
          recognition.start(trackRef.current);
          return;
        } catch {
          // Heuristic capability check (see canRecognizeTrack's own ponytail note) —
          // fall through to the trackless start below.
        }
      }
      try {
        recognition.start();
      } catch {
        // Already running, or the device just vanished. If a session was mid-flight
        // this is a no-op; otherwise onerror/onend never fires and there's nothing
        // more to safely do here without risking a duplicate-start throw loop.
      }
    }

    (async () => {
      let probe = supportByTag.get(sttTag);
      if (!probe) supportByTag.set(sttTag, (probe = speechSupport(window, sttTag))); // bounded: PROBE_TIMEOUT_MS
      const support = await probe;
      if (cancelled) return;
      const mode: 'on-device' | 'cloud' = support === 'on-device' ? 'on-device' : 'cloud';

      recognition = new ctor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = sttTag;
      if (mode === 'on-device') recognition.processLocally = true;

      let lastError: string | null = null;

      recognition.onresult = (event) => {
        // Chrome often splits the in-progress speech across several non-final
        // results (a stable head plus an unstable tail) and later finalizes them as
        // ONE result at the first index. So every non-final result is joined into a
        // single interim keyed to the first non-final index — per-index ids would
        // leave the tail behind as an orphan interim line that never finalizes.
        let interimIndex = -1;
        const interimParts: string[] = [];
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const transcript = result[0]?.transcript ?? '';
          if (result.isFinal) {
            const text = transcript.trim();
            if (text) emitFinal(idFor(i), text);
          } else {
            if (interimIndex < 0) interimIndex = i;
            interimParts.push(transcript);
          }
        }
        const interimText = joinTranscripts(interimParts);
        if (interimIndex >= 0 && interimText) {
          pending = { id: idFor(interimIndex), text: interimText };
          emitInterim(pending.id, interimText);
        }
        // A result — final or interim — proves this session is actually working:
        // clear the retry count and any "reconnecting" notice from an earlier hiccup.
        attempt = 0;
        setState({ status: 'listening', mode, notice: null });
      };
      recognition.onerror = (event) => {
        lastError = event.error;
      };
      recognition.onstart = () => {
        setState((s) => ({ status: 'listening', mode, notice: s.notice }));
      };
      recognition.onend = () => {
        promotePending();
        clearAllThrottles();
        const reason = lastError ?? 'end';
        lastError = null;
        const decision = onRecognitionEnd(reason, attempt);
        if (!decision.restart) {
          setState({ status: 'blocked', mode, notice: decision.notice });
          return;
        }
        // Only a backed-off restart counts as an "attempt" — a clean, immediate
        // restart (no-speech/aborted/end) isn't a failure and shouldn't escalate it.
        if (decision.delayMs > 0) attempt += 1;
        setState((s) => ({ status: 'starting', mode, notice: decision.notice ?? s.notice }));
        if (!enabledRef.current || cancelled) return;
        restartTimer = setTimeout(beginStart, decision.delayMs);
      };

      if (cancelled) return;
      beginStart();
    })();

    return () => {
      cancelled = true;
      if (restartTimer) clearTimeout(restartTimer);
      promotePending();
      clearAllThrottles();
      // Handlers nulled BEFORE abort(): abort() dispatches its own 'end' event, and
      // a stale onend firing after cleanup could otherwise schedule a zombie restart.
      if (recognition) {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        recognition.onstart = null;
        recognition.abort();
      }
    };
  }, [enabled, sttTag, track]);

  return state;
}
