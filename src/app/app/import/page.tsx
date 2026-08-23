import { requireUser } from '@/lib/auth/session';
import { TopBar } from '@/components/AppShell';
import { ImportWizard } from '@/components/ImportWizard';
import { SourceNote } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  await requireUser();
  return (
    <>
      <TopBar title="Import collection" subtitle="CSV from any tracker or marketplace" back="/app/collection" />
      <main className="px-4 pb-8 pt-4">
        <ImportWizard />
        <SourceNote className="mt-6 border-t border-ink-line pt-4">
          Matching is deliberately strict. Set plus card number is the only pair that identifies a
          card uniquely, so it is tried first; a name on its own is accepted only when exactly one
          card in all 174 sets carries it. Anything else is returned to you as ambiguous with its
          candidates. Rows that name a printing the card does not have are imported as the card&apos;s
          actual printing, and say so. Nothing is written until you press import, and the whole file
          is applied in one transaction.
        </SourceNote>
      </main>
    </>
  );
}
