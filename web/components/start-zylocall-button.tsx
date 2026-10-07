'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Loader2, PhoneCall } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useApi } from '@/lib/api';
import { brand } from '@/lib/brand';
import type { MeetingCard } from '@/lib/types';

export function StartZyloCallButton() {
  const api = useApi();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function start() {
    setPending(true);
    try {
      const { meeting } = await api<{ meeting: MeetingCard }>('/meetings', {
        method: 'POST',
        body: JSON.stringify({ title: brand.call }),
      });
      router.push(`/m/${meeting.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not start a ${brand.call}.`);
      setPending(false);
    }
  }

  return (
    <Button className="h-11 w-full" onClick={start} disabled={pending}>
      {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <PhoneCall className="size-4" aria-hidden="true" />}
      Start now
    </Button>
  );
}
