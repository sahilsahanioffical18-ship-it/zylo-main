'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardCopy, Download, Languages, Mic, Volume2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { languageFor, type ConvoLanguage } from '@/lib/convo-languages';
import { canRecognizeTrack, speechSupport, translatorSupport, voicePlanNote, voicesFor, type SpeechSupport, type TranslatorSupport } from '@/lib/convo-support';
import { unlockSpeech, useSpeechOutput } from '@/lib/use-speech-output';

// The Phase 6 gate (docs/superpowers/plans/2026-09-23-zylo-phase-6.md, "Build
// order" step 1): prove this on real devices before live translation gets built.
// Self-contained on purpose — it gets embedded in pre-join in a later task.

type Level = 'good' | 'warn' | 'bad';
type Voice = { name: string; lang: string; localService: boolean };
type TestState = { state: 'idle' | 'running' | 'done' | 'error'; result: string; error: string | null };
const IDLE: TestState = { state: 'idle', result: '', error: null };

function StatusIcon({ level }: { level: Level }) {
  if (level === 'good') return <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden="true" />;
  if (level === 'warn') return <AlertTriangle className="size-5 shrink-0 text-warning" aria-hidden="true" />;
  return <XCircle className="size-5 shrink-0 text-destructive" aria-hidden="true" />;
}

function StatusLine({ level, children }: { level: Level; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <StatusIcon level={level} />
      <div className="space-y-1 text-sm">{children}</div>
    </div>
  );
}

function TestResult({ test, placeholder = 'Working…' }: { test: TestState; placeholder?: string }) {
  if (test.state === 'idle') return null;
  return (
    <p aria-live="polite" className="rounded-lg bg-muted px-3 py-2 text-sm break-words">
      {test.error ?? (test.result || placeholder)}
    </p>
  );
}

function speechLevel(status: SpeechSupport): Level {
  if (status === 'on-device') return 'good';
  if (status === 'none') return 'bad';
  return 'warn';
}

function speechCopy(status: SpeechSupport, name: string): string {
  if (status === 'on-device') return `Captions for ${name} run privately on this device.`;
  if (status === 'on-device-downloadable') return `On-device captions for ${name} need a one-time download.`;
  if (status === 'cloud') return `Captions for ${name} will be sent to this browser's cloud speech service.`;
  return `This browser can't recognize ${name} speech. Typing captions is the fallback.`;
}

function speechErrorMessage(code: string, name: string): string {
  if (code === 'not-allowed' || code === 'service-not-allowed') return 'Microphone access was blocked. Allow it in your browser’s site settings and try again.';
  if (code === 'network') return 'No network reached the cloud speech service.';
  if (code === 'no-speech') return 'No speech was detected. Try again and speak clearly.';
  if (code === 'language-not-supported') return `This browser doesn’t support ${name} for speech recognition.`;
  if (code === 'audio-capture') return 'No microphone was found, or it’s already in use by another app.';
  return 'Speech recognition stopped unexpectedly.';
}

function translatorLevel(status: TranslatorSupport): Level {
  if (status === 'available') return 'good';
  if (status === 'downloadable' || status === 'downloading') return 'warn';
  return 'bad';
}

function translatorCopy(status: TranslatorSupport, from: string, to: string): string {
  const pair = `${from} → ${to}`;
  if (status === 'available') return `${pair} translates on-device.`;
  if (status === 'downloadable') return `${pair} needs a one-time download.`;
  if (status === 'downloading') return `${pair} is downloading.`;
  if (status === 'unavailable') return `${pair} isn’t supported on-device here.`;
  return `${pair}: no on-device translator in this browser.`;
}

