'use client';

// The spoken-translation queue for Zylo Translator Convo: speaks finished
// translations in order, with the device's own voice (speechSynthesis) when it has
// one for the language, otherwise Google's voice through our server (/api/tts).
// Verified live, not unit-tested (see the plan) — ordering/pacing decisions live in
// speech-queue.ts and the voice choice in convo-support.ts (voicePlan), both tested.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { SERVER_URL } from '@/lib/api';
import { voicePlan, type VoicePlan } from '@/lib/convo-support';
import { nextToSpeak, splitForSpeech, speechRate, type Pending } from '@/lib/speech-queue';
import { createLru } from '@/lib/translate-chain';

const CLOUD_PIECE_MAX = 180; // /api/tts takes up to 200 characters
const CLOUD_FETCH_TIMEOUT_MS = 8000; // the server itself gives Google 5s
// 10ms of silence, played inside the Join click so Safari lets this element play later.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';

// One element for every online clip: Safari/iOS unlock playback per element, and
// the Join click unlocks this one (unlockSpeech) before any hook exists.
// ponytail: shared by every queue on the page, so two queues playing at once (only
// possible on the device-check page, checklist + loopback) cut each other off and
// the watchdog moves the loser on. One element per queue if a page ever needs two.
let sharedAudio: HTMLAudioElement | null = null;
function cloudAudio(): HTMLAudioElement {
  sharedAudio ??= new Audio();
  return sharedAudio;
}

// Online clips already fetched on this page (the server caches too; this skips the
// round trip). Blobs, not object URLs: an evicted Blob is simply garbage-collected.
const clipCache = createLru<Blob>(50);

// speechSynthesis and media playback grant a user-gesture unlock per page, not per
// hook instance, so this has to be callable before useSpeechOutput (and its
// enclosing meeting) even exists — see the Join click in meeting-room-flow.tsx.
export function unlockSpeech(): void {
  if (typeof window === 'undefined') return;
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance('');
    utter.volume = 0;
    window.speechSynthesis.speak(utter);
  }
  const audio = cloudAudio();
  audio.src = SILENT_WAV;
  audio.play().catch(() => {}); // best effort: Chrome and Edge don't need it
}

