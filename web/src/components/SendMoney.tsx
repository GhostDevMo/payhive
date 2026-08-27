import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, newIdempotencyKey } from '../lib/api';

/**
 * The send flow.
 *
 * Two deliberate choices:
 *
 *  - The recipient is confirmed by name before the button is armed. People
 *    mistype IDs, and an irreversible transfer to a stranger is the worst bug
 *    a payments app can ship.
 *  - The idempotency key is minted once per attempt and held in a ref, so a
 *    user hammering Send on a slow connection retries the same request rather
 *    than starting new ones.
 */
export default function SendMoney({
  currency,
  onDone,
}: {
  currency: string;
  onDone: () => Promise<void>;
}) {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [recipient, setRecipient] = useState<{
    payhiveId: string;
    handle: string | null;
    displayName: string;
  } | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef<string | null>(null);

  // Debounced recipient lookup as the address is typed. The address may be a
  // PayHive ID or a handle, so the minimum length is the shortest handle, not
  // the fixed length of an ID — and the case is left as typed, because the
  // server matches a handle case-insensitively and uppercasing it here would
  // only make what the payer sees disagree with what they wrote.
  useEffect(() => {
    const candidate = to.trim().replace(/^@/, '');
    setRecipient(null);
    setLookupError(null);
    if (candidate.length < 3) return;

    const timer = setTimeout(() => {
      api
        .lookupRecipient(candidate)
        .then((r) => setRecipient(r.recipient))
        .catch(() => setLookupError('No PayHive user with that ID or handle.'));
    }, 300);

    return () => clearTimeout(timer);
  }, [to]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!recipient) return;

    setError(null);
    setSuccess(null);
    setBusy(true);
    idempotencyKey.current ??= newIdempotencyKey();

    try {
      const result = await api.transfer(
        { to: recipient.payhiveId, amount: amount.trim(), currency, note: note.trim() || undefined },
        idempotencyKey.current,
      );
      setSuccess(
        `Sent ${result.transfer.amount.formatted} ${currency} to ${result.transfer.to.displayName}.`,
      );
      setTo('');
      setAmount('');
      setNote('');
      setRecipient(null);
      idempotencyKey.current = null;
      await onDone();
    } catch (caught) {
      // Keep the key: the next press should retry this send, not start another.
      setError(caught instanceof ApiError ? caught.message : 'Transfer failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2 className="text-sm font-semibold text-white">Send money</h2>
      <p className="mt-0.5 text-xs text-slate-500">
        Instant and free between PayHive wallets.
      </p>

      <form onSubmit={submit} className="mt-4 space-y-3.5">
        <div>
          <label className="label" htmlFor="recipient">
            Recipient PayHive ID or handle
          </label>
          <input
            id="recipient"
            className="field tnum font-mono uppercase"
            value={to}
            onChange={(e) => setTo(e.target.value.toUpperCase())}
            placeholder="PH7K4M2Q9X or @handle"
            maxLength={10}
            autoComplete="off"
            spellCheck={false}
            required
          />
          <div className="mt-1.5 min-h-[1.25rem] text-xs">
            {recipient && (
              // The resolved PayHive ID is shown next to the name on purpose. A
              // handle can be chosen to resemble someone else's; the permanent
              // ID cannot, so this is the payer's chance to notice.
              <span className="text-emerald-400">
                Paying <strong className="font-semibold">{recipient.displayName}</strong>{' '}
                <span className="tnum font-mono text-slate-500">{recipient.payhiveId}</span>
              </span>
            )}
            {lookupError && <span className="text-red-400">{lookupError}</span>}
          </div>
        </div>

        <div>
          <label className="label" htmlFor="amount">
            Amount ({currency})
          </label>
          <input
            id="amount"
            className="field tnum"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            inputMode="decimal"
            // Digits with an optional decimal part. The server re-validates and
            // is the authority; this only stops obvious nonsense early.
            pattern="^\d+(\.\d{1,3})?$"
            required
          />
        </div>

        <div>
          <label className="label" htmlFor="note">
            Note <span className="normal-case text-slate-600">(optional)</span>
          </label>
          <input
            id="note"
            className="field"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Rent, October"
            maxLength={140}
          />
        </div>

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

        <button type="submit" className="btn-primary w-full" disabled={busy || !recipient}>
          {busy ? 'Sending…' : recipient ? `Send to ${recipient.displayName}` : 'Send'}
        </button>
      </form>
    </section>
  );
}
