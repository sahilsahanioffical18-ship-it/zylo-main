import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function SiteHeader({ title }: { title: string }) {
  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b border-border">
      <div className="flex w-full items-center gap-2 px-4 lg:px-6">
        <Tooltip>
          <TooltipTrigger asChild>
            <SidebarTrigger className="-ml-1 size-10" aria-label="Toggle sidebar" />
          </TooltipTrigger>
          <TooltipContent>Toggle sidebar</TooltipContent>
        </Tooltip>
        <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-5" />
        <h1 className="text-base font-semibold">{title}</h1>
      </div>
    </header>
  );
}
