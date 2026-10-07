'use client';

// "Try it on this device": the real Translator Convo pipeline with your own speech
// looped back as if it were the partner's. You speak (or type) in your language, see
// the caption and its translation, and hear it spoken the way your partner would.
// Uses the same hooks as the room, so a language that works here works in a convo —
// and it needs no second account or second device.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mic, Send, Square, Volume2 } from 'lucide-react';
import { listenStatusText } from '@/components/captions-panel';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { languageFor } from '@/lib/convo-languages';
import { canRecognizeTrack, voicePlanNote } from '@/lib/convo-support';
import { useConvoTranslation } from '@/lib/use-convo-translation';
import { useSpeechCaptions } from '@/lib/use-speech-captions';
import { unlockSpeech, useSpeechOutput } from '@/lib/use-speech-output';

// translation: undefined while pending, null when every engine failed. The *Ms
// fields are timings from the sentence ending (finalAt) — what a partner waits.
type Line = {
  id: string;
  text: string;
  final: boolean;
  translation?: string | null;
  finalAt?: number;
  translatedMs?: number;
  voiceMs?: number;
};

function upsert(lines: Line[], next: Line): Line[] {
  const idx = lines.findIndex((l) => l.id === next.id);
  if (idx === -1) return [...lines, next].slice(-20);
  if (lines[idx].final && !next.final) return lines;
  return lines.map((l, i) => (i === idx ? { ...l, ...next } : l));
}

export function ConvoLoopback({ myLang, partnerLang }: { myLang: string; partnerLang: string }) {
  const mine = languageFor(myLang)!;
  const partner = languageFor(partnerLang)!;
  const [running, setRunning] = useState(false);
  const [track, setTrack] = useState<MediaStreamTrack | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [typed, setTyped] = useState('');
  // A ref, not state: two submits before a re-render must still get two ids.
  const seqRef = useRef(0);

  const pairs = useMemo(() => (myLang === partnerLang ? [] : [[myLang, partnerLang] as const]), [myLang, partnerLang]);
  const translation = useConvoTranslation({ enabled: true, pairs });
  const onVoiceStart = useCallback(
    (key: string) => setLines((ls) => ls.map((l) => (l.id === key && l.finalAt ? { ...l, voiceMs: Date.now() - l.finalAt } : l))),
    [],
  );
  const output = useSpeechOutput({ lang: partnerLang, sttTag: partner.stt, enabled: true, onStart: onVoiceStart });

  const onInterim = useCallback((id: string, text: string) => setLines((ls) => upsert(ls, { id, text, final: false })), []);
  const onFinal = useCallback(
    (id: string, text: string) => {
      const finalAt = Date.now();
      setLines((ls) => upsert(ls, { id, text, final: true, finalAt }));
      output.enqueue(id, null);
      const translated = myLang === partnerLang ? Promise.resolve(text) : translation.translate(text, myLang, partnerLang, { onDeviceOnly: false });
      translated.then((result) => {
        setLines((ls) => ls.map((l) => (l.id === id ? { ...l, translation: result, translatedMs: Date.now() - finalAt } : l)));
        output.resolve(id, result);
      });
    },
    [output, translation, myLang, partnerLang],
  );

  const listen = useSpeechCaptions({ enabled: running && !output.speaking, sttTag: mine.stt, track, onInterim, onFinal });

  useEffect(() => () => track?.stop(), [track]);

  async function start() {
    unlockSpeech(); // this click is the user gesture speech and audio playback need
    setLines([]);
    // Mirrors the room on desktop Chrome: recognize an echo-cancelled mic track.
    if (canRecognizeTrack(window)) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        setTrack(stream.getAudioTracks()[0] ?? null);
      } catch {
        // No track: useSpeechCaptions falls back to the default microphone.
      }
    }
    setRunning(true);
  }

  function stop() {
    setRunning(false);
    setTrack(null);
  }

  // Typed text takes the exact path a spoken sentence does once it's final.
  function sendTyped(e: React.FormEvent) {
    e.preventDefault();
    const text = typed.trim();
    if (!text) return;
    unlockSpeech();
    onFinal(`typed-${seqRef.current++}`, text);
    setTyped('');
  }

  function playSample() {
    unlockSpeech();
    output.enqueue(`sample-${seqRef.current++}`, partner.sample);
  }

  const statusText = running ? listenStatusText(listen, output.speaking, mine.name) : null;
  const voiceSource =
    output.plan.kind === 'native' ? `Voice: ${output.plan.voice.name} (on this device)` : voicePlanNote(output.plan, partner.name);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mic className="size-4 text-muted-foreground" aria-hidden="true" /> Try it on this device
        </CardTitle>
        <CardDescription>
          Speak or type {mine.name}: you’ll see your caption, its {partner.name} translation, and hear it the way your partner
          would. Headphones stop the translation being captioned again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {running ? (
            <Button type="button" variant="outline" className="h-11" onClick={stop}>
              <Square aria-hidden="true" /> Stop
            </Button>
          ) : (
            <Button type="button" className="h-11" onClick={start} disabled={listen.status === 'unsupported'}>
              <Mic aria-hidden="true" /> Start speaking
            </Button>
          )}
          <Button type="button" variant="outline" className="h-11" onClick={playSample} disabled={output.plan.kind === 'none'}>
            <Volume2 aria-hidden="true" /> Play a {partner.name} sample
          </Button>
        </div>

        <form onSubmit={sendTyped} className="flex gap-2">
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={`Or type ${mine.name} here`}
            aria-label={`Type ${mine.name} to translate`}
            lang={myLang}
            dir="auto"
            maxLength={500}
            className="h-11"
          />
          <Button type="submit" variant="secondary" className="h-11 shrink-0" disabled={!typed.trim()}>
            <Send aria-hidden="true" /> Translate
          </Button>
        </form>

        {listen.status === 'unsupported' && <p className="text-sm text-muted-foreground">This browser can’t caption speech. Typing still works.</p>}
        {listen.notice && <p className="text-sm text-muted-foreground">{listen.notice}</p>}
        {statusText && (
          <p role="status" className="text-sm text-muted-foreground" data-loopback-status>
            {statusText}
          </p>
        )}
        <p className="text-sm text-muted-foreground" data-loopback-voice>
          {voiceSource}
        </p>
        {output.voiceError && (
          <p className="text-sm text-destructive" data-loopback-voice-error>
            The online voice didn’t answer, so that line wasn’t spoken. Captions still work.
          </p>
        )}

        {lines.length > 0 && (
          <ul className="space-y-2" aria-live="polite">
            {lines.map((line) => (
              <li key={line.id} className="rounded-lg border border-border p-3 text-sm" data-loopback-line>
                <p lang={myLang} dir="auto" className={line.final ? '' : 'italic opacity-70'}>
                  {line.text}
                </p>
                {line.final && (
                  <p lang={partnerLang} dir="auto" className="mt-1 font-semibold" data-loopback-translation>
                    {line.translation === undefined ? 'Translating…' : line.translation === null ? 'Translation failed' : line.translation}
                  </p>
                )}
                {line.translatedMs !== undefined && (
                  <p className="mt-1 text-xs tabular-nums text-muted-foreground" data-loopback-timing>
                    Translated in {line.translatedMs} ms{line.voiceMs !== undefined ? ` · voice started at ${line.voiceMs} ms` : ''}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
