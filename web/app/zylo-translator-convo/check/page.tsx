import type { Metadata } from 'next';
import { AppSidebar } from '@/components/app-sidebar';
import { SiteHeader } from '@/components/site-header';
import { TranslatorCheckForm } from '@/components/translator-check-form';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';

export const metadata: Metadata = { title: 'Translator check' };

export default function TranslatorCheckPage() {
  return (
    <SidebarProvider
      style={
        {
          '--sidebar-width': 'calc(var(--spacing) * 64)',
          '--header-height': 'calc(var(--spacing) * 14)',
        } as React.CSSProperties
      }
    >
      <AppSidebar variant="inset" />
      {/* SidebarInset renders the page's <main> element */}
      <SidebarInset>
        <SiteHeader title="Translator check" />
        <div className="flex flex-1 flex-col p-4 lg:p-6">
          <div className="mx-auto w-full max-w-2xl space-y-4">
            <p className="text-sm text-muted-foreground">
              This checks whether your device can run Zylo Translator Convo: live captions, on-device translation and a
              voice for each language.
            </p>
            <TranslatorCheckForm />
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
