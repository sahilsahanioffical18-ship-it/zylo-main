'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CalendarClock, Copy, History, MoreHorizontal, Radio, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { brand } from '@/lib/brand';
import { formatDuration, formatWhen, initials } from '@/lib/format';
import type { MeetingCard } from '@/lib/types';

const STATUS_ICON = { live: Radio, scheduled: CalendarClock, ended: History };

function subtitle(m: MeetingCard): string {
  const host = m.isHost ? 'Hosted by you' : `Hosted by ${m.host.name}`;
  if (m.status === 'live' && m.startedAt) return `Started ${formatWhen(m.startedAt)} · ${host}`;
  if (m.status === 'ended' && m.startedAt && m.endedAt) {
    return `${formatWhen(m.endedAt)} · ${formatDuration(m.startedAt, m.endedAt)} · ${host}`;
  }
  if (m.scheduledFor) return `${formatWhen(m.scheduledFor)} · ${host}`;
  return host;
}

export function MeetingRow({ meeting, onCancel }: { meeting: MeetingCard; onCancel: (id: string) => Promise<void> }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const Icon = STATUS_ICON[meeting.status];
  const shown = meeting.participants.slice(0, 3);
  const extra = meeting.participants.length - shown.length;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/m/${meeting.id}`);
      toast.success('Meeting link copied');
    } catch {
      toast.error('Could not copy the link');
    }
  }

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-shadow duration-200 hover:shadow-sm sm:flex-row sm:items-center">
      <span
        className={`grid size-11 shrink-0 place-items-center rounded-xl ${
          meeting.status === 'live' ? 'bg-success text-success-foreground' : 'bg-accent text-accent-foreground'
        }`}
      >
        <Icon className="size-5" aria-hidden="true" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate font-semibold">{meeting.title}</p>
          {meeting.status === 'live' && <Badge className="bg-success text-success-foreground">Live</Badge>}
          {meeting.isHost && <Badge variant="secondary">Host</Badge>}
          {meeting.admission === 'manual' && meeting.status !== 'ended' && <Badge variant="outline">Manual admission</Badge>}
        </div>
        <p className="mt-0.5 truncate text-sm text-muted-foreground">{subtitle(meeting)}</p>
      </div>

      {shown.length > 0 && (
        <div className="flex -space-x-2" role="img" aria-label={`${meeting.participants.length} participants`}>
          {shown.map((p, i) => (
            <Avatar key={`${p.name}-${i}`} className="size-8 ring-2 ring-card">
              {p.imageUrl && <AvatarImage src={p.imageUrl} alt="" />}
              <AvatarFallback className="text-xs">{initials(p.name)}</AvatarFallback>
            </Avatar>
          ))}
          {extra > 0 && (
            <span className="grid size-8 place-items-center rounded-full bg-muted text-xs font-semibold text-muted-foreground tabular-nums ring-2 ring-card">
              +{extra}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        {meeting.status !== 'ended' && (
          <Button asChild className="h-11 px-5">
            <Link href={`/m/${meeting.id}`}>{meeting.status === 'live' ? 'Join now' : 'Open'}</Link>
          </Button>
        )}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-11" aria-label={`More actions for ${meeting.title}`}>
                  <MoreHorizontal className="size-5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>More actions</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={copyLink}>
              <Copy className="size-4" /> Copy link
            </DropdownMenuItem>
            {meeting.isHost && meeting.status === 'scheduled' && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirmOpen(true)}>
                  <Trash2 className="size-4" /> Cancel meeting
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel “{meeting.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              It will disappear from everyone’s {brand.meet} list. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep meeting</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => onCancel(meeting.id)}>
              Cancel meeting
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
