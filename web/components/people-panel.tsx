'use client';

import { useState } from 'react';
import { Check, MicOff, MoreHorizontal, ScreenShareOff, UserX, Volume2, VolumeX, X } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ADMISSION_OPTIONS, AI_NUDGE_OPTIONS, AI_OPTIONS, ChoiceGroup, SCREEN_POLICY_OPTIONS } from '@/components/choice-group';
import { initials } from '@/lib/format';
import { hostActionsFor, type HostAction } from '@/lib/host-actions';
import { brand } from '@/lib/brand';
import type { Admission, ScreenSharePolicy } from '@/lib/types';
import type { LobbyEntry, Person } from '@/lib/use-meeting';

// Side by side without hints below lg (the phone Sheet), so the host's settings
// don't push "In the meeting" off screen; stacked with hints in the docked panel.
const ROOM_SETTING_GRID = 'grid grid-cols-2 gap-2 lg:grid-cols-1 max-lg:[&_[data-hint]]:hidden';

function PersonAvatar({ name, imageUrl }: { name: string; imageUrl: string | null }) {
  return (
    <Avatar className="size-8">
      {imageUrl && <AvatarImage src={imageUrl} alt="" />}
      <AvatarFallback>{initials(name)}</AvatarFallback>
    </Avatar>
  );
}

