'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RemoteAudioTrack, VideoTrack } from 'livekit-client';
import { MicOff, VolumeX } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { brand } from '@/lib/brand';
import { initials } from '@/lib/format';
import { presentingBanner, type StageView } from '@/lib/screen-share';
import { fitGrid } from '@/lib/stage-layout';
import type { LiveKitStatus } from '@/lib/use-livekit-room';
import type { Person } from '@/lib/use-meeting';

// One CSS gap for the grid stage, at every screen size — see stage-layout.ts.
const GRID_GAP = 12;

// attach()/detach() in an effect keyed on the track: one copy for every media element here.
function useAttach<E extends HTMLMediaElement>(track: VideoTrack | RemoteAudioTrack | undefined) {
  const ref = useRef<E | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return ref;
}

// object-contain: a shared screen is mostly text, so letterbox it, never crop it.
// muted: its audio, if shared, plays through AudioSink like every other track.
function ScreenVideo({ track }: { track: VideoTrack }) {
  const ref = useAttach<HTMLVideoElement>(track);
  return <video ref={ref} autoPlay playsInline muted className="size-full object-contain" />;
}

// The RoomAudioRenderer replacement we took on by declining @livekit/components-react:
// one hidden <audio> per subscribed remote audio track, never given the local track
// (that would cause echo). The room as a whole is never muted — `muted` here is
// per person, driven by the viewer's own "Mute for me" choice in the People list
// (Translator Convo's "Partner's voice" setting also lands here as `muted`, ORed
// together with "Mute for me" at the call site below — mutedForMe always wins).
// Keyed by track sid at the call site so a real track change remounts this and
// re-runs the attach effect, while an unrelated snapshot update does not.
// ponytail: iOS ignores HTMLMediaElement.volume outright, so Translator Convo's
// "Low" plays there exactly like "Full" — only the during-speech mute (still a real
// `muted` toggle, which iOS does honor) actually ducks the partner's voice on iOS.
function AudioSink({ track, muted, volume = 1 }: { track: RemoteAudioTrack; muted: boolean; volume?: number }) {
  const ref = useAttach<HTMLAudioElement>(track);
  // livekit-client unmutes attached elements behind React's back (attach() and
  // room.startAudio() both set muted = false), so re-assert on every volumechange.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      if (el.muted !== muted) el.muted = muted;
      if (el.volume !== volume) el.volume = volume;
    };
    apply();
    el.addEventListener('volumechange', apply);
    return () => el.removeEventListener('volumechange', apply);
  }, [ref, track, muted, volume]);
  return <audio ref={ref} autoPlay playsInline />;
}

type TileData = {
  person: Person;
  isSelf: boolean;
  track: VideoTrack | undefined;
  isSpeaking: boolean;
  isMicMuted: boolean;
  isMutedForMe: boolean;
};

function Tile({
  person,
  isSelf,
  track,
  isSpeaking,
  isMicMuted,
  isMutedForMe,
  compact,
  size,
}: TileData & {
  compact?: boolean;
  // Grid tiles pass their fitGrid pixel size; the presenting filmstrip omits it and
  // keeps aspect-video instead.
  size?: { width: number; height: number };
}) {
  const ref = useAttach<HTMLVideoElement>(track);
  // Below 200px wide a size-20 avatar and full caption no longer fit.
  const small = compact || (size !== undefined && size.width < 200);

  return (
    <div
      style={size && { width: size.width, height: size.height }}
      className={`relative grid place-items-center overflow-hidden rounded-2xl border border-border bg-card transition-[box-shadow] duration-200 ${
        size ? '' : 'aspect-video'
      } ${isSpeaking ? 'ring-2 ring-success' : ''}`}
    >
      {/* Roster is the source of truth: the tile exists whether or not `track` has
          arrived yet, so a slow or failed media connection still shows the avatar
          instead of an empty stage. */}
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={isSelf}
        className={`size-full object-cover ${isSelf ? '-scale-x-100' : ''} ${track ? '' : 'hidden'}`}
      />
      {!track && (
        <span
          className={`grid place-items-center rounded-full bg-muted font-bold text-muted-foreground ${
            small ? 'size-10 text-base' : 'size-20 text-2xl'
          }`}
        >
          {initials(person.name)}
        </span>
      )}
      <span className={`absolute flex items-center gap-2 ${small ? 'inset-x-2 bottom-2 text-xs' : 'inset-x-3 bottom-3'}`}>
        <span className={`min-w-0 truncate rounded-md bg-background/80 px-2 py-1 font-medium ${small ? 'text-xs' : 'text-sm'}`}>
          {person.name}
        </span>
        {person.isHost && <Badge variant="secondary">Host</Badge>}
        {isMicMuted && <MicOff className="size-4 shrink-0 text-muted-foreground" aria-label="Muted" />}
        {isMutedForMe && <VolumeX className="size-4 shrink-0 text-muted-foreground" aria-label="Muted for you" />}
      </span>
    </div>
  );
}