function getRecognitionCtor(): SpeechRecognitionStatic | null {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

// Used twice (partner→mine and mine→partner), so it earns a real extraction;
// the four cards below render once each and stay inline in ConvoChecklist.
function TranslatorRow({ status, from, to, test, onTest }: { status: TranslatorSupport | null; from: ConvoLanguage; to: ConvoLanguage; test: TestState; onTest: () => void }) {
  return (
    <div className="space-y-2">
      {status === null ? (
        <p className="text-sm text-muted-foreground">
          Checking {from.name} → {to.name}…
        </p>
      ) : (
        <StatusLine level={translatorLevel(status)}>{translatorCopy(status, from.name, to.name)}</StatusLine>
      )}
      {status && status !== 'none' && status !== 'unavailable' && (
        <Button type="button" variant="outline" className="h-11" disabled={test.state === 'running'} onClick={onTest}>
          {test.state === 'running' ? 'Testing…' : 'Test on-device translation'}
        </Button>
      )}
      <TestResult test={test} />
    </div>
  );
}

export function ConvoChecklist({ myLang, partnerLang }: { myLang: string; partnerLang: string }) {
  const mine = languageFor(myLang) ?? languageFor('en')!;
  const partner = languageFor(partnerLang) ?? languageFor('en')!;

  const [speechState, setSpeechState] = useState<{ status: SpeechSupport; track: boolean; canInstall: boolean } | null>(null);
  const [captionTest, setCaptionTest] = useState<TestState>(IDLE);
  const [installState, setInstallState] = useState<TestState>(IDLE);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  const [toMine, setToMine] = useState<TranslatorSupport | null>(null);
  const [toPartner, setToPartner] = useState<TranslatorSupport | null>(null);
  const [testToMine, setTestToMine] = useState<TestState>(IDLE);
  const [testToPartner, setTestToPartner] = useState<TestState>(IDLE);
  const [mymemoryTest, setMymemoryTest] = useState<TestState>(IDLE);
  const translatorsRef = useRef<Translator[]>([]);

  const [voices, setVoices] = useState<Voice[] | null>(null);
  // The same speech queue a convo uses, so "Test voice" plays exactly what a
  // partner's translation would: the device voice, else Google's online voice.
  const output = useSpeechOutput({ lang: mine.code, sttTag: mine.stt, enabled: true });
  const plan = output.plan;

  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [reportText, setReportText] = useState<string | null>(null);

  // Detection: client-only, re-runs whenever either language changes.
  useEffect(() => {
    let cancelled = false;
    speechSupport(window, mine.stt).then((status) => {
      if (cancelled) return;
      const canInstall = typeof getRecognitionCtor()?.install === 'function';
      setSpeechState({ status, track: canRecognizeTrack(window), canInstall });
    });
    return () => {
      cancelled = true;
    };
  }, [mine.stt]);

  useEffect(() => {
    let cancelled = false;
    translatorSupport(window, partner.onDevice, mine.onDevice).then((s) => !cancelled && setToMine(s));
    translatorSupport(window, mine.onDevice, partner.onDevice).then((s) => !cancelled && setToPartner(s));
    return () => {
      cancelled = true;
    };
  }, [partner.onDevice, mine.onDevice]);

  useEffect(() => {
    const load = () => {
      setVoices(voicesFor(window, mine.stt));
    };
    load();
    window.speechSynthesis?.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', load);
  }, [mine.stt]);

  // Cleanup: stop anything that could otherwise outlive the page.
  useEffect(
    () => () => {
      recognitionRef.current?.abort();
      window.speechSynthesis?.cancel();
      translatorsRef.current.forEach((t) => t.destroy());
    },
    [],
  );

  const runCaptionTest = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    setCaptionTest({ state: 'running', result: '', error: null });
    const recognition = new Ctor();
    recognitionRef.current = recognition;
    recognition.lang = mine.stt;
    recognition.continuous = true;
    recognition.interimResults = true;
    let finalText = '';
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) finalText += `${text} `;
        else interim += text;
      }
      setCaptionTest((s) => ({ ...s, result: (finalText + interim).trim() }));
    };
    recognition.onerror = (event) => setCaptionTest((s) => ({ ...s, error: speechErrorMessage(event.error, mine.name) }));
    recognition.onend = () => setCaptionTest((s) => (s.state === 'running' ? { ...s, state: 'done' } : s));
    try {
      // ponytail: this standalone check page has no live LiveKit mic track, so it
      // always calls start() with no args. The real hook (use-speech-captions.ts,
      // a later task) is the one that tries start(track) and falls back in a
      // try/catch — this button only proves recognition itself works.
      recognition.start();
    } catch {
      setCaptionTest({ state: 'error', result: '', error: 'Could not start the microphone.' });
      return;
    }
    window.setTimeout(() => recognition.stop(), 5000);
  }, [mine.stt, mine.name]);

  const runInstall = useCallback(async () => {
    const Ctor = getRecognitionCtor();
    if (!Ctor?.install) return;
    setInstallState({ state: 'running', result: '', error: null });
    try {
      const ok = await Ctor.install({ langs: [mine.stt], processLocally: true });
      setInstallState(ok ? { state: 'done', result: 'Speech pack installed.', error: null } : { state: 'error', result: '', error: 'Install did not complete.' });
    } catch {
      setInstallState({ state: 'error', result: '', error: 'Could not install the speech pack.' });
    }
  }, [mine.stt]);

  const runTranslatorTest = useCallback((from: ConvoLanguage, to: ConvoLanguage, setState: typeof setTestToMine) => {
    if (!from.onDevice || !to.onDevice || !window.Translator) return;
    setState({ state: 'running', result: '', error: null });
    window.Translator.create({
      sourceLanguage: from.onDevice,
      targetLanguage: to.onDevice,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => setState((s) => ({ ...s, result: `Downloading… ${Math.round(e.loaded * 100)}%` })));
      },
    })
      .then(async (translator) => {
        translatorsRef.current.push(translator);
        const text = await translator.translate(from.sample);
        setState({ state: 'done', result: text, error: null });
      })
      .catch(() => setState({ state: 'error', result: '', error: 'On-device translation failed. Try again.' }));
  }, []);

  const runMyMemoryTest = useCallback(async () => {
    setMymemoryTest({ state: 'running', result: '', error: null });
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(partner.sample)}&langpair=${partner.mymemory}|${mine.mymemory}`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      // quotaFinished can arrive alongside a translatedText that's just MyMemory's
      // own warning string, so the quota check has to be checked first.
      if (data?.quotaFinished) setMymemoryTest({ state: 'error', result: '', error: 'daily limit reached' });
      else if (data?.responseData?.translatedText) setMymemoryTest({ state: 'done', result: data.responseData.translatedText, error: null });
      else setMymemoryTest({ state: 'error', result: '', error: 'MyMemory returned no translation.' });
    } catch {
      setMymemoryTest({ state: 'error', result: '', error: 'Could not reach MyMemory. Check your connection.' });
    }
  }, [partner.sample, partner.mymemory, mine.mymemory]);

  const runVoiceTest = useCallback(() => {
    unlockSpeech(); // this click is the gesture speech and audio playback need
    output.enqueue(`voice-test-${Date.now()}`, mine.sample);
  }, [output, mine.sample]);

  const copyReport = useCallback(async () => {
    const report = {
      userAgent: navigator.userAgent,
      myLang,
      partnerLang,
      speech: { status: speechState?.status ?? null, canRecognizeTrack: speechState?.track ?? null, transcript: captionTest.result || null, error: captionTest.error },
      translator: { partnerToMine: toMine, mineToPartner: toPartner, partnerToMineResult: testToMine.result || null, mineToPartnerResult: testToPartner.result || null },
      mymemory: { result: mymemoryTest.result || null, error: mymemoryTest.error },
      voices: (voices ?? []).slice(0, 3).map((v) => v.name),
      generatedAt: new Date().toISOString(),
    };
    const text = JSON.stringify(report, null, 2);
    setReportText(text);
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }, [myLang, partnerLang, speechState, captionTest, toMine, toPartner, testToMine, testToPartner, mymemoryTest, voices]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mic className="size-4 text-muted-foreground" aria-hidden="true" /> Captions (your speech)
          </CardTitle>
          <CardDescription>Can this device turn your {mine.name} speech into captions?</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {speechState === null ? (
            <p className="text-sm text-muted-foreground">Checking this browser…</p>
          ) : (
            <StatusLine level={speechLevel(speechState.status)}>
              <p>{speechCopy(speechState.status, mine.name)}</p>
              <p className="text-xs text-muted-foreground">
                {speechState.track ? 'This device can listen on the echo-cancelled meeting mic.' : 'It listens to your whole microphone — headphones help avoid echo.'}
              </p>
            </StatusLine>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" className="h-11" disabled={!speechState || speechState.status === 'none' || captionTest.state === 'running'} onClick={runCaptionTest}>
              <Mic aria-hidden="true" /> {captionTest.state === 'running' ? 'Listening… (5s)' : 'Test captions (5 s)'}
            </Button>
            {speechState?.canInstall && speechState.status === 'on-device-downloadable' && (
              <Button type="button" variant="outline" className="h-11" disabled={installState.state === 'running'} onClick={runInstall}>
                <Download aria-hidden="true" /> Download {mine.name} speech pack
              </Button>
            )}
          </div>
          <TestResult test={captionTest} placeholder="Listening…" />
          <TestResult test={installState} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Languages className="size-4 text-muted-foreground" aria-hidden="true" /> Translation
          </CardTitle>
          <CardDescription>
            Can this device translate between {partner.name} and {mine.name} for free?
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <TranslatorRow status={toMine} from={partner} to={mine} test={testToMine} onTest={() => runTranslatorTest(partner, mine, setTestToMine)} />
          <TranslatorRow status={toPartner} from={mine} to={partner} test={testToPartner} onTest={() => runTranslatorTest(mine, partner, setTestToPartner)} />
          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-sm text-muted-foreground">
              Free online fallback (MyMemory), {partner.name} → {mine.name}:
            </p>
            <Button type="button" variant="outline" className="h-11" disabled={mymemoryTest.state === 'running'} onClick={runMyMemoryTest}>
              {mymemoryTest.state === 'running' ? 'Testing…' : 'Test free online translation'}
            </Button>
            <TestResult test={mymemoryTest} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Volume2 className="size-4 text-muted-foreground" aria-hidden="true" /> Voice
          </CardTitle>
          <CardDescription>How translations will be read to you, in {mine.name}.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {voices === null ? (
            <p className="text-sm text-muted-foreground">Checking voices…</p>
          ) : plan.kind !== 'native' ? (
            <StatusLine level="warn">{voicePlanNote(plan, mine.name)}</StatusLine>
          ) : (
            <StatusLine level="good">
              {voices.length} voice{voices.length === 1 ? '' : 's'} found: {voices.slice(0, 3).map((v) => v.name).join(', ')}
            </StatusLine>
          )}
          <Button type="button" variant="outline" className="h-11" disabled={plan.kind === 'none' || output.speaking} onClick={runVoiceTest}>
            <Volume2 aria-hidden="true" /> {output.speaking ? 'Playing…' : 'Test voice'}
          </Button>
          {output.voiceError && <StatusLine level="bad">The online voice didn’t answer. Try again in a moment; captions still work.</StatusLine>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ClipboardCopy className="size-4 text-muted-foreground" aria-hidden="true" /> Report
          </CardTitle>
          <CardDescription>Copy this and send it back so the next step can be planned.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button type="button" className="h-11" onClick={copyReport}>
            <ClipboardCopy aria-hidden="true" /> Copy report
          </Button>
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {copyState === 'copied' && 'Copied to your clipboard.'}
            {copyState === 'failed' && 'Couldn’t copy automatically — copy the text below.'}
          </p>
          {copyState === 'failed' && reportText && (
            <pre tabIndex={0} aria-label="Report JSON" className="max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs break-words whitespace-pre-wrap">
              {reportText}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