export function useSpeechOutput(opts: {
  lang: string;
  sttTag: string;
  enabled: boolean;
  /** Called when an utterance actually starts sounding (for the loopback timings). */
  onStart?: (key: string) => void;
}): {
  enqueue: (key: string, text: string | null) => void;
  resolve: (key: string, text: string | null) => void;
  speaking: boolean;
  plan: VoicePlan;
  /** The online voice failed on the last try (fetch or playback); cleared by the next success. */
  voiceError: boolean;
  unlock: () => void;
  recentSpoken: () => readonly { text: string; at: number }[];
  cancelAll: () => void;
} {
  const { lang, sttTag, enabled } = opts;
  const { getToken, isSignedIn } = useAuth();
  const [speaking, setSpeaking] = useState(false);
  const [plan, setPlan] = useState<VoicePlan>({ kind: 'none' });
  const [voiceError, setVoiceError] = useState(false);

  const enabledRef = useRef(enabled);
  const planRef = useRef(plan);
  const langRef = useRef(lang);
  const getTokenRef = useRef(getToken);
  const onStartRef = useRef(opts.onStart);
  const speakingRef = useRef(false);
  const queueRef = useRef<Pending[]>([]);
  const seqRef = useRef(0);
  const recentRef = useRef<{ text: string; at: number }[]>([]);
  // Bumped by cancelAll: a run that was cancelled mid-way (an online clip still
  // downloading, say) must never play, or reset the state of the run after it.
  const runRef = useRef(0);
  // Chrome drops onend for an utterance that gets garbage-collected mid-speech;
  // holding the current one here keeps it alive until it finishes.
  const utterRef = useRef<SpeechSynthesisUtterance | null>(null);
  useEffect(() => {
    enabledRef.current = enabled;
    planRef.current = plan;
    langRef.current = lang;
    getTokenRef.current = getToken;
    onStartRef.current = opts.onStart;
  });

  const cancelAll = useCallback(() => {
    runRef.current += 1;
    queueRef.current = [];
    window.speechSynthesis?.cancel();
    sharedAudio?.pause();
    utterRef.current = null;
    speakingRef.current = false;
    setSpeaking(false);
  }, []);

  // enabled false: drop everything in flight and refuse new work (enqueue below
  // checks enabledRef too, so a call racing this effect can't sneak past it).
  useEffect(() => {
    if (enabled) return;
    // Deferred: reacting to a prop flip with several resets, same idiom as
    // use-meeting.ts's connecting-state reset.
    Promise.resolve().then(() => cancelAll());
  }, [enabled, cancelAll]);

  // Plans the voice immediately, and again whenever the browser's voice list changes
  // (Chrome loads it asynchronously; the first getVoices() is often empty) or the
  // user signs in (the online voice needs a signed-in user).
  useEffect(() => {
    const load = () => setPlan(voicePlan(window, lang, sttTag, Boolean(isSignedIn)));
    load();
    window.speechSynthesis?.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', load);
  }, [lang, sttTag, isSignedIn]);

  useEffect(() => () => cancelAll(), [cancelAll]);

  // pumpRef (not a plain useCallback self-reference) so `finish` below can call
  // "pump again" without referencing the useCallback binding from inside its own
  // initializer — the closure only ever runs later (async), but the linter can't
  // see that, and a ref sidesteps the question entirely.
  const pumpRef = useRef<() => void>(() => {});
  useEffect(() => {
    const fetchClip = async (clipLang: string, text: string): Promise<Blob> => {
      const key = `${clipLang}\n${text}`;
      const cached = clipCache.get(key);
      if (cached) return cached;
      const token = await getTokenRef.current();
      const res = await fetch(`${SERVER_URL}/api/tts?${new URLSearchParams({ lang: clipLang, text })}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(CLOUD_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`tts ${res.status}`);
      const blob = await res.blob();
      clipCache.set(key, blob);
      return blob;
    };

    pumpRef.current = () => {
      if (!enabledRef.current) return;
      const now = Date.now();
      const { speak, drop } = nextToSpeak(queueRef.current, now);
      if (drop.length) queueRef.current = queueRef.current.filter((p) => !drop.includes(p.key));
      if (!speak || speak.text === null || speakingRef.current) return;

      queueRef.current = queueRef.current.filter((p) => p.key !== speak.key);
      const current = planRef.current;
      if (current.kind === 'none') return; // no voice at all: captions only (enqueue refuses too)
      const pieces = splitForSpeech(speak.text, current.kind === 'cloud' ? CLOUD_PIECE_MAX : undefined);
      if (pieces.length === 0) return; // nothing to actually say; leave it for the next pump

      const run = runRef.current;
      speakingRef.current = true;
      setSpeaking(true);
      // Recorded when speaking STARTS, not per piece, so the echo guard's 8s window
      // covers the whole utterance from the moment anything could be heard.
      recentRef.current = [...recentRef.current, { text: speak.text, at: now }].slice(-10);
      const backlog = queueRef.current.filter((p) => p.text !== null).length;
      const rate = speechRate(backlog);

      // A stuck `speaking` is the worst failure here: it also pauses my own
      // captions (use-translator-convo). So every piece has a watchdog, and
      // `finish` runs at most once however end/error/the watchdog race.
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (watchdog) clearTimeout(watchdog);
        if (run !== runRef.current) return; // cancelled: cancelAll already reset everything
        utterRef.current = null;
        speakingRef.current = false;
        setSpeaking(false);
        pumpRef.current();
      };
      // ponytail: ~150ms per character at rate 1 plus 3s of slack is generous for
      // every voice we've seen; if a real voice is slower, it gets cut, not stuck.
      const pieceBudgetMs = (piece: string) => 3000 + (piece.length * 150) / rate;

      if (current.kind === 'cloud') {
        const clipLang = langRef.current;
        // Every piece is requested at once, then they play in order as each is ready.
        const clips = pieces.map((piece) => fetchClip(clipLang, piece));
        clips.forEach((clip) => clip.catch(() => {})); // failures are handled where awaited
        const playPiece = async (index: number) => {
          if (watchdog) clearTimeout(watchdog);
          if (finished) return;
          if (index >= pieces.length) return finish();
          let blob: Blob;
          try {
            blob = await clips[index];
          } catch {
            if (run === runRef.current) setVoiceError(true);
            return finish(); // the caption still shows; this sentence just isn't spoken
          }
          if (finished || run !== runRef.current) return finish();

          const audio = cloudAudio();
          const url = URL.createObjectURL(blob);
          let settled = false;
          const settle = (ok: boolean) => {
            if (settled) return;
            settled = true;
            audio.onended = null;
            audio.onerror = null;
            URL.revokeObjectURL(url);
            if (ok) {
              void playPiece(index + 1);
            } else {
              if (run === runRef.current) setVoiceError(true);
              finish();
            }
          };
          audio.onended = () => settle(true);
          audio.onerror = () => settle(false);
          audio.src = url;
          audio.playbackRate = rate;
          watchdog = setTimeout(() => {
            audio.pause();
            settle(true); // cut, not stuck: move on to the next piece
          }, pieceBudgetMs(pieces[index]));
          try {
            await audio.play();
            if (run === runRef.current) setVoiceError(false);
            if (index === 0) onStartRef.current?.(speak.key);
          } catch {
            settle(false);
          }
        };
        void playPiece(0);
        return;
      }

      const voice = current.voice;
      const speakPiece = (index: number) => {
        if (watchdog) clearTimeout(watchdog);
        if (finished) return;
        if (index >= pieces.length) {
          finish();
          return;
        }
        const utter = new SpeechSynthesisUtterance(pieces[index]);
        utterRef.current = utter;
        // voicePlan narrows the type for testability; at runtime it's the same
        // SpeechSynthesisVoice getVoices() returned.
        utter.voice = voice as unknown as SpeechSynthesisVoice;
        utter.lang = voice.lang;
        utter.rate = rate;
        if (index === 0) utter.onstart = () => onStartRef.current?.(speak.key);
        utter.onend = () => speakPiece(index + 1);
        utter.onerror = finish; // stop the whole utterance early rather than get stuck
        watchdog = setTimeout(() => {
          window.speechSynthesis.cancel();
          finish();
        }, pieceBudgetMs(pieces[index]));
        // ponytail: Chrome sometimes leaves speechSynthesis paused (a known bug after
        // tab visibility changes) with no event to react to; resuming defensively
        // before every utterance is cheaper than tracking Chrome's pause state.
        window.speechSynthesis.resume();
        window.speechSynthesis.speak(utter);
      };
      speakPiece(0);
    };
  }, []);
  const pump = useCallback(() => pumpRef.current(), []);

  // A safety-net poll, mainly for nextToSpeak's 4s wait-timeout to actually get
  // re-checked even when nothing else nudges the queue. ponytail: always-on rather
  // than started/stopped exactly when the queue is non-empty — pump() is a cheap
  // no-op on an empty queue, so the extra polling costs nothing worth guarding.
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(pump, 500);
    return () => clearInterval(id);
  }, [enabled, pump]);

  const enqueue = useCallback(
    (key: string, text: string | null) => {
      if (!enabledRef.current || planRef.current.kind === 'none') return;
      queueRef.current = [...queueRef.current, { key, seq: seqRef.current++, text, at: Date.now() }];
      pump();
    },
    [pump],
  );

  const resolve = useCallback(
    (key: string, text: string | null) => {
      if (text === null) {
        // Give up: drop it now rather than waiting for nextToSpeak's timeout.
        queueRef.current = queueRef.current.filter((p) => p.key !== key);
      } else {
        queueRef.current = queueRef.current.map((p) => (p.key === key ? { ...p, text } : p));
      }
      pump();
    },
    [pump],
  );

  const unlock = useCallback(() => unlockSpeech(), []);
  const recentSpoken = useCallback(() => recentRef.current, []);

  return { enqueue, resolve, speaking, plan, voiceError, unlock, recentSpoken, cancelAll };
}
