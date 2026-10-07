'use client';

import type { LucideIcon } from 'lucide-react';
import { CalendarPlus, History, Radio, RefreshCw } from 'lucide-react';
import { MeetingRow } from '@/components/meeting-row';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { brand } from '@/lib/brand';
import type { Dashboard, MeetingCard } from '@/lib/types';

type Props = {
  dashboard: Dashboard | null;
  error: string | null;
  onRetry: () => void;
  onCancel: (id: string) => Promise<void>;
};

function RowSkeletons() {
  return (
    <ul className="space-y-3" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <li key={i} className="flex items-center gap-3 rounded-xl border border-border p-4">
          <Skeleton className="size-11 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-10 text-center">
      <span className="grid size-11 place-items-center rounded-xl bg-accent text-accent-foreground">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <p className="font-semibold">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

function RowList({ meetings, onCancel }: { meetings: MeetingCard[]; onCancel: Props['onCancel'] }) {
  return (
    <ul className="space-y-3">
      {meetings.map((m) => (
        <MeetingRow key={m.id} meeting={m} onCancel={onCancel} />
      ))}
    </ul>
  );
}

export function MeetingsSection({ dashboard, error, onRetry, onCancel }: Props) {
  if (error) {
    return (
      <Card role="alert">
        <CardHeader>
          <CardTitle>Couldn’t load your meetings</CardTitle>
          <CardDescription>{error}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" className="h-11" onClick={onRetry}>
            <RefreshCw className="size-4" /> Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  const live = dashboard?.live ?? [];

  return (
    <div className="space-y-6">
      {live.length > 0 && (
        <section aria-labelledby="live-now" className="space-y-3">
          <h2 id="live-now" className="flex items-center gap-2 text-lg font-bold">
            <Radio className="size-5 text-success" aria-hidden="true" /> Live now
          </h2>
          <RowList meetings={live} onCancel={onCancel} />
        </section>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-bold">{brand.meet}</CardTitle>
          <CardDescription>Your scheduled and past meetings.</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="upcoming">
            <TabsList>
              <TabsTrigger value="upcoming">
                Upcoming{dashboard && <span className="ml-1 tabular-nums">({dashboard.upcoming.length})</span>}
              </TabsTrigger>
              <TabsTrigger value="previous">Previous</TabsTrigger>
            </TabsList>
            <TabsContent value="upcoming" className="mt-4">
              {!dashboard ? (
                <RowSkeletons />
              ) : dashboard.upcoming.length === 0 ? (
                <EmptyState
                  icon={CalendarPlus}
                  title="Nothing scheduled"
                  text={`Schedule a ${brand.meet} and it shows up here for you and everyone you invite.`}
                />
              ) : (
                <RowList meetings={dashboard.upcoming} onCancel={onCancel} />
              )}
            </TabsContent>
            <TabsContent value="previous" className="mt-4">
              {!dashboard ? (
                <RowSkeletons />
              ) : dashboard.previous.length === 0 ? (
                <EmptyState icon={History} title="No past meetings yet" text="Meetings you join appear here after they end." />
              ) : (
                <RowList meetings={dashboard.previous} onCancel={onCancel} />
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
