import { useState, type FormEvent } from 'react';
import { ApiError, api, type User } from '../lib/api';
import { Logo } from './Logo';

export default function AuthScreen({
  onAuthenticated,
  onForgotPassword,
}: {
  onAuthenticated: (user: User) => void;
  onForgotPassword: () => void;
}) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result =
        mode === 'login'
          ? await api.login({ email, password })
          : await api.signup({ email, password, displayName, currency });
      onAuthenticated(result.user);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <Logo className="h-7 w-7 text-hive-500" />
          <span className="text-xl font-semibold tracking-tight text-white">PayHive</span>
        </div>

        <div className="card">
          <h1 className="text-lg font-semibold text-white">
            {mode === 'login' ? 'Sign in' : 'Create your wallet'}
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            {mode === 'login'
              ? 'Access your PayHive wallet.'
              : 'You’ll get a PayHive ID that others can send money to.'}
          </p>

          <form onSubmit={submit} className="mt-5 space-y-4">
            {mode === 'signup' && (
              <div>
                <label className="label" htmlFor="displayName">
                  Name
                </label>
                <input
                  id="displayName"
                  className="field"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Ada Ojo"
                  autoComplete="name"
                  required
                />
              </div>
            )}

            <div>
              <label className="label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                className="field"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                required
              />
            </div>

            <div>
              <label className="label" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                type="password"
                className="field"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'signup' ? 'At least 10 characters' : '••••••••'}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                minLength={mode === 'signup' ? 10 : undefined}
                required
              />
            </div>

            {mode === 'signup' && (
              <div>
                <label className="label" htmlFor="currency">
                  Wallet currency
                </label>
                <select
                  id="currency"
                  className="field"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                >
                  {['USD', 'EUR', 'GBP', 'NGN', 'GHS', 'KES', 'ZAR'].map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
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

            <button type="submit" className="btn-primary w-full" disabled={busy}>
              {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create wallet'}
            </button>

            {mode === 'login' && (
              <button
                type="button"
                onClick={onForgotPassword}
                className="w-full text-center text-xs font-medium text-slate-500 transition hover:text-hive-500"
              >
                Forgot your password?
              </button>
            )}
          </form>
        </div>

        <p className="mt-5 text-center text-sm text-slate-500">
          {mode === 'login' ? 'No account yet?' : 'Already have an account?'}{' '}
          <button
            type="button"
            className="font-medium text-hive-500 hover:text-hive-400"
            onClick={() => {
              setMode(mode === 'login' ? 'signup' : 'login');
              setError(null);
            }}
          >
            {mode === 'login' ? 'Create one' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}
