import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, newIdempotencyKey } from '../lib/api';

/**
 * Wallet funding and withdrawal — the two points where PayHive touches an
 * external provider.
 *
 * With PAYMENT_PROVIDER=mock the deposit settles immediately, which is what
 * makes the whole app demonstrable without a Stripe key. With the Stripe
 * provider this returns a client secret and the wallet is credited by the
 * webhook, so this component would hand off to Stripe Elements here.
 */
export default function TopUp({
  currency,
  onDone,
}: {
  currency: string;
  onDone: () => Promise<void>;
}) {
  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef<string | null>(null);
  const [fee, setFee] = useState<{ fee: string; net: string } | null>(null);

  /**
   * Price the amount as it is typed.
   *
   * A fee the user only discovers on the receipt is a bad fee. Debounced, and
   * failures are silent: a quote that cannot be fetched should not put an
   * error in front of someone who has not asked for anything yet.
   */
  useEffect(() => {
    setFee(null);
    const typed = amount.trim();
    if (!typed || Number.isNaN(Number(typed)) || Number(typed) <= 0) return;

    const timer = setTimeout(() => {
      api
        .quote({ operation: mode === 'deposit' ? 'deposit' : 'withdrawal', amount: typed, currency })
        .then((r) => {
          if (r.quote.fee.amount !== '0') {
            setFee({ fee: r.quote.fee.formatted, net: r.quote.net.formatted });
          }
        })
        .catch(() => setFee(null));
    }, 300);

    return () => clearTimeout(timer);
  }, [amount, mode, currency]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    setBusy(true);
    idempotencyKey.current ??= newIdempotencyKey();

    try {
      if (mode === 'deposit') {
        const result = await api.deposit(
          { amount: amount.trim(), currency },
          idempotencyKey.current,
        );
        setSuccess(
          result.deposit.status === 'succeeded'
            ? `Added ${amount} ${currency} to your wallet.`
            : 'Payment started — complete it with your card to finish.',
        );
      } else {
        const result = await api.withdraw(
          { amount: amount.trim(), currency },
          idempotencyKey.current,
        );
        const net = result.withdrawal?.net?.formatted;
        setSuccess(
          net
            ? `Sending ${net} ${currency} to your bank.`
            : `Withdrawal of ${amount} ${currency} requested.`,
        );
      }
      setAmount('');
      idempotencyKey.current = null;
      await onDone();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Request failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">Move money</h2>
        <div className="flex rounded-lg border border-white/10 p-0.5">
          {(['deposit', 'withdraw'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                setMode(option);
                setError(null);
                setSuccess(null);
                idempotencyKey.current = null;
              }}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold capitalize transition ${
                mode === option ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {option === 'deposit' ? 'Add' : 'Withdraw'}
            </button>
          ))}
        </div>
      </div>

      <p className="mt-0.5 text-xs text-slate-500">
        {mode === 'deposit'
          ? 'Fund your wallet from a card or bank.'
          : 'Send funds out to your linked bank account.'}
      </p>

      <form onSubmit={submit} className="mt-4 space-y-3.5">
        <div>
          <label className="label" htmlFor="moveAmount">
            Amount ({currency})
          </label>
          <input
            id="moveAmount"
            className="field tnum"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            inputMode="decimal"
            pattern="^\d+(\.\d{1,3})?$"
            required
          />
        </div>

        <div className="flex flex-wrap gap-1.5">
          {['10', '25', '50', '100'].map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setAmount(preset)}
              className="rounded-full border border-white/10 px-3 py-1 text-xs text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
            >
              {preset}
            </button>
          ))}
        </div>

        {fee && (
          <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-xs">
            <div className="flex justify-between text-slate-500">
              <span>Fee</span>
              <span className="tnum text-slate-400">
                {fee.fee} {currency}
              </span>
            </div>
            <div className="mt-1 flex justify-between font-medium text-slate-300">
              <span>{mode === 'deposit' ? 'Added to your wallet' : 'Sent to your bank'}</span>
              <span className="tnum">
                {fee.net} {currency}
              </span>
            </div>
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300"
          >
            {error}
          </p>
        )}
        {success && (
          <p
            role="status"
            className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300"
          >
            {success}
          </p>
        )}

        <button type="submit" className="btn-ghost w-full" disabled={busy}>
          {busy ? 'Working…' : mode === 'deposit' ? 'Add funds' : 'Withdraw'}
        </button>
      </form>
    </section>
  );
}
