import type { TransactionRow } from '../lib/api';

const LABELS: Record<TransactionRow['type'], string> = {
  deposit: 'Added funds',
  transfer: 'Transfer',
  withdrawal: 'Withdrawal',
  fee: 'Fee',
  reversal: 'Reversal',
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function History({
  transactions,
  loading,
}: {
  transactions: TransactionRow[];
  loading: boolean;
}) {
  return (
    <section className="card mt-5">
      <h2 className="text-sm font-semibold text-white">Activity</h2>

      {loading ? (
        <div className="mt-4 space-y-2.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-white/5" />
          ))}
        </div>
      ) : transactions.length === 0 ? (
        <p className="mt-6 pb-4 text-center text-sm text-slate-500">
          Nothing here yet. Add funds to get started.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-white/5">
          {transactions.map((row) => {
            const incoming = !row.amount.formatted.startsWith('-');
            return (
              <li key={`${row.transactionId}-${row.currency}`} className="flex items-center gap-3 py-3">
                <span
                  aria-hidden="true"
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm ${
                    incoming ? 'bg-emerald-500/10 text-emerald-400' : 'bg-white/5 text-slate-400'
                  }`}
                >
                  {incoming ? '↓' : '↑'}
                </span>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-200">
                    {row.counterparty ? (
                      <>
                        {incoming ? 'From' : 'To'}{' '}
                        <span className="tnum font-mono text-slate-300">{row.counterparty}</span>
                      </>
                    ) : (
                      LABELS[row.type]
                    )}
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {row.description ?? LABELS[row.type]} · {formatDate(row.createdAt)}
                  </p>
                </div>

                <p
                  className={`tnum shrink-0 text-sm font-semibold ${
                    incoming ? 'text-emerald-400' : 'text-slate-300'
                  }`}
                >
                  {incoming ? '+' : ''}
                  {row.amount.formatted} {row.currency}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
