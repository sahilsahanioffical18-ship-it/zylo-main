'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { LanguageSelect } from '@/components/language-select';
import { languageFor } from '@/lib/convo-languages';
import { voicePlanNote } from '@/lib/convo-support';
import type { CaptionLine } from '@/lib/caption-feed';
import type { PartnerVoiceSetting } from '@/lib/partner-voice';
import type { CaptionListenState } from '@/lib/use-speech-captions';
import type { useTranslatorConvo } from '@/lib/use-translator-convo';

const MAX_CAPTION_LENGTH = 500;


const PARTNER_VOICE_OPTIONS: { value: PartnerVoiceSetting; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'full', label: 'Full' },
  { value: 'off', label: 'Off' },
];

/** Always shown, so "captions aren't working" always comes with a reason. Null for
 * unsupported/blocked, which get their own banners. */
export function listenStatusText(listen: CaptionListenState, speaking: boolean, languageName: string): string | null {
  switch (listen.status) {
    case 'listening':
      return `Listening in ${languageName}${listen.mode === 'on-device' ? ' (on this device)' : ''}`;
    case 'starting':
      return 'Starting captions…';
    case 'off':
      return speaking ? 'Paused while the translation plays' : 'Your mic is off: turn it on to caption your speech';
    default:
      return null;
  }
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="rounded-lg border border-warning bg-card px-3 py-2 text-sm">
      {children}
    </p>
  );
}

function CaptionBubble({ line, myLang, own }: { line: CaptionLine; myLang: string; own: boolean }) {
  const translation = !own ? line.translations[myLang] : undefined;
  const primaryText = translation ?? line.text;
  const primaryLang = translation ? myLang : line.lang;
  return (
    <li className={cn('flex', own ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-3 py-2 text-sm',
          own ? 'bg-muted' : 'border border-border',
          !line.final && 'italic opacity-70',
        )}
      >
        <p lang={primaryLang} dir="auto" className="whitespace-pre-wrap break-words">
          {primaryText}
        </p>
        {!own && translation && (
          <p lang={line.lang} dir="auto" className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {line.text}
          </p>
        )}
      </div>
    </li>
  );
}

