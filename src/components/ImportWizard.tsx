'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { money } from '@/lib/pricing/quote';

interface PreviewRow {
  line: number;
  confidence: 'exact' | 'ambiguous' | 'unmatched';
  cardName?: string;
  setName?: string;
  resolvedVariant?: string;
  quantity: number;
  condition: string;
  paidCents: number | null;
  reason?: string;
  nameHint: string | null;
  numberHint: string | null;
  setHint: string | null;
  candidates?: { cardId: string; label: string }[];
}

interface CommitRow {
  cardId: string;
  variant: string;
  quantity: number;
  condition: string;
  paidCents: number | null;
}

interface PreviewResult {
  header: string[];
  recognised: string[];
  preview: {
    rows: PreviewRow[];
    matched: number;
    ambiguous: number;
    unmatched: number;
    totalQuantity: number;
  };
  allRows: CommitRow[];
}

const SAMPLE = `Set,Card Number,Name,Quantity,Condition,Printing,Price Paid
Base,4,Charizard,1,Lightly Played,Holofoil,220.00
Base,58,Pikachu,2,Near Mint,,3.50
151,151,Mew,1,Near Mint,,14.00
Evolving Skies,64,Umbreon VMAX,1,Near Mint,Holofoil,`;

/**
 * Import wizard.
 *
 * The rule this screen exists to enforce: nothing is written until the
 * collector has seen what SetValue believes each row means. Rows it cannot
 * resolve are shown with the reason rather than dropped, because a silently
 * skipped card is a completion percentage that is quietly wrong.
 */
