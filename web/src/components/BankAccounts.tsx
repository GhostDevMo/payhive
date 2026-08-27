import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type BankAccount } from '../lib/api';

/**
 * Linked bank accounts.
 *
 * Nothing in this component ever holds an account number. Linking is a
 * two-step handshake with the aggregator: the server mints a link token, the
 * aggregator's own UI collects the bank login, and what comes back here is a
 * public token that means nothing on its own.
 */

const PLAID_SDK = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

interface PlaidHandler {
  open: () => void;
  destroy: () => void;
}

declare global {
  interface Window {
    Plaid?: {
      create(config: {
        token: string;
        onSuccess: (publicToken: string, metadata: { account_id?: string }) => void;
        onExit: (error: unknown) => void;
      }): PlaidHandler;
    };
  }
}

/**
 * Load Plaid Link on demand.
 *
 * Fetched only when a real aggregator is configured, so a mock-provider
 * deployment never reaches out to a third-party CDN at all.
 */
function loadPlaid(): Promise<NonNullable<Window['Plaid']>> {
  if (window.Plaid) return Promise.resolve(window.Plaid);

  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${PLAID_SDK}"]`);
    const script = existing ?? document.createElement('script');

    script.addEventListener('load', () => {
      if (window.Plaid) resolve(window.Plaid);
      else reject(new Error('Plaid Link loaded but did not initialise'));
    });
    script.addEventListener('error', () => reject(new Error('Could not load Plaid Link')));

    if (!existing) {
      script.src = PLAID_SDK;
      script.async = true;
      document.head.appendChild(script);
    }
  });
}

export default function BankAccounts({ currency }: { currency: string }) {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api.bankAccounts();
      setAccounts(result.bankAccounts);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load your accounts.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function link() {
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const session = await api.bankLinkToken({ currency, country: 'US' });

      if (!session.usesClientSdk) {
        // The mock aggregator has no UI to open. Complete the same exchange
        // the real one would, so this path stays exercised in development.
        const publicToken = `mock_public_${currency}_${crypto.randomUUID()}`;
        await api.linkBankAccount({ publicToken, country: 'US' });
        await refresh();
        return;
      }

      const plaid = await loadPlaid();
      await new Promise<void>((resolve, reject) => {
        const handler = plaid.create({
          token: session.linkToken,
          onSuccess: (publicToken, metadata) => {
            api
              .linkBankAccount({ publicToken, accountId: metadata.account_id, country: 'US' })
              .then(() => refresh())
              .then(resolve, reject)
              .finally(() => handler.destroy());
          },
          onExit: (exitError) => {
            handler.destroy();
            // Closing the window is a normal thing to do, not a failure.
            if (exitError) reject(new Error('Bank linking was interrupted.'));
            else resolve();
          },
        });
        handler.open();
      });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : (caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function act(run: () => Promise<unknown>) {
    setError(null);
    try {
      await run();
      await refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That did not work.');
    }
  }

  return (
    <section className="card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-white">Bank accounts</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Where withdrawals are sent. You sign in with your bank through our provider — PayHive
            never sees your bank login or account number.
          </p>
        </div>
        <button onClick={() => void link()} disabled={busy} className="btn-primary !py-2 shrink-0">
          {busy ? 'Linking…' : 'Link a bank'}
        </button>
      </div>

      {error && <p className="mt-3 text-xs text-rose-400">{error}</p>}

      <div className="mt-4 space-y-2">
        {loading && <div className="h-12 animate-pulse rounded bg-white/5" />}

        {!loading && accounts.length === 0 && (
          <p className="text-sm text-slate-500">
            No accounts linked yet. You need one before you can withdraw.
          </p>
        )}

        {accounts.map((account) => (
          <div
            key={account.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-slate-200">
                {account.institution}{' '}
                <span className="tnum font-mono text-slate-500">••{account.last4}</span>
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {account.currency}
                {account.isDefault && <span className="ml-2 text-hive-500">Default</span>}
                {!account.payoutReady && (
                  <span className="ml-2 text-amber-400">Not ready for payouts</span>
                )}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {!account.isDefault && (
                <button
                  onClick={() => void act(() => api.setDefaultBankAccount(account.id))}
                  className="btn-ghost !px-3 !py-1.5 text-xs"
                >
                  Make default
                </button>
              )}
              <button
                onClick={() => void act(() => api.removeBankAccount(account.id))}
                className="!px-3 !py-1.5 text-xs font-semibold text-slate-500 transition hover:text-rose-400"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