function GridStage({
  people,
  status,
  tileProps,
  subtitle,
}: {
  people: Person[];
  status: LiveKitStatus;
  tileProps: (person: Person) => TileData;
  subtitle?: React.ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  // p-1 on <main> leaves room for the 2px speaking ring: a tile that fills the stage
  // would otherwise have it clipped by overflow-hidden (contentRect excludes padding).
  // Grid-only measurement: mounts and unmounts with grid mode. ResizeObserver's first
  // notification arrives before paint, so there's no first-frame flash, and the
  // setSize call lives in its callback (not the effect body), so this stays clear of
  // react-hooks/set-state-in-effect.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fit = fitGrid(people.length, size.width, size.height, GRID_GAP);

  return (
    <main
      ref={ref}
      aria-label={`${brand.room} stage`}
      className={`relative min-h-0 min-w-0 flex-1 p-1 ${fit.scroll ? 'overflow-y-auto' : 'overflow-hidden'}`}
    >
      {status === 'connecting' && (
        <p
          role="status"
          className="absolute inset-x-0 top-2 mx-auto w-fit rounded-full bg-background/80 px-3 py-1 text-sm text-muted-foreground"
        >
          Connecting video…
        </p>
      )}
      <div
        className={`grid min-h-full justify-center ${fit.scroll ? 'content-start' : 'content-center'}`}
        style={{ gridTemplateColumns: `repeat(${fit.cols}, ${fit.tileWidth}px)`, gridAutoRows: `${fit.tileHeight}px`, gap: GRID_GAP }}
      >
        {people.map((person) => (
          <Tile key={person.userId} {...tileProps(person)} size={{ width: fit.tileWidth, height: fit.tileHeight }} />
        ))}
      </div>
      {subtitle}
    </main>
  );
}

export function VideoStage({
  people,
  selfUserId,
  videoTracks,
  audioTracks,
  speaking,
  micMuted,
  mutedForMe,
  status,
  view,
  screenTracks,
  subtitle,
  partnerVolume,
}: {
  people: Person[];
  selfUserId: string;
  videoTracks: Map<string, VideoTrack>;
  audioTracks: { sid: string; identity: string; track: RemoteAudioTrack }[];
  speaking: Set<string>;
  micMuted: Set<string>;
  mutedForMe: Set<string>;
  status: LiveKitStatus;
  view: StageView;
  screenTracks: Map<string, VideoTrack>;
  // Translator Convo only: renders nothing (undefined) for a standard meeting.
  subtitle?: React.ReactNode;
  // Translator Convo only: the partner's real-voice level, from RoomShell's
  // "Partner's voice" setting (see lib/partner-voice.ts).
  partnerVolume?: { userId: string; volume: number; muted: boolean };
}) {
  const tileProps = (person: Person) => ({
    person,
    isSelf: person.userId === selfUserId,
    track: videoTracks.get(person.userId),
    isSpeaking: speaking.has(person.userId),
    isMicMuted: micMuted.has(person.userId),
    isMutedForMe: mutedForMe.has(person.userId),
  });

  // display:none removes this from flex/grid layout entirely, so it never
  // introduces a phantom gap in the row RoomShell lays VideoStage out in.
  const audioSinks = (
    <div className="hidden">
      {/* ponytail: muted keys on the person's identity, so muting them for me also
          silences their ZyloLive screen-share audio (same participant, same key).
          Split it per source (mic vs screen) if anyone asks. */}
      {audioTracks.map(({ sid, identity, track }) => {
        const forThisPerson = partnerVolume?.userId === identity ? partnerVolume : undefined;
        // "Mute for me" always wins over the Translator Convo voice setting.
        const muted = mutedForMe.has(identity) || Boolean(forThisPerson?.muted);
        return <AudioSink key={sid} track={track} muted={muted} volume={forThisPerson?.volume} />;
      })}
    </div>
  );

  if (view.mode === 'presenting') {
    const screen = view.isSelf ? undefined : screenTracks.get(view.sharerUserId);
    return (
      <>
        {/* min-w-0: the filmstrip scrolls inside itself; the page never scrolls sideways. */}
        <main aria-label={`${brand.room} stage`} className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <p role="status" className="rounded-lg bg-success px-4 py-2 text-sm font-semibold text-success-foreground">
            {presentingBanner(view, brand.live)}
          </p>
          <div className="relative grid min-h-0 flex-1 place-items-center overflow-hidden rounded-2xl border border-border bg-card">
            {view.isSelf ? (
              <p className="max-w-sm px-6 text-center text-sm text-muted-foreground">
                Everyone can see your screen. Press {brand.live} in the controls when you’re done.
              </p>
            ) : screen ? (
              <ScreenVideo track={screen} />
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                Waiting for {view.sharerName}’s screen…
              </p>
            )}
            {subtitle}
          </div>
          <ul aria-label="People" className="flex shrink-0 gap-3 overflow-x-auto pb-1">
            {people.map((person) => (
              <li key={person.userId} className="w-36 shrink-0 sm:w-44">
                <Tile {...tileProps(person)} compact />
              </li>
            ))}
          </ul>
        </main>
        {audioSinks}
      </>
    );
  }

  return (
    <>
      <GridStage people={people} status={status} tileProps={tileProps} subtitle={subtitle} />
      {audioSinks}
    </>
  );
}
