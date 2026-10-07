'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@clerk/nextjs';
import { CalendarClock, Languages, LogIn, PhoneCall } from 'lucide-react';
import { toast } from 'sonner';
import { JoinWithCode } from '@/components/join-with-code';
import { MeetingsSection } from '@/components/meetings-section';
import { ScheduleDialog } from '@/components/schedule-dialog';
import { StartZyloCallButton } from '@/components/start-zylocall-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useApi } from '@/lib/api';
import { brand } from '@/lib/brand';
import type { Dashboard } from '@/lib/types';

function greeting(hour: number) {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function DashboardView() {
  const api = useApi();
  const { user } = useUser();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<Dashboard>('/dashboard');
      setDashboard(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  }, [api]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time fetch on mount; state updates happen after an await, not synchronously
    void load();
  }, [load]);

  const cancelMeeting = useCallback(
    async (id: string) => {
      try {
        await api(`/meetings/${id}`, { method: 'DELETE' });
        toast.success('Meeting cancelled');
        await load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not cancel the meeting.');
      }
    },
    [api, load],
  );

  const now = new Date();

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div>
        {/* Local time and name differ between server render and browser */}
        <h2 className="text-2xl font-extrabold tracking-tight sm:text-3xl" suppressHydrationWarning>
          {greeting(now.getHours())}
          {user?.firstName ? `, ${user.firstName}` : ''}
        </h2>
        <p className="text-muted-foreground" suppressHydrationWarning>
          {new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(now)}
        </p>
      </div>

      <section aria-label="Start or join a meeting" className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="space-y-2">
            <span className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground">
              <PhoneCall className="size-5" aria-hidden="true" />
            </span>
            <CardTitle className="text-base font-bold">{brand.call}</CardTitle>
            <CardDescription>Start an instant meeting and share the link.</CardDescription>
          </CardHeader>
          <CardContent>
            <StartZyloCallButton />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="space-y-2">
            <span className="grid size-10 place-items-center rounded-xl bg-accent text-accent-foreground">
              <CalendarClock className="size-5" aria-hidden="true" />
            </span>
            <CardTitle className="text-base font-bold">{brand.meet}</CardTitle>
            <CardDescription>Schedule for later and invite people by email.</CardDescription>
          </CardHeader>
          <CardContent>
            <ScheduleDialog onScheduled={() => void load()} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="space-y-2">
            <span className="grid size-10 place-items-center rounded-xl bg-accent text-accent-foreground">
              <LogIn className="size-5" aria-hidden="true" />
            </span>
            <CardTitle className="text-base font-bold">Join with code</CardTitle>
            <CardDescription>Enter a code or paste a meeting link.</CardDescription>
          </CardHeader>
          <CardContent>
            <JoinWithCode />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="space-y-2">
            <span className="grid size-10 place-items-center rounded-xl bg-accent text-accent-foreground">
              <Languages className="size-5" aria-hidden="true" />
            </span>
            <CardTitle className="text-base font-bold">Zylo Translator Convo</CardTitle>
            <CardDescription>Talk face to face in two languages: live captions and spoken translation, free.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="h-11 w-full">
              <Link href="/zylo-translator-convo">Try it</Link>
            </Button>
          </CardContent>
        </Card>
      </section>

      <MeetingsSection
        dashboard={dashboard}
        error={error}
        onRetry={() => {
          setError(null);
          setDashboard(null);
          void load();
        }}
        onCancel={cancelMeeting}
      />
    </div>
  );
}
