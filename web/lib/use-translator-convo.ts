'use client';

// Ties the Translator Convo pipeline together: my own speech captions, the hybrid
// translation rule, spoken output and the echo guard. Verified live, not
// unit-tested (see the plan) — every decision that could be wrong lives in the pure
// modules the sub-hooks below are built on, all of which have their own tests.

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { applyCaption, attachTranslation, captionKey, EMPTY_FEED, latestFor, type CaptionFeed, type CaptionLine } from '@/lib/caption-feed';
import { languageFor } from '@/lib/convo-languages';
import { isEcho } from '@/lib/speech-policy';
import type { IncomingCaption, OutgoingCaption } from '@/lib/types';
import type { VoicePlan } from '@/lib/convo-support';
import { useConvoTranslation, type PairState } from '@/lib/use-convo-translation';
import type { Person } from '@/lib/use-meeting';
import { useSpeechCaptions, type CaptionListenState } from '@/lib/use-speech-captions';
import { useSpeechOutput } from '@/lib/use-speech-output';
import { splitForSpeech } from '@/lib/speech-queue';

// Held true this long after TTS actually stops, so a partner's "..." trailing
// silence doesn't immediately unpause my own recognition mid-breath.
const SPEAKING_TAIL_MS = 400;
// The server drops a caption over this (captionRules.MAX_CAPTION_LENGTH).
const MAX_CAPTION_LENGTH = 500;

