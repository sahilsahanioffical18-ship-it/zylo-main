import { CalendarClock, MonitorUp, ShieldCheck } from 'lucide-react';
import { ZyloLogo } from '@/components/zylo-logo';
import { brand } from '@/lib/brand';

const points = [
  { icon: ShieldCheck, title: brand.room, text: 'Only the host admits, mutes and removes people.' },
  { icon: MonitorUp, title: brand.live, text: 'One presenter at a time, so screens never collide.' },
  { icon: CalendarClock, title: brand.meet, text: 'Schedule ahead and invite people by email.' },
];

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh lg:grid-cols-2">
      <section className="hidden flex-col justify-between bg-foreground p-10 text-background lg:flex">
        <ZyloLogo className="text-background" />
        <div className="max-w-md space-y-8">
          <h1 className="text-4xl leading-tight font-extrabold tracking-tight text-balance">{brand.tagline}</h1>
          <ul className="space-y-5">
            {points.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <div>
                  <p className="font-semibold">{title}</p>
                  <p className="text-sm opacity-80">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-sm opacity-70">© {new Date().getFullYear()} {brand.product}</p>
      </section>
      <section className="flex flex-col items-center justify-center gap-8 px-4 py-12">
        <ZyloLogo className="lg:hidden" />
        {children}
      </section>
    </main>
  );
}
