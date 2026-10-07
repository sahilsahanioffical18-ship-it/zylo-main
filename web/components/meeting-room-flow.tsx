'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@clerk/nextjs';
import { Loader2 } from 'lucide-react';
import { Notice, PreJoin } from '@/components/pre-join';
import { RoomShell } from '@/components/room-shell';
import { WaitingCard } from '@/components/waiting-card';
import { brand } from '@/lib/brand';
import type { IncomingCaption, MeetingCard } from '@/lib/types';
import { useLiveKitRoom, type MediaPrefs } from '@/lib/use-livekit-room';
import { useMeeting, type DeniedReason } from '@/lib/use-meeting';
import { unlockSpeech } from '@/lib/use-speech-output';
import { useTranslatorConvo } from '@/lib/use-translator-convo';

// Module-level so it's a stable reference — allocating a fresh object per render
// would needlessly re-run any effect that has it in a dependency array.
const MEDIA_OFF: MediaPrefs = Object.freeze({ micOn: false, camOn: false });

const DENIED_COPY: Record<DeniedReason, { title: string; text: string }> = {
  not_found: {
    title: 'Meeting not found',
    text: 'This meeting doesn’t exist or the host cancelled it.',
  },
  ended: {
    title: 'This meeting has ended',
    text: `You can find it under ${brand.meet} → Previous on your dashboard.`,
  },
  removed: {
    title: 'You were removed from this meeting',
    text: 'The host removed you, so you can’t rejoin this one. Any other meeting still works.',
  },
  denied: {
    title: 'The host didn’t let you in',
    text: `Ask them for a new invite if you think this was a mistake, then open the ${brand.room} link again.`,
  },
  full: {
    title: 'This Translator Convo is full',
    text: 'This Translator Convo already has two people.',
  },
  unavailable: {
    title: 'Meetings are unavailable for a moment',
    text: 'Zylo couldn’t reach its meeting service. Reload this page in a few seconds to try again.',
  },
};

