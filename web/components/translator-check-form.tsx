'use client';

import { useState } from 'react';
import { ConvoChecklist } from '@/components/convo-checklist';
import { ConvoLoopback } from '@/components/convo-loopback';
import { LanguageSelect } from '@/components/language-select';
import { Label } from '@/components/ui/label';


export function TranslatorCheckForm() {
  const [myLang, setMyLang] = useState('hi');
  const [partnerLang, setPartnerLang] = useState('ru');

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="my-lang">I speak</Label>
          <LanguageSelect id="my-lang" value={myLang} onChange={setMyLang} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="partner-lang">My partner speaks</Label>
          <LanguageSelect id="partner-lang" value={partnerLang} onChange={setPartnerLang} />
        </div>
      </div>
      <ConvoLoopback myLang={myLang} partnerLang={partnerLang} />
      <ConvoChecklist myLang={myLang} partnerLang={partnerLang} />
    </div>
  );
}
