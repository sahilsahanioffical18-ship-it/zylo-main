'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Languages, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { LanguageSelect } from '@/components/language-select';
import { useApi } from '@/lib/api';
import { defaultLanguage } from '@/lib/convo-languages';
import type { MeetingCard } from '@/lib/types';


const LANG_STORAGE_KEY = 'zylo.convoLang';

export function TranslatorLanding() {
  const api = useApi();
  const router = useRouter();
  const [lang, setLang] = useState('en'); // SSR-safe default; corrected client-side below
  const [pending, setPending] = useState(false);

  useEffect(() => {
    // Deferred a tick so this isn't a synchronous setState-in-effect (matches the
    // async-callback pattern the rest of this codebase uses, e.g. use-meeting.ts).
    Promise.resolve().then(() => {
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(LANG_STORAGE_KEY);
      } catch {
        // localStorage unavailable (private mode, etc.) — fall through to the browser default.
      }
      setLang(stored ?? defaultLanguage(navigator.languages));
    });
  }, []);

  async function start() {
    setPending(true);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, lang);
    } catch {
      // Not fatal — the pre-join screen just falls back to the browser default.
    }
    try {
      const { meeting } = await api<{ meeting: MeetingCard }>('/meetings', {
        method: 'POST',
        body: JSON.stringify({ mode: 'translator' }),
      });
      router.push(`/zylo-translator-convo/${meeting.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start a Translator Convo.');
      setPending(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-lg space-y-6">
      <div className="space-y-3">
        <span className="grid size-12 place-items-center rounded-2xl bg-primary text-primary-foreground">
          <Languages className="size-6" aria-hidden="true" />
        </span>
        <h2 className="text-2xl font-extrabold tracking-tight">Zylo Translator Convo</h2>
        <p className="text-muted-foreground">Talk face to face with someone who speaks a different language.</p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Live captions in both languages, side by side.</li>
          <li>The translation is spoken aloud, over the other person&apos;s real voice.</li>
          <li>Free, and works best in Chrome on a computer.</li>
        </ul>
      </div>

      <Card>
        <CardContent className="space-y-4 p-6">
          <div className="space-y-1.5">
            <Label htmlFor="landing-lang">I speak</Label>
            <LanguageSelect id="landing-lang" value={lang} onChange={setLang} />
          </div>

          <Button className="h-12 w-full text-base" onClick={start} disabled={pending}>
            {pending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            Start convo
          </Button>

          <p className="text-center text-sm text-muted-foreground">
            <Link href="/zylo-translator-convo/check" className="underline underline-offset-4 hover:text-foreground">
              Check this device first
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
