'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { normalizeCode } from '@/lib/format';

export function JoinWithCode() {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const code = normalizeCode(value);
    if (!code) {
      setError('Enter a code like abc-defg-hij or paste a meeting link.');
      return;
    }
    router.push(`/m/${code}`);
  }

  return (
    <form onSubmit={submit} noValidate>
      <Field data-invalid={Boolean(error)}>
        <FieldLabel htmlFor="join-code">Meeting code or link</FieldLabel>
        <div className="flex gap-2">
          <Input
            id="join-code"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            placeholder="abc-defg-hij"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(error)}
            className="h-11"
          />
          <Button type="submit" variant="outline" className="h-11 px-5">
            Join
          </Button>
        </div>
        {error && <FieldError>{error}</FieldError>}
      </Field>
    </form>
  );
}
