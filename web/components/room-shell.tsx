'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CaptionsPanel } from '@/components/captions-panel';
import { ChatPanel } from '@/components/chat-panel';
import { ControlBar, type PanelTab } from '@/components/control-bar';
import { PeoplePanel } from '@/components/people-panel';
import { SubtitleOverlay } from '@/components/subtitle-overlay';
import { VideoStage } from '@/components/video-stage';
import { AI_NAME, askAiBlocked, newlyDone, type ChatItem } from '@/lib/ai-chat';
import { brand } from '@/lib/brand';
import { shouldToast, toastPreview } from '@/lib/chat-toast';
import { languageFor } from '@/lib/convo-languages';
import { partnerVolume as partnerVolumeFor, type PartnerVoiceSetting } from '@/lib/partner-voice';
import { stageView } from '@/lib/screen-share';
import type { Admission, ScreenSharePolicy } from '@/lib/types';
import type { useLiveKitRoom } from '@/lib/use-livekit-room';
import type { LobbyEntry, Person } from '@/lib/use-meeting';
import type { useTranslatorConvo } from '@/lib/use-translator-convo';

// Tailwind's lg: where the Chat/People panel docks beside the stage instead of opening as a Sheet.
const DOCKED_QUERY = '(min-width: 1024px)';

export function RoomShell({
  title,
  maxParticipants,
  people,
  lobby,
  admission,
  isHost,
  selfUserId,
  media,
  sharerUserId,
  screenPolicy,
  onSetScreenPolicy,
  onToggleLive,
  onAdmit,
  onDeny,
  onSetAdmission,
  onMute,
  onStopShare,
  onKick,
  onLeave,
  onEndForAll,
  messages,
  onSendChat,
  aiAvailable,
  aiEnabled,
  onAskAi,
  onSetAiEnabled,
  aiNudges,
  onSetAiNudges,
  convo,
  myLang,
  onChangeLang,
  readAloud,
  onReadAloud,
  headphones,
  onHeadphones,
}: {
  title: string;
  maxParticipants: number;
  people: Person[];
  lobby: LobbyEntry[];
  admission: Admission;
  isHost: boolean;
  selfUserId: string;
  media: ReturnType<typeof useLiveKitRoom>;
  sharerUserId: string | null;
  screenPolicy: ScreenSharePolicy;
  onSetScreenPolicy: (policy: ScreenSharePolicy) => void;
  onToggleLive: () => void;
  onAdmit: (userId: string) => void;
  onDeny: (userId: string) => void;
  onSetAdmission: (mode: Admission) => void;
  onMute: (userId: string) => void;
  onStopShare: (userId: string) => void;
  onKick: (userId: string) => void;
  onLeave: () => void;
  onEndForAll: () => void;
  messages: ChatItem[];
  onSendChat: (text: string) => void;
  aiAvailable: boolean;
  aiEnabled: boolean;
  onAskAi: (text: string) => void;
  onSetAiEnabled: (enabled: boolean) => void;
  aiNudges: boolean;
  onSetAiNudges: (enabled: boolean) => void;
  // Translator Convo only. Its presence IS the mode flag (`translator` below) —
  // every other translator-only prop just below is only ever read once this exists.
  convo?: ReturnType<typeof useTranslatorConvo>;
  myLang: string;
  onChangeLang: (lang: string) => void;
  readAloud: boolean;
  onReadAloud: (value: boolean) => void;
  headphones: boolean;
  onHeadphones: (value: boolean) => void;
}) {
  const translator = Boolean(convo);
  const view = stageView(sharerUserId, selfUserId, people);
  // People is the default for a standard meeting: the host's lobby (admit/deny) and
  // the admission setting live there, and hiding those behind a tab would regress
  // Phase 2 behaviour. Translator Convo defaults to Captions instead (plan: Task 6).
  const [tab, setTab] = useState<PanelTab>(() => (translator ? 'captions' : 'people'));
  const [sheetOpen, setSheetOpen] = useState(false);
  // Translator Convo only, session-only: how loud the partner's real voice plays.
  const [partnerVoice, setPartnerVoice] = useState<PartnerVoiceSetting>('low');
  // Session-only, local to this viewer: never persisted, never sent to the server.
  const [mutedForMe, setMutedForMe] = useState<Set<string>>(() => new Set());

  // Stable (setters only), so the ZyloChat toast effect below doesn't re-run every render.
  const openPanel = useCallback((next: PanelTab) => {
    setTab(next);
    // The panel is docked at >=1024px; below that the same button opens the Sheet.
    // Reading the media query in the click handler (not during render) keeps this
    // out of hydration and out of react-hooks' way.
    if (!window.matchMedia(DOCKED_QUERY).matches) setSheetOpen(true);
  }, []);

  const toggleMuteForMe = (userId: string) => {
    setMutedForMe((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  // Toasts a new ZyloChat message, and each Zylo AI answer once it's done, while chat
  // isn't on screen. Messages are keyed on the last item, not messages.length: the list
  // is capped (ai-chat.ts's MAX_CHAT_ITEMS), so the length stops changing at the cap.
  const seenRef = useRef<ChatItem | undefined>(messages.at(-1));
  // Answer ids already handled. null until the first run, which takes the answers that
  // finished before mount as history, never toasted.
  const answersRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const chatVisible = tab === 'chat' && (sheetOpen || window.matchMedia(DOCKED_QUERY).matches);
    const pop = (title: string, text: string) =>
      toast(title, {
        id: 'zylochat', // a burst of messages replaces one toast instead of stacking
        description: toastPreview(text),
        duration: 4000,
        position: 'top-right', // off the room title and the control bar
        action: { label: 'Open', onClick: () => openPanel('chat') },
      });
    const firstRun = answersRef.current === null;
    answersRef.current ??= new Set();
    for (const answer of newlyDone(messages, answersRef.current)) {
      if (!firstRun && !chatVisible) pop(AI_NAME, answer.text.trim().split('\n')[0]); // its first line
    }
    const last = messages.at(-1);
    if (!last || last === seenRef.current) return;
    seenRef.current = last; // seeded at mount, so a remount never re-toasts history
    // A streaming answer is a new last item on every piece: only people's messages toast here.
    if (last.kind === 'person' && shouldToast(last, selfUserId, chatVisible)) pop(last.name, last.text);
  }, [messages, selfUserId, tab, sheetOpen, openPanel]);

  const peoplePanel = (
    <PeoplePanel
      people={people}
      lobby={lobby}
      admission={admission}
      isHost={isHost}
      selfUserId={selfUserId}
      sharerUserId={sharerUserId}
      micMuted={media.micMuted}
      mutedForMe={mutedForMe}
      onToggleMuteForMe={toggleMuteForMe}
      screenPolicy={screenPolicy}
      onSetScreenPolicy={onSetScreenPolicy}
      onAdmit={onAdmit}
      onDeny={onDeny}
      onSetAdmission={onSetAdmission}
      onMute={onMute}
      onStopShare={onStopShare}
      onKick={onKick}
      aiEnabled={aiEnabled}
      onSetAiEnabled={onSetAiEnabled}
      aiNudges={aiNudges}
      onSetAiNudges={onSetAiNudges}
      translator={translator}
    />
  );

  // Card chrome only when docked (lg): inside the phone Sheet it would double the padding.
  const panel = (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as PanelTab)}
      className="flex h-full min-h-0 flex-col lg:rounded-2xl lg:border lg:border-border lg:bg-card lg:p-4"
    >
      <TabsList className="w-full">
        {/* Captions comes first and is the default tab in translator mode (plan: Task 6). */}
        {convo && <TabsTrigger value="captions">Captions</TabsTrigger>}
        <TabsTrigger value="chat">{brand.chat}</TabsTrigger>
        <TabsTrigger value="people">People ({people.length})</TabsTrigger>
      </TabsList>
      {convo && (
        <TabsContent value="captions" className="min-h-0 flex-1">
          <CaptionsPanel
            convo={convo}
            myLang={myLang}
            onChangeLang={onChangeLang}
            readAloud={readAloud}
            onReadAloud={onReadAloud}
            headphones={headphones}
            onHeadphones={onHeadphones}
            partnerVoice={partnerVoice}
            onPartnerVoice={setPartnerVoice}
            selfUserId={selfUserId}
          />
        </TabsContent>
      )}
      <TabsContent value="chat" className="min-h-0 flex-1">
        <ChatPanel
          messages={messages}
          selfUserId={selfUserId}
          onSend={onSendChat}
          ai={translator ? undefined : { onAsk: onAskAi, blockedReason: askAiBlocked(aiAvailable, aiEnabled) }}
        />
      </TabsContent>
      <TabsContent value="people" className="min-h-0 flex-1">
        {peoplePanel}
      </TabsContent>
    </Tabs>
  );
  const waitingCount = isHost ? lobby.length : 0;
  const panelTitle = translator ? 'Captions, chat and people' : 'Chat and people';

  // Translator Convo only: the partner is the one other seat, and their real voice's
  // volume follows the viewer's own "Partner's voice" setting, ducked to muted
  // whenever this browser's translated speech is playing (lib/partner-voice.ts).
  const partnerUserId = translator ? (people.find((p) => p.userId !== selfUserId)?.userId ?? null) : null;
  const partnerLang = convo?.partnerLang ?? null;
  const subtitle = convo ? <SubtitleOverlay line={convo.partnerLine} myLang={myLang} /> : undefined;

  // ZyloRoom is always dark, whatever the dashboard's theme is set to.
  return (
    <div className="dark flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <h1 className="min-w-0 flex-1 truncate font-semibold">{title}</h1>
        <Badge variant="outline" className="tabular-nums">
          {people.length}/{maxParticipants}
        </Badge>
        {isHost && !translator && (
          // cn() drops the badge's base inline-flex in favour of `hidden` (checked).
          <Badge variant="outline" className="hidden sm:inline-flex">
            {admission === 'manual' ? 'Host admits' : 'Join instantly'}
          </Badge>
        )}
        {translator && partnerLang && (
          <Badge variant="outline" className="hidden sm:inline-flex">
            {languageFor(myLang)?.nativeName ?? myLang} ⇄ {languageFor(partnerLang)?.nativeName ?? partnerLang}
          </Badge>
        )}
      </header>

      {media.status === 'error' && (
        // Non-blocking, above the stage: losing video must not eject anyone from a
        // meeting whose chat, presence and lobby run over an independent transport.
        <p role="alert" className="mx-4 mt-3 rounded-lg border border-warning bg-card px-4 py-3 text-sm">
          {media.error} <Button variant="ghost" size="sm" onClick={media.retry}>Try again</Button>
        </p>
      )}

      <div className="flex min-h-0 flex-1 gap-4 p-4">
        <VideoStage
          people={people}
          selfUserId={selfUserId}
          videoTracks={media.videoTracks}
          audioTracks={media.audioTracks}
          speaking={media.speaking}
          micMuted={media.micMuted}
          mutedForMe={mutedForMe}
          status={media.status}
          view={view}
          screenTracks={media.screenTracks}
          subtitle={subtitle}
          partnerVolume={partnerUserId ? { userId: partnerUserId, ...partnerVolumeFor(partnerVoice, convo?.speaking ?? false) } : undefined}
        />
        <aside aria-label={panelTitle} className="hidden w-80 shrink-0 lg:block">
          {panel}
        </aside>
      </div>

      {/* Controlled, no SheetTrigger: ControlBar's Chat/People buttons open this too
          (via openPanel), so they just flip the same `sheetOpen` state. */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="dark p-4 data-[side=right]:w-full data-[side=right]:max-w-sm">
          <SheetHeader className="p-0 pb-4">
            <SheetTitle>{panelTitle}</SheetTitle>
          </SheetHeader>
          {panel}
        </SheetContent>
      </Sheet>

      <ControlBar
        micOn={media.micOn}
        camOn={media.camOn}
        onToggleMic={media.toggleMic}
        onToggleCam={media.toggleCam}
        mediaReady={media.status === 'connected'}
        sharing={sharerUserId !== null && sharerUserId === selfUserId}
        onToggleLive={onToggleLive}
        peopleCount={people.length}
        waitingCount={waitingCount}
        onOpenPanel={openPanel}
        onLeave={onLeave}
        isHost={isHost}
        onEndForAll={onEndForAll}
        translator={translator}
      />
    </div>
  );
}