export function ImportWizard() {
  const router = useRouter();
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ added: number; rows: number } | null>(null);
  const [filter, setFilter] = useState<'all' | 'problems'>('all');

  async function preview() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'preview', csv }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not read that file.');
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that file.');
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'commit', rows: result.allRows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Import failed.');
      setDone({ added: data.added, rows: data.rows });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File) {
    setCsv(await file.text());
    setResult(null);
    setDone(null);
  }

  if (done) {
    return (
      <div className="panel px-5 py-8 text-center">
        <p className="text-4xl" aria-hidden>📥</p>
        <h2 className="mt-3 text-xl font-bold">Import complete</h2>
        <p className="num mt-1 text-sm text-ink-mute">
          {done.added.toLocaleString()} card{done.added === 1 ? '' : 's'} added across{' '}
          {done.rows.toLocaleString()} row{done.rows === 1 ? '' : 's'}.
        </p>
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button onClick={() => { setDone(null); setResult(null); setCsv(''); }} className="btn-ghost">
            Import more
          </button>
          <a href="/app/collection" className="btn-primary">View collection</a>
        </div>
      </div>
    );
  }

  const p = result?.preview;
  const visibleRows = p
    ? filter === 'problems'
      ? p.rows.filter((r) => r.confidence !== 'exact')
      : p.rows
    : [];

  return (
    <div>
      <div className="panel px-4 py-4">
        <p className="text-sm font-semibold">Bring your collection with you</p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-mute">
          Paste or upload a CSV. SetValue reads the common export formats and matches on set plus
          card number — the only combination that identifies a card uniquely. It shows you every row
          it could not resolve instead of dropping it.
        </p>

        <label className="btn-ghost mt-3 w-full cursor-pointer">
          Choose a CSV file
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            className="sr-only"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }}
          />
        </label>

        <textarea
          value={csv}
          onChange={(e) => { setCsv(e.target.value); setResult(null); }}
          rows={7}
          spellCheck={false}
          aria-label="CSV contents"
          placeholder={SAMPLE}
          className="field mt-2 font-mono text-[12px] leading-relaxed"
        />

        <div className="mt-2 flex gap-2">
          <button onClick={() => setCsv(SAMPLE)} className="btn-ghost flex-1 text-xs">
            Use a sample
          </button>
          <button onClick={preview} disabled={busy || !csv.trim()} className="btn-primary flex-1">
            {busy ? 'Reading…' : 'Preview'}
          </button>
        </div>

        {error && (
          <p role="alert" className="mt-3 rounded-lg border border-need/40 bg-need/10 px-3 py-2 text-xs text-need">
            {error}
          </p>
        )}
      </div>

      {p && (
        <div className="mt-4">
          <div className="panel grid grid-cols-3 gap-px overflow-hidden bg-ink-line">
            <Cell label="Matched" value={p.matched.toLocaleString()} tone="have" />
            <Cell label="Ambiguous" value={p.ambiguous.toLocaleString()} tone={p.ambiguous ? 'gold' : 'mute'} />
            <Cell label="Unmatched" value={p.unmatched.toLocaleString()} tone={p.unmatched ? 'need' : 'mute'} />
          </div>

          <p className="mt-2 text-[11px] leading-relaxed text-ink-mute">
            Columns recognised: {result!.recognised.length ? result!.recognised.join(', ') : 'none'}.
            {result!.recognised.length < 3 &&
              ' Add set, card number and quantity columns for the most reliable match.'}
            {(p.ambiguous > 0 || p.unmatched > 0) &&
              ` ${p.ambiguous + p.unmatched} row${p.ambiguous + p.unmatched === 1 ? '' : 's'} will not be imported — nothing is guessed.`}
          </p>

          <div className="mt-3 flex gap-1.5">
            {(['all', 'problems'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                  filter === f ? 'bg-white text-ink' : 'border border-ink-line text-ink-mute'
                }`}
              >
                {f === 'all' ? `All rows (${p.rows.length})` : `Needs attention (${p.ambiguous + p.unmatched})`}
              </button>
            ))}
          </div>

          <ul className="mt-3 space-y-1.5">
            {visibleRows.slice(0, 200).map((r) => (
              <li
                key={r.line}
                className={`panel px-3 py-2.5 ${
                  r.confidence === 'exact'
                    ? ''
                    : r.confidence === 'ambiguous'
                      ? 'border-gold/40'
                      : 'border-need/40'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">
                      {r.confidence === 'exact'
                        ? `${r.cardName} · ${r.setName}`
                        : (r.nameHint ?? r.numberHint ?? 'row') + (r.setHint ? ` · ${r.setHint}` : '')}
                    </p>
                    <p className="num text-[11px] text-ink-mute">
                      line {r.line} · ×{r.quantity} · {r.condition}
                      {r.confidence === 'exact' && r.resolvedVariant ? ` · ${r.resolvedVariant}` : ''}
                      {r.paidCents !== null ? ` · paid ${money(r.paidCents)}` : ''}
                    </p>
                    {r.reason && (
                      <p className={`mt-1 text-[11px] ${r.confidence === 'exact' ? 'text-gold' : 'text-ink-mute'}`}>
                        {r.reason}
                      </p>
                    )}
                    {r.candidates && (
                      <ul className="mt-1 space-y-0.5">
                        {r.candidates.map((c) => (
                          <li key={c.cardId} className="text-[11px] text-ink-mute">· {c.label}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                      r.confidence === 'exact'
                        ? 'bg-have/15 text-have'
                        : r.confidence === 'ambiguous'
                          ? 'bg-gold/15 text-gold'
                          : 'bg-need/15 text-need'
                    }`}
                  >
                    {r.confidence === 'exact' ? 'match' : r.confidence}
                  </span>
                </div>
              </li>
            ))}
          </ul>

          {p.rows.length > 200 && (
            <p className="mt-2 text-center text-[11px] text-ink-mute">
              Showing the first 200 rows. All {p.matched.toLocaleString()} matched rows will be imported.
            </p>
          )}

          <div className="sticky bottom-20 mt-4">
            <button onClick={commit} disabled={busy || p.matched === 0} className="btn-need w-full shadow-2xl">
              {busy
                ? 'Importing…'
                : p.matched === 0
                  ? 'Nothing to import'
                  : `Import ${p.totalQuantity.toLocaleString()} card${p.totalQuantity === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Cell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'have' | 'need' | 'gold' | 'mute';
}) {
  const colors = { have: 'text-have', need: 'text-need', gold: 'text-gold', mute: 'text-ink-mute' };
  return (
    <div className="bg-ink-soft px-3 py-3 text-center">
      <p className="label">{label}</p>
      <p className={`num mt-1 text-lg font-bold ${colors[tone]}`}>{value}</p>
    </div>
  );
}
