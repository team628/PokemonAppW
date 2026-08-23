import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth/session';
import { AppShell } from '@/components/AppShell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/signin');
  return <AppShell>{children}</AppShell>;
}
