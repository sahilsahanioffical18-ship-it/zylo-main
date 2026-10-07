import Link from 'next/link';
import { SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ZyloLogo } from '@/components/zylo-logo';

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 text-center">
      <ZyloLogo />
      <span className="grid size-14 place-items-center rounded-2xl bg-accent text-accent-foreground">
        <SearchX className="size-7" aria-hidden="true" />
      </span>
      <div className="space-y-2">
        <h1 className="text-2xl font-extrabold tracking-tight">Page not found</h1>
        <p className="text-muted-foreground">Check the link or meeting code and try again.</p>
      </div>
      <Button asChild className="h-11 px-6">
        <Link href="/dashboard">Back to dashboard</Link>
      </Button>
    </main>
  );
}