export function CaptionsPanel({
  convo,
  myLang,
  onChangeLang,
  readAloud,
  onReadAloud,
  headphones,
  onHeadphones,
  partnerVoice,
  onPartnerVoice,
  selfUserId,
}: {
  convo: ReturnType<typeof useTranslatorConvo>;
  myLang: string;
  onChangeLang: (lang: string) => void;
  readAloud: boolean;
  onReadAloud: (value: boolean) => void;
  headphones: boolean;
  onHeadphones: (value: boolean) => void;
  partnerVoice: PartnerVoiceSetting;
  onPartnerVoice: (value: PartnerVoiceSetting) => void;
  selfUserId: string;
}) {
  const [draft, setDraft] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // DOM write, not a setState — lint-clean under react-hooks/set-state-in-effect
  // (same idiom as ChatPanel's auto-scroll).
  useEffect(() => {
    const viewport = containerRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [convo.feed]);

  function send() {
    const clean = draft.trim();
    if (!clean) return;
    convo.typeCaption(clean);
    setDraft('');
  }

  const partnerName = languageFor(convo.partnerLang ?? '')?.name ?? 'their language';
  const myName = languageFor(myLang)?.name ?? 'your language';
  const voiceNote = voicePlanNote(convo.voicePlan, myName);
  const listenLine = listenStatusText(convo.listen, convo.speaking, myName);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 border-b border-border pb-3">
        <div className="space-y-1">
          <Label htmlFor="captions-my-lang" className="text-xs text-muted-foreground">
            I speak
          </Label>
          <LanguageSelect id="captions-my-lang" value={myLang} onChange={onChangeLang} />
        </div>
        <div className="space-y-1">
          <span id="captions-read-aloud-label" className="block text-xs text-muted-foreground">
            Read translations aloud
          </span>
          <Button
            type="button"
            variant={readAloud ? 'default' : 'outline'}
            className="h-11 w-full"
            aria-pressed={readAloud}
            aria-labelledby="captions-read-aloud-label"
            onClick={() => onReadAloud(!readAloud)}
          >
            {readAloud ? 'On' : 'Off'}
          </Button>
        </div>
        <div className="col-span-2 space-y-1">
          <span id="captions-partner-voice-label" className="block text-xs text-muted-foreground">
            Partner’s voice
          </span>
          <div role="group" aria-labelledby="captions-partner-voice-label" className="grid grid-cols-3 gap-2">
            {PARTNER_VOICE_OPTIONS.map((opt) => (
              <Button
                key={opt.value}
                type="button"
                variant={partnerVoice === opt.value ? 'default' : 'outline'}
                className="h-11"
                aria-pressed={partnerVoice === opt.value}
                onClick={() => onPartnerVoice(opt.value)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        {listenLine && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <span
              aria-hidden="true"
              className={cn('size-2 shrink-0 rounded-full', convo.listen.status === 'listening' ? 'bg-success' : 'bg-muted-foreground')}
            />
            {listenLine}
          </p>
        )}
        {convo.pairState === 'downloadable' && (
          <Banner>
            <span className="mr-2">
              Download {partnerName}→{myName} translation (one time)
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => void convo.prepareTranslator()}>
              Download
            </Button>
          </Banner>
        )}
        {convo.pairState === 'downloading' && (
          <Banner>
            Downloading {partnerName}→{myName} translation…{' '}
            {convo.progress !== null ? `${Math.round(convo.progress * 100)}%` : ''}
          </Banner>
        )}
        {convo.quotaReached && <Banner>Free translation limit reached for today. Captions show the original text.</Banner>}
        {convo.listen.status === 'unsupported' ? (
          <Banner>This browser can’t caption speech. Type below; your partner still hears it translated.</Banner>
        ) : (
          convo.listen.notice && <Banner>{convo.listen.notice}</Banner>
        )}
        {readAloud && voiceNote && <Banner>{voiceNote}</Banner>}
        {readAloud && convo.voiceError && (
          <Banner>The online voice didn’t answer, so the last translation wasn’t spoken. Captions still work.</Banner>
        )}
        {/* Captions pause while a translation plays so the speakers aren't captioned
            as you; with headphones there's nothing to hear, so they keep listening. */}
        <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
          <span id="captions-headphones-label" className="text-muted-foreground">
            {headphones ? 'Headphones on: captions keep listening while translations play.' : 'Use headphones to avoid echo, then turn this on.'}
          </span>
          <Button
            type="button"
            size="sm"
            variant={headphones ? 'default' : 'outline'}
            className="h-9 shrink-0"
            aria-pressed={headphones}
            aria-labelledby="captions-headphones-label"
            onClick={() => onHeadphones(!headphones)}
          >
            Headphones
          </Button>
        </div>
      </div>

      <div ref={containerRef} className="min-h-0 flex-1">
        {convo.feed.lines.length === 0 ? (
          <p role="status" className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
            No captions yet. Start talking, or type below.
          </p>
        ) : (
          <ScrollArea className="h-full">
            <ul className="space-y-2 pr-3">
              {convo.feed.lines.map((line) => (
                <CaptionBubble key={line.key} line={line} myLang={myLang} own={line.userId === selfUserId} />
              ))}
            </ul>
          </ScrollArea>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          maxLength={MAX_CAPTION_LENGTH}
          placeholder="Type instead"
          aria-label="Type a caption"
          className="max-h-32 resize-none"
        />
        <div className="flex items-center justify-end gap-2">
          {draft.length > MAX_CAPTION_LENGTH - 100 && (
            <span className="mr-auto text-xs tabular-nums text-muted-foreground">
              {draft.length}/{MAX_CAPTION_LENGTH}
            </span>
          )}
          <Button type="button" size="sm" onClick={send} disabled={!draft.trim()}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
