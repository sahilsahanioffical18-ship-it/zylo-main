'use client';

import { FieldLegend, FieldSet } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import type { Admission, ScreenSharePolicy } from '@/lib/types';

// One copy of the admission and ZyloLive wording for the schedule dialog and the
// in-room people panel, so the two can never drift apart.
export const ADMISSION_OPTIONS: { value: Admission; label: string; hint: string }[] = [
  { value: 'auto', label: 'Join instantly', hint: 'People enter until the room is full.' },
  { value: 'manual', label: 'Host admits', hint: 'People wait in the lobby for you.' },
];

export const SCREEN_POLICY_OPTIONS: { value: ScreenSharePolicy; label: string; hint: string }[] = [
  { value: 'anyone', label: 'Anyone', hint: 'One presenter at a time.' },
  { value: 'host_only', label: 'Host only', hint: 'Only you can present.' },
];

// In-room only: the host's "AI in chat" setting.
export const AI_OPTIONS: { value: 'on' | 'off'; label: string; hint: string }[] = [
  { value: 'on', label: 'On', hint: 'Anyone here can ask Zylo AI.' },
  { value: 'off', label: 'Off', hint: 'Nobody can ask Zylo AI.' },
];

// In-room only: the host's "AI nudges" setting.
export const AI_NUDGE_OPTIONS: { value: 'on' | 'off'; label: string; hint: string }[] = [
  { value: 'on', label: 'On', hint: 'Zylo AI may speak up when the chat stalls or the room goes quiet.' },
  { value: 'off', label: 'Off', hint: 'Zylo AI only answers when asked.' },
];

export function ChoiceGroup<T extends string>({
  legend,
  name,
  value,
  onChange,
  options,
  className = 'grid gap-2 sm:grid-cols-2',
  disabledReason,
}: {
  legend: string;
  name: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; hint: string }[];
  className?: string;
  // Set: the options can't be changed, and this line under them says why.
  disabledReason?: string;
}) {
  return (
    <FieldSet>
      <FieldLegend>{legend}</FieldLegend>
      <RadioGroup value={value} onValueChange={(v) => onChange(v as T)} disabled={Boolean(disabledReason)} className={className}>
        {options.map((option) => (
          <Label
            key={option.value}
            htmlFor={`${name}-${option.value}`}
            className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 transition-colors duration-150 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-accent has-data-[disabled]:cursor-not-allowed has-data-[disabled]:opacity-50"
          >
            <RadioGroupItem id={`${name}-${option.value}`} value={option.value} className="mt-0.5" />
            <span className="space-y-0.5">
              <span className="block font-semibold">{option.label}</span>
              <span data-hint className="block text-xs font-normal text-muted-foreground">{option.hint}</span>
            </span>
          </Label>
        ))}
      </RadioGroup>
      {disabledReason && <p className="text-xs text-muted-foreground">{disabledReason}</p>}
    </FieldSet>
  );
}
