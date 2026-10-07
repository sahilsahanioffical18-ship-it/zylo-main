'use client';

import { useState } from 'react';
import { CalendarPlus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ADMISSION_OPTIONS, ChoiceGroup, SCREEN_POLICY_OPTIONS } from '@/components/choice-group';
import { useApi } from '@/lib/api';
import { brand } from '@/lib/brand';
import { parseInviteEmails, toDateTimeLocalValue } from '@/lib/format';
import type { Admission, MeetingCard, ScreenSharePolicy } from '@/lib/types';

type ErrorKey = 'title' | 'when' | 'emails';
type Errors = Partial<Record<ErrorKey | 'form', string>>;

const FIELD_IDS: Record<ErrorKey, string> = { title: 'meet-title', when: 'meet-when', emails: 'meet-emails' };

function nextHalfHour(): Date {
  const date = new Date();
  date.setMinutes(date.getMinutes() < 30 ? 30 : 60, 0, 0);
  return date;
}

export function ScheduleDialog({ onScheduled }: { onScheduled: () => void }) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState('');
  const [admission, setAdmission] = useState<Admission>('auto');
  const [policy, setPolicy] = useState<ScreenSharePolicy>('anyone');
  const [emails, setEmails] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);

  function resetForm() {
    setTitle('');
    setWhen(toDateTimeLocalValue(nextHalfHour()));
    setAdmission('auto');
    setPolicy('anyone');
    setEmails('');
    setErrors({});
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const next: Errors = {};
    if (!title.trim()) next.title = 'Give your meeting a title.';
    const time = Date.parse(when); // datetime-local values without an offset parse as local time
    if (!when || Number.isNaN(time)) next.when = 'Pick a date and time.';
    else if (time <= Date.now()) next.when = 'Pick a time in the future.';
    const parsed = parseInviteEmails(emails);
    if (parsed.invalid.length) next.emails = `Check these emails: ${parsed.invalid.join(', ')}`;
    else if (parsed.emails.length > 20) next.emails = 'You can invite up to 20 people.';

    setErrors(next);
    const firstInvalid = (['title', 'when', 'emails'] as const).find((key) => next[key]);
    if (firstInvalid) {
      document.getElementById(FIELD_IDS[firstInvalid])?.focus();
      return;
    }

    setPending(true);
    try {
      const { meeting } = await api<{ meeting: MeetingCard }>('/meetings', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          scheduledFor: new Date(time).toISOString(),
          admission,
          screenSharePolicy: policy,
          inviteEmails: parsed.emails,
        }),
      });
      toast.success(`${brand.meet} scheduled`, {
        action: {
          label: 'Copy link',
          onClick: () => void navigator.clipboard.writeText(`${window.location.origin}/m/${meeting.id}`),
        },
      });
      setOpen(false);
      onScheduled();
    } catch (err) {
      setErrors({ form: err instanceof Error ? err.message : 'Could not schedule the meeting.' });
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) resetForm();
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" className="h-11 w-full">
          <CalendarPlus className="size-4" aria-hidden="true" /> Schedule
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>Schedule a {brand.meet}</DialogTitle>
            <DialogDescription>Everyone you invite sees it in their Upcoming list.</DialogDescription>
          </DialogHeader>

          <FieldGroup className="py-4">
            <Field data-invalid={Boolean(errors.title)}>
              <FieldLabel htmlFor={FIELD_IDS.title}>Title</FieldLabel>
              <Input
                id={FIELD_IDS.title}
                value={title}
                maxLength={120}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Design review"
                aria-invalid={Boolean(errors.title)}
                className="h-11"
              />
              {errors.title && <FieldError>{errors.title}</FieldError>}
            </Field>

            <Field data-invalid={Boolean(errors.when)}>
              <FieldLabel htmlFor={FIELD_IDS.when}>Date and time</FieldLabel>
              <Input
                id={FIELD_IDS.when}
                type="datetime-local"
                value={when}
                min={toDateTimeLocalValue(new Date())}
                onChange={(e) => setWhen(e.target.value)}
                aria-invalid={Boolean(errors.when)}
                className="h-11"
              />
              {errors.when ? (
                <FieldError>{errors.when}</FieldError>
              ) : (
                <FieldDescription>Invitees see it in their own time zone.</FieldDescription>
              )}
            </Field>

            <ChoiceGroup
              legend="Admission"
              name="admission"
              value={admission}
              onChange={setAdmission}
              options={ADMISSION_OPTIONS}
            />

            <ChoiceGroup
              legend={`${brand.live} (screen share)`}
              name="policy"
              value={policy}
              onChange={setPolicy}
              options={SCREEN_POLICY_OPTIONS}
            />

            <Field data-invalid={Boolean(errors.emails)}>
              <FieldLabel htmlFor={FIELD_IDS.emails}>
                Invite by email <span className="font-normal text-muted-foreground">(optional)</span>
              </FieldLabel>
              <Textarea
                id={FIELD_IDS.emails}
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
                rows={3}
                placeholder="priya@company.com, sam@company.com"
                aria-invalid={Boolean(errors.emails)}
              />
              {errors.emails ? (
                <FieldError>{errors.emails}</FieldError>
              ) : (
                <FieldDescription>Up to 20 people. Separate with commas or new lines.</FieldDescription>
              )}
            </Field>

            {errors.form && (
              <p role="alert" className="text-sm text-destructive">
                {errors.form}
              </p>
            )}
          </FieldGroup>

          <DialogFooter>
            <Button type="button" variant="ghost" className="h-11" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" className="h-11 px-6" disabled={pending}>
              {pending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              Schedule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
