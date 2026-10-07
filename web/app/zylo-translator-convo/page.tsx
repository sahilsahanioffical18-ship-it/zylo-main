import type { Metadata } from 'next';
import { AppSidebar } from '@/components/app-sidebar';
import { SiteHeader } from '@/components/site-header';
import { TranslatorLanding } from '@/components/translator-landing';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';

export const metadata: Metadata = { title: 'Zylo Translator Convo' };

export default function TranslatorConvoLandingPage() {
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
        <SiteHeader title="Zylo Translator Convo" />
        <div className="flex flex-1 flex-col p-4 lg:p-6">
          <TranslatorLanding />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
