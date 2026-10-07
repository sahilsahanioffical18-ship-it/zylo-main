import type { Metadata } from 'next';
import { SignIn } from '@clerk/nextjs';
import { AuthShell } from '@/components/auth-shell';

export const metadata: Metadata = { title: 'Sign in' };

export default function SignInPage() {
  return (
    <AuthShell>
      <SignIn />
    </AuthShell>
  );
}