function LobbyAction({
  label,
  icon: Icon,
  variant,
  onClick,
}: {
  label: string;
  icon: typeof Check;
  variant: 'secondary' | 'ghost';
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" size="icon" variant={variant} className="size-9" aria-label={label} onClick={onClick}>
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

// Local-only, session-only: never touches the server, so it's offered for every row
// (host or not) except the viewer's own, unlike the host-only PersonMenu below.
function MuteForMeAction({ name, muted, onClick }: { name: string; muted: boolean; onClick: () => void }) {
  const Icon = muted ? VolumeX : Volume2;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-11"
          aria-pressed={muted}
          aria-label={`Mute ${name} for me`} // constant: aria-pressed carries the state
          onClick={onClick}
        >
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{muted ? 'Unmute for me' : 'Only you won’t hear them'}</TooltipContent>
    </Tooltip>
  );
}

// Kick confirms first; Mute and Stop are reversible (they can unmute, share again).
function PersonMenu({
  person,
  actions,
  onMute,
  onStopShare,
  onKick,
}: {
  person: Person;
  actions: HostAction[];
  onMute: (userId: string) => void;
  onStopShare: (userId: string) => void;
  onKick: (userId: string) => void;
}) {
  const [confirmKick, setConfirmKick] = useState(false);
  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-11"
                aria-label={`Actions for ${person.name}`}
              >
                <MoreHorizontal className="size-5" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Actions</TooltipContent>
        </Tooltip>
        {/* Portals out of ZyloRoom's dark subtree, so it re-declares dark. */}
        <DropdownMenuContent align="end" className="dark min-w-44">
          {actions.includes('mute') && (
            <DropdownMenuItem onSelect={() => onMute(person.userId)}>
              <MicOff className="size-4" /> Mute
            </DropdownMenuItem>
          )}
          {actions.includes('stop-share') && (
            <DropdownMenuItem onSelect={() => onStopShare(person.userId)}>
              <ScreenShareOff className="size-4" /> Stop {brand.live}
            </DropdownMenuItem>
          )}
          {actions.includes('kick') && (
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirmKick(true)}>
              <UserX className="size-4" /> Kick
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirmKick} onOpenChange={setConfirmKick}>
        <AlertDialogContent className="dark">
          <AlertDialogHeader>
            <AlertDialogTitle>Kick {person.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              They leave this {brand.room} now and can’t rejoin this meeting.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => onKick(person.userId)}>
              Kick
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function PeoplePanel({
  people,
  lobby,
  admission,
  isHost,
  selfUserId,
  sharerUserId,
  micMuted,
  mutedForMe,
  onToggleMuteForMe,
  screenPolicy,
  onSetScreenPolicy,
  onAdmit,
  onDeny,
  onSetAdmission,
  onMute,
  onStopShare,
  onKick,
  aiEnabled,
  onSetAiEnabled,
  aiNudges,
  onSetAiNudges,
  translator = false,
}: {
  people: Person[];
  lobby: LobbyEntry[];
  admission: Admission;
  isHost: boolean;
  selfUserId: string;
  sharerUserId: string | null;
  micMuted: Set<string>;
  mutedForMe: Set<string>;
  onToggleMuteForMe: (userId: string) => void;
  screenPolicy: ScreenSharePolicy;
  onSetScreenPolicy: (policy: ScreenSharePolicy) => void;
  onAdmit: (userId: string) => void;
  onDeny: (userId: string) => void;
  onSetAdmission: (mode: Admission) => void;
  onMute: (userId: string) => void;
  onStopShare: (userId: string) => void;
  onKick: (userId: string) => void;
  aiEnabled: boolean;
  onSetAiEnabled: (enabled: boolean) => void;
  aiNudges: boolean;
  onSetAiNudges: (enabled: boolean) => void;
  // A translator convo is always auto (link-shared, 2 seats) and the server ignores
  // this setting for it, so it's hidden here rather than shown but inert.
  translator?: boolean;
}) {
  // The room is exactly one screen tall, so nothing here can rely on the page
  // scrolling: the panel scrolls itself once settings + lobby outgrow it, and the
  // people list keeps min-h-40 so it never collapses to nothing.
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      {isHost && !translator && (
        <ChoiceGroup
          legend="Admission"
          name="room-admission"
          value={admission}
          onChange={onSetAdmission}
          options={ADMISSION_OPTIONS}
          className={ROOM_SETTING_GRID}
        />
      )}

      {isHost && (
        <ChoiceGroup
          legend={`${brand.live} (screen share)`}
          name="room-screen-policy"
          value={screenPolicy}
          onChange={onSetScreenPolicy}
          options={SCREEN_POLICY_OPTIONS}
          className={ROOM_SETTING_GRID}
        />
      )}

      {/* No Ask AI in a translator convo, so no setting for it either. */}
      {isHost && !translator && (
        <ChoiceGroup
          legend="AI in chat"
          name="room-ai"
          value={aiEnabled ? 'on' : 'off'}
          onChange={(value) => onSetAiEnabled(value === 'on')}
          options={AI_OPTIONS}
          className={ROOM_SETTING_GRID}
        />
      )}

      {/* A nudge is Zylo AI speaking in the chat, so it needs AI in chat on. */}
      {isHost && !translator && (
        <ChoiceGroup
          legend="AI nudges"
          name="room-ai-nudges"
          value={aiNudges ? 'on' : 'off'}
          onChange={(value) => onSetAiNudges(value === 'on')}
          options={AI_NUDGE_OPTIONS}
          className={ROOM_SETTING_GRID}
          disabledReason={aiEnabled ? undefined : 'Turn on AI in chat first'}
        />
      )}

      {isHost && lobby.length > 0 && (
        <section aria-label="Waiting to join" className="space-y-2">
          <h2 className="text-sm font-semibold tabular-nums">Waiting ({lobby.length})</h2>
          <ul className="space-y-1">
            {lobby.map((entry) => (
              <li key={entry.userId} className="flex items-center gap-3 rounded-lg px-1 py-1.5">
                <PersonAvatar name={entry.name} imageUrl={entry.imageUrl} />
                <span className="flex-1 truncate text-sm">{entry.name}</span>
                <LobbyAction
                  label={`Admit ${entry.name}`}
                  icon={Check}
                  variant="secondary"
                  onClick={() => onAdmit(entry.userId)}
                />
                <LobbyAction
                  label={`Deny ${entry.name}`}
                  icon={X}
                  variant="ghost"
                  onClick={() => onDeny(entry.userId)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="People in the meeting" className="flex min-h-40 flex-1 flex-col space-y-2">
        <h2 className="text-sm font-semibold tabular-nums">In the meeting ({people.length})</h2>
        <ScrollArea className="min-h-0 flex-1">
          <ul className="space-y-1 pr-3">
            {people.map((person) => {
              const actions = hostActionsFor(
                { userId: person.userId, micMuted: micMuted.has(person.userId) },
                { isHost, selfUserId, sharerUserId },
              );
              return (
                <li key={person.userId} className="flex items-center gap-3 rounded-lg px-1 py-1.5">
                  <PersonAvatar name={person.name} imageUrl={person.imageUrl} />
                  <span className="min-w-0 flex-1 truncate text-sm">{person.name}</span>
                  {sharerUserId === person.userId && (
                    <Badge className="bg-success text-success-foreground">{brand.live}</Badge>
                  )}
                  {person.isHost && <Badge variant="secondary">Host</Badge>}
                  {person.userId !== selfUserId && (
                    <MuteForMeAction
                      name={person.name}
                      muted={mutedForMe.has(person.userId)}
                      onClick={() => onToggleMuteForMe(person.userId)}
                    />
                  )}
                  {actions.length > 0 && (
                    <PersonMenu person={person} actions={actions} onMute={onMute} onStopShare={onStopShare} onKick={onKick} />
                  )}
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      </section>
    </div>
  );
}
