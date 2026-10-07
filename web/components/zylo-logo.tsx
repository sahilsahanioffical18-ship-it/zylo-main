import Link from 'next/link';
import { Video } from 'lucide-react';
import { brand } from '@/lib/brand';
import { cn } from '@/lib/utils';

export function ZyloLogo({ href = '/', className }: { href?: string; className?: string }) {
  return (
    <Link
      href={href}
      className={cn('inline-flex items-center gap-2 rounded-lg font-extrabold tracking-tight text-foreground', className)}
    >
      <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
        <Video className="size-4" aria-hidden="true" />
      </span>
      <span className="text-lg">{brand.product}</span>
    </Link>
  );
}
