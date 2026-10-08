'use client';

import { Languages, MessageSquare, Mic, MicOff, PhoneOff, ScreenShare, ScreenShareOff, Users, Video, VideoOff } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MediaToggle } from '@/components/media-toggle';
import { brand } from '@/lib/brand';
import { canShareScreen } from '@/lib/screen-share';

// Icon-only on phones, "Leave" from sm up: the label costs no width once it's
// gone, and PhoneOff plus aria-label keeps it readable to screen readers either way.
const LEAVE_BUTTON_CLASS = 'h-11 w-11 rounded-full px-0 sm:h-12 sm:w-auto sm:px-6';

export type PanelTab = 'captions' | 'chat' | 'people';

export function ControlBar({
  micOn,
  camOn,
  onToggleMic,
  onToggleCam,
  mediaReady,
  sharing,
  onToggleLive,
  peopleCount,
  waitingCount,
  onOpenPanel,
  onLeave,
  isHost,
  onEndForAll,
  translator = false,
}: {
  micOn: boolean;
  camOn: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  mediaReady: boolean;
  sharing: boolean;
  onToggleLive: () => void;
  peopleCount: number;
  waitingCount: number;
  onOpenPanel: (tab: PanelTab) => void;
  onLeave: () => void;
  isHost: boolean;
  onEndForAll: () => void;
  // Translator Convo only: the "chat" button (there's no room in the 320px budget —
  // see the comment below — for a dedicated Captions button) opens the Captions tab
  // instead of ZyloChat.
  translator?: boolean;
}) {
  const chatTab: PanelTab = translator ? 'captions' : 'chat';
  const ChatIcon = translator ? Languages : MessageSquare;
  const chatLabel = translator ? 'Captions' : brand.chat;
  // 320px budget: 6 controls × 44 + 5 gaps × 8 = 304 = 320 − px-2 × 2, zero slack.
  // A 7th control below sm needs a "More" menu, or the bar wraps to two rows.
  return (
    <footer className="flex flex-wrap items-center justify-center gap-2 border-t border-border px-2 py-3 sm:gap-3 sm:px-4">
      <MediaToggle
        on={micOn}
        label="microphone"
        onIcon={Mic}
        offIcon={MicOff}
        disabled={!mediaReady}
        onClick={onToggleMic}
      />
      <MediaToggle
        on={camOn}
        label="camera"
        onIcon={Video}
        offIcon={VideoOff}
        disabled={!mediaReady}
        onClick={onToggleCam}
      />

      {/* Enabled whoever is presenting and whatever the policy: the server answers
          with the spec's toasts (busy / host_only / unavailable). Available on both
          laptop and mobile/phone devices. */}
      {canShareScreen() && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant={sharing ? 'default' : 'secondary'}
              className="size-11 rounded-full sm:size-12"
              aria-label={sharing ? `Stop ${brand.live}` : brand.live}
              aria-pressed={sharing}
              disabled={!mediaReady}
              onClick={onToggleLive}
            >
              {sharing ? <ScreenShareOff className="size-5" /> : <ScreenShare className="size-5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{sharing ? `Stop ${brand.live}` : `${brand.live} · share your screen`}</TooltipContent>
        </Tooltip>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="secondary"
            className="size-11 rounded-full sm:size-12"
            aria-label={chatLabel}
            onClick={() => onOpenPanel(chatTab)}
          >
            <ChatIcon className="size-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{chatLabel}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="secondary"
            className="relative size-11 rounded-full sm:size-12"
            aria-label={`People (${peopleCount})`}
            onClick={() => onOpenPanel('people')}
          >
            <Users className="size-5" />
            {waitingCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 grid size-5 place-items-center rounded-full bg-primary text-xs font-bold tabular-nums text-primary-foreground">
                {waitingCount}
              </span>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>People</TooltipContent>
      </Tooltip>

      {/* Hosts get one Leave button, not two: it opens the choice (Keep meeting /
          Leave / End for all) instead of a permanent second button next to it. */}
      {isHost ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" className={LEAVE_BUTTON_CLASS} aria-label="Leave">
              <PhoneOff className="size-5" />
              <span className="hidden sm:inline">Leave</span>
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="dark">
            <AlertDialogHeader>
              <AlertDialogTitle>Leave this meeting?</AlertDialogTitle>
              <AlertDialogDescription>
                The meeting keeps going without you. Or end it for everyone — that moves it to {brand.meet} →
                Previous.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep meeting</AlertDialogCancel>
              <AlertDialogAction variant="outline" onClick={onLeave}>
                Leave
              </AlertDialogAction>
              <AlertDialogAction variant="destructive" onClick={onEndForAll}>
                End for all
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : (
        <Button variant="destructive" className={LEAVE_BUTTON_CLASS} aria-label="Leave" onClick={onLeave}>
          <PhoneOff className="size-5" />
          <span className="hidden sm:inline">Leave</span>
        </Button>
      )}
    </footer>
  );
}
