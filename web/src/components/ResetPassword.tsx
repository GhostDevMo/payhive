import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '../lib/api';
import { Logo } from './Logo';

/**
 * The two halves of a password reset.
 *
 * Asking for a link says the same thing whether or not the address has an
 * account, because the server deliberately answers the same way — telling a
 * stranger which addresses bank here is not something the UI should undo.
 */
export function ForgotPassword({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    // No error branch on purpose: a failure here must not tell the caller
    // anything the success case would not.
    await api.requestPasswordReset(email.trim()).catch(() => undefined);
    setSent(true);
    setBusy(false);
  }

  if (sent) {
    return (
      <Shell title="Check your email">
        <p className="text-sm text-slate-400">
          If <span className="text-slate-200">{email.trim()}</span> has a PayHive account, a link to
          set a new password is on its way. It works once and expires in an hour.
        </p>
        <button onClick={onBack} className="btn-ghost mt-5 w-full">
          Back to sign in
        </button>
      </Shell>
    );
  }

  return (
    <Shell title="Reset your password">
      <p className="text-sm text-slate-500">
        We will email you a link to set a new one.
      </p>
      <form onSubmit={submit} className="mt-4 space-y-3.5">
        <div>
          <label className="label" htmlFor="reset-email">
            Email
          </label>
          <input
            id="reset-email"
            type="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="input"
          />
        </div>
        <button type="submit" disabled={busy || !email.trim()} className="btn-primary w-full">
          {busy ? 'Sending…' : 'Send the link'}
        </button>
        <button type="button" onClick={onBack} className="btn-ghost w-full">
          Back to sign in
        </button>
      </form>
    </Shell>
  );
}

export function ChooseNewPassword({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.confirmPasswordReset({ token, password });
      setDone(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Shell title="Password changed">
        <p className="text-sm text-slate-400">
          Every device that was signed in has been signed out. Sign in again with your new password.
        </p>
        <button onClick={onDone} className="btn-primary mt-5 w-full">
          Sign in
        </button>
      </Shell>
    );
  }

  return (
    <Shell title="Choose a new password">
      <form onSubmit={submit} className="mt-4 space-y-3.5">
        <div>
          <label className="label" htmlFor="new-password">
            New password
          </label>
          <input
            id="new-password"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 10 characters"
            className="input"
          />
        </div>
        {error && <p className="text-xs text-rose-400">{error}</p>}
        <button
          type="submit"
          disabled={busy || password.length < 10}
          className="btn-primary w-full"
        >
          {busy ? 'Saving…' : 'Set password'}
        </button>
        <button type="button" onClick={onDone} className="btn-ghost w-full">
          Cancel
        </button>
      </form>
    </Shell>
  );
}

export function ConfirmEmail({ token, onDone }: { token: string; onDone: () => void }) {
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [detail, setDetail] = useState('');

  // Redeeming is a side effect of arriving here, and the token is single-use,
  // so this must run exactly once for a given link.
  useEffect(() => {
    let cancelled = false;
    api
      .confirmEmailChange(token)
      .then((r) => {
        if (cancelled) return;
        setDetail(r.email);
        setState('done');
      })
      .catch((caught) => {
        if (cancelled) return;
        setDetail(caught instanceof ApiError ? caught.message : 'That link did not work.');
        setState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <Shell title={state === 'done' ? 'Email confirmed' : 'Confirming your email'}>
      {state === 'working' && <p className="text-sm text-slate-500">One moment…</p>}
      {state === 'done' && (
        <p className="text-sm text-slate-400">
          Your account now uses <span className="text-slate-200">{detail}</span>. Sign in with it
          from now on.
        </p>
      )}
      {state === 'failed' && <p className="text-sm text-rose-400">{detail}</p>}
      {state !== 'working' && (
        <button onClick={onDone} className="btn-primary mt-5 w-full">
          Continue
        </button>
      )}
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <Logo className="h-7 w-7 text-hive-500" />
          <span className="text-xl font-semibold tracking-tight text-white">PayHive</span>
        </div>
        <div className="card">
          <h1 className="text-base font-semibold text-white">{title}</h1>
          <div className="mt-1">{children}</div>
        </div>
      </div>
    </div>
  );
}
