import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { CalendarClock, Mic, MonitorUp, PhoneCall, ShieldCheck, Video } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ZyloLogo } from '@/components/zylo-logo';
import { brand } from '@/lib/brand';

const features = [
  { icon: PhoneCall, title: brand.call, text: 'Start a meeting in one click and share the link.' },
  { icon: CalendarClock, title: brand.meet, text: 'Schedule ahead, invite by email, see it on everyone\'s dashboard.' },
  { icon: ShieldCheck, title: brand.room, text: 'Up to 20 people. The host admits, mutes and removes.' },
  { icon: MonitorUp, title: brand.live, text: 'One presenter at a time, so shared screens never collide.' },
];

// Decorative illustration of the ZyloRoom layout: no names, counts or "live" data.
function RoomIllustration() {
  return (
    <div aria-hidden="true" className="dark rounded-2xl border border-border bg-background p-3 shadow-2xl">
      <div className="grid grid-cols-3 gap-2">
        {['A', 'B', 'C', 'D', 'E', 'F'].map((letter, i) => (
          <div
            key={letter}
            className={`grid aspect-video place-items-center rounded-lg bg-card ${i === 1 ? 'ring-2 ring-success' : ''}`}
          >
            <span className="grid size-9 place-items-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
              {letter}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-center gap-2">
        {[Mic, Video, MonitorUp].map((Icon, i) => (
          <span key={i} className="grid size-9 place-items-center rounded-full bg-card text-foreground">
            <Icon className="size-4" />
          </span>
        ))}
        <span className="h-9 w-14 rounded-full bg-destructive" />
      </div>
    </div>
  );
}

export default async function LandingPage() {
  const { userId } = await auth();
  if (userId) redirect('/dashboard');

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <ZyloLogo />
        <nav className="flex items-center gap-2">
          <Button asChild variant="ghost" className="h-11 px-4">
            <Link href="/sign-in">Sign in</Link>
          </Button>
          <Button asChild className="h-11 px-5">
            <Link href="/sign-up">Get started</Link>
          </Button>
        </nav>
      </header>

      <main className="flex-1">
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-12 sm:px-6 lg:grid-cols-2 lg:py-20">
          <div className="space-y-6">
            <h1 className="text-4xl leading-tight font-extrabold tracking-tight text-balance sm:text-5xl">
              {brand.tagline}
            </h1>
            <p className="max-w-prose text-lg text-muted-foreground">
              {brand.product} brings scheduling, instant calls and host-controlled rooms into one calm workspace — for teams of up to 20.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild className="h-11 px-6 text-base">
                <Link href="/sign-up">Start free with {brand.call}</Link>
              </Button>
              <Button asChild variant="outline" className="h-11 px-6 text-base">
                <Link href="/sign-in">I have an account</Link>
              </Button>
            </div>
          </div>
          <RoomIllustration />
        </section>

        <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {features.map(({ icon: Icon, title, text }) => (
              <Card key={title} className="transition-shadow duration-200 hover:shadow-md">
                <CardHeader className="space-y-3">
                  <span className="grid size-10 place-items-center rounded-xl bg-accent text-accent-foreground">
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  <CardTitle className="text-base font-semibold">{title}</CardTitle>
                  <CardDescription>{text}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-sm text-muted-foreground sm:px-6">
          <span>© {new Date().getFullYear()} {brand.product}</span>
          <span>{brand.meet} · {brand.call} · {brand.room} · {brand.live} · {brand.chat}</span>
        </div>
      </footer>
    </div>
  );
}
