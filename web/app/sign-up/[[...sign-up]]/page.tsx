import type { Metadata } from 'next';
import { SignUp } from '@clerk/nextjs';
import { AuthShell } from '@/components/auth-shell';

export const metadata: Metadata = { title: 'Create account' };

export default function SignUpPage() {
  return (
    <AuthShell>
      <SignUp />
    </AuthShell>
  );
}
