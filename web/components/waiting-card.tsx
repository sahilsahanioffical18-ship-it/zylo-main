'use client';

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ZyloLogo } from '@/components/zylo-logo';
import { brand } from '@/lib/brand';

export function WaitingCard({
  manual,
  position,
  onLeave,
}: {
  manual: boolean;
  position: number;
  onLeave: () => void;
}) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4">
      <ZyloLogo href="/dashboard" />
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
          <Loader2 className="size-8 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
          <div className="space-y-2">
            <h1 className="text-xl font-extrabold tracking-tight" role="status">
              {manual ? `Waiting for the host to let you into this ${brand.room}` : `${brand.room} is full`}
            </h1>
            <p className="text-muted-foreground">
              {manual
                ? 'They will see your name in their people panel.'
                : `You are #${position} in line and join as soon as a seat frees up.`}
            </p>
          </div>
          <Button variant="ghost" className="h-11 w-full" onClick={onLeave}>
            Leave
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