export function useTranslatorConvo({
  enabled,
  selfUserId,
  myLang,
  partner,
  micOn,
  localMicTrack,
  sendCaption,
  captionSink: captionSinkRef, // renamed so the linter recognizes this as a ref to mutate
  readAloud,
  headphones,
}: {
  enabled: boolean;
  selfUserId: string;
  myLang: string;
  partner: Person | null;
  // The user's mic choice, NOT whether video connected: captions ride Socket.IO and
  // must keep working when LiveKit can't connect (a phone behind USB forwarding).
  micOn: boolean;
  localMicTrack: MediaStreamTrack | null;
  sendCaption: (c: OutgoingCaption) => void;
  captionSink: RefObject<(c: IncomingCaption) => void>;
  readAloud: boolean;
  // With headphones the speakers can't be captioned, so there's no need to stop
  // listening while a translation plays (the echo guard's main job).
  headphones: boolean;
}): {
  feed: CaptionFeed;
  partnerLine: CaptionLine | undefined;
  partnerLang: string | null;
  listen: CaptionListenState;
  speaking: boolean;
  voicePlan: VoicePlan;
  voiceError: boolean;
  quotaReached: boolean;
  pairState: PairState;
  progress: number | null;
  prepareTranslator: () => Promise<void>;
  typeCaption: (text: string) => void;
  unlock: () => void;
} {
  const [feed, setFeed] = useState<CaptionFeed>(EMPTY_FEED);

  // Read inside stable callbacks (handleRemote, onInterim/onFinal, finalizeLocal) so
  // none of them go stale — same no-dependency-array idiom as use-meeting.ts's langRef.
  const selfUserIdRef = useRef(selfUserId);
  const myLangRef = useRef(myLang);
  const partnerRef = useRef(partner);
  const sendCaptionRef = useRef(sendCaption);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    selfUserIdRef.current = selfUserId;
    myLangRef.current = myLang;
    partnerRef.current = partner;
    sendCaptionRef.current = sendCaption;
    enabledRef.current = enabled;
  });

  const partnerLang = partner?.lang ?? null;
  // Both directions: whoever can translate on-device does (the hybrid rule), so both
  // this browser's outgoing hybrid attempt and the incoming interim/final path need
  // their own pair probed and (if needed) downloaded.
  const pairs = useMemo<readonly (readonly [string, string])[]>(
    () => (partnerLang && partnerLang !== myLang ? [[myLang, partnerLang] as const, [partnerLang, myLang] as const] : []),
    [myLang, partnerLang],
  );

  const translation = useConvoTranslation({ enabled, pairs });
  const sttTag = languageFor(myLang)?.stt ?? myLang;
  const output = useSpeechOutput({ lang: myLang, sttTag, enabled: enabled && readAloud });

  // True while TTS speaks, plus a trailing window after — drives both the ducking
  // the UI does and the pause on my own recognition below. The setState only ever
  // happens inside the timer's own callback (never the effect body itself), so a
  // flip-back-to-speaking before the tail timer fires just cancels it via cleanup.
  const [speakingWithTail, setSpeakingWithTail] = useState(false);
  useEffect(() => {
    const speaking = output.speaking;
    const timer = setTimeout(() => setSpeakingWithTail(speaking), speaking ? 0 : SPEAKING_TAIL_MS);
    return () => clearTimeout(timer);
  }, [output.speaking]);

  // Local final and typed captions share this: apply to the feed, then attach a
  // translation for the partner when it can be made on-device right now (the
  // hybrid rule — the receiver falls back to MyMemory itself if this browser can't).
  // Split at sentence boundaries first: one long, pause-free monologue (or a long
  // paste) would otherwise exceed the server's limit and never reach the partner.
  const finalizeLocal = useCallback(
    (baseId: string, fullText: string, lang: string = myLangRef.current) => {
      const theirLang = partnerRef.current?.lang ?? null;
      splitForSpeech(fullText, MAX_CAPTION_LENGTH).forEach((text, i) => {
        const id = i ? `${baseId}-${i}` : baseId;
        setFeed((f) => applyCaption(f, { userId: selfUserIdRef.current, id, text, lang, final: true, ts: Date.now() }));

        if (!theirLang || theirLang === lang || translation.pairState(lang, theirLang) !== 'ready') {
          sendCaptionRef.current({ id, text, lang, final: true });
          return;
        }
        translation.translate(text, lang, theirLang, { onDeviceOnly: true, budgetMs: 800 }).then((result) => {
          sendCaptionRef.current(result ? { id, text, lang, final: true, translation: { lang: theirLang, text: result } } : { id, text, lang, final: true });
        });
      });
    },
    // Depends on the whole `translation` object, not just the two methods it calls
    // right now — matches what the linter wants, and keeps this correct even if a
    // future edit calls another translation.* method without updating this array.
    [translation],
  );

  // The language each unfinished sentence was begun in: switching "I speak" mid-
  // sentence promotes that sentence as a final (use-speech-captions), and it must
  // still be sent as what it was spoken in, not the newly chosen language.
  const interimLangRef = useRef(new Map<string, string>());

  const onInterim = useCallback(
    (id: string, text: string) => {
      if (isEcho(text, output.recentSpoken(), Date.now())) return;
      const lang = myLangRef.current;
      interimLangRef.current.set(id, lang);
      setFeed((f) => applyCaption(f, { userId: selfUserIdRef.current, id, text, lang, final: false, ts: Date.now() }));
      // Past the server's limit the interim would be dropped anyway; the partner's
      // line holds until the (split) final arrives.
      if (text.length <= MAX_CAPTION_LENGTH) sendCaptionRef.current({ id, text, lang, final: false });
    },
    [output],
  );

  const onFinal = useCallback(
    (id: string, text: string) => {
      const lang = interimLangRef.current.get(id) ?? myLangRef.current;
      interimLangRef.current.delete(id);
      if (isEcho(text, output.recentSpoken(), Date.now())) return;
      finalizeLocal(id, text, lang);
    },
    [output, finalizeLocal],
  );

  const typeSeqRef = useRef(0);
  const typeCaption = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean) return;
      finalizeLocal(`${Date.now().toString(36)}-t${typeSeqRef.current++}`, clean);
    },
    [finalizeLocal],
  );

  const localEnabled = enabled && micOn && (headphones || !speakingWithTail);
  const listen = useSpeechCaptions({ enabled: localEnabled, sttTag, track: localMicTrack, onInterim, onFinal });

  // Remote captions: assigned to the ref every render (matches the "assign your
  // handler to .current" contract) rather than via an effect, since there's no
  // subscription to clean up — the parent (use-meeting.ts) owns the socket listener
  // and just calls whatever is in captionSink.current at delivery time.
  // Keys already handled as final: Android Chrome can re-deliver a final, and
  // speaking a sentence twice is worse than the (deduped) caption update.
  const heardFinalsRef = useRef(new Set<string>());
  const handleRemote = useCallback(
    (ev: IncomingCaption) => {
      if (!enabledRef.current) return; // disabled: every sub-hook stays idle
      if (ev.userId === selfUserIdRef.current) return;
      const lang = myLangRef.current;
      const key = captionKey(ev.userId, ev.id);
      setFeed((f) => applyCaption(f, { ...ev, ts: Date.now() })); // local clock: see isSubtitleStale

      if (!ev.final) {
        // Interim: on-device only, and only once the pair is actually ready — never
        // spend MyMemory quota on text that's about to be replaced by the final.
        if (ev.lang !== lang && translation.pairState(ev.lang, lang) === 'ready') {
          translation.translate(ev.text, ev.lang, lang, { onDeviceOnly: true, budgetMs: 600 }).then((result) => {
            if (result !== null) setFeed((f) => attachTranslation(f, key, ev.text, lang, result));
          });
        }
        return;
      }

      if (heardFinalsRef.current.has(key)) return;
      heardFinalsRef.current.add(key);

      // The sender's on-device translation when it made one for this language,
      // otherwise the chain (on-device, then MyMemory). null = failed.
      const translateTo = (to: string): Promise<string | null> =>
        ev.translation?.lang === to ? Promise.resolve(ev.translation.text) : translation.translate(ev.text, ev.lang, to, { onDeviceOnly: false });

      // Nothing to translate or speak when the partner already speaks my language.
      if (ev.lang === lang) return;
      output.enqueue(key, null); // queued now so sentences are spoken in arrival order
      translateTo(lang).then((result) => {
        if (result !== null) setFeed((f) => attachTranslation(f, key, ev.text, lang, result));
        output.resolve(key, result); // null (failed): captions keep the original, nothing is spoken
      });
    },
    [translation, output],
  );
  useEffect(() => {
    captionSinkRef.current = handleRemote;
  });

  const prepareTranslator = useCallback(async () => {
    const thePartner = partnerRef.current;
    const lang = myLangRef.current;
    if (!thePartner?.lang || thePartner.lang === lang) return;
    const pairs: [string, string][] = [[lang, thePartner.lang], [thePartner.lang, lang]];
    await Promise.all(pairs.filter(([a, b]) => translation.pairState(a, b) !== 'ready').map(([a, b]) => translation.prepare(a, b)));
  }, [translation]);

  const partnerLine = partner ? latestFor(feed, partner.userId) : undefined;
  const readPairState = partnerLang && partnerLang !== myLang ? translation.pairState(partnerLang, myLang) : 'none';

  return {
    feed,
    partnerLine,
    partnerLang,
    listen,
    speaking: speakingWithTail,
    voicePlan: output.plan,
    voiceError: output.voiceError,
    quotaReached: translation.quotaReached,
    pairState: readPairState,
    progress: translation.progress,
    prepareTranslator,
    typeCaption,
    unlock: output.unlock,
  };
}
