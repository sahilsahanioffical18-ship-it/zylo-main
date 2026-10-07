import type { Metadata } from 'next';
import { Plus_Jakarta_Sans } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { brand } from '@/lib/brand';
import './globals.css';

// cyrillic-ext + a generic fallback: without them, Russian falls outside this font's
// downloaded glyphs and Hindi (no Devanagari glyphs in this font at all) both land on
// whatever serif the browser picks by default, instead of a sans-serif caption.
const sans = Plus_Jakarta_Sans({ variable: '--font-sans', subsets: ['latin', 'cyrillic-ext'], fallback: ['system-ui', 'sans-serif'] });

export const metadata: Metadata = {
  title: { default: brand.product, template: `%s · ${brand.product}` },
  description: brand.tagline,
};

// Clerk computes its own shades from a concrete color, so this mirrors --primary / --radius from globals.css.
const clerkAppearance = {
  variables: { colorPrimary: '#6366f1', borderRadius: '0.75rem', fontFamily: 'var(--font-sans)' },
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${sans.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="min-h-full bg-background font-sans text-foreground">
        <ClerkProvider appearance={clerkAppearance}>
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
            <TooltipProvider>
              {children}
              <Toaster richColors position="top-center" />
            </TooltipProvider>
          </ThemeProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
