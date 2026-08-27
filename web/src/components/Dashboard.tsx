import { useCallback, useEffect, useState } from 'react';
import { api, type TransactionRow, type User, type Wallet } from '../lib/api';
import { Logo } from './Logo';
import SendMoney from './SendMoney';
import TopUp from './TopUp';
import History from './History';

export default function Dashboard({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [active, setActive] = useState<string>('USD');
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    const [walletResult, transactionResult] = await Promise.all([
      api.wallets(),
      api.transactions({ limit: 50 }),
    ]);
    setWallets(walletResult.wallets);
    setTransactions(transactionResult.transactions);
    setActive((current) =>
      walletResult.wallets.some((w) => w.currency === current)
        ? current
        : (walletResult.wallets[0]?.currency ?? 'USD'),
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeWallet = wallets.find((w) => w.currency === active);

  async function copyId() {
    await navigator.clipboard.writeText(user.payhiveId).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="mx-auto min-h-full w-full max-w-5xl px-4 pb-16 pt-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <Logo className="h-6 w-6 text-hive-500" />
          <span className="text-lg font-semibold tracking-tight text-white">PayHive</span>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="text-sm font-medium text-slate-200">{user.displayName}</p>
            <button
              onClick={copyId}
              title="Copy your PayHive ID"
              className="tnum font-mono text-xs text-slate-500 transition hover:text-hive-500"
            >
              {copied ? 'Copied' : user.payhiveId}
            </button>
          </div>
          <button onClick={onSignOut} className="btn-ghost !px-3 !py-1.5 text-xs">
            Sign out
          </button>
        </div>
      </header>

      {/* Balance ------------------------------------------------------------ */}
      <section className="mt-7">
        {wallets.length > 1 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {wallets.map((wallet) => (
              <button
                key={wallet.currency}
                onClick={() => setActive(wallet.currency)}
                className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                  wallet.currency === active
                    ? 'bg-hive-500 text-ink-950'
                    : 'border border-white/10 text-slate-400 hover:bg-white/5'
                }`}
              >
                {wallet.currency}
              </button>
            ))}
          </div>
        )}

        <div className="card bg-gradient-to-br from-ink-800 to-ink-900">
          <p className="label mb-2">Available balance</p>
          {loading ? (
            <div className="h-10 w-40 animate-pulse rounded bg-white/5" />
          ) : (
            <p className="tnum text-4xl font-semibold tracking-tight text-white sm:text-5xl">
              {activeWallet?.balance.formatted ?? '0.00'}
              <span className="ml-2 text-lg font-medium text-slate-500">{active}</span>
            </p>
          )}
          <p className="mt-3 text-sm text-slate-500">
            Anyone can pay you with your PayHive ID{' '}
            <span className="tnum font-mono text-slate-300">{user.payhiveId}</span>
          </p>
        </div>
      </section>

      {/* Actions ------------------------------------------------------------ */}
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <SendMoney currency={active} onDone={refresh} />
        <TopUp currency={active} onDone={refresh} />
      </div>

      <History transactions={transactions} loading={loading} />
    </div>
  );
}
