'use client';

import { LANGUAGE_GROUPS } from '@/lib/convo-languages';

// Native <select>, 44px touch target, Input's border/focus treatment — there's no
// shadcn select component in this repo, and a native one covers 18 options fine.
export function LanguageSelect({ id, value, onChange }: { id: string; value: string; onChange: (code: string) => void }) {
  return (
    <select
      id={id}
      className="h-11 w-full rounded-lg border border-input bg-transparent px-3 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {LANGUAGE_GROUPS.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.languages.map((l) => (
            <option key={l.code} value={l.code}>
              {/* Native name first; the English name helps a partner pick for you. */}
              {l.nativeName === l.name ? l.name : `${l.nativeName} — ${l.name}`}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