export function MeetingRoomFlow({ code }: { code: string }) {
  const router = useRouter();
  const { user } = useUser();
  const [joined, setJoined] = useState<{ meeting: MeetingCard; prefs: MediaPrefs } | null>(null);
  // Set by handleLeave, checked only in the `!joined` branch below: it exists
  // purely to stop <PreJoin> mounting (and calling getUserMedia) during the
  // window between setJoined(null) and router.push('/dashboard') landing.
  const [leaving, setLeaving] = useState(false);
  const translator = joined?.meeting.mode === 'translator';

  // Translator Convo only. PreJoin resolves the real language (its own select,
  // defaulted from localStorage or the browser) and hands it to onJoin below,
  // BEFORE this ever needs a value — so 'en' here is a type-only placeholder, never
  // actually sent in a join-request. That's what closes the race that used to exist
  // when this was corrected by an effect running after Join: the very first
  // join-request now always carries the language the user actually chose.
  const [myLang, setMyLang] = useState('en');
  // Read aloud defaults on; lifted here (not local to RoomShell) because it also
  // has to reach useTranslatorConvo below.
  const [readAloud, setReadAloud] = useState(true);
  // Off by default: without headphones, captioning while a translation plays would
  // caption the speakers. Session-only, like the other convo settings.
  const [headphones, setHeadphones] = useState(false);

  // Assigned by use-translator-convo.ts; use-meeting.ts's onCaption just forwards
  // here so a language/convo change never has to tear down and reopen the socket.
  const captionSink = useRef<(c: IncomingCaption) => void>(() => {});

  // The socket only opens once Join is pressed, so nobody takes a seat while
  // they are still setting up their camera.
  const {
    state,
    lobby,
    admission,
    messages,
    leave,
    admitFromLobby,
    denyFromLobby,
    setAdmissionMode,
    sendChat,
    sharerUserId,
    shareGrant,
    requestScreen,
    stopScreen,
    screenPolicy,
    kick,
    mute,
    stopShareOf,
    setScreenPolicyMode,
    endMeeting,
    sendCaption,
    setConvoLang,
    aiEnabled,
    askAi,
    setAiEnabled,
    aiNudges,
    setAiNudges,
    reportSpeech,
  } = useMeeting(joined ? code : null, { lang: translator ? myLang : null, onCaption: (c) => captionSink.current(c) });
  const selfUserId = user?.id ?? '';
  const presenting = sharerUserId !== null && sharerUserId === selfUserId;
  // AI nudges are effectively on (spec §3): only then does this browser tell the server,
  // at most every 10 s, that its own person spoke. Never audio or text.
  const nudgesOn = Boolean(
    joined &&
      !translator &&
      joined.meeting.aiAvailable &&
      (aiEnabled ?? joined.meeting.aiEnabled) &&
      (aiNudges ?? joined.meeting.aiNudges),
  );
  // One expression decides both "which screen" and "is LiveKit connected", so they
  // can never disagree. `joined` is deliberately part of this condition, not
  // redundant with `state.status`: it is the only thing Leave changes
  // synchronously. use-meeting.ts's join effect opens with `if (!meetingId) return;`
  // *before* it would ever reset `state` — so when Leave fires, `state.status` is
  // still 'admitted' on the very next render, and dropping `joined` from this
  // expression would leave LiveKit connected (and still publishing) under a
  // <PreJoin> that believes it's starting fresh. Seat lost any other way -> a real
  // socket event flips `state.status` itself (denied/replaced/offline) -> this
  // still goes to null -> the connect effect's cleanup runs -> room.disconnect().
  // A transient socket blip is NOT one of these paths: use-meeting.ts only flips
  // state away from 'admitted' on connect_error, not on a bare 'disconnect', so a
  // reconnecting socket keeps video up.
  const media = useLiveKitRoom(
    joined && state.status === 'admitted' ? code : null,
    joined?.prefs ?? MEDIA_OFF,
    { grant: shareGrant, allowed: presenting, onEnded: stopScreen },
    nudgesOn ? reportSpeech : undefined,
  );

  // Translator Convo only. Partner is the first other seated person — Translator
  // Convo is a 2-seat room, so there's at most one. Called unconditionally (hooks
  // rule) regardless of mode/admission; `enabled` keeps every sub-hook idle
  // otherwise, so a standard meeting behaves exactly as it did before this feature.
  const people = state.status === 'admitted' ? state.people : [];
  const partner = people.find((p) => p.userId !== selfUserId) ?? null;
  const convo = useTranslatorConvo({
    enabled: translator && state.status === 'admitted',
    selfUserId,
    myLang,
    partner,
    micOn: media.micOn,
    localMicTrack: media.localMicTrack,
    sendCaption,
    captionSink,
    readAloud,
    headphones,
  });

  // Changing "I speak" in the Captions panel: updates the local render, tells the
  // server (so presence and the seat's `lang` follow), and remembers the choice for
  // next time — the same key PreJoin and the landing page read.
  const handleChangeLang = useCallback(
    (lang: string) => {
      setMyLang(lang);
      setConvoLang(lang);
      try {
        localStorage.setItem('zylo.convoLang', lang);
      } catch {
        // Not fatal — just means next time won't remember this choice.
      }
    },
    [setConvoLang],
  );

  // Tells the server first (releases the seat), then tears down locally right
  // away rather than waiting on a socket round-trip: setting joined to null
  // unmounts useMeeting's effect (disconnects the socket) and — because `joined`
  // is part of the gate above — flips useLiveKitRoom's meeting id to null on this
  // same render, so its connect effect's cleanup (room.disconnect()) is queued
  // before <PreJoin> ever mounts and re-acquires the camera.
  function handleLeave() {
    setLeaving(true);
    leave();
    setJoined(null);
    router.push('/dashboard');
  }

  if (!joined) {
    // Never PreJoin (it would re-acquire the camera), never blank: if router.push never
    // lands, this still offers the way back.
    if (leaving) return <Notice title={`You left the ${brand.room}`} text="Taking you back to your dashboard…" />;
    return (
      <PreJoin
        code={code}
        onJoin={(meeting, prefs, lang) => {
          // A user gesture (this click) is required to unlock speechSynthesis on
          // iOS/Chrome — done here, not inside useSpeechOutput, so it fires even
          // though that hook doesn't exist yet (joined is still null this render).
          if (meeting.mode === 'translator') {
            unlockSpeech();
            // Set BEFORE setJoined, in the same handler: both land before the next
            // render, so the join effect below (keyed on `joined`) reads the real
            // language on its very first join-request, never PreJoin's placeholder.
            if (lang) {
              setMyLang(lang);
              try {
                localStorage.setItem('zylo.convoLang', lang);
              } catch {
                // Not fatal — just means next time won't remember this choice.
              }
            }
          }
          setJoined({ meeting, prefs });
        }}
      />
    );
  }

  if (state.status === 'denied') {
    const { title, text } = DENIED_COPY[state.reason];
    return <Notice title={title} text={text} />;
  }
  if (state.status === 'replaced') {
    return (
      <Notice
        title="You joined from another tab or device"
        text={`Only one ${brand.room} connection per person stays open. Close the other one and open this link again if you want to come back here.`}
      />
    );
  }
  if (state.status === 'offline') {
    return (
      <Notice
        title={`Can’t reach the ${brand.product} server`}
        text="Check that it’s running, then open this link again. Reconnecting happens on its own if it comes back."
      />
    );
  }
  if (state.status === 'connecting') {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3" role="status">
        <Loader2 className="size-8 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
        <p className="text-muted-foreground">Connecting to {brand.room}…</p>
      </main>
    );
  }
  if (state.status === 'waiting') {
    return <WaitingCard manual={state.manual} position={state.position} onLeave={handleLeave} />;
  }

  return (
    <RoomShell
      title={joined.meeting.title}
      maxParticipants={joined.meeting.maxParticipants}
      people={state.people}
      lobby={lobby}
      admission={admission ?? joined.meeting.admission}
      isHost={state.people.find((p) => p.userId === user?.id)?.isHost ?? false}
      selfUserId={selfUserId}
      media={media}
      sharerUserId={sharerUserId}
      screenPolicy={screenPolicy ?? joined.meeting.screenSharePolicy}
      onSetScreenPolicy={setScreenPolicyMode}
      onToggleLive={presenting ? media.stopScreenShare : requestScreen}
      onAdmit={admitFromLobby}
      onDeny={denyFromLobby}
      onSetAdmission={setAdmissionMode}
      onMute={mute}
      onStopShare={stopShareOf}
      onKick={kick}
      onLeave={handleLeave}
      onEndForAll={endMeeting}
      messages={messages}
      onSendChat={sendChat}
      aiAvailable={joined.meeting.aiAvailable}
      aiEnabled={aiEnabled ?? joined.meeting.aiEnabled}
      onAskAi={askAi}
      onSetAiEnabled={setAiEnabled}
      aiNudges={aiNudges ?? joined.meeting.aiNudges}
      onSetAiNudges={setAiNudges}
      convo={translator ? convo : undefined} // RoomShell reads its presence as the mode flag
      myLang={myLang}
      onChangeLang={handleChangeLang}
      readAloud={readAloud}
      onReadAloud={setReadAloud}
      headphones={headphones}
      onHeadphones={setHeadphones}
    />
  );
}
