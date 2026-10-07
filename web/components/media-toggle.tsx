'use client';

import type { Mic } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// Moved out of pre-join.tsx verbatim (was the private `ToggleButton`): the control
// bar needs the identical mic/camera button, so it's shared instead of duplicated.
export function MediaToggle({
  on,
  label,
  onIcon: OnIcon,
  offIcon: OffIcon,
  disabled,
  onClick,
}: {
  on: boolean;
  label: string;
  onIcon: typeof Mic;
  offIcon: typeof Mic;
  disabled: boolean;
  onClick: () => void;
}) {
  const text = `${on ? 'Turn off' : 'Turn on'} ${label}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant={on ? 'secondary' : 'destructive'}
          className="size-11 rounded-full sm:size-12"
          aria-label={text}
          aria-pressed={on}
          disabled={disabled}
          onClick={onClick}
        >
          {on ? <OnIcon className="size-5" /> : <OffIcon className="size-5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
