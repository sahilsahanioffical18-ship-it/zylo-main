import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { MeetingRoomFlow } from '@/components/meeting-room-flow';
import { brand } from '@/lib/brand';

export const metadata: Metadata = { title: brand.room };

export default async function MeetingPage({ params }: PageProps<'/m/[code]'>) {
  const { code } = await params;
  if (!/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code)) notFound();
  return <MeetingRoomFlow code={code} />;
}
